package jobs

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
)

const jobsSchema = `
CREATE TABLE IF NOT EXISTS deck_jobs (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS job_outbox (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS job_outbox_pending_idx ON job_outbox(id) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS job_migration_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

type PostgresStore struct {
	db          *sql.DB
	instanceID  string
	mu          sync.Mutex
	subscribers map[string]map[chan Job]struct{}
	deliver     func(Job)
	listenStop  chan struct{}
	listenDone  chan struct{}
}

func NewPostgresStore(ctx context.Context, dsn string) (*PostgresStore, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	db.SetConnMaxIdleTime(5 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	connection, err := db.Conn(ctx)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	defer connection.Close()
	if _, err := connection.ExecContext(ctx, "SELECT pg_advisory_lock(861905)"); err != nil {
		_ = db.Close()
		return nil, err
	}
	defer func() { _, _ = connection.ExecContext(ctx, "SELECT pg_advisory_unlock(861905)") }()
	if _, err := connection.ExecContext(ctx, jobsSchema); err != nil {
		_ = db.Close()
		return nil, err
	}
	store := &PostgresStore{
		db: db, instanceID: newPostgresInstanceID(),
		subscribers: map[string]map[chan Job]struct{}{},
		listenStop:  make(chan struct{}), listenDone: make(chan struct{}),
	}
	go store.listen(context.Background())
	return store, nil
}

func newPostgresInstanceID() string {
	value := make([]byte, 8)
	if _, err := rand.Read(value); err == nil {
		return hex.EncodeToString(value)
	}
	return fmt.Sprintf("instance-%d", time.Now().UnixNano())
}

// RecoverAgents is called at single-gateway startup before accepting requests.
// Replica startup must not interrupt another healthy gateway's executions.
func (s *PostgresStore) RecoverAgents(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, "SELECT payload FROM deck_jobs WHERE payload->'agent' IS NOT NULL FOR UPDATE")
	if err != nil {
		return err
	}
	var pending []Job
	for rows.Next() {
		var payload []byte
		if err := rows.Scan(&payload); err != nil {
			rows.Close()
			return err
		}
		var job Job
		if err := json.Unmarshal(payload, &job); err != nil {
			rows.Close()
			return err
		}
		if job.Agent == nil {
			continue
		}
		changed := activePhase(job.Agent.Phase) || job.Agent.Phase == "queued"
		for _, call := range job.Agent.Calls {
			if call.Status == "sent" {
				changed = true
			}
		}
		if changed {
			interruptAgent(job.Agent)
			pending = append(pending, job)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, job := range pending {
		job.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		payload, err := json.Marshal(job)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE deck_jobs SET payload=$1,updated_at=$2 WHERE id=$3", payload, job.UpdatedAt, job.ID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO job_outbox(job_id,payload,created_at) VALUES($1,$2,$3)", job.ID, payload, job.UpdatedAt); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "SELECT pg_notify('deck_job_events',$1)", s.instanceID+":"+job.ID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *PostgresStore) Close() error {
	if s.listenStop != nil {
		close(s.listenStop)
		<-s.listenDone
	}
	return s.db.Close()
}

func (s *PostgresStore) listen(ctx context.Context) {
	defer close(s.listenDone)
	connection, err := s.db.Conn(ctx)
	if err != nil {
		return
	}
	defer connection.Close()
	var pgxConnection *pgx.Conn
	if err := connection.Raw(func(driverConnection any) error {
		pgxConnection = driverConnection.(interface{ Conn() *pgx.Conn }).Conn()
		return nil
	}); err != nil {
		return
	}
	listenContext, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-s.listenStop:
			cancel()
		case <-listenContext.Done():
		}
	}()
	if _, err := pgxConnection.Exec(listenContext, "LISTEN deck_job_events"); err != nil {
		return
	}
	for {
		notification, err := pgxConnection.WaitForNotification(listenContext)
		if err != nil {
			return
		}
		parts := strings.SplitN(notification.Payload, ":", 2)
		if len(parts) != 2 || parts[0] == s.instanceID {
			continue
		}
		job, ok := s.Get(parts[1])
		if ok {
			s.notify(job)
		}
	}
}

func (s *PostgresStore) Create(job Job) error {
	if job.Events == nil {
		job.Events = []string{}
	}
	if job.OverflowPages == nil {
		job.OverflowPages = []int{}
	}
	job.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	payload, err := json.Marshal(job)
	if err != nil {
		return err
	}
	_, err = s.db.Exec("INSERT INTO deck_jobs(id,payload,updated_at) VALUES($1,$2,$3)", job.ID, payload, job.UpdatedAt)
	if err != nil {
		return fmt.Errorf("deck 任务已存在或无法创建: %w", err)
	}
	return nil
}

func (s *PostgresStore) Save(job Job) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	current, err := postgresJobForUpdate(tx, job.ID)
	if err != nil {
		return err
	}
	if current.Agent != nil {
		return errors.New("Agent 任务必须通过条件更新接口修改")
	}
	if current.Cancelled && job.Status == "creating" {
		job.Status = "error"
		job.Error = "用户取消了任务"
		job.Cancelled = true
	}
	if len(job.Events) > 200 {
		job.Events = append([]string(nil), job.Events[len(job.Events)-200:]...)
	}
	job.Webhook = current.Webhook
	job.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	payload, err := json.Marshal(job)
	if err != nil {
		return err
	}
	if _, err := tx.Exec("UPDATE deck_jobs SET payload=$1,updated_at=$2 WHERE id=$3", payload, job.UpdatedAt, job.ID); err != nil {
		return err
	}
	if _, err := tx.Exec("INSERT INTO job_outbox(job_id,payload,created_at) VALUES($1,$2,$3)", job.ID, payload, job.UpdatedAt); err != nil {
		return err
	}
	if _, err := tx.Exec("SELECT pg_notify('deck_job_events',$1)", s.instanceID+":"+job.ID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.notify(job)
	s.deliverJob(job)
	return nil
}

func postgresJobForUpdate(tx *sql.Tx, id string) (Job, error) {
	var payload []byte
	if err := tx.QueryRow("SELECT payload FROM deck_jobs WHERE id=$1 FOR UPDATE", id).Scan(&payload); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Job{}, errors.New("deck 任务不存在")
		}
		return Job{}, err
	}
	var job Job
	return job, json.Unmarshal(payload, &job)
}

func (s *PostgresStore) Get(id string) (Job, bool) {
	var payload []byte
	if err := s.db.QueryRow("SELECT payload FROM deck_jobs WHERE id=$1", id).Scan(&payload); err != nil {
		return Job{}, false
	}
	var job Job
	if err := json.Unmarshal(payload, &job); err != nil {
		return Job{}, false
	}
	return job, true
}

func (s *PostgresStore) List() []Job {
	rows, err := s.db.Query("SELECT payload FROM deck_jobs ORDER BY updated_at")
	if err != nil {
		return []Job{}
	}
	defer rows.Close()
	result := make([]Job, 0)
	for rows.Next() {
		var payload []byte
		if err := rows.Scan(&payload); err == nil {
			var job Job
			if json.Unmarshal(payload, &job) == nil {
				result = append(result, job)
			}
		}
	}
	return result
}

func (s *PostgresStore) Delete(id string) {
	_, _ = s.db.Exec("DELETE FROM deck_jobs WHERE id=$1", id)
}

func (s *PostgresStore) Cancel(id string) (Job, bool, error) {
	job, ok := s.Get(id)
	if !ok {
		return Job{}, false, nil
	}
	if job.Agent != nil {
		result, err := s.MutateAgent(AgentCommand{Action: "cancel", DeckID: id, RunSeq: job.Agent.RunSeq})
		return result, true, err
	}
	job.Cancelled = true
	job.Status = "error"
	job.Error = "用户取消了任务"
	if err := s.Save(job); err != nil {
		return Job{}, true, err
	}
	return job, true, nil
}

func (s *PostgresStore) SetWebhook(id string, config WebhookConfig) error {
	job, ok := s.Get(id)
	if !ok {
		return errors.New("deck 任务不存在")
	}
	job.Webhook = &config
	payload, err := json.Marshal(job)
	if err != nil {
		return err
	}
	_, err = s.db.Exec("UPDATE deck_jobs SET payload=$1,updated_at=$2 WHERE id=$3", payload, time.Now().UTC().Format(time.RFC3339), id)
	return err
}

func (s *PostgresStore) SetDeliveryHandler(deliver func(Job)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deliver = deliver
}

func (s *PostgresStore) deliverJob(job Job) {
	s.mu.Lock()
	deliver := s.deliver
	s.mu.Unlock()
	if deliver != nil && job.Webhook != nil {
		deliver(job)
	}
}

func (s *PostgresStore) Subscribe(id string) (<-chan Job, func()) {
	channel := make(chan Job, 1)
	s.mu.Lock()
	if s.subscribers[id] == nil {
		s.subscribers[id] = map[chan Job]struct{}{}
	}
	s.subscribers[id][channel] = struct{}{}
	s.mu.Unlock()
	return channel, func() {
		s.mu.Lock()
		delete(s.subscribers[id], channel)
		close(channel)
		s.mu.Unlock()
	}
}

func (s *PostgresStore) notify(job Job) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for channel := range s.subscribers[job.ID] {
		select {
		case <-channel:
		default:
		}
		select {
		case channel <- job:
		default:
		}
	}
}

func (s *PostgresStore) nextOutbox(ctx context.Context) (int64, Job, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, Job{}, err
	}
	defer tx.Rollback()
	var id int64
	var payload []byte
	err = tx.QueryRowContext(ctx, `
		SELECT id,payload FROM job_outbox
		WHERE delivered_at IS NULL AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '10 minutes')
		ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id, &payload)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, Job{}, tx.Commit()
	}
	if err != nil {
		return 0, Job{}, err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE job_outbox SET claimed_at=NOW() WHERE id=$1", id); err != nil {
		return 0, Job{}, err
	}
	if err := tx.Commit(); err != nil {
		return 0, Job{}, err
	}
	var job Job
	return id, job, json.Unmarshal(payload, &job)
}

func (s *PostgresStore) markOutboxDelivered(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, "UPDATE job_outbox SET delivered_at=NOW() WHERE id=$1", id)
	return err
}

func (s *PostgresStore) MigrateJSON(ctx context.Context, dataDir string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var migrated string
	if err := tx.QueryRowContext(ctx, "SELECT value FROM job_migration_meta WHERE key='json_v1'").Scan(&migrated); err == nil {
		return nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	data, err := os.ReadFile(filepath.Join(dataDir, "deck-jobs.json"))
	if errors.Is(err, os.ErrNotExist) {
		if _, err := tx.ExecContext(ctx, "INSERT INTO job_migration_meta(key,value) VALUES('json_v1','empty') ON CONFLICT(key) DO NOTHING"); err != nil {
			return err
		}
		return tx.Commit()
	}
	if err != nil {
		return err
	}
	var saved []Job
	if err := json.Unmarshal(data, &saved); err != nil {
		return err
	}
	for _, job := range saved {
		if job.Status == "creating" {
			job.Status = "error"
			job.Error = "服务重启中断了生成，请重新创建任务"
		}
		if job.UpdatedAt == "" {
			job.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		}
		payload, err := json.Marshal(job)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO deck_jobs(id,payload,updated_at) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING", job.ID, payload, job.UpdatedAt); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO job_migration_meta(key,value) VALUES('json_v1','done') ON CONFLICT(key) DO NOTHING"); err != nil {
		return err
	}
	return tx.Commit()
}

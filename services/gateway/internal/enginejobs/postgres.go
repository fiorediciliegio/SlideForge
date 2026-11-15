package enginejobs

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	_ "github.com/jackc/pgx/v5/stdlib"
	"time"
)

// A short row transaction serializes scheduling across gateway replicas. Large
// input/output bytes live in object storage, never in the scheduling document.
func NewPostgresStore(ctx context.Context, dsn string, objects objectStore) (*Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(2)
	if err = db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	setup, err := db.BeginTx(ctx, nil)
	if err != nil {
		db.Close()
		return nil, err
	}
	defer setup.Rollback()
	_, err = setup.ExecContext(ctx, `SELECT pg_advisory_xact_lock(861906)`)
	if err != nil {
		db.Close()
		return nil, err
	}
	_, err = setup.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS engine_queue (id INTEGER PRIMARY KEY CHECK(id=1), payload JSONB NOT NULL);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	initial, _ := json.Marshal(emptyState())
	_, err = setup.ExecContext(ctx, `INSERT INTO engine_queue(id,payload) VALUES(1,$1) ON CONFLICT(id) DO NOTHING`, initial)
	if err != nil {
		db.Close()
		return nil, err
	}
	if err = setup.Commit(); err != nil {
		db.Close()
		return nil, err
	}
	return newSQLStore(db, objects), nil
}
func newSQLStore(db *sql.DB, objects objectStore) *Store {
	s := &Store{objects: objects, close: db.Close}
	s.now = time.Now
	s.transaction = func(write bool, fn func(*state) error) error {
		tx, err := db.BeginTx(context.Background(), nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		query := `SELECT payload FROM engine_queue WHERE id=1`
		if write {
			query += ` FOR UPDATE`
		}
		var data []byte
		if err = tx.QueryRow(query).Scan(&data); err != nil {
			return err
		}
		var st state
		if err = json.Unmarshal(data, &st); err != nil {
			return err
		}
		previous, err := json.Marshal(st)
		if err != nil {
			return err
		}
		if err = fn(&st); err != nil {
			return err
		}
		if write {
			data, err = json.Marshal(st)
			if err != nil {
				return err
			}
			if !bytes.Equal(previous, data) {
				if _, err = tx.Exec(`UPDATE engine_queue SET payload=$1 WHERE id=1`, data); err != nil {
					return err
				}
			}
		}
		return tx.Commit()
	}
	return s
}

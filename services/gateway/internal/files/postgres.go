package files

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

type ObjectStore interface {
	Put(key string, content []byte) error
	Get(key string) ([]byte, error)
	Delete(key string) error
}

type PostgresFileStore struct {
	db      *sql.DB
	objects ObjectStore
}

const filesSchema = `
CREATE TABLE IF NOT EXISTS deck_files (
  file_id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  download_url TEXT NOT NULL,
  owner_key_hash TEXT NOT NULL,
  object_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS deck_files_owner_idx ON deck_files(deck_id, owner_key_hash);
CREATE TABLE IF NOT EXISTS files_migration_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

func NewPostgresFileStore(ctx context.Context, dsn string, objects ObjectStore) (*PostgresFileStore, error) {
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
	if _, err := connection.ExecContext(ctx, filesSchema); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &PostgresFileStore{db: db, objects: objects}, nil
}

func (s *PostgresFileStore) Close() error { return s.db.Close() }

func (s *PostgresFileStore) Publish(deckID, name, mediaType, ownerKeyHash string, content []byte) (Record, error) {
	return s.publish("", deckID, name, mediaType, ownerKeyHash, content)
}
func (s *PostgresFileStore) PublishOnce(operationID, deckID, name, mediaType, owner string, content []byte) (Record, error) {
	return s.publish(deliveryFileID(operationID, deckID, owner), deckID, name, mediaType, owner, content)
}
func (s *PostgresFileStore) publish(id, deckID, name, mediaType, ownerKeyHash string, content []byte) (Record, error) {
	if !strings.HasPrefix(deckID, "deck-") || ownerKeyHash == "" {
		return Record{}, errors.New("deck_id 或文件归属无效")
	}
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	if name == "" || name == "." || strings.ContainsAny(name, "\r\n") {
		return Record{}, errors.New("文件名无效")
	}
	if mediaType != "application/vnd.openxmlformats-officedocument.presentationml.presentation" && mediaType != "application/pdf" {
		return Record{}, errors.New("仅支持 PPTX 或 PDF 文件")
	}
	if len(content) == 0 || len(content) > MaxFileBytes {
		return Record{}, errors.New("文件为空或超过 64 MiB 上限")
	}
	deterministic := id != ""
	if deterministic {
		existing, ok, err := s.Get(id)
		if err != nil {
			return Record{}, err
		}
		if ok {
			return existing, nil
		}
	} else {
		var err error
		id, err = newFileID()
		if err != nil {
			return Record{}, err
		}
	}
	objectKey := "exports/" + id
	if err := s.objects.Put(objectKey, content); err != nil {
		return Record{}, err
	}
	record := Record{
		ID: id, DeckID: deckID, Name: name, MediaType: mediaType, SizeBytes: len(content),
		DownloadURL: "/files/" + id, OwnerKeyHash: ownerKeyHash, ObjectPath: objectKey,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	insert := `
		INSERT INTO deck_files(file_id,deck_id,name,media_type,size_bytes,download_url,owner_key_hash,object_key,created_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`
	if deterministic {
		insert += ` ON CONFLICT(file_id) DO NOTHING`
	}
	_, err := s.db.Exec(insert,
		record.ID, record.DeckID, record.Name, record.MediaType, record.SizeBytes,
		record.DownloadURL, record.OwnerKeyHash, record.ObjectPath, record.CreatedAt,
	)
	if err != nil && !deterministic {
		_ = s.objects.Delete(objectKey)
	}
	if err == nil && deterministic {
		existing, _, readErr := s.Get(id)
		return existing, readErr
	}
	return record, err
}

func (s *PostgresFileStore) Get(id string) (Record, bool, error) {
	var record Record
	err := s.db.QueryRow(`
		SELECT file_id,deck_id,name,media_type,size_bytes,download_url,owner_key_hash,object_key,created_at
		FROM deck_files WHERE file_id=$1`, id).Scan(
		&record.ID, &record.DeckID, &record.Name, &record.MediaType, &record.SizeBytes,
		&record.DownloadURL, &record.OwnerKeyHash, &record.ObjectPath, &record.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Record{}, false, nil
	}
	return record, err == nil, err
}

func (s *PostgresFileStore) ListDeck(deckID, ownerKeyHash string) ([]Record, error) {
	rows, err := s.db.Query(`
		SELECT file_id,deck_id,name,media_type,size_bytes,download_url,owner_key_hash,object_key,created_at
		FROM deck_files WHERE deck_id=$1 AND owner_key_hash=$2 ORDER BY created_at`, deckID, ownerKeyHash)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Record{}
	for rows.Next() {
		var record Record
		if err := rows.Scan(
			&record.ID, &record.DeckID, &record.Name, &record.MediaType, &record.SizeBytes,
			&record.DownloadURL, &record.OwnerKeyHash, &record.ObjectPath, &record.CreatedAt,
		); err != nil {
			return nil, err
		}
		result = append(result, record)
	}
	return result, rows.Err()
}

func (s *PostgresFileStore) Read(record Record) ([]byte, error) {
	return s.objects.Get(record.ObjectPath)
}

func (s *PostgresFileStore) MigrateJSON(ctx context.Context, dataDir string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var value string
	err = tx.QueryRowContext(ctx, "SELECT value FROM files_migration_meta WHERE key='json_v1'").Scan(&value)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	data, err := os.ReadFile(filepath.Join(dataDir, "files.json"))
	if errors.Is(err, os.ErrNotExist) {
		_, err = tx.ExecContext(ctx, "INSERT INTO files_migration_meta(key,value) VALUES('json_v1','empty') ON CONFLICT DO NOTHING")
		if err != nil {
			return err
		}
		return tx.Commit()
	}
	if err != nil {
		return err
	}
	var saved []Record
	if err := json.Unmarshal(data, &saved); err != nil {
		return err
	}
	for _, record := range saved {
		if record.CreatedAt == "" {
			record.CreatedAt = time.Now().UTC().Format(time.RFC3339)
		}
		content, err := os.ReadFile(record.ObjectPath)
		if err != nil {
			return err
		}
		objectKey := "exports/" + record.ID
		if err := s.objects.Put(objectKey, content); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `
			INSERT INTO deck_files(file_id,deck_id,name,media_type,size_bytes,download_url,owner_key_hash,object_key,created_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(file_id) DO NOTHING`,
			record.ID, record.DeckID, record.Name, record.MediaType, record.SizeBytes,
			record.DownloadURL, record.OwnerKeyHash, objectKey, record.CreatedAt,
		)
		if err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO files_migration_meta(key,value) VALUES('json_v1','done') ON CONFLICT(key) DO NOTHING"); err != nil {
		return err
	}
	return tx.Commit()
}

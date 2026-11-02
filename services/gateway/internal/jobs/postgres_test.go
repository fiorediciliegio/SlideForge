package jobs

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestPostgresJobSaveCommitsUpdateOutboxAndNotificationTogether(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := &PostgresStore{db: db, instanceID: "instance-test", subscribers: map[string]map[chan Job]struct{}{}}
	current := Job{ID: "deck-a", Status: "creating", Events: []string{}, OverflowPages: []int{}}
	payload, _ := json.Marshal(current)
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT payload FROM deck_jobs").WithArgs("deck-a").WillReturnRows(sqlmock.NewRows([]string{"payload"}).AddRow(payload))
	mock.ExpectExec("UPDATE deck_jobs SET payload").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO job_outbox").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("SELECT pg_notify").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	job := current
	job.Events = append(job.Events, "page 1")
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresOutboxClaimUsesSkipLocked(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := &PostgresStore{db: db}
	job := Job{ID: "deck-a", Status: "ready", Events: []string{}, OverflowPages: []int{}}
	payload, _ := json.Marshal(job)
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT id,payload FROM job_outbox").WillReturnRows(sqlmock.NewRows([]string{"id", "payload"}).AddRow(7, payload))
	mock.ExpectExec("UPDATE job_outbox SET claimed_at").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	id, claimed, err := store.nextOutbox(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if id != 7 || claimed.ID != job.ID {
		t.Fatalf("unexpected outbox item: %d %#v", id, claimed)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresJobMigrationMarker(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := &PostgresStore{db: db}
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT value FROM job_migration_meta").WillReturnRows(sqlmock.NewRows([]string{"value"}))
	mock.ExpectExec("INSERT INTO job_migration_meta").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()
	if err := store.MigrateJSON(context.Background(), t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresJobMigrationBackfillsUpdatedAt(t *testing.T) {
	directory := t.TempDir()
	payload, _ := json.Marshal([]Job{{ID: "deck-legacy", Status: "ready", Events: []string{}, OverflowPages: []int{}}})
	if err := os.WriteFile(filepath.Join(directory, "deck-jobs.json"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := &PostgresStore{db: db}
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT value FROM job_migration_meta").WillReturnRows(sqlmock.NewRows([]string{"value"}))
	mock.ExpectExec("INSERT INTO deck_jobs").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("INSERT INTO job_migration_meta").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()
	if err := store.MigrateJSON(context.Background(), directory); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

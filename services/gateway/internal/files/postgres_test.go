package files

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

type memoryObjects struct{ values map[string][]byte }

func (m *memoryObjects) Put(key string, content []byte) error {
	m.values[key] = content
	return nil
}
func (m *memoryObjects) Get(key string) ([]byte, error) { return m.values[key], nil }
func (m *memoryObjects) Delete(key string) error {
	delete(m.values, key)
	return nil
}

func TestPostgresFilePublishAndRead(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	objects := &memoryObjects{values: map[string][]byte{}}
	store := &PostgresFileStore{db: db, objects: objects}
	mock.ExpectExec("INSERT INTO deck_files").WillReturnResult(sqlmock.NewResult(1, 1))
	record, err := store.Publish("deck-a", "deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "owner-a", []byte("pptx"))
	if err != nil {
		t.Fatal(err)
	}
	mock.ExpectQuery("SELECT file_id,deck_id,name,media_type,size_bytes,download_url,owner_key_hash,object_key,created_at FROM deck_files").WithArgs(record.ID).WillReturnRows(
		sqlmock.NewRows([]string{"file_id", "deck_id", "name", "media_type", "size_bytes", "download_url", "owner_key_hash", "object_key", "created_at"}).AddRow(
			record.ID, "deck-a", "deck.pptx", record.MediaType, 4, "/files/"+record.ID, "owner-a", record.ObjectPath, record.CreatedAt,
		),
	)
	loaded, ok, err := store.Get(record.ID)
	if err != nil || !ok {
		t.Fatalf("get failed: ok=%v err=%v", ok, err)
	}
	content, err := store.Read(loaded)
	if err != nil || string(content) != "pptx" {
		t.Fatalf("unexpected object: %s %v", content, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresFileMigrationMarker(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := &PostgresFileStore{db: db}
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT value FROM files_migration_meta").WillReturnRows(sqlmock.NewRows([]string{"value"}))
	mock.ExpectExec("INSERT INTO files_migration_meta").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()
	if err := store.MigrateJSON(context.Background(), t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresPublishDeletesObjectWhenMetadataFails(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	objects := &memoryObjects{values: map[string][]byte{}}
	store := &PostgresFileStore{db: db, objects: objects}
	mock.ExpectExec("INSERT INTO deck_files").WillReturnError(errors.New("insert failed"))
	if _, err := store.Publish("deck-a", "deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "owner-a", []byte("pptx")); err == nil {
		t.Fatal("expected metadata failure")
	}
	if len(objects.values) != 0 {
		t.Fatalf("orphan object was not deleted: %#v", objects.values)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresFileMigrationBackfillsCreatedAt(t *testing.T) {
	directory := t.TempDir()
	objectPath := filepath.Join(directory, "legacy-object")
	if err := os.WriteFile(objectPath, []byte("legacy"), 0o600); err != nil {
		t.Fatal(err)
	}
	records, _ := json.Marshal([]Record{{
		ID: "file-legacy", DeckID: "deck-a", Name: "legacy.pptx", MediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		SizeBytes: 6, DownloadURL: "/files/file-legacy", OwnerKeyHash: "owner-a", ObjectPath: objectPath,
	}})
	if err := os.WriteFile(filepath.Join(directory, "files.json"), records, 0o600); err != nil {
		t.Fatal(err)
	}
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	objects := &memoryObjects{values: map[string][]byte{}}
	store := &PostgresFileStore{db: db, objects: objects}
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT value FROM files_migration_meta").WillReturnRows(sqlmock.NewRows([]string{"value"}))
	mock.ExpectExec("INSERT INTO deck_files").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("INSERT INTO files_migration_meta").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()
	if err := store.MigrateJSON(context.Background(), directory); err != nil {
		t.Fatal(err)
	}
	if string(objects.values["exports/file-legacy"]) != "legacy" {
		t.Fatalf("legacy object was not migrated: %#v", objects.values)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

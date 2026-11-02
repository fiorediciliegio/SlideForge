package billing

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestPostgresCheckAndChargeUseTransactionsAndIdempotency(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := &PostgresStore{db: db}
	key := "sk-postgres-test"
	hash := HashAPIKey(key)
	mock.ExpectQuery("SELECT balance FROM billing_api_keys").WithArgs(hash).WillReturnRows(sqlmock.NewRows([]string{"balance"}).AddRow(100))
	if ok, _, err := store.Check(key); err != nil || !ok {
		t.Fatalf("check failed: ok=%v err=%v", ok, err)
	}
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT name,balance,key_prefix,charges FROM billing_api_keys").WithArgs(hash).WillReturnRows(
		sqlmock.NewRows([]string{"name", "balance", "key_prefix", "charges"}).AddRow("postgres", 100, "sk-test", `{}`),
	)
	mock.ExpectExec("UPDATE billing_api_keys SET balance").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO billing_ledger").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()
	receipt, err := store.Charge(key, "deck-a", "operation-a", 10)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Balance != 90 {
		t.Fatalf("unexpected balance: %#v", receipt)
	}
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT name,balance,key_prefix,charges FROM billing_api_keys").WithArgs(hash).WillReturnRows(
		sqlmock.NewRows([]string{"name", "balance", "key_prefix", "charges"}).AddRow(
			"postgres", 90, "sk-test", `{"operation-a":{"points":10,"balance":90}}`,
		),
	)
	mock.ExpectRollback()
	repeated, err := store.Charge(key, "deck-a", "operation-a", 10)
	if err != nil {
		t.Fatal(err)
	}
	if repeated != receipt {
		t.Fatalf("idempotent receipt changed: %#v", repeated)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresMigrationMarkerIsCommittedOnce(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := &PostgresStore{db: db}
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT value FROM billing_migration_meta").WillReturnRows(sqlmock.NewRows([]string{"value"}))
	mock.ExpectExec("INSERT INTO billing_migration_meta").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()
	if err := store.MigrateJSON(context.Background(), t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

package billing

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

type PostgresStore struct {
	db *sql.DB
}

const billingSchema = `
CREATE TABLE IF NOT EXISTS billing_api_keys (
  key_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  balance DOUBLE PRECISION NOT NULL,
  key_prefix TEXT NOT NULL DEFAULT '',
  charges JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS billing_ledger (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL,
  deck_id TEXT NOT NULL,
  key_name TEXT NOT NULL,
  key_hash TEXT NOT NULL DEFAULT '',
  operation_id TEXT NOT NULL DEFAULT '',
  prompt_tokens DOUBLE PRECISION NOT NULL DEFAULT 0,
  completion_tokens DOUBLE PRECISION NOT NULL DEFAULT 0,
  points DOUBLE PRECISION NOT NULL,
  balance DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_ledger_key_idx ON billing_ledger(key_hash, ts DESC);
CREATE TABLE IF NOT EXISTS billing_migration_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

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
	if _, err := connection.ExecContext(ctx, billingSchema); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &PostgresStore{db: db}, nil
}

func (s *PostgresStore) Close() error { return s.db.Close() }

func (s *PostgresStore) Check(apiKey string) (bool, string, error) {
	if apiKey == "" {
		return false, "missing X-API-Key", nil
	}
	var balance float64
	err := s.db.QueryRow("SELECT balance FROM billing_api_keys WHERE key_hash=$1", HashAPIKey(apiKey)).Scan(&balance)
	if errors.Is(err, sql.ErrNoRows) {
		return false, "invalid api key", nil
	}
	if err != nil {
		return false, "", err
	}
	if balance <= 0 {
		return false, "点数余额不足，请充值", nil
	}
	return true, "", nil
}

func (s *PostgresStore) Issue(name string, points float64) (string, float64, error) {
	if points < 0 {
		return "", 0, errors.New("points 必须为非负数字")
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", 0, err
	}
	key := "sk-" + hex.EncodeToString(random)
	_, err := s.db.Exec(
		"INSERT INTO billing_api_keys(key_hash,name,balance,key_prefix) VALUES($1,$2,$3,$4)",
		HashAPIKey(key), name, points, key[:12],
	)
	return key, points, err
}

func (s *PostgresStore) Recharge(keyOrHash string, points float64) (float64, error) {
	if points <= 0 {
		return 0, errors.New("points 必须为正数字")
	}
	identity := keyOrHash
	if strings.HasPrefix(identity, "sk-") {
		identity = HashAPIKey(identity)
	}
	var balance float64
	err := s.db.QueryRow(
		"UPDATE billing_api_keys SET balance=balance+$2 WHERE key_hash=$1 RETURNING balance",
		identity, points,
	).Scan(&balance)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, errors.New("key 不存在")
	}
	return balance, err
}

func (s *PostgresStore) List() ([]KeyDTO, error) {
	rows, err := s.db.Query("SELECT key_hash,name,balance,key_prefix FROM billing_api_keys ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []KeyDTO{}
	for rows.Next() {
		var item KeyDTO
		if err := rows.Scan(&item.Key, &item.Name, &item.Balance, &item.KeyPrefix); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *PostgresStore) Settle(apiKey, deckID string, promptTokens, completionTokens, inputPerK, outputPerK float64) (ChargeReceipt, error) {
	points := math.Max(1, math.Ceil((promptTokens/1000)*inputPerK+(completionTokens/1000)*outputPerK))
	tx, err := s.db.Begin()
	if err != nil {
		return ChargeReceipt{}, err
	}
	defer tx.Rollback()
	record, err := lockRecord(tx, HashAPIKey(apiKey))
	if errors.Is(err, sql.ErrNoRows) {
		return ChargeReceipt{}, nil
	}
	if err != nil {
		return ChargeReceipt{}, err
	}
	record.Balance = math.Max(0, record.Balance-points)
	receipt := ChargeReceipt{Points: points, Balance: record.Balance}
	if err := saveRecord(tx, HashAPIKey(apiKey), record); err != nil {
		return ChargeReceipt{}, err
	}
	if err := appendPostgresLedger(tx, LedgerEntry{
		Timestamp: time.Now().UTC().Format(time.RFC3339), Type: "deck", DeckID: deckID,
		KeyName: record.Name, KeyHash: HashAPIKey(apiKey), PromptTokens: promptTokens,
		CompletionTokens: completionTokens, Points: points, Balance: record.Balance,
	}); err != nil {
		return ChargeReceipt{}, err
	}
	return receipt, tx.Commit()
}

func (s *PostgresStore) Charge(apiKey, deckID, operationID string, points float64) (ChargeReceipt, error) {
	return s.chargeIdentity(HashAPIKey(apiKey), deckID, operationID, points, false)
}
func (s *PostgresStore) ChargeOwner(ownerHash, deckID, operationID string, points float64) (ChargeReceipt, error) {
	return s.chargeIdentity(ownerHash, deckID, operationID, points, true)
}
func (s *PostgresStore) chargeIdentity(identity, deckID, operationID string, points float64, requireOwner bool) (ChargeReceipt, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return ChargeReceipt{}, err
	}
	defer tx.Rollback()
	record, err := lockRecord(tx, identity)
	if errors.Is(err, sql.ErrNoRows) {
		if requireOwner {
			return ChargeReceipt{}, errors.New("导出归属用户不存在")
		}
		return ChargeReceipt{}, nil
	}
	if err != nil {
		return ChargeReceipt{}, err
	}
	if operationID != "" && record.Charges != nil {
		if existing, ok := record.Charges[operationID]; ok {
			return existing, nil
		}
	}
	if requireOwner && record.Balance < points {
		return ChargeReceipt{}, errors.New("导出点数不足")
	}
	record.Balance = math.Max(0, record.Balance-points)
	receipt := ChargeReceipt{Points: points, Balance: record.Balance}
	if operationID != "" {
		if record.Charges == nil {
			record.Charges = map[string]ChargeReceipt{}
		}
		record.Charges[operationID] = receipt

	}
	if err := saveRecord(tx, identity, record); err != nil {
		return ChargeReceipt{}, err
	}
	if err := appendPostgresLedger(tx, LedgerEntry{
		Timestamp: time.Now().UTC().Format(time.RFC3339), Type: "export", DeckID: deckID,
		KeyName: record.Name, KeyHash: identity, OperationID: operationID,
		Points: points, Balance: record.Balance,
	}); err != nil {
		return ChargeReceipt{}, err
	}
	return receipt, tx.Commit()
}

func (s *PostgresStore) Usage(apiKey string) (*Usage, error) {
	identity := HashAPIKey(apiKey)
	var record KeyRecord
	err := s.db.QueryRow("SELECT name,balance FROM billing_api_keys WHERE key_hash=$1", identity).Scan(&record.Name, &record.Balance)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	ledger, err := s.Ledger(500)
	if err != nil {
		return nil, err
	}
	entries := []LedgerEntry{}
	for _, entry := range ledger.Entries {
		if entry.KeyHash == identity || (entry.KeyHash == "" && entry.KeyName == record.Name) {
			entries = append(entries, entry)
			if len(entries) == 50 {
				break
			}
		}
	}
	return &Usage{Name: record.Name, Balance: record.Balance, Entries: entries}, nil
}

func (s *PostgresStore) Ledger(limit int) (LedgerResult, error) {
	if limit <= 0 {
		limit = 50
	}
	result := LedgerResult{Entries: []LedgerEntry{}}
	rows, err := s.db.Query(`
		SELECT ts,type,deck_id,key_name,key_hash,operation_id,prompt_tokens,completion_tokens,points,balance
		FROM billing_ledger ORDER BY ts DESC, id DESC LIMIT $1`, limit)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var entry LedgerEntry
		var timestamp time.Time
		if err := rows.Scan(
			&timestamp, &entry.Type, &entry.DeckID, &entry.KeyName, &entry.KeyHash,
			&entry.OperationID, &entry.PromptTokens, &entry.CompletionTokens, &entry.Points, &entry.Balance,
		); err != nil {
			return result, err
		}
		entry.Timestamp = timestamp.UTC().Format(time.RFC3339)
		result.Entries = append(result.Entries, entry)
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	err = s.db.QueryRow("SELECT COALESCE(SUM(points),0),COALESCE(SUM(prompt_tokens+completion_tokens),0) FROM billing_ledger").Scan(&result.TotalPoints, &result.TotalTokens)
	return result, err
}

type sqlExecutor interface {
	Exec(query string, args ...any) (sql.Result, error)
	QueryRow(query string, args ...any) *sql.Row
}

func lockRecord(tx *sql.Tx, identity string) (KeyRecord, error) {
	var record KeyRecord
	var charges []byte
	err := tx.QueryRow("SELECT name,balance,key_prefix,charges FROM billing_api_keys WHERE key_hash=$1 FOR UPDATE", identity).Scan(
		&record.Name, &record.Balance, &record.KeyPrefix, &charges,
	)
	if err != nil {
		return record, err
	}
	if err := json.Unmarshal(charges, &record.Charges); err != nil {
		return record, err
	}
	return record, nil
}

func saveRecord(tx *sql.Tx, identity string, record KeyRecord) error {
	if record.Charges == nil {
		record.Charges = map[string]ChargeReceipt{}
	}
	charges, err := json.Marshal(record.Charges)
	if err != nil {
		return err
	}
	_, err = tx.Exec("UPDATE billing_api_keys SET balance=$2,charges=$3 WHERE key_hash=$1", identity, record.Balance, charges)
	return err
}

func appendPostgresLedger(tx *sql.Tx, entry LedgerEntry) error {
	_, err := tx.Exec(`
		INSERT INTO billing_ledger(ts,type,deck_id,key_name,key_hash,operation_id,prompt_tokens,completion_tokens,points,balance)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		entry.Timestamp, entry.Type, entry.DeckID, entry.KeyName, entry.KeyHash, entry.OperationID,
		entry.PromptTokens, entry.CompletionTokens, entry.Points, entry.Balance,
	)
	return err
}

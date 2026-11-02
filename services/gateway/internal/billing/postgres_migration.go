package billing

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func (s *PostgresStore) MigrateJSON(ctx context.Context, dataDir string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var migrated string
	err = tx.QueryRowContext(ctx, "SELECT value FROM billing_migration_meta WHERE key='json_v1'").Scan(&migrated)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	data, err := os.ReadFile(filepath.Join(dataDir, "api-keys.json"))
	if errors.Is(err, os.ErrNotExist) {
		_, err = tx.ExecContext(ctx, "INSERT INTO billing_migration_meta(key,value) VALUES('json_v1','empty') ON CONFLICT DO NOTHING")
		if err != nil {
			return err
		}
		return tx.Commit()
	}
	if err != nil {
		return err
	}
	var raw map[string]KeyRecord
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	for identity, record := range raw {
		if strings.HasPrefix(identity, "sk-") {
			if record.KeyPrefix == "" {
				record.KeyPrefix = identity[:12]
			}
			identity = HashAPIKey(identity)
		}
		charges, err := json.Marshal(record.Charges)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO billing_api_keys(key_hash,name,balance,key_prefix,charges) VALUES($1,$2,$3,$4,$5)
			ON CONFLICT(key_hash) DO NOTHING`, identity, record.Name, record.Balance, record.KeyPrefix, charges); err != nil {
			return err
		}
	}
	ledgerFile, err := os.Open(filepath.Join(dataDir, "billing", "ledger.jsonl"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		defer ledgerFile.Close()
		scanner := bufio.NewScanner(ledgerFile)
		scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
		for scanner.Scan() {
			var entry LedgerEntry
			if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
				return err
			}
			if err := appendPostgresLedger(tx, entry); err != nil {
				return err
			}
		}
		if err := scanner.Err(); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO billing_migration_meta(key,value) VALUES('json_v1','done')"); err != nil {
		return err
	}
	return tx.Commit()
}

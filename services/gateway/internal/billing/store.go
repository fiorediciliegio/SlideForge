package billing

import (
	"bufio"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type ChargeReceipt struct {
	Points  float64 `json:"points"`
	Balance float64 `json:"balance"`
}

type KeyRecord struct {
	Name      string                   `json:"name"`
	Balance   float64                  `json:"balance"`
	KeyPrefix string                   `json:"key_prefix,omitempty"`
	Charges   map[string]ChargeReceipt `json:"charges,omitempty"`
}

type KeyDTO struct {
	Key       string  `json:"key"`
	KeyPrefix string  `json:"key_prefix"`
	Name      string  `json:"name"`
	Balance   float64 `json:"balance"`
}

type LedgerEntry struct {
	Timestamp        string  `json:"ts"`
	Type             string  `json:"type"`
	DeckID           string  `json:"deck_id"`
	KeyName          string  `json:"key_name"`
	KeyHash          string  `json:"key_hash,omitempty"`
	OperationID      string  `json:"operation_id,omitempty"`
	PromptTokens     float64 `json:"prompt_tokens,omitempty"`
	CompletionTokens float64 `json:"completion_tokens,omitempty"`
	Points           float64 `json:"points"`
	Balance          float64 `json:"balance"`
}

type LedgerResult struct {
	Entries     []LedgerEntry `json:"entries"`
	TotalPoints float64       `json:"totalPoints"`
	TotalTokens float64       `json:"totalTokens"`
}

type Usage struct {
	Name    string        `json:"name"`
	Balance float64       `json:"balance"`
	Entries []LedgerEntry `json:"entries"`
}

type StoreAPI interface {
	Check(apiKey string) (bool, string, error)
	Issue(name string, points float64) (string, float64, error)
	Recharge(keyOrHash string, points float64) (float64, error)
	List() ([]KeyDTO, error)
	Settle(apiKey, deckID string, promptTokens, completionTokens, inputPerK, outputPerK float64) (ChargeReceipt, error)
	Charge(apiKey, deckID, operationID string, points float64) (ChargeReceipt, error)
	Usage(apiKey string) (*Usage, error)
	Ledger(limit int) (LedgerResult, error)
}

type Store struct {
	dataDir string
	mu      sync.Mutex
}

func NewStore(dataDir string) *Store {
	return &Store{dataDir: dataDir}
}

func HashAPIKey(apiKey string) string {
	sum := sha256.Sum256([]byte(apiKey))
	return hex.EncodeToString(sum[:])
}

func (s *Store) Check(apiKey string) (bool, string, error) {
	if apiKey == "" {
		return false, "missing X-API-Key", nil
	}
	keys, _, err := s.load()
	if err != nil {
		return false, "", err
	}
	record, ok := keys[HashAPIKey(apiKey)]
	if !ok {
		return false, "invalid api key", nil
	}
	if record.Balance <= 0 {
		return false, "点数余额不足，请充值", nil
	}
	return true, "", nil
}

func (s *Store) Issue(name string, points float64) (string, float64, error) {
	if points < 0 {
		return "", 0, errors.New("points 必须为非负数字")
	}
	var key string
	_, err := s.update(func(keys map[string]KeyRecord) error {
		random := make([]byte, 16)
		if _, err := rand.Read(random); err != nil {
			return err
		}
		key = "sk-" + hex.EncodeToString(random)
		keys[HashAPIKey(key)] = KeyRecord{Name: name, Balance: points, KeyPrefix: key[:12]}
		return nil
	})
	return key, points, err
}

func (s *Store) Recharge(keyOrHash string, points float64) (float64, error) {
	if points <= 0 {
		return 0, errors.New("points 必须为正数字")
	}
	identity := keyOrHash
	if strings.HasPrefix(identity, "sk-") {
		identity = HashAPIKey(identity)
	}
	var balance float64
	_, err := s.update(func(keys map[string]KeyRecord) error {
		record, ok := keys[identity]
		if !ok {
			return errors.New("key 不存在")
		}
		record.Balance += points
		keys[identity] = record
		balance = record.Balance
		return nil
	})
	return balance, err
}

func (s *Store) List() ([]KeyDTO, error) {
	keys, _, err := s.load()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []KeyDTO{}, nil
		}
		return nil, err
	}
	result := make([]KeyDTO, 0, len(keys))
	for hash, record := range keys {
		prefix := record.KeyPrefix
		if prefix == "" {
			prefix = "sha256:" + hash[:8]
		}
		result = append(result, KeyDTO{Key: hash, KeyPrefix: prefix, Name: record.Name, Balance: record.Balance})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func (s *Store) Settle(apiKey, deckID string, promptTokens, completionTokens, inputPerK, outputPerK float64) (ChargeReceipt, error) {
	points := (promptTokens/1000)*inputPerK + (completionTokens/1000)*outputPerK
	if points < 1 {
		points = 1
	} else if points != float64(int64(points)) {
		points = float64(int64(points) + 1)
	}
	var receipt ChargeReceipt
	_, err := s.update(func(keys map[string]KeyRecord) error {
		identity := HashAPIKey(apiKey)
		record, ok := keys[identity]
		if !ok {
			receipt = ChargeReceipt{}
			return nil
		}
		record.Balance = max(0, record.Balance-points)
		keys[identity] = record
		receipt = ChargeReceipt{Points: points, Balance: record.Balance}
		return s.appendLedger(LedgerEntry{
			Timestamp: time.Now().UTC().Format(time.RFC3339), Type: "deck", DeckID: deckID,
			KeyName: record.Name, KeyHash: identity, PromptTokens: promptTokens,
			CompletionTokens: completionTokens, Points: points, Balance: record.Balance,
		})
	})
	return receipt, err
}

func (s *Store) Charge(apiKey, deckID, operationID string, points float64) (ChargeReceipt, error) {
	var receipt ChargeReceipt
	_, err := s.update(func(keys map[string]KeyRecord) error {
		identity := HashAPIKey(apiKey)
		record, ok := keys[identity]
		if !ok {
			receipt = ChargeReceipt{}
			return nil
		}
		if operationID != "" && record.Charges != nil {
			if existing, ok := record.Charges[operationID]; ok {
				receipt = existing
				return nil
			}
		}
		record.Balance = max(0, record.Balance-points)
		receipt = ChargeReceipt{Points: points, Balance: record.Balance}
		if operationID != "" {
			if record.Charges == nil {
				record.Charges = map[string]ChargeReceipt{}
			}
			record.Charges[operationID] = receipt
			if len(record.Charges) > 100 {
				keysToDelete := make([]string, 0, len(record.Charges))
				for key := range record.Charges {
					keysToDelete = append(keysToDelete, key)
				}
				sort.Strings(keysToDelete)
				for _, key := range keysToDelete[:len(keysToDelete)-100] {
					delete(record.Charges, key)
				}
			}
		}
		keys[identity] = record
		return s.appendLedger(LedgerEntry{
			Timestamp: time.Now().UTC().Format(time.RFC3339), Type: "export", DeckID: deckID,
			KeyName: record.Name, KeyHash: identity, OperationID: operationID,
			Points: points, Balance: record.Balance,
		})
	})
	return receipt, err
}

func (s *Store) Usage(apiKey string) (*Usage, error) {
	keys, _, err := s.load()
	if err != nil {
		return nil, err
	}
	identity := HashAPIKey(apiKey)
	record, ok := keys[identity]
	if !ok {
		return nil, nil
	}
	ledger, err := s.Ledger(500)
	if err != nil {
		return nil, err
	}
	entries := make([]LedgerEntry, 0, 50)
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

func (s *Store) Ledger(limit int) (LedgerResult, error) {
	result := LedgerResult{Entries: []LedgerEntry{}}
	file, err := os.Open(filepath.Join(s.dataDir, "billing", "ledger.jsonl"))
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	defer file.Close()
	all := make([]LedgerEntry, 0)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var entry LedgerEntry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			return result, err
		}
		all = append(all, entry)
		result.TotalPoints += entry.Points
		result.TotalTokens += entry.PromptTokens + entry.CompletionTokens
	}
	if err := scanner.Err(); err != nil {
		return result, err
	}
	if limit <= 0 {
		limit = 50
	}
	for index := len(all) - 1; index >= 0 && len(result.Entries) < limit; index-- {
		result.Entries = append(result.Entries, all[index])
	}
	return result, nil
}

func (s *Store) load() (map[string]KeyRecord, bool, error) {
	data, err := os.ReadFile(filepath.Join(s.dataDir, "api-keys.json"))
	if err != nil {
		return nil, false, err
	}
	var raw map[string]KeyRecord
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, false, err
	}
	keys := make(map[string]KeyRecord, len(raw))
	migrated := false
	for identity, record := range raw {
		if strings.HasPrefix(identity, "sk-") {
			if record.KeyPrefix == "" {
				record.KeyPrefix = identity[:12]
			}
			identity = HashAPIKey(identity)
			migrated = true
		}
		keys[identity] = record
	}
	if migrated {
		if err := s.save(keys); err != nil {
			return nil, false, err
		}
	}
	return keys, migrated, nil
}

func (s *Store) update(operation func(map[string]KeyRecord) error) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys, _, err := s.load()
	if errors.Is(err, os.ErrNotExist) {
		keys = map[string]KeyRecord{}
	} else if err != nil {
		return false, err
	}
	if err := operation(keys); err != nil {
		return false, err
	}
	return true, s.save(keys)
}

func (s *Store) save(keys map[string]KeyRecord) error {
	if err := os.MkdirAll(s.dataDir, 0o750); err != nil {
		return err
	}
	data, err := json.MarshalIndent(keys, "", "  ")
	if err != nil {
		return err
	}
	temporary := filepath.Join(s.dataDir, fmt.Sprintf("api-keys.%d.tmp", time.Now().UnixNano()))
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	file := filepath.Join(s.dataDir, "api-keys.json")
	if err := os.Rename(temporary, file); err != nil {
		if removeErr := os.Remove(file); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return err
		}
		if retryErr := os.Rename(temporary, file); retryErr != nil {
			return retryErr
		}
	}
	return nil
}

func (s *Store) appendLedger(entry LedgerEntry) error {
	directory := filepath.Join(s.dataDir, "billing")
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return err
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(directory, "ledger.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(append(data, '\n'))
	return err
}

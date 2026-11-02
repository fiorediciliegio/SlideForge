package billing

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestStoreOwnsHashedKeysBillingAndIdempotency(t *testing.T) {
	store := NewStore(t.TempDir())
	key, _, err := store.Issue("remote-user", 100)
	if err != nil {
		t.Fatal(err)
	}
	if ok, _, err := store.Check(key); err != nil || !ok {
		t.Fatalf("raw key should be valid: ok=%v err=%v", ok, err)
	}
	if ok, _, _ := store.Check(HashAPIKey(key)); ok {
		t.Fatal("stored hash must not act as a bearer credential")
	}
	var wait sync.WaitGroup
	for index := 0; index < 5; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if _, err := store.Charge(key, "deck-a", "", 2); err != nil {
				t.Error(err)
			}
		}()
	}
	wait.Wait()
	first, err := store.Charge(key, "deck-a", "operation-a", 10)
	if err != nil {
		t.Fatal(err)
	}
	repeated, err := store.Charge(key, "deck-a", "operation-a", 10)
	if err != nil {
		t.Fatal(err)
	}
	if first != repeated || repeated.Balance != 80 {
		t.Fatalf("unexpected receipts: first=%#v repeated=%#v", first, repeated)
	}
	data, err := os.ReadFile(filepath.Join(store.dataDir, "api-keys.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), key) {
		t.Fatal("plaintext key leaked into storage")
	}
	ledger, err := store.Ledger(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(ledger.Entries) != 6 || ledger.TotalPoints != 20 {
		t.Fatalf("unexpected ledger: %#v", ledger)
	}
}

func TestStoreMigratesLegacyPlaintextKeys(t *testing.T) {
	directory := t.TempDir()
	legacy := "sk-legacy-key"
	if err := os.WriteFile(filepath.Join(directory, "api-keys.json"), []byte(`{"`+legacy+`":{"name":"legacy","balance":88}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(directory)
	if ok, _, err := store.Check(legacy); err != nil || !ok {
		t.Fatalf("legacy key should remain valid: ok=%v err=%v", ok, err)
	}
	data, err := os.ReadFile(filepath.Join(directory, "api-keys.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), legacy) || !strings.Contains(string(data), HashAPIKey(legacy)) {
		t.Fatalf("legacy key was not migrated: %s", data)
	}
}

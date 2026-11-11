package billing

import "testing"

func TestAgentExportChargesOwnerWithoutPersistingBearerKey(t *testing.T) {
	store := NewStore(t.TempDir())
	key, _, err := store.Issue("agent", 100)
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.ChargeOwner(HashAPIKey(key), "deck-a", "agent-export-a", 10)
	if err != nil {
		t.Fatal(err)
	}
	repeated, err := store.ChargeOwner(HashAPIKey(key), "deck-a", "agent-export-a", 10)
	if err != nil {
		t.Fatal(err)
	}
	if first.Balance != 90 || first != repeated {
		t.Fatalf("duplicate charge: %+v %+v", first, repeated)
	}
	if _, err = store.ChargeOwner("missing", "deck-a", "missing", 10); err == nil {
		t.Fatal("missing owner falsely succeeded")
	}
	if ok, _, _ := store.Check(HashAPIKey(key)); ok {
		t.Fatal("hash became a bearer key")
	}
}

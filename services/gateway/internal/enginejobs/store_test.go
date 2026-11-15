package enginejobs

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestPersistedJSONParameterOrderDoesNotChangeIdentity(t *testing.T) {
	a := Request{Owner: "a", DeckID: "deck-a", SourceHash: "fixed", Kind: "inspect", Params: json.RawMessage(`{"layout":true,"pages":[1],"visual":true}`)}
	b := a
	b.Params = json.RawMessage(`{ "pages": [1], "visual": true, "layout": true }`)
	if identity(a) != identity(b) {
		t.Fatal("JSONB serialization changed task identity")
	}
}

func TestMixedOwnersCannotStarveOneOwnersExport(t *testing.T) {
	s, _ := NewStore(t.TempDir())
	for _, owner := range []string{"a", "b", "c"} {
		for index := 0; index < 10; index++ {
			artifact, _ := s.PutArtifact(owner, "deck-test", "application/json", []byte(fmt.Sprintf(`{"page":%d}`, index)))
			_, err := s.Submit(Request{Owner: owner, DeckID: "deck-test", SnapshotID: artifact.ID, SourceHash: artifact.SHA256, Kind: "validate", OperationID: fmt.Sprint(index), Profile: "html-v1"})
			if err != nil {
				t.Fatal(err)
			}
		}
		submitTest(t, s, owner, "export", "export")
	}
	seen := map[string]bool{}
	for index := 0; index < 9; index++ {
		job, err := s.Claim("worker")
		if err != nil {
			t.Fatal(err)
		}
		if job.Kind == "export" {
			seen[job.Owner] = true
		}
	}
	if len(seen) != 3 {
		t.Fatalf("an owner's export was starved: %v", seen)
	}
}

func submitTest(t *testing.T, s *Store, owner, op, kind string) Job {
	t.Helper()
	a, err := s.PutArtifact(owner, "deck-test", "application/json", []byte(`{"schema_version":1}`))
	if err != nil {
		t.Fatal(err)
	}
	j, err := s.Submit(Request{Owner: owner, DeckID: "deck-test", SnapshotID: a.ID, SourceHash: a.SHA256, Kind: kind, OperationID: op, Profile: "html-v1"})
	if err != nil {
		t.Fatal(err)
	}
	return j
}
func TestDurableDedupAndFencedRecovery(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	s.now = func() time.Time { return now }
	first := submitTest(t, s, "owner-a", "op-a", "validate")
	if next := submitTest(t, s, "owner-a", "op-b", "validate"); next.ID != first.ID {
		t.Fatal("active task not reused")
	}
	restarted, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	restarted.now = s.now
	running, err := restarted.Claim("worker-a")
	if err != nil || running == nil || running.Attempt != 1 {
		t.Fatalf("claim: %+v %v", running, err)
	}
	now = now.Add(31 * time.Second)
	recovered, err := restarted.Claim("worker-b")
	if err != nil || recovered == nil || recovered.Attempt != 2 {
		t.Fatalf("recovery: %+v %v", recovered, err)
	}
	if _, err := restarted.Update(first.ID, running.LeaseToken, "complete", "", ""); err == nil {
		t.Fatal("stale worker accepted")
	}
	now = now.Add(31 * time.Second)
	if j, err := restarted.Claim("worker-c"); err != nil || j != nil {
		t.Fatalf("third attempt: %+v %v", j, err)
	}
	failed, _ := restarted.Get(first.ID)
	if failed.State != "failed" {
		t.Fatal(failed.State)
	}
	replay := submitTest(t, restarted, "owner-a", "op-a", "validate")
	if replay.State != "failed" {
		t.Fatal("replay reset attempt")
	}
	fresh := submitTest(t, restarted, "owner-a", "op-c", "validate")
	if fresh.ID == first.ID {
		t.Fatal("explicit retry not created")
	}
}
func TestFairOwnersCancellationAndPrivateArtifacts(t *testing.T) {
	s, _ := NewStore(t.TempDir())
	a := submitTest(t, s, "a", "1", "validate")
	submitTest(t, s, "a", "2", "export")
	b := submitTest(t, s, "b", "3", "validate")
	j, _ := s.Claim("one")
	if j.ID != a.ID {
		t.Fatal("FIFO start")
	}
	next, _ := s.Claim("two")
	if next.ID != b.ID {
		t.Fatal("owner rotation")
	}
	if _, err := s.ReadArtifact(a.SnapshotID, "b"); err == nil {
		t.Fatal("cross owner read")
	}
	cancelled, err := s.Cancel(j.ID, "a")
	if err != nil || cancelled.State != "cancelled" {
		t.Fatal(err)
	}
	if _, err := s.Update(j.ID, j.LeaseToken, "complete", "", ""); err == nil {
		t.Fatal("cancelled worker published")
	}
}

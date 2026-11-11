package jobs

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAgentReservationFailureExplainsRemainingAndNextCost(t *testing.T) {
	run := NewAgentRun(json.RawMessage(`{"version":1}`), 600, 2)
	run.Budget.ActiveSeconds = 220
	run.Budget.SpentCNY = 0.951346
	err := mutateBudget(run, AgentCommand{Action: "reserve_call", CallID: "vision", InputHash: "images", Cost: 1.624192})
	if err == nil || !strings.Contains(err.Error(), "1.0487") || !strings.Contains(err.Error(), "1.6242") {
		t.Fatalf("missing remaining and required reserve: %v", err)
	}
	if run.Budget.ReservedCNY != 0 || len(run.Calls) != 0 {
		t.Fatal("rejected reservation changed the ledger")
	}
}

func agentFixture(t *testing.T) *Store {
	t.Helper()
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Create(Job{ID: "deck-agent", Status: "creating", Agent: NewAgentRun(json.RawMessage(`{"version":1}`), 600, 2)}); err != nil {
		t.Fatal(err)
	}
	return s
}
func TestAgentConcurrentBudgetReservationsShareOneLimit(t *testing.T) {
	s := agentFixture(t)
	job, err := s.MutateAgent(AgentCommand{Action: "claim", DeckID: "deck-agent", RunSeq: 1})
	if err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	var mutex sync.Mutex
	accepted := 0
	for index := 0; index < 10; index++ {
		group.Add(1)
		go func(id int) {
			defer group.Done()
			_, err := s.MutateAgent(AgentCommand{Action: "reserve_call", DeckID: job.ID, RunSeq: 1, Epoch: job.Agent.Epoch, CallID: fmt.Sprint("call-", id), InputHash: fmt.Sprint(id), Cost: 0.4})
			if err == nil {
				mutex.Lock()
				accepted++
				mutex.Unlock()
			}
		}(index)
	}
	group.Wait()
	current, _ := s.Get(job.ID)
	if accepted != 5 || current.Agent.Budget.ReservedCNY != 2 {
		t.Fatalf("oversubscribed: %d %+v", accepted, current.Agent.Budget)
	}
}
func TestAgentWaitingAndQueuedTimeDoNotConsumeExecutionBudget(t *testing.T) {
	job := Job{Agent: NewAgentRun(json.RawMessage(`{}`), 600, 2)}
	now := time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)
	if err := mutateAgentJob(&job, AgentCommand{Action: "claim", RunSeq: 1}, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := mutateAgentJob(&job, AgentCommand{Action: "transition", RunSeq: 1, Epoch: job.Agent.Epoch, ExpectedCheckpoint: job.Agent.Checkpoint, Phase: "waiting_user"}, now.Add(time.Hour+10*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := mutateAgentJob(&job, AgentCommand{Action: "continue", RunSeq: 1, ExpectedCheckpoint: job.Agent.Checkpoint}, now.Add(3*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := mutateAgentJob(&job, AgentCommand{Action: "claim", RunSeq: 1, Epoch: job.Agent.Epoch, ExpectedCheckpoint: job.Agent.Checkpoint}, now.Add(4*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if job.Agent.Budget.ActiveSeconds != 10 {
		t.Fatalf("waiting time charged: %+v", job.Agent.Budget)
	}
}
func TestAgentPersistenceFailureKeepsPriorSnapshotAndMemory(t *testing.T) {
	s := agentFixture(t)
	before, err := os.ReadFile(s.file)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(s.file+".tmp", 0700); err != nil {
		t.Fatal(err)
	}
	if _, err = s.MutateAgent(AgentCommand{Action: "claim", DeckID: "deck-agent", RunSeq: 1}); err == nil {
		t.Fatal("write failure was hidden")
	}
	after, err := os.ReadFile(s.file)
	if err != nil {
		t.Fatal(err)
	}
	job, _ := s.Get("deck-agent")
	if string(before) != string(after) || job.Agent.Phase != "queued" {
		t.Fatal("failed commit replaced old state")
	}
}

func TestAgentClaimFencesDuplicateAndCancelledWrites(t *testing.T) {
	s := agentFixture(t)
	cmd := AgentCommand{Action: "claim", DeckID: "deck-agent", RunSeq: 1, ExpectedCheckpoint: 0, InstanceID: "brain-a"}
	job, err := s.MutateAgent(cmd)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.MutateAgent(cmd); err == nil {
		t.Fatal("duplicate claim succeeded")
	}
	if _, _, err = s.Cancel("deck-agent"); err != nil {
		t.Fatal(err)
	}
	_, err = s.MutateAgent(AgentCommand{Action: "transition", DeckID: "deck-agent", RunSeq: 1, Epoch: job.Agent.Epoch, ExpectedCheckpoint: job.Agent.Checkpoint, Phase: "completed"})
	if err == nil {
		t.Fatal("cancelled execution accepted a late completion")
	}
}

func TestAgentBudgetReservationsAndSettlementAreDurable(t *testing.T) {
	s := agentFixture(t)
	job, err := s.MutateAgent(AgentCommand{Action: "claim", DeckID: "deck-agent", RunSeq: 1, InstanceID: "brain-a"})
	if err != nil {
		t.Fatal(err)
	}
	cmd := AgentCommand{Action: "reserve_call", DeckID: job.ID, RunSeq: 1, Epoch: job.Agent.Epoch, CallID: "call-a", InputHash: "a", Cost: 1.5}
	if _, err = s.MutateAgent(cmd); err != nil {
		t.Fatal(err)
	}
	cmd.CallID = "call-b"
	cmd.InputHash = "b"
	cmd.Cost = 0.6
	if _, err = s.MutateAgent(cmd); err == nil {
		t.Fatal("budget over-reserved")
	}
	cmd.Action = "settle_call"
	cmd.CallID = "call-a"
	cmd.InputHash = "a"
	cmd.Cost = 0.4
	cmd.ResponseRef = "responses/call-a.json"
	if _, err = s.MutateAgent(cmd); err != nil {
		t.Fatal(err)
	}
	job, err = s.MutateAgent(cmd)
	if err != nil {
		t.Fatal(err)
	}
	if job.Agent.Budget.SpentCNY != 0.4 || job.Agent.Budget.ReservedCNY != 0 {
		t.Fatalf("duplicate settlement: %+v", job.Agent.Budget)
	}
	saved, err := NewStore(filepath.Dir(s.file))
	if err != nil {
		t.Fatal(err)
	}
	recovered, _ := saved.Get(job.ID)
	if recovered.Agent.Phase != "interrupted" || recovered.Agent.Budget.SpentCNY != 0.4 {
		t.Fatalf("recovery lost state: %+v", recovered.Agent)
	}
}

func TestAgentToolReplayAndParentRevisionCAS(t *testing.T) {
	s := agentFixture(t)
	job, err := s.MutateAgent(AgentCommand{Action: "claim", DeckID: "deck-agent", RunSeq: 1, InstanceID: "brain-a"})
	if err != nil {
		t.Fatal(err)
	}
	cmd := AgentCommand{Action: "begin_tool", DeckID: job.ID, RunSeq: 1, Epoch: job.Agent.Epoch, OperationID: "tool-a", InputHash: "hash-a"}
	if _, err = s.MutateAgent(cmd); err != nil {
		t.Fatal(err)
	}
	cmd.Action = "complete_tool"
	cmd.ProjectRef = json.RawMessage(`{"revision_id":"rev-a"}`)
	cmd.Result = json.RawMessage(`{"ok":true}`)
	if _, err = s.MutateAgent(cmd); err != nil {
		t.Fatal(err)
	}
	job, err = s.MutateAgent(cmd)
	if err != nil {
		t.Fatal(err)
	}
	if len(job.Agent.Operations) != 1 {
		t.Fatal("receipt duplicated")
	}
	cmd.OperationID = "tool-b"
	cmd.Action = "begin_tool"
	cmd.InputHash = "hash-b"
	if _, err = s.MutateAgent(cmd); err != nil {
		t.Fatal(err)
	}
	cmd.Action = "complete_tool"
	cmd.ParentRevision = "stale"
	if _, err = s.MutateAgent(cmd); err == nil {
		t.Fatal("stale revision committed")
	}
}

func TestAgentDraftSaveDoesNotPublishUntilConfirmation(t *testing.T) {
	s := agentFixture(t)
	job, err := s.MutateAgent(AgentCommand{Action: "claim", DeckID: "deck-agent", RunSeq: 1, InstanceID: "brain"})
	if err != nil {
		t.Fatal(err)
	}
	job, err = s.MutateAgent(AgentCommand{Action: "transition", DeckID: job.ID, RunSeq: 1, Epoch: job.Agent.Epoch, ExpectedCheckpoint: job.Agent.Checkpoint, Phase: "waiting_outline"})
	if err != nil {
		t.Fatal(err)
	}
	job, err = s.MutateAgent(AgentCommand{Action: "draft", DeckID: job.ID, RunSeq: 1, ExpectedDraft: 0, DraftRef: "project/drafts/one.json"})
	if err != nil {
		t.Fatal(err)
	}
	if len(job.Agent.ProjectRef) != 0 || job.Agent.DraftRevision != 1 {
		t.Fatal("draft unexpectedly published pages")
	}
	job, err = s.MutateAgent(AgentCommand{Action: "confirm", DeckID: job.ID, RunSeq: 1, ExpectedDraft: 1, ProjectRef: json.RawMessage(`{"revision_id":"confirmed"}`), RunDir: "confirmed-dir"})
	if err != nil {
		t.Fatal(err)
	}
	if revisionOf(job.Agent.ProjectRef) != "confirmed" || job.RunDir != "confirmed-dir" || job.Agent.Phase != "queued" {
		t.Fatal("confirmation did not atomically publish the selected draft")
	}
}

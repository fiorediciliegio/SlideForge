package jobs

import (
	"errors"
	"testing"
	"time"
)

func TestInFlightBudgetWaitDiffersFromExhaustion(t *testing.T) {
	run := NewAgentRun(nil, 600, 2)
	run.Budget.SpentCNY = .8
	run.Budget.ReservedCNY = .8
	run.Calls["active"] = AgentCall{Status: "sent", Cost: .8}
	cmd := AgentCommand{Action: "reserve_call", CallID: "next", InputHash: "next", Cost: .6}
	if err := mutateBudget(run, cmd); !errors.Is(err, ErrBudgetInFlight) {
		t.Fatalf("want inflight, got %v", err)
	}
	if _, ok := run.Calls["next"]; ok {
		t.Fatal("waiting request reserved money")
	}
	if err := mutateBudget(run, AgentCommand{Action: "settle_call", CallID: "active", Cost: .1, ResponseRef: "r"}); err != nil {
		t.Fatal(err)
	}
	if err := mutateBudget(run, cmd); err != nil {
		t.Fatal(err)
	}
	cmd.CallID = "too-expensive"
	cmd.Cost = 1.5
	if err := mutateBudget(run, cmd); !errors.Is(err, ErrBudgetExhausted) {
		t.Fatalf("want exhausted, got %v", err)
	}
}

func TestUnknownAtomicallyBlocksReserveAndSend(t *testing.T) {
	run := NewAgentRun(nil, 600, 2)
	run.Calls["lost"] = AgentCall{Status: "unknown", Cost: .1}
	run.Calls["reserved"] = AgentCall{Status: "reserved", Cost: .1}
	for _, cmd := range []AgentCommand{{Action: "reserve_call", CallID: "new", Cost: .1}, {Action: "send_call", CallID: "reserved"}} {
		if err := mutateBudget(run, cmd); !errors.Is(err, ErrUnknownCall) {
			t.Fatalf("want unknown guard, got %v", err)
		}
	}
	if run.Calls["reserved"].Status != "reserved" {
		t.Fatal("unknown sibling allowed send")
	}
}

func TestReservedCallCannotSendAfterEffectiveTimeExpires(t *testing.T) {
	run := NewAgentRun(nil, 600, 2)
	if err := mutateBudget(run, AgentCommand{Action: "reserve_call", CallID: "waiting", InputHash: "same", Cost: .1}); err != nil {
		t.Fatal(err)
	}
	run.Budget.ActiveSeconds = 600
	if err := mutateBudget(run, AgentCommand{Action: "send_call", CallID: "waiting"}); !errors.Is(err, ErrBudgetExhausted) {
		t.Fatalf("expired reservation sent: %v", err)
	}
	if run.Calls["waiting"].Status != "reserved" {
		t.Fatal("expired call changed status")
	}
}

func TestResourceWaitCountsOnlyActualOverlappingWork(t *testing.T) {
	now := time.Now().UTC()
	run := NewAgentRun(nil, 600, 2)
	run.Phase = "generating"
	run.Epoch = 1
	run.LastActiveAt = now.Format(time.RFC3339Nano)
	job := Job{ID: "deck-work", Agent: run}
	work := func(id, state string) {
		t.Helper()
		if err := mutateAgentJob(&job, AgentCommand{Action: "work_state", RunSeq: 1, Epoch: 1, OperationID: id, WorkState: state}, now); err != nil {
			t.Fatal(err)
		}
	}
	tick := func(seconds int) {
		t.Helper()
		now = now.Add(time.Duration(seconds) * time.Second)
		if err := mutateAgentJob(&job, AgentCommand{Action: "heartbeat", RunSeq: 1, Epoch: 1}, now); err != nil {
			t.Fatal(err)
		}
	}
	work("a", "capacity")
	tick(30)
	if run.Budget.ActiveSeconds != 0 {
		t.Fatal("pure capacity wait counted")
	}
	work("b", "local")
	tick(10)
	if run.Budget.ActiveSeconds != 10 {
		t.Fatal("local work was hidden by waiting sibling")
	}
	work("b", "budget")
	run.Calls["sent"] = AgentCall{Status: "sent"}
	tick(10)
	if run.Budget.ActiveSeconds != 20 {
		t.Fatal("model work was hidden by budget wait")
	}
	delete(run.Calls, "sent")
	work("a", "engine")
	run.EngineWaits = map[string]string{"engine": "queued"}
	tick(20)
	if run.Budget.ActiveSeconds != 20 {
		t.Fatal("mixed pure queues counted")
	}
	run.EngineWaits["engine"] = "running"
	tick(10)
	if run.Budget.ActiveSeconds != 30 {
		t.Fatal("running engine not counted exactly once")
	}
	if err := mutateAgentJob(&job, AgentCommand{Action: "work_state", RunSeq: 1, Epoch: 0, OperationID: "a", WorkState: "local"}, now); err == nil {
		t.Fatal("stale work changed execution")
	}
	if err := mutateAgentJob(&job, AgentCommand{Action: "cancel", RunSeq: 1, Epoch: 1}, now); err != nil {
		t.Fatal(err)
	}
	if len(run.WorkStates) != 0 {
		t.Fatal("cancel retained resource work")
	}
}

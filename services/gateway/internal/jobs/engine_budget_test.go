package jobs

import (
	"testing"
	"time"
)

func TestEngineQueueTimeExcludedAndParallelWorkCountsOnce(t *testing.T) {
	now := time.Now().UTC()
	run := NewAgentRun(nil, 600, 2)
	run.Phase = "checking"
	run.Epoch = 1
	run.LastActiveAt = now.Format(time.RFC3339Nano)
	job := Job{ID: "deck-budget", Agent: run}
	command := AgentCommand{Action: "engine_wait", RunSeq: 1, Epoch: 1, OperationID: "engine-a", EngineState: "queued"}
	if err := mutateAgentJob(&job, command, now); err != nil {
		t.Fatal(err)
	}
	now = now.Add(60 * time.Second)
	if err := mutateAgentJob(&job, AgentCommand{Action: "heartbeat", RunSeq: 1, Epoch: 1}, now); err != nil {
		t.Fatal(err)
	}
	if run.Budget.ActiveSeconds != 0 {
		t.Fatalf("queued work billed: %f", run.Budget.ActiveSeconds)
	}
	command.EngineState = "running"
	mutateAgentJob(&job, command, now)
	run.Calls["model"] = AgentCall{Status: "sent", Cost: 0.1}
	run.Budget.ReservedCNY = 0.1
	now = now.Add(10 * time.Second)
	mutateAgentJob(&job, AgentCommand{Action: "heartbeat", RunSeq: 1, Epoch: 1}, now)
	if run.Budget.ActiveSeconds != 10 {
		t.Fatalf("parallel work counted twice: %f", run.Budget.ActiveSeconds)
	}
	command.EngineState = "done"
	mutateAgentJob(&job, command, now)
	command.Epoch = 0
	if err := mutateAgentJob(&job, command, now); err == nil {
		t.Fatal("stale waiter changed budget")
	}
}

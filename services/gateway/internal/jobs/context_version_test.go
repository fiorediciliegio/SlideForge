package jobs

import (
	"testing"
	"time"
)

func TestContextVersionChangesOnlyAtNewExecution(t *testing.T) {
	run := NewAgentRun(nil, 600, 2)
	if run.ContextVersion != 2 {
		t.Fatal("new execution lacks context v2")
	}
	run.ContextVersion = 0
	run.Phase = "interrupted"
	run.Epoch = 1
	job := Job{ID: "context-old", Agent: run}
	if err := mutateAgentJob(&job, AgentCommand{Action: "continue", RunSeq: 1, Epoch: 1}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if job.Agent.ContextVersion != 0 {
		t.Fatal("continue silently upgraded old history")
	}
	run.Phase = "completed"
	if err := mutateAgentJob(&job, AgentCommand{Action: "start_run", RunSeq: 1, Epoch: run.Epoch, ExpectedCheckpoint: run.Checkpoint, LimitSeconds: 600, LimitCNY: 2}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if job.Agent.ContextVersion != 2 || job.Agent.RunSeq != 2 || job.AgentHistory[0].ContextVersion != 0 {
		t.Fatal("new edit or archive context version changed incorrectly")
	}
}

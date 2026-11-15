package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"
)

var ErrAgentConflict = errors.New("任务状态或修订已改变，请刷新后重试")
var ErrBudgetExhausted = errors.New("任务预算不足，请明确追加预算后继续")

type AgentBudget struct {
	ActiveSeconds float64 `json:"active_seconds"`
	LimitSeconds  float64 `json:"limit_seconds"`
	SpentCNY      float64 `json:"spent_cny"`
	ReservedCNY   float64 `json:"reserved_cny"`
	LimitCNY      float64 `json:"limit_cny"`
}
type AgentCall struct {
	Status      string          `json:"status"`
	InputHash   string          `json:"input_hash"`
	Cost        float64         `json:"cost"`
	ResponseRef string          `json:"response_ref,omitempty"`
	Usage       json.RawMessage `json:"usage,omitempty"`
}
type AgentOperation struct {
	Status    string          `json:"status"`
	InputHash string          `json:"input_hash"`
	Result    json.RawMessage `json:"result,omitempty"`
}
type AgentRun struct {
	Version         int                       `json:"version"`
	RunSeq          int64                     `json:"run_seq"`
	Epoch           int64                     `json:"runner_epoch"`
	Checkpoint      int64                     `json:"checkpoint_seq"`
	Phase           string                    `json:"phase"`
	Options         json.RawMessage           `json:"options"`
	ProjectRef      json.RawMessage           `json:"project_ref,omitempty"`
	QualityRevision string                    `json:"quality_revision,omitempty"`
	DraftRef        string                    `json:"draft_ref,omitempty"`
	DraftRevision   int64                     `json:"draft_revision"`
	ContextRef      string                    `json:"context_ref,omitempty"`
	Messages        json.RawMessage           `json:"messages,omitempty"`
	MessagesRef     string                    `json:"messages_ref,omitempty"`
	Request         json.RawMessage           `json:"request,omitempty"`
	Pricing         json.RawMessage           `json:"pricing,omitempty"`
	Budget          AgentBudget               `json:"budget"`
	Calls           map[string]AgentCall      `json:"calls"`
	Operations      map[string]AgentOperation `json:"operations"`
	InstanceID      string                    `json:"instance_id,omitempty"`
	LeaseUntil      string                    `json:"lease_until,omitempty"`
	LastActiveAt    string                    `json:"last_active_at,omitempty"`
	Error           string                    `json:"error,omitempty"`
	EngineWaits     map[string]string         `json:"engine_waits,omitempty"`
}
type AgentCommand struct {
	Title              string          `json:"title"`
	InitialRun         *AgentRun       `json:"initial_run"`
	Action             string          `json:"action"`
	DeckID             string          `json:"deck_id"`
	RunSeq             int64           `json:"run_seq"`
	Epoch              int64           `json:"runner_epoch"`
	ExpectedCheckpoint int64           `json:"expected_checkpoint"`
	ExpectedDraft      int64           `json:"expected_draft_revision"`
	Phase              string          `json:"phase"`
	InstanceID         string          `json:"instance_id"`
	ContextRef         string          `json:"context_ref"`
	DraftRef           string          `json:"draft_ref"`
	ProjectRef         json.RawMessage `json:"project_ref"`
	Messages           json.RawMessage `json:"messages"`
	MessagesRef        string          `json:"messages_ref"`
	Request            json.RawMessage `json:"request"`
	Pricing            json.RawMessage `json:"pricing"`
	Options            json.RawMessage `json:"options"`
	LimitSeconds       float64         `json:"limit_seconds"`
	LimitCNY           float64         `json:"limit_cny"`
	AddSeconds         float64         `json:"add_seconds"`
	AddCNY             float64         `json:"add_cny"`
	RetryUnknown       []string        `json:"retry_unknown_call_ids"`
	CallID             string          `json:"call_id"`
	OperationID        string          `json:"operation_id"`
	InputHash          string          `json:"input_hash"`
	Cost               float64         `json:"cost"`
	ResponseRef        string          `json:"response_ref"`
	Usage              json.RawMessage `json:"usage"`
	ParentRevision     string          `json:"parent_revision"`
	Result             json.RawMessage `json:"result"`
	RunDir             string          `json:"run_dir"`
	Error              string          `json:"error"`
	EngineState        string          `json:"engine_state"`
}

func NewAgentRun(options json.RawMessage, seconds, cny float64) *AgentRun {
	return &AgentRun{Version: 1, RunSeq: 1, Phase: "queued", Options: options, Budget: AgentBudget{LimitSeconds: seconds, LimitCNY: cny}, Calls: map[string]AgentCall{}, Operations: map[string]AgentOperation{}}
}
func cloneJob(job Job) Job {
	data, _ := json.Marshal(job)
	var copy Job
	_ = json.Unmarshal(data, &copy)
	return copy
}
func activePhase(phase string) bool {
	return phase == "planning" || phase == "generating" || phase == "checking" || phase == "revising"
}
func terminalPhase(phase string) bool {
	return phase == "completed" || phase == "failed" || phase == "cancelled"
}
func accrue(run *AgentRun, now time.Time) {
	active := len(run.EngineWaits) == 0
	for _, status := range run.EngineWaits {
		if status == "running" {
			active = true
		}
	}
	for _, call := range run.Calls {
		if call.Status == "sent" {
			active = true
		}
	}
	if active && activePhase(run.Phase) && run.LastActiveAt != "" {
		if last, err := time.Parse(time.RFC3339Nano, run.LastActiveAt); err == nil {
			run.Budget.ActiveSeconds += math.Max(0, now.Sub(last).Seconds())
		}
	}
	run.LastActiveAt = now.UTC().Format(time.RFC3339Nano)
}
func interruptAgent(run *AgentRun) {
	if activePhase(run.Phase) || run.Phase == "queued" {
		run.Phase = "interrupted"
		run.Epoch++
		run.Checkpoint++
		run.LastActiveAt = ""
		run.LeaseUntil = ""
	}
	for id, call := range run.Calls {
		if call.Status == "sent" {
			call.Status = "unknown"
			run.Calls[id] = call
		}
	}
}
func revisionOf(ref json.RawMessage) string {
	var value struct {
		Revision string `json:"revision_id"`
	}
	_ = json.Unmarshal(ref, &value)
	return value.Revision
}
func mutateAgentJob(job *Job, c AgentCommand, now time.Time) error {
	run := job.Agent
	if c.Action == "migrate" {
		if run != nil {
			return nil
		}
		if c.InitialRun == nil || c.InitialRun.Version != 1 {
			return errors.New("无效项目迁移")
		}
		job.Agent = c.InitialRun
		job.RunDir = c.RunDir
		return nil
	}
	if run == nil {
		return errors.New("作品尚未建立 Agent 项目")
	}
	if c.RunSeq != run.RunSeq {
		if c.Action == "settle_call" || c.Action == "mark_unknown" {
			for index := range job.AgentHistory {
				if job.AgentHistory[index].RunSeq == c.RunSeq {
					return mutateBudget(&job.AgentHistory[index], c)
				}
			}
		}
		return ErrAgentConflict
	}
	// Settling a known call is permitted after cancellation; it never publishes pages.
	lateCall := c.Action == "settle_call" || c.Action == "mark_unknown"
	if !lateCall && c.Action != "continue" && c.Action != "draft" && c.Action != "confirm" && c.Action != "claim" && c.Action != "start_run" && c.Action != "cancel" && c.Action != "interrupt" && c.Action != "schedule" && c.Action != "user_revision" && c.Action != "proposal" {
		if c.Epoch != run.Epoch || job.Cancelled || (!activePhase(run.Phase) && !(c.Action == "heartbeat" && run.Phase == "queued")) {
			return ErrAgentConflict
		}
	}
	switch c.Action {
	case "user_revision":
		if activePhase(run.Phase) || run.Phase == "queued" || c.ExpectedCheckpoint != run.Checkpoint || revisionOf(run.ProjectRef) != c.ParentRevision {
			return ErrAgentConflict
		}
		run.ProjectRef = c.ProjectRef
		if c.Options != nil {
			run.Options = c.Options
		}
		run.QualityRevision = ""
		run.Checkpoint++
		if c.ContextRef != "" {
			run.ContextRef = c.ContextRef
		}
		if c.RunDir != "" {
			job.RunDir = c.RunDir
		}
	case "proposal":
		if run.Phase != "waiting_user" || run.Checkpoint != c.ExpectedCheckpoint || c.DraftRef == "" {
			return ErrAgentConflict
		}
		run.DraftRef = c.DraftRef
		run.DraftRevision++
		run.Checkpoint++
		run.Phase = "waiting_outline"
		run.Request = nil
	case "schedule":
		if run.Phase != "queued" || c.Epoch != run.Epoch {
			return ErrAgentConflict
		}
		run.InstanceID = c.InstanceID
		run.LeaseUntil = now.Add(30 * time.Second).UTC().Format(time.RFC3339Nano)
	case "interrupt":
		if run.Epoch != c.Epoch || terminalPhase(run.Phase) {
			return ErrAgentConflict
		}
		interruptAgent(run)
		run.Error = c.Error
	case "cancel":
		accrue(run, now)
		run.Phase = "cancelled"
		run.Epoch++
		run.Checkpoint++
		run.Error = "用户取消了任务"
		job.Cancelled = true
	case "claim":
		if run.Phase != "queued" || run.Checkpoint != c.ExpectedCheckpoint || job.Cancelled || c.Epoch != run.Epoch {
			return ErrAgentConflict
		}
		run.Epoch++
		run.EngineWaits = nil
		run.Checkpoint++
		run.Phase = "planning"
		run.InstanceID = c.InstanceID
		run.LastActiveAt = now.UTC().Format(time.RFC3339Nano)
		run.LeaseUntil = now.Add(30 * time.Second).UTC().Format(time.RFC3339Nano)
	case "engine_wait":
		if c.OperationID == "" || (c.EngineState != "queued" && c.EngineState != "running" && c.EngineState != "done") {
			return errors.New("无效引擎等待状态")
		}
		accrue(run, now)
		if run.EngineWaits == nil {
			run.EngineWaits = map[string]string{}
		}
		if c.EngineState == "done" {
			delete(run.EngineWaits, c.OperationID)
		} else {
			run.EngineWaits[c.OperationID] = c.EngineState
		}
	case "heartbeat":
		accrue(run, now)
		run.LeaseUntil = now.Add(30 * time.Second).UTC().Format(time.RFC3339Nano)
		if run.Budget.ActiveSeconds >= run.Budget.LimitSeconds {
			run.Phase = "paused_budget"
			run.Checkpoint++
		}
	case "transition":
		if run.Checkpoint != c.ExpectedCheckpoint {
			return ErrAgentConflict
		}
		allowed := map[string]bool{"planning": true, "generating": true, "checking": true, "revising": true, "waiting_outline": true, "waiting_user": true, "paused_budget": true, "completed": true, "failed": true}
		if !allowed[c.Phase] {
			return errors.New("无效 Agent 阶段")
		}
		accrue(run, now)
		run.Phase = c.Phase
		run.Checkpoint++
		run.Error = c.Error
		if c.Messages != nil {
			run.Messages = c.Messages
		}
		if c.MessagesRef != "" {
			run.MessagesRef = c.MessagesRef
			run.Messages = nil
		}
		if c.Request != nil {
			run.Request = c.Request
		}
		if c.ContextRef != "" {
			run.ContextRef = c.ContextRef
		}
		if c.Pricing != nil {
			run.Pricing = c.Pricing
		}
	case "draft":
		if run.Phase != "waiting_outline" || run.DraftRevision != c.ExpectedDraft {
			return ErrAgentConflict
		}
		run.DraftRevision++
		run.DraftRef = c.DraftRef
		run.Checkpoint++
	case "confirm":
		if run.Phase == "queued" && run.DraftRevision == c.ExpectedDraft {
			return nil
		}
		if run.Phase != "waiting_outline" || run.DraftRevision != c.ExpectedDraft {
			return ErrAgentConflict
		}
		if c.ProjectRef == nil || revisionOf(run.ProjectRef) != c.ParentRevision {
			return ErrAgentConflict
		}
		run.ProjectRef = c.ProjectRef
		job.RunDir = c.RunDir
		run.QualityRevision = ""
		if c.Options != nil {
			run.Options = c.Options
		}
		run.Phase = "queued"
		run.Checkpoint++
		run.Request = nil
	case "continue":
		if run.Checkpoint != c.ExpectedCheckpoint || !(run.Phase == "interrupted" || run.Phase == "paused_budget" || run.Phase == "waiting_user") {
			return ErrAgentConflict
		}
		if c.AddCNY < 0 || c.AddSeconds < 0 {
			return errors.New("追加预算不能为负数")
		}
		approved := map[string]bool{}
		for _, id := range c.RetryUnknown {
			approved[id] = true
		}
		for id, call := range run.Calls {
			if call.Status == "unknown" && !approved[id] {
				return fmt.Errorf("调用 %s 结果未知，必须明确同意重新调用", id)
			}
		}
		for id, call := range run.Calls {
			if call.Status == "unknown" && approved[id] {
				call.Status = "retry_approved"
				run.Calls[id] = call
			}
		}
		run.Budget.LimitCNY += c.AddCNY
		run.Budget.LimitSeconds += c.AddSeconds
		run.Phase = "queued"
		run.Checkpoint++
		run.Error = ""
		run.Request = c.Request
	case "start_run":
		if !terminalPhase(run.Phase) || run.Checkpoint != c.ExpectedCheckpoint {
			return ErrAgentConflict
		}
		if c.LimitSeconds <= 0 || c.LimitCNY <= 0 {
			return errors.New("执行预算必须大于0")
		}
		job.AgentHistory = append(job.AgentHistory, *run)
		next := NewAgentRun(c.Options, c.LimitSeconds, c.LimitCNY)
		next.RunSeq = run.RunSeq + 1
		next.Epoch = run.Epoch + 1
		next.ProjectRef = run.ProjectRef
		next.ContextRef = c.ContextRef
		next.DraftRef = run.DraftRef
		next.DraftRevision = run.DraftRevision
		job.Agent = next
		run = next
		job.Cancelled = false
	case "begin_tool":
		if c.OperationID == "" || c.InputHash == "" {
			return errors.New("操作身份缺失")
		}
		if op, ok := run.Operations[c.OperationID]; ok {
			if op.InputHash != c.InputHash {
				return ErrAgentConflict
			}
			return nil
		}
		run.Operations[c.OperationID] = AgentOperation{Status: "pending", InputHash: c.InputHash}
	case "complete_tool":
		op, ok := run.Operations[c.OperationID]
		if !ok || op.InputHash != c.InputHash {
			return ErrAgentConflict
		}
		if op.Status == "completed" {
			return nil
		}
		if c.ProjectRef != nil {
			if revisionOf(run.ProjectRef) != c.ParentRevision {
				return ErrAgentConflict
			}
			run.ProjectRef = c.ProjectRef
			if c.RunDir != "" {
				job.RunDir = c.RunDir
			}
		}
		if c.DraftRef != "" {
			run.DraftRef = c.DraftRef
			run.DraftRevision++
		}
		if c.ContextRef != "" {
			run.ContextRef = c.ContextRef
		}
		op.Status = "completed"
		op.Result = c.Result
		run.Operations[c.OperationID] = op
		run.Checkpoint++
	case "reserve_call", "send_call", "settle_call", "mark_unknown", "reject_call":
		accrue(run, now)
		if err := mutateBudget(run, c); err != nil {
			return err
		}
	default:
		return errors.New("未知 Agent 操作")
	}
	if run.Phase == "completed" {
		job.Status = "ready"
		if c.Action == "transition" {
			for _, op := range run.Operations {
				var result struct {
					Completed  bool            `json:"completed"`
					ProjectRef json.RawMessage `json:"project_ref"`
				}
				if json.Unmarshal(op.Result, &result) == nil && result.Completed && revisionOf(result.ProjectRef) == revisionOf(run.ProjectRef) {
					run.QualityRevision = revisionOf(run.ProjectRef)
				}
			}
		}
	} else if run.Phase == "failed" || run.Phase == "cancelled" {
		job.Status = "error"
		job.Error = run.Error
	} else {
		job.Status = "creating"
		job.Error = ""
	}
	if c.Title != "" {
		job.Title = c.Title
	}
	if !activePhase(run.Phase) {
		run.LastActiveAt = ""
		run.LeaseUntil = ""
	}
	return nil
}

// WatchAgents only detects lost workers. Recovery always requires an explicit user action.
func WatchAgents(ctx context.Context, store StoreAPI) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			for _, job := range store.List() {
				run := job.Agent
				if run == nil || run.LeaseUntil == "" {
					continue
				}
				until, err := time.Parse(time.RFC3339Nano, run.LeaseUntil)
				if err == nil && now.After(until) {
					_, _ = store.MutateAgent(AgentCommand{Action: "interrupt", DeckID: job.ID, RunSeq: run.RunSeq, Epoch: run.Epoch})
				}
			}
		}
	}
}
func (s *Store) MutateAgent(c AgentCommand) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.jobs[c.DeckID]
	if !ok {
		return Job{}, errors.New("deck 任务不存在")
	}
	job := cloneJob(current)
	if err := mutateAgentJob(&job, c, time.Now()); err != nil {
		return Job{}, err
	}
	job.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	s.jobs[job.ID] = job
	if err := s.saveLocked(); err != nil {
		s.jobs[job.ID] = current
		return Job{}, err
	}
	s.notifyLocked(job)
	s.deliverLocked(job)
	return cloneJob(job), nil
}
func (s *PostgresStore) MutateAgent(c AgentCommand) (Job, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Job{}, err
	}
	defer tx.Rollback()
	job, err := postgresJobForUpdate(tx, c.DeckID)
	if err != nil {
		return Job{}, err
	}
	if err = mutateAgentJob(&job, c, time.Now()); err != nil {
		return Job{}, err
	}
	job.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	payload, err := json.Marshal(job)
	if err != nil {
		return Job{}, err
	}
	if _, err = tx.Exec("UPDATE deck_jobs SET payload=$1,updated_at=$2 WHERE id=$3", payload, job.UpdatedAt, job.ID); err != nil {
		return Job{}, err
	}
	if _, err = tx.Exec("INSERT INTO job_outbox(job_id,payload,created_at) VALUES($1,$2,$3)", job.ID, payload, job.UpdatedAt); err != nil {
		return Job{}, err
	}
	if _, err = tx.Exec("SELECT pg_notify('deck_job_events',$1)", s.instanceID+":"+job.ID); err != nil {
		return Job{}, err
	}
	if err = tx.Commit(); err != nil {
		return Job{}, err
	}
	s.notify(job)
	s.deliverJob(job)
	return job, nil
}

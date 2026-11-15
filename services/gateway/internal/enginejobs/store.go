// Package enginejobs owns durable engine scheduling. Browser workers never receive
// business workspace paths or customer API keys.
package enginejobs

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

var ErrConflict = errors.New("引擎任务身份或租约已失效")
var ErrNotFound = errors.New("引擎任务或私有文件不存在")
var ErrQueueFull = errors.New("引擎队列已满，请稍后提交")

const MaxArtifactBytes = 64 * 1024 * 1024

type Request struct {
	Owner       string          `json:"owner_key_hash"`
	DeckID      string          `json:"deck_id"`
	SnapshotID  string          `json:"snapshot_id"`
	SourceHash  string          `json:"source_hash"`
	Kind        string          `json:"kind"`
	OperationID string          `json:"operation_id"`
	Profile     string          `json:"profile_version"`
	Params      json.RawMessage `json:"params"`
	AgentRun    int64           `json:"agent_run_seq,omitempty"`
	AgentEpoch  int64           `json:"agent_epoch,omitempty"`
}
type Job struct {
	Request
	ID         string          `json:"job_id"`
	State      string          `json:"state"`
	Stage      string          `json:"stage"`
	Attempt    int             `json:"attempt"`
	Worker     string          `json:"worker_id,omitempty"`
	LeaseToken string          `json:"lease_token,omitempty"`
	LeaseUntil time.Time       `json:"lease_until,omitempty"`
	QueuedAt   time.Time       `json:"queued_at"`
	StartedAt  *time.Time      `json:"started_at,omitempty"`
	FinishedAt *time.Time      `json:"finished_at,omitempty"`
	ResultRef  string          `json:"result_ref,omitempty"`
	Error      string          `json:"error,omitempty"`
	Delivery   json.RawMessage `json:"delivery,omitempty"`
}
type Artifact struct {
	ID        string `json:"artifact_id"`
	Owner     string `json:"owner_key_hash"`
	DeckID    string `json:"deck_id"`
	MediaType string `json:"media_type"`
	SHA256    string `json:"sha256"`
	Size      int    `json:"size_bytes"`
}
type state struct {
	Jobs       map[string]Job      `json:"jobs"`
	Artifacts  map[string]Artifact `json:"artifacts"`
	Operations map[string]string   `json:"operations"`
	LastOwner  string              `json:"last_owner"`
	OwnerTurns map[string]int      `json:"owner_turns"`
}

func emptyState() state {
	return state{Jobs: map[string]Job{}, Artifacts: map[string]Artifact{}, Operations: map[string]string{}, OwnerTurns: map[string]int{}}
}

type objectStore interface {
	Put(string, []byte) error
	Get(string) ([]byte, error)
	Delete(string) error
}
type Store struct {
	mu          sync.Mutex
	file        string
	data        state
	objects     objectStore
	now         func() time.Time
	transaction func(bool, func(*state) error) error
	close       func() error
}

func NewStore(dir string) (*Store, error) {
	s := &Store{file: filepath.Join(dir, "engine-jobs.json"), data: emptyState(), objects: diskObjects(filepath.Join(dir, "engine-objects")), now: time.Now}
	content, err := os.ReadFile(s.file)
	if err == nil {
		err = json.Unmarshal(content, &s.data)
	} else if errors.Is(err, os.ErrNotExist) {
		err = nil
	}
	return s, err
}
func (s *Store) Close() error {
	if s.close != nil {
		return s.close()
	}
	return nil
}
func (s *Store) tx(write bool, fn func(*state) error) error {
	if s.transaction != nil {
		return s.transaction(write, fn)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !write {
		return fn(&s.data)
	}
	// Apply to a copy: failed transitions never alter the live queue.
	b, err := json.Marshal(s.data)
	if err != nil {
		return err
	}
	var next state
	previous := b
	if err = json.Unmarshal(b, &next); err != nil {
		return err
	}
	if err = fn(&next); err != nil {
		return err
	}
	b, err = json.Marshal(next)
	if err != nil {
		return err
	}
	if bytes.Equal(previous, b) {
		return nil
	}
	if err = os.MkdirAll(filepath.Dir(s.file), 0700); err != nil {
		return err
	}
	temp := s.file + "." + newID() + ".tmp"
	if err = os.WriteFile(temp, b, 0600); err != nil {
		return err
	}
	if err = os.Rename(temp, s.file); err != nil {
		return err
	}
	s.data = next
	return nil
}
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func hash(b []byte) string { v := sha256.Sum256(b); return hex.EncodeToString(v[:]) }
func identity(r Request) string {
	var parameters any
	if len(r.Params) > 0 {
		_ = json.Unmarshal(r.Params, &parameters)
	}
	b, _ := json.Marshal([]any{r.Owner, r.DeckID, r.SourceHash, r.Kind, r.Profile, parameters})
	return hash(b)
}
func operation(r Request) string { return hash([]byte(r.Owner + "\x00" + r.OperationID)) }
func (s *Store) Submit(r Request) (Job, error) {
	var result Job
	if r.Owner == "" || r.DeckID == "" || r.OperationID == "" || r.Profile == "" || (r.Kind != "validate" && r.Kind != "inspect" && r.Kind != "export") {
		return result, errors.New("无效引擎任务参数")
	}
	// Canonicalize object keys so retries do not depend on JSON whitespace/order.
	var params any
	if len(r.Params) == 0 {
		r.Params = json.RawMessage(`{}`)
	}
	if err := json.Unmarshal(r.Params, &params); err != nil {
		return result, err
	}
	r.Params, _ = json.Marshal(params)
	err := s.tx(true, func(st *state) error {
		a, ok := st.Artifacts[r.SnapshotID]
		if !ok || a.Owner != r.Owner || a.DeckID != r.DeckID || a.SHA256 != r.SourceHash {
			return ErrNotFound
		}
		key := operation(r)
		fingerprint := identity(r)
		if id := st.Operations[key]; id != "" {
			j := st.Jobs[id]
			if identity(j.Request) != fingerprint {
				return ErrConflict
			}
			result = j
			return nil
		}
		pending, owned := 0, 0
		for _, j := range st.Jobs {
			if identity(j.Request) == fingerprint && (j.State == "queued" || j.State == "running" || j.State == "completed") {
				result = j
				st.Operations[key] = j.ID
				return nil
			}
			if j.State == "queued" {
				pending++
				if j.Owner == r.Owner {
					owned++
				}
			}
		}
		if pending >= 100 || owned >= 20 {
			return ErrQueueFull
		}
		result = Job{Request: r, ID: "engine-" + newID(), State: "queued", Stage: "queued", QueuedAt: s.now().UTC()}
		st.Jobs[result.ID] = result
		st.Operations[key] = result.ID
		return nil
	})
	return result, err
}
func (s *Store) Get(id string) (Job, error) {
	var result Job
	err := s.tx(false, func(st *state) error {
		var ok bool
		result, ok = st.Jobs[id]
		if !ok {
			return ErrNotFound
		}
		return nil
	})
	return result, err
}
func (s *Store) Claim(worker string) (*Job, error) {
	if worker == "" {
		return nil, errors.New("worker_id 不能为空")
	}
	var result *Job
	err := s.tx(true, func(st *state) error {
		now := s.now().UTC()
		for id, j := range st.Jobs {
			if j.State == "running" && !now.Before(j.LeaseUntil) {
				j.LeaseToken = ""
				j.Worker = ""
				if j.Attempt >= 2 {
					j.State = "failed"
					j.Stage = "failed"
					j.Error = "引擎执行两次失联"
					j.FinishedAt = &now
				} else {
					j.State = "queued"
					j.Stage = "recovering"
				}
				st.Jobs[id] = j
			}
		}
		var pending []Job
		for _, j := range st.Jobs {
			if j.State == "queued" {
				pending = append(pending, j)
			}
		}
		if len(pending) == 0 {
			return nil
		}
		sort.Slice(pending, func(i, j int) bool {
			if pending[i].QueuedAt.Equal(pending[j].QueuedAt) {
				return pending[i].ID < pending[j].ID
			}
			return pending[i].QueuedAt.Before(pending[j].QueuedAt)
		})
		owners := []string{}
		seen := map[string]bool{}
		for _, j := range pending {
			if !seen[j.Owner] {
				owners = append(owners, j.Owner)
				seen[j.Owner] = true
			}
		}
		owner := owners[0]
		for i, o := range owners {
			if o == st.LastOwner {
				owner = owners[(i+1)%len(owners)]
				break
			}
		}
		index := -1
		if st.OwnerTurns == nil {
			st.OwnerTurns = map[string]int{}
		}
		exportTurn := st.OwnerTurns[owner]%3 == 2
		for i, j := range pending {
			if j.Owner == owner && (j.Kind == "export") == exportTurn {
				index = i
				break
			}
		}
		if index < 0 {
			for i, j := range pending {
				if j.Owner == owner {
					index = i
					break
				}
			}
		}
		j := pending[index]
		j.State = "running"
		j.Stage = "executing"
		j.Attempt++
		j.Worker = worker
		j.LeaseToken = newID()
		j.LeaseUntil = now.Add(30 * time.Second)
		j.StartedAt = &now
		st.LastOwner = owner
		st.OwnerTurns[owner]++
		st.Jobs[j.ID] = j
		result = &j
		return nil
	})
	return result, err
}
func (s *Store) Update(id, token, action, resultRef, message string) (Job, error) {
	var result Job
	err := s.tx(true, func(st *state) error {
		j, ok := st.Jobs[id]
		now := s.now().UTC()
		if !ok || j.State != "running" || j.LeaseToken != token || !now.Before(j.LeaseUntil) {
			return ErrConflict
		}
		switch action {
		case "heartbeat":
			j.LeaseUntil = now.Add(30 * time.Second)
		case "complete":
			a, ok := st.Artifacts[resultRef]
			if !ok || a.Owner != j.Owner || a.DeckID != j.DeckID {
				return ErrNotFound
			}
			j.State = "completed"
			j.Stage = "completed"
			j.ResultRef = resultRef
			j.FinishedAt = &now
		case "fail":
			j.State = "failed"
			j.Stage = "failed"
			j.Error = message
			j.FinishedAt = &now
		default:
			return errors.New("未知引擎状态变更")
		}
		st.Jobs[id] = j
		result = j
		return nil
	})
	return result, err
}
func (s *Store) Cancel(id, owner string) (Job, error) {
	var result Job
	err := s.tx(true, func(st *state) error {
		j, ok := st.Jobs[id]
		if !ok || j.Owner != owner {
			return ErrNotFound
		}
		if j.State == "completed" {
			return ErrConflict
		}
		if j.State == "queued" || j.State == "running" {
			now := s.now().UTC()
			j.State = "cancelled"
			j.Stage = "cancelled"
			j.FinishedAt = &now
			j.LeaseToken = ""
			st.Jobs[id] = j
		}
		result = j
		return nil
	})
	return result, err
}
func (s *Store) PutArtifact(owner, deck, media string, content []byte) (Artifact, error) {
	if owner == "" || deck == "" || len(content) == 0 || len(content) > MaxArtifactBytes {
		return Artifact{}, errors.New("私有文件归属、内容或大小无效")
	}
	a := Artifact{ID: "artifact-" + hash(append([]byte(owner+"\x00"+deck+"\x00"+media+"\x00"), content...)), Owner: owner, DeckID: deck, MediaType: media, SHA256: hash(content), Size: len(content)}
	// Content-addressed bytes are immutable and safe to upload concurrently.
	if err := s.objects.Put("engine/"+a.ID, content); err != nil {
		return a, err
	}
	err := s.tx(true, func(st *state) error { st.Artifacts[a.ID] = a; return nil })
	return a, err
}
func (s *Store) ReadArtifact(id, owner string) ([]byte, error) {
	_, content, err := s.readArtifact(id, owner)
	return content, err
}
func (s *Store) readArtifact(id, owner string) (Artifact, []byte, error) {
	var a Artifact
	err := s.tx(false, func(st *state) error {
		var ok bool
		a, ok = st.Artifacts[id]
		if !ok || a.Owner != owner {
			return ErrNotFound
		}
		return nil
	})
	if err != nil {
		return a, nil, err
	}
	b, err := s.objects.Get("engine/" + a.ID)
	if err == nil && hash(b) != a.SHA256 {
		return a, nil, fmt.Errorf("私有文件摘要不匹配")
	}
	return a, b, err
}

type diskObjects string

func (d diskObjects) Put(key string, b []byte) error {
	file := filepath.Join(string(d), key)
	if _, err := os.Stat(file); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	temp := file + "." + newID() + ".tmp"
	if err := os.WriteFile(temp, b, 0600); err != nil {
		return err
	}
	return os.Rename(temp, file)
}
func (d diskObjects) Get(key string) ([]byte, error) {
	return os.ReadFile(filepath.Join(string(d), key))
}
func (d diskObjects) Delete(key string) error { return os.Remove(filepath.Join(string(d), key)) }

package jobs

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Billing struct {
	Points  float64 `json:"points"`
	Balance float64 `json:"balance,omitempty"`
}

type WebhookConfig struct {
	URL    string `json:"url"`
	Secret string `json:"secret"`
}

type Job struct {
	ID            string         `json:"id"`
	RunDir        string         `json:"runDir,omitempty"`
	Title         string         `json:"title,omitempty"`
	Status        string         `json:"status"`
	Events        []string       `json:"events"`
	Error         string         `json:"error,omitempty"`
	OverflowPages []int          `json:"overflowPages"`
	Billing       *Billing       `json:"billing,omitempty"`
	OwnerKeyHash  string         `json:"ownerKeyHash,omitempty"`
	Cancelled     bool           `json:"cancelled,omitempty"`
	Webhook       *WebhookConfig `json:"webhook,omitempty"`
	CreatedAt     string         `json:"createdAt,omitempty"`
	UpdatedAt     string         `json:"updatedAt,omitempty"`
}

type StoreAPI interface {
	Create(job Job) error
	Save(job Job) error
	Get(id string) (Job, bool)
	List() []Job
	Delete(id string)
	Cancel(id string) (Job, bool, error)
	SetWebhook(id string, config WebhookConfig) error
	SetDeliveryHandler(deliver func(Job))
	Subscribe(id string) (<-chan Job, func())
}

type Store struct {
	file        string
	mu          sync.Mutex
	jobs        map[string]Job
	subscribers map[string]map[chan Job]struct{}
	deliver     func(Job)
}

func NewStore(dataDir string) (*Store, error) {
	store := &Store{
		file: filepath.Join(dataDir, "deck-jobs.json"), jobs: map[string]Job{},
		subscribers: map[string]map[chan Job]struct{}{},
	}
	data, err := os.ReadFile(store.file)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	var saved []Job
	if err := json.Unmarshal(data, &saved); err != nil {
		return nil, err
	}
	changed := false
	for _, job := range saved {
		if job.Status == "creating" {
			job.Status = "error"
			job.Error = "服务重启中断了生成，请重新创建任务"
			changed = true
		}
		store.jobs[job.ID] = job
	}
	if changed {
		return store, store.saveLocked()
	}
	return store, nil
}

func (s *Store) Create(job Job) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.jobs[job.ID]; exists {
		return errors.New("deck 任务已存在")
	}
	if job.Events == nil {
		job.Events = []string{}
	}
	if job.OverflowPages == nil {
		job.OverflowPages = []int{}
	}
	job.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	s.jobs[job.ID] = job
	return s.saveLocked()
}

func (s *Store) Save(job Job) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, exists := s.jobs[job.ID]
	if !exists {
		return errors.New("deck 任务不存在")
	}
	if current.Cancelled && job.Status == "creating" {
		job.Status = "error"
		job.Error = "用户取消了任务"
		job.Cancelled = true
	}
	if len(job.Events) > 200 {
		job.Events = append([]string(nil), job.Events[len(job.Events)-200:]...)
	}
	// Node 的任务快照不持有 webhook 密钥，更新时必须保留 Go 侧配置。
	job.Webhook = current.Webhook
	job.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	s.jobs[job.ID] = job
	if err := s.saveLocked(); err != nil {
		return err
	}
	s.notifyLocked(job)
	s.deliverLocked(job)
	return nil
}

func (s *Store) Get(id string) (Job, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.jobs[id]
	return job, ok
}

func (s *Store) List() []Job {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]Job, 0, len(s.jobs))
	for _, job := range s.jobs {
		result = append(result, job)
	}
	return result
}

func (s *Store) Delete(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.jobs, id)
	_ = s.saveLocked()
}

func (s *Store) Cancel(id string) (Job, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.jobs[id]
	if !ok {
		return Job{}, false, nil
	}
	job.Cancelled = true
	job.Status = "error"
	job.Error = "用户取消了任务"
	job.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	s.jobs[id] = job
	if err := s.saveLocked(); err != nil {
		return Job{}, true, err
	}
	s.notifyLocked(job)
	s.deliverLocked(job)
	return job, true, nil
}

func (s *Store) SetWebhook(id string, config WebhookConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.jobs[id]
	if !ok {
		return errors.New("deck 任务不存在")
	}
	job.Webhook = &config
	s.jobs[id] = job
	return s.saveLocked()
}

func (s *Store) SetDeliveryHandler(deliver func(Job)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deliver = deliver
}

func (s *Store) deliverLocked(job Job) {
	if s.deliver != nil && job.Webhook != nil {
		s.deliver(job)
	}
}

func (s *Store) Subscribe(id string) (<-chan Job, func()) {
	channel := make(chan Job, 1)
	s.mu.Lock()
	if s.subscribers[id] == nil {
		s.subscribers[id] = map[chan Job]struct{}{}
	}
	s.subscribers[id][channel] = struct{}{}
	s.mu.Unlock()
	return channel, func() {
		s.mu.Lock()
		delete(s.subscribers[id], channel)
		close(channel)
		s.mu.Unlock()
	}
}

func (s *Store) notifyLocked(job Job) {
	for channel := range s.subscribers[job.ID] {
		select {
		case <-channel:
		default:
		}
		select {
		case channel <- job:
		default:
		}
	}
}

func (s *Store) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.file), 0o750); err != nil {
		return err
	}
	jobs := make([]Job, 0, len(s.jobs))
	for _, job := range s.jobs {
		jobs = append(jobs, job)
	}
	data, err := json.MarshalIndent(jobs, "", "  ")
	if err != nil {
		return err
	}
	temporary := s.file + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, s.file); err != nil {
		if removeErr := os.Remove(s.file); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return err
		}
		return os.Rename(temporary, s.file)
	}
	return nil
}

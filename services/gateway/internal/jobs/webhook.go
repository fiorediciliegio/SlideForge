package jobs

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type delivery struct {
	id  string
	job Job
}

type Dispatcher struct {
	client    *http.Client
	retries   int
	backoff   time.Duration
	auditFile string
	queue     chan delivery
	done      chan struct{}
	closeOnce sync.Once
	outbox    *PostgresStore
}

func NewDispatcher(dataDir string, client *http.Client, retries int, backoff time.Duration) *Dispatcher {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	if retries < 1 {
		retries = 1
	}
	dispatcher := &Dispatcher{
		client: client, retries: retries, backoff: backoff,
		auditFile: filepath.Join(dataDir, "job-webhooks.jsonl"),
		queue:     make(chan delivery, 100), done: make(chan struct{}),
	}
	go dispatcher.run()
	return dispatcher
}

func NewPostgresDispatcher(dataDir string, store *PostgresStore, client *http.Client, retries int, backoff time.Duration) *Dispatcher {
	dispatcher := NewDispatcher(dataDir, client, retries, backoff)
	dispatcher.outbox = store
	return dispatcher
}

func (d *Dispatcher) Enqueue(job Job) {
	if d.outbox != nil {
		// outbox 已在任务事务中持久化，内存队列仅用于关闭本地 worker。
		return
	}
	item := delivery{id: newDeliveryID(), job: job}
	select {
	case d.queue <- item:
	default:
		d.audit(item, 0, "dropped", "webhook queue full")
	}
}

func (d *Dispatcher) Close() {
	d.closeOnce.Do(func() {
		close(d.queue)
		<-d.done
	})
}

func (d *Dispatcher) run() {
	defer close(d.done)
	if d.outbox != nil {
		d.runOutbox()
		return
	}
	for item := range d.queue {
		d.deliver(item)
	}
}

func (d *Dispatcher) runOutbox() {
	interval := d.backoff
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	ctx := context.Background()
	for {
		select {
		case <-d.queue:
			return
		case <-ticker.C:
			id, job, err := d.outbox.nextOutbox(ctx)
			if err != nil {
				continue
			}
			if id == 0 {
				continue
			}
			item := delivery{id: fmt.Sprintf("%d", id), job: job}
			if d.deliver(item) {
				_ = d.outbox.markOutboxDelivered(ctx, id)
			}
		}
	}
}

func (d *Dispatcher) deliver(item delivery) bool {
	eventType := "job.updated"
	if item.job.Cancelled {
		eventType = "job.cancelled"
	}
	payload, _ := json.Marshal(map[string]any{
		"id": item.id, "type": eventType, "created_at": time.Now().UTC().Format(time.RFC3339),
		"data": publicJob(item.job, 8),
	})
	if item.job.Webhook == nil {
		return true
	}
	for attempt := 1; attempt <= d.retries; attempt++ {
		request, err := http.NewRequest(http.MethodPost, item.job.Webhook.URL, bytes.NewReader(payload))
		if err != nil {
			d.audit(item, attempt, "failed", err.Error())
			return false
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-SlideForge-Delivery", item.id)
		request.Header.Set("X-SlideForge-Event", eventType)
		signature := hmac.New(sha256.New, []byte(item.job.Webhook.Secret))
		_, _ = signature.Write(payload)
		request.Header.Set("X-SlideForge-Signature", "sha256="+hex.EncodeToString(signature.Sum(nil)))
		response, err := d.client.Do(request)
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				d.audit(item, attempt, "delivered", "")
				return true
			}
			err = fmt.Errorf("webhook status %d", response.StatusCode)
		}
		d.audit(item, attempt, "retrying", err.Error())
		if attempt < d.retries {
			time.Sleep(d.backoff * time.Duration(attempt))
		}
	}
	return false
}

func (d *Dispatcher) audit(item delivery, attempt int, status, message string) {
	if err := os.MkdirAll(filepath.Dir(d.auditFile), 0o750); err != nil {
		return
	}
	file, err := os.OpenFile(d.auditFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	_ = json.NewEncoder(file).Encode(map[string]any{
		"ts": time.Now().UTC().Format(time.RFC3339), "delivery_id": item.id,
		"deck_id": item.job.ID, "url": sanitizedURL(item.job.Webhook.URL),
		"attempt": attempt, "status": status, "error": message,
	})
}

func sanitizedURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "invalid-url"
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func newDeliveryID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err == nil {
		return hex.EncodeToString(value[:])
	}
	return strings.ReplaceAll(time.Now().UTC().Format(time.RFC3339Nano), ":", "-")
}

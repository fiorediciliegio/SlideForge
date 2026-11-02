package jobs

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type receivedWebhook struct {
	body      []byte
	signature string
	event     string
}

func TestWebhookSignsRetriesAndAuditsWithoutLeakingSecret(t *testing.T) {
	received := make(chan receivedWebhook, 2)
	attempts := 0
	receiver := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		attempts++
		body, _ := io.ReadAll(request.Body)
		received <- receivedWebhook{
			body: body, signature: request.Header.Get("X-SlideForge-Signature"),
			event: request.Header.Get("X-SlideForge-Event"),
		}
		if attempts == 1 {
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer receiver.Close()
	directory := t.TempDir()
	dispatcher := NewDispatcher(directory, receiver.Client(), 3, time.Millisecond)
	store, err := NewStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	store.SetDeliveryHandler(dispatcher.Enqueue)
	job := Job{ID: "deck-a", Status: "creating", Events: []string{}, OverflowPages: []int{}}
	if err := store.Create(job); err != nil {
		t.Fatal(err)
	}
	secret := "test-secret-at-least-16"
	if err := store.SetWebhook(job.ID, WebhookConfig{URL: receiver.URL + "/callback?secret=hidden", Secret: secret}); err != nil {
		t.Fatal(err)
	}
	job.Status = "ready"
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 2; index++ {
		select {
		case request := <-received:
			signature := hmac.New(sha256.New, []byte(secret))
			_, _ = signature.Write(request.body)
			if request.signature != "sha256="+hex.EncodeToString(signature.Sum(nil)) {
				t.Fatal("invalid webhook signature")
			}
			if request.event != "job.updated" || strings.Contains(string(request.body), secret) {
				t.Fatalf("unexpected webhook payload: %s", request.body)
			}
			var payload map[string]any
			if err := json.Unmarshal(request.body, &payload); err != nil {
				t.Fatal(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("webhook delivery timed out")
		}
	}
	dispatcher.Close()
	audit, err := os.ReadFile(filepath.Join(directory, "job-webhooks.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(audit), "delivered") || strings.Contains(string(audit), "secret=hidden") {
		t.Fatalf("unexpected audit log: %s", audit)
	}
}

func TestPostgresDispatcherEnqueueDoesNotInterruptPersistentWorker(t *testing.T) {
	dispatcher := &Dispatcher{outbox: &PostgresStore{}, queue: make(chan delivery, 1)}
	dispatcher.Enqueue(Job{ID: "deck-a"})
	select {
	case <-dispatcher.queue:
		t.Fatal("outbox mode must not enqueue in-memory work or stop the persistent worker")
	default:
	}
}

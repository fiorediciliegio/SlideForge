package jobs

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"slideforge/services/gateway/internal/billing"
)

func TestStorePersistsNotifiesAndPreservesCancellation(t *testing.T) {
	directory := t.TempDir()
	store, err := NewStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	job := Job{ID: "deck-a", Status: "creating", Events: []string{}, OverflowPages: []int{}, OwnerKeyHash: "owner-a"}
	if err := store.Create(job); err != nil {
		t.Fatal(err)
	}
	updates, unsubscribe := store.Subscribe(job.ID)
	defer unsubscribe()
	job.Events = append(job.Events, "page 1")
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}
	select {
	case update := <-updates:
		if len(update.Events) != 1 {
			t.Fatalf("unexpected update: %#v", update)
		}
	case <-time.After(time.Second):
		t.Fatal("missing job update")
	}
	if _, _, err := store.Cancel(job.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}
	current, _ := store.Get(job.ID)
	if !current.Cancelled || current.Status != "error" {
		t.Fatalf("cancellation was overwritten: %#v", current)
	}
	restarted, err := NewStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	persisted, ok := restarted.Get(job.ID)
	if !ok || !persisted.Cancelled {
		t.Fatal("cancelled job was not persisted")
	}
}

func TestSSEStartsWithOwnedSnapshot(t *testing.T) {
	directory := t.TempDir()
	store, err := NewStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	billingStore := billing.NewStore(directory)
	key, _, err := billingStore.Issue("job-user", 100)
	if err != nil {
		t.Fatal(err)
	}
	job := Job{ID: "deck-a", Status: "creating", Events: []string{"created"}, OverflowPages: []int{}, OwnerKeyHash: billing.HashAPIKey(key)}
	if err := store.Create(job); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	NewHTTPHandler(store, billingStore, "internal-secret").Register(mux)
	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, "/decks/deck-a/events", nil).WithContext(ctx)
	request.Header.Set("X-API-Key", key)
	response := httptest.NewRecorder()
	cancel()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "event: job") {
		t.Fatalf("unexpected SSE response: %d %s", response.Code, response.Body.String())
	}
}

package enginejobs

import (
	"encoding/json"
	"errors"
	"slideforge/services/gateway/internal/billing"
	"slideforge/services/gateway/internal/files"
	"testing"
	"time"
)

type blockedPublisher struct {
	files.StoreAPI
	entered, release chan struct{}
}

func (f *blockedPublisher) PublishOnce(op, deck, name, media, owner string, content []byte) (files.Record, error) {
	close(f.entered)
	<-f.release
	return f.StoreAPI.PublishOnce(op, deck, name, media, owner, content)
}
func TestFileDeliveryDoesNotBlockEngineQueue(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewStore(dir)
	b := billing.NewStore(dir)
	key, _, _ := b.Issue("customer", 100)
	owner := billing.HashAPIKey(key)
	f := files.NewStore(dir)
	job := submitTest(t, s, owner, "delivery", "export")
	running, _ := s.Claim("worker")
	file, _ := s.PutArtifact(owner, job.DeckID, "application/pdf", []byte("%PDF"))
	payload, _ := json.Marshal(map[string]any{"file_ref": file.ID, "media_type": "application/pdf", "name": "deck.pdf", "slide_count": 2})
	output, _ := s.PutArtifact(owner, job.DeckID, "application/json", payload)
	s.Update(job.ID, running.LeaseToken, "complete", output.ID, "")
	publisher := &blockedPublisher{StoreAPI: f, entered: make(chan struct{}), release: make(chan struct{})}
	done := make(chan error, 1)
	defer func() { close(publisher.release); <-done }()
	go func() { _, err := NewHTTPHandler(s, b, publisher, "internal").deliver(job.ID, owner); done <- err }()
	<-publisher.entered
	read := make(chan struct{})
	go func() { s.Get(job.ID); close(read) }()
	select {
	case <-read:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("file transfer held the engine queue lock")
	}
}

type lostPublishAck struct {
	files.StoreAPI
	lose bool
}

func (f *lostPublishAck) PublishOnce(operationID, deck, name, media, owner string, content []byte) (files.Record, error) {
	record, err := f.StoreAPI.PublishOnce(operationID, deck, name, media, owner, content)
	if err == nil && f.lose {
		f.lose = false
		return record, errors.New("file publish acknowledgement lost")
	}
	return record, err
}

func TestDeliveryChargesOnceAndNeverPublishesWithoutPayment(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewStore(dir)
	b := billing.NewStore(dir)
	f := files.NewStore(dir)
	key, _, _ := b.Issue("customer", 20)
	owner := billing.HashAPIKey(key)
	job := submitTest(t, s, owner, "export-one", "export")
	running, _ := s.Claim("worker")
	binary, _ := s.PutArtifact(owner, job.DeckID, "application/pdf", []byte("%PDF-test"))
	output, _ := json.Marshal(map[string]any{"file_ref": binary.ID, "name": "deck.pdf", "media_type": "application/pdf", "slide_count": 2, "warnings": []string{}})
	result, _ := s.PutArtifact(owner, job.DeckID, "application/json", output)
	if _, err := s.Update(job.ID, running.LeaseToken, "complete", result.ID, ""); err != nil {
		t.Fatal(err)
	}
	flaky := &lostPublishAck{StoreAPI: f, lose: true}
	h := NewHTTPHandler(s, b, flaky, "internal")
	if _, err := h.deliver(job.ID, owner); err == nil {
		t.Fatal("expected lost publication acknowledgement")
	}
	first, err := h.deliver(job.ID, owner)
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.deliver(job.ID, owner)
	if err != nil || string(first) != string(second) {
		t.Fatal("receipt changed", err)
	}
	usage, _ := b.Usage(key)
	if usage.Balance != 10 {
		t.Fatal(usage.Balance)
	}
	records, _ := f.ListDeck(job.DeckID, owner)
	if len(records) != 1 {
		t.Fatal("duplicate publication")
	}
	if _, err = h.deliver(job.ID, "another-owner"); err == nil {
		t.Fatal("cross owner delivery")
	}

	poorKey, _, _ := b.Issue("poor", 1)
	poor := billing.HashAPIKey(poorKey)
	j := submitTest(t, s, poor, "export-poor", "export")
	r, _ := s.Claim("worker")
	bin, _ := s.PutArtifact(poor, j.DeckID, "application/pdf", []byte("%PDF-test"))
	content, _ := json.Marshal(map[string]any{"file_ref": bin.ID, "name": "deck.pdf", "media_type": "application/pdf", "slide_count": 2})
	out, _ := s.PutArtifact(poor, j.DeckID, "application/json", content)
	s.Update(j.ID, r.LeaseToken, "complete", out.ID, "")
	if _, err = h.deliver(j.ID, poor); err == nil {
		t.Fatal("unpaid output delivered")
	}
	records, _ = f.ListDeck(j.DeckID, poor)
	if len(records) != 0 {
		t.Fatal("published before payment")
	}
}

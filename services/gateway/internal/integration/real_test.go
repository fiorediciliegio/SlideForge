//go:build integration

package integration

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"slideforge/services/gateway/internal/billing"
	"slideforge/services/gateway/internal/files"
	"slideforge/services/gateway/internal/jobs"
)

func TestRealPostgresS3AndCrossInstanceDelivery(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is required for real infrastructure integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	billingStore, err := billing.NewPostgresStore(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer billingStore.Close()
	key, _, err := billingStore.Issue("integration", 100)
	if err != nil {
		t.Fatal(err)
	}
	operation := fmt.Sprintf("export-%d", time.Now().UnixNano())
	first, err := billingStore.Charge(key, "deck-integration", operation, 10)
	if err != nil {
		t.Fatal(err)
	}
	repeated, err := billingStore.Charge(key, "deck-integration", operation, 10)
	if err != nil {
		t.Fatal(err)
	}
	if first != repeated || repeated.Balance != 90 {
		t.Fatalf("shared idempotency failed: first=%#v repeated=%#v", first, repeated)
	}

	jobStoreA, err := jobs.NewPostgresStore(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer jobStoreA.Close()
	jobStoreB, err := jobs.NewPostgresStore(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer jobStoreB.Close()
	job := jobs.Job{ID: fmt.Sprintf("deck-%d", time.Now().UnixNano()), Status: "creating", Events: []string{}, OverflowPages: []int{}}
	if err := jobStoreA.Create(job); err != nil {
		t.Fatal(err)
	}
	updates, unsubscribe := jobStoreB.Subscribe(job.ID)
	defer unsubscribe()
	job.Events = append(job.Events, "page 1")
	if err := jobStoreA.Save(job); err != nil {
		t.Fatal(err)
	}
	select {
	case update := <-updates:
		if len(update.Events) != 1 {
			t.Fatalf("unexpected cross-instance update: %#v", update)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("LISTEN/NOTIFY update was not received by the second store")
	}

	delivered := make(chan struct{}, 1)
	receiver := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
		delivered <- struct{}{}
	}))
	defer receiver.Close()
	dispatcher := jobs.NewPostgresDispatcher(t.TempDir(), jobStoreA, receiver.Client(), 3, 20*time.Millisecond)
	defer dispatcher.Close()
	jobStoreA.SetDeliveryHandler(dispatcher.Enqueue)
	if err := jobStoreA.SetWebhook(job.ID, jobs.WebhookConfig{URL: receiver.URL, Secret: "integration-secret"}); err != nil {
		t.Fatal(err)
	}
	job.Events = append(job.Events, "page 2")
	if err := jobStoreA.Save(job); err != nil {
		t.Fatal(err)
	}
	select {
	case <-delivered:
	case <-time.After(5 * time.Second):
		t.Fatal("persistent outbox was not delivered")
	}

	objectStore, err := files.NewS3ObjectStore(files.S3Config{
		Endpoint: os.Getenv("TEST_S3_ENDPOINT"), Bucket: os.Getenv("TEST_S3_BUCKET"),
		Region: os.Getenv("TEST_S3_REGION"), AccessKeyID: os.Getenv("TEST_S3_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("TEST_S3_SECRET_ACCESS_KEY"), ForcePathStyle: true,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := objectStore.EnsureBucket(); err != nil {
		t.Fatal(err)
	}
	fileStore, err := files.NewPostgresFileStore(ctx, dsn, objectStore)
	if err != nil {
		t.Fatal(err)
	}
	defer fileStore.Close()
	record, err := fileStore.Publish(job.ID, "deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", billing.HashAPIKey(key), []byte("real-pptx"))
	if err != nil {
		t.Fatal(err)
	}
	content, err := fileStore.Read(record)
	if err != nil || string(content) != "real-pptx" {
		t.Fatalf("S3 roundtrip failed: %s %v", content, err)
	}
}

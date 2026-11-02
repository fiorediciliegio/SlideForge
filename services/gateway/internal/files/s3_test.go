package files

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestS3PutAndGetUseSignedRequests(t *testing.T) {
	var putAuthorization string
	deleted := false
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodPut {
			putAuthorization = request.Header.Get("Authorization")
			body, _ := io.ReadAll(request.Body)
			if string(body) != "pptx" {
				t.Errorf("unexpected object body: %s", body)
			}
			writer.WriteHeader(http.StatusOK)
			return
		}
		if request.Method == http.MethodDelete {
			deleted = true
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		writer.Header().Set("Content-Type", "application/octet-stream")
		_, _ = writer.Write([]byte("pptx"))
	}))
	defer server.Close()
	store, err := NewS3ObjectStore(S3Config{
		Endpoint: server.URL, Bucket: "exports", Region: "test-region",
		AccessKeyID: "test-access", SecretAccessKey: "test-secret", ForcePathStyle: true,
	}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC) }
	if err := store.Put("exports/file-a", []byte("pptx")); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(putAuthorization, "AWS4-HMAC-SHA256 Credential=test-access/20260102/test-region/s3/aws4_request") {
		t.Fatalf("unexpected authorization: %s", putAuthorization)
	}
	content, err := store.Get("exports/file-a")
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "pptx" {
		t.Fatalf("unexpected object: %s", content)
	}
	if err := store.Delete("exports/file-a"); err != nil {
		t.Fatal(err)
	}
	if !deleted {
		t.Fatal("S3 DeleteObject was not called")
	}
}

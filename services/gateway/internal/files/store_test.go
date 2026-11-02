package files

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"slideforge/services/gateway/internal/billing"
)

func TestPublishListAndDownloadEnforceOwnership(t *testing.T) {
	directory := t.TempDir()
	billingStore := billing.NewStore(directory)
	ownerKey, _, err := billingStore.Issue("owner", 100)
	if err != nil {
		t.Fatal(err)
	}
	otherKey, _, err := billingStore.Issue("other", 100)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	NewHTTPHandler(NewStore(directory), billingStore, "internal-secret").Register(mux)
	body := bytes.NewBufferString(`{"deck_id":"deck-a","name":"deck.pptx","media_type":"application/vnd.openxmlformats-officedocument.presentationml.presentation","content_base64":"cHB0eA==","ownerKeyHash":"` + billing.HashAPIKey(ownerKey) + `"}`)
	request := httptest.NewRequest(http.MethodPost, "/internal/files", body)
	request.Header.Set("X-Internal-Token", "internal-secret")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("publish failed: %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "object_path") || strings.Contains(response.Body.String(), "ownerKeyHash") {
		t.Fatalf("internal fields leaked: %s", response.Body.String())
	}
	listRequest := httptest.NewRequest(http.MethodGet, "/decks/deck-a/files", nil)
	listRequest.Header.Set("X-API-Key", ownerKey)
	listResponse := httptest.NewRecorder()
	mux.ServeHTTP(listResponse, listRequest)
	if listResponse.Code != http.StatusOK || !strings.Contains(listResponse.Body.String(), "file-") {
		t.Fatalf("unexpected file list: %d %s", listResponse.Code, listResponse.Body.String())
	}
	fileID := strings.Split(strings.Split(listResponse.Body.String(), `"file_id":"`)[1], `"`)[0]
	downloadRequest := httptest.NewRequest(http.MethodGet, "/files/"+fileID, nil)
	downloadRequest.Header.Set("X-API-Key", ownerKey)
	downloadResponse := httptest.NewRecorder()
	mux.ServeHTTP(downloadResponse, downloadRequest)
	content, _ := io.ReadAll(downloadResponse.Body)
	if downloadResponse.Code != http.StatusOK || string(content) != "pptx" {
		t.Fatalf("unexpected download: %d %s", downloadResponse.Code, content)
	}
	otherRequest := httptest.NewRequest(http.MethodGet, "/files/"+fileID, nil)
	otherRequest.Header.Set("X-API-Key", otherKey)
	otherResponse := httptest.NewRecorder()
	mux.ServeHTTP(otherResponse, otherRequest)
	if otherResponse.Code != http.StatusNotFound {
		t.Fatalf("other user should not see file: %d", otherResponse.Code)
	}
}

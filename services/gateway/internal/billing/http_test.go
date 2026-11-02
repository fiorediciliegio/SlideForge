package billing

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestInternalAPIRequiresTokenAndChecksCredentials(t *testing.T) {
	store := NewStore(t.TempDir())
	key, _, err := store.Issue("internal-user", 100)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	NewHTTPHandler(store, "internal-secret", "admin-secret").Register(mux)
	body := bytes.NewBufferString(`{"api_key":"` + key + `"}`)
	request := httptest.NewRequest(http.MethodPost, "/internal/auth/check", body)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("internal endpoint without token should be hidden: %d", response.Code)
	}
	request = httptest.NewRequest(http.MethodPost, "/internal/auth/check", bytes.NewBufferString(`{"api_key":"`+key+`"}`))
	request.Header.Set("X-Internal-Token", "internal-secret")
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", response.Code)
	}
	var result map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result["ok"] != true {
		t.Fatalf("unexpected auth result: %#v", result)
	}
}

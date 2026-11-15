package files

import (
	"net/http"
	"net/http/httptest"
	"slideforge/services/gateway/internal/billing"
	"testing"
)

func TestPaidFileRemainsDownloadableAtZeroBalance(t *testing.T) {
	dir := t.TempDir()
	b := billing.NewStore(dir)
	f := NewStore(dir)
	key, _, _ := b.Issue("customer", 10)
	if _, err := b.Charge(key, "deck-paid", "export", 10); err != nil {
		t.Fatal(err)
	}
	record, err := f.Publish("deck-paid", "paid.pdf", "application/pdf", billing.HashAPIKey(key), []byte("%PDF-paid"))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	NewHTTPHandler(f, b, "internal").Register(mux)
	request := httptest.NewRequest("GET", record.DownloadURL, nil)
	request.Header.Set("X-API-Key", key)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("paid file denied: %d %s", response.Code, response.Body.String())
	}
}

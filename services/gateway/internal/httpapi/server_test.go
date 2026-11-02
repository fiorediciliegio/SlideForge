package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"slideforge/services/gateway/internal/config"
)

func TestHealthIncludesRequestID(t *testing.T) {
	application := newTestApplication(t, testConfig(t, "http://127.0.0.1:3210"), testLogger())
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", response.Code)
	}
	if response.Header().Get("X-Request-ID") == "" {
		t.Fatal("missing request id")
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["ok"] != true || body["service"] != "slideforge-gateway" {
		t.Fatalf("unexpected health response: %#v", body)
	}
}

func TestProxyPreservesRequestContract(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.RequestURI() != "/engine/deck-Shared-123?pages=1" {
			t.Errorf("unexpected upstream URI: %s", request.URL.RequestURI())
		}
		if request.Header.Get("X-API-Key") != "sk-test" {
			t.Errorf("API key was not forwarded")
		}
		if request.Header.Get("X-Request-ID") != "request-test-1" {
			t.Errorf("request id was not forwarded")
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"deck_id":"deck-Shared-123","status":"ready"}`))
	}))
	defer upstream.Close()
	application := newTestApplication(t, testConfig(t, upstream.URL), testLogger())
	request := httptest.NewRequest(http.MethodGet, "/engine/deck-Shared-123?pages=1", nil)
	request.Header.Set("X-API-Key", "sk-test")
	request.Header.Set("X-Request-ID", "request-test-1")
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", response.Code)
	}
	if response.Body.String() != `{"deck_id":"deck-Shared-123","status":"ready"}` {
		t.Fatalf("unexpected proxy response: %s", response.Body.String())
	}
}

func TestReadinessAndProxyFailuresUseSharedErrorShape(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	upstreamURL := upstream.URL
	upstream.Close()
	application := newTestApplication(t, testConfig(t, upstreamURL), testLogger())
	for _, path := range []string{"/readyz", "/engine/deck-a"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := httptest.NewRecorder()
		application.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusServiceUnavailable && response.Code != http.StatusBadGateway {
			t.Fatalf("unexpected status for %s: %d", path, response.Code)
		}
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body["error"] == "" || body["error_code"] == "" || body["retryable"] != true {
			t.Fatalf("unexpected error response: %#v", body)
		}
	}
}

func TestReadyChecksCapabilityEngineAndBrain(t *testing.T) {
	newHealthy := func() *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			_, _ = writer.Write([]byte(`{"ok":true}`))
		}))
	}
	capability := newHealthy()
	defer capability.Close()
	engine := newHealthy()
	defer engine.Close()
	brain := newHealthy()
	cfg := testConfig(t, capability.URL)
	cfg.NodeEngineURL, _ = url.Parse(engine.URL)
	cfg.BrainURL, _ = url.Parse(brain.URL)
	application := newTestApplication(t, cfg, testLogger())
	request := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("all services should be ready: %d", response.Code)
	}
	brain.Close()
	response = httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "brain") {
		t.Fatalf("brain failure should be identified: %d %s", response.Code, response.Body.String())
	}
}

func testConfig(t *testing.T, upstream string) config.Config {
	t.Helper()
	parsed, err := url.Parse(upstream)
	if err != nil {
		t.Fatal(err)
	}
	return config.Config{
		EngineUpstream:  parsed,
		UpstreamTimeout: 500 * time.Millisecond,
		DataDir:         t.TempDir(),
	}
}

func newTestApplication(t *testing.T, cfg config.Config, logger *slog.Logger) *Server {
	t.Helper()
	application, err := New(cfg, logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	return application
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

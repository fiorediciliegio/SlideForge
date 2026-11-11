package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"slideforge/services/gateway/internal/billing"
	"slideforge/services/gateway/internal/config"
	"slideforge/services/gateway/internal/files"
	"slideforge/services/gateway/internal/jobs"
)

type Server struct {
	config       config.Config
	logger       *slog.Logger
	handler      http.Handler
	readyClient  *http.Client
	dispatcher   *jobs.Dispatcher
	closeBilling func() error
	closeJobs    func() error
	closeFiles   func() error
	stopAgents   context.CancelFunc
}

func New(cfg config.Config, logger *slog.Logger) (*Server, error) {
	server := &Server{
		config:      cfg,
		logger:      logger,
		readyClient: &http.Client{Timeout: cfg.UpstreamTimeout},
	}
	var jobStore jobs.StoreAPI
	if cfg.JobsDatabaseURL != "" {
		postgres, err := jobs.NewPostgresStore(context.Background(), cfg.JobsDatabaseURL)
		if err != nil {
			return nil, fmt.Errorf("initialize PostgreSQL job store: %w", err)
		}
		if cfg.MigrateJSON {
			if err := postgres.MigrateJSON(context.Background(), cfg.DataDir); err != nil {
				_ = postgres.Close()
				return nil, fmt.Errorf("migrate JSON job store: %w", err)
			}
		}
		server.closeJobs = postgres.Close
		if cfg.GatewayReplicas <= 1 {
			if err := postgres.RecoverAgents(context.Background()); err != nil {
				_ = postgres.Close()
				return nil, fmt.Errorf("recover PostgreSQL Agent executions: %w", err)
			}
		}
		server.dispatcher = jobs.NewPostgresDispatcher(cfg.DataDir, postgres, nil, 3, time.Second)
		jobStore = postgres
	} else {
		local, err := jobs.NewStore(cfg.DataDir)
		if err != nil {
			return nil, err
		}
		server.dispatcher = jobs.NewDispatcher(cfg.DataDir, nil, 3, time.Second)
		jobStore = local
		jobStore.SetDeliveryHandler(server.dispatcher.Enqueue)
	}
	var billingStore billing.StoreAPI
	if cfg.DatabaseURL != "" {
		postgres, err := billing.NewPostgresStore(context.Background(), cfg.DatabaseURL)
		if err != nil {
			return nil, fmt.Errorf("initialize PostgreSQL billing store: %w", err)
		}
		if cfg.MigrateJSON {
			if err := postgres.MigrateJSON(context.Background(), cfg.DataDir); err != nil {
				_ = postgres.Close()
				return nil, fmt.Errorf("migrate JSON billing store: %w", err)
			}
		}
		server.closeBilling = postgres.Close
		billingStore = postgres
	} else {
		billingStore = billing.NewStore(cfg.DataDir)
	}
	var fileStore files.StoreAPI
	if cfg.FilesDatabaseURL != "" {
		objects, err := files.NewS3ObjectStore(files.S3Config{
			Endpoint: cfg.S3Endpoint, Bucket: cfg.S3Bucket, Region: cfg.S3Region,
			AccessKeyID: cfg.S3AccessKeyID, SecretAccessKey: cfg.S3SecretAccessKey,
			ForcePathStyle: cfg.S3ForcePathStyle,
		}, nil)
		if err != nil {
			return nil, fmt.Errorf("initialize S3 object store: %w", err)
		}
		postgres, err := files.NewPostgresFileStore(context.Background(), cfg.FilesDatabaseURL, objects)
		if err != nil {
			return nil, fmt.Errorf("initialize PostgreSQL file store: %w", err)
		}
		if cfg.MigrateJSON {
			if err := postgres.MigrateJSON(context.Background(), cfg.DataDir); err != nil {
				_ = postgres.Close()
				return nil, fmt.Errorf("migrate JSON file store: %w", err)
			}
		}
		server.closeFiles = postgres.Close
		fileStore = postgres
	} else {
		fileStore = files.NewStore(cfg.DataDir)
	}
	mux := http.NewServeMux()
	agentContext, stopAgents := context.WithCancel(context.Background())
	server.stopAgents = stopAgents
	go jobs.WatchAgents(agentContext, jobStore)
	mux.HandleFunc("/healthz", server.handleHealth)
	mux.HandleFunc("/readyz", server.handleReady)
	billing.NewHTTPHandler(billingStore, cfg.InternalToken, cfg.AdminToken).Register(mux)
	jobs.NewHTTPHandler(jobStore, billingStore, cfg.InternalToken).Register(mux)
	files.NewHTTPHandler(fileStore, billingStore, cfg.InternalToken).Register(mux)
	mux.Handle("/", server.newEngineProxy())
	server.handler = server.withRequestLogging(mux)
	return server, nil
}

func (s *Server) Handler() http.Handler {
	return s.handler
}

func (s *Server) Close() {
	if s.stopAgents != nil {
		s.stopAgents()
	}
	if s.dispatcher != nil {
		s.dispatcher.Close()
	}
	if s.closeBilling != nil {
		_ = s.closeBilling()
	}
	if s.closeJobs != nil {
		_ = s.closeJobs()
	}
	if s.closeFiles != nil {
		_ = s.closeFiles()
	}
}

func (s *Server) handleHealth(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeError(writer, http.StatusMethodNotAllowed, "method not allowed", "method_not_allowed", false)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "slideforge-gateway",
	})
}

func (s *Server) handleReady(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeError(writer, http.StatusMethodNotAllowed, "method not allowed", "method_not_allowed", false)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), s.config.UpstreamTimeout)
	defer cancel()
	targets := []struct {
		name string
		url  *url.URL
	}{
		{name: "capability", url: s.config.EngineUpstream},
		{name: "engine", url: s.config.NodeEngineURL},
		{name: "brain", url: s.config.BrainURL},
	}
	for _, target := range targets {
		if target.url == nil {
			continue
		}
		readyURL := *target.url
		readyURL.Path = strings.TrimSuffix(readyURL.Path, "/") + "/healthz"
		readyURL.RawQuery = ""
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, readyURL.String(), nil)
		if err != nil {
			writeError(writer, http.StatusServiceUnavailable, "上游地址无效："+target.name, "upstream_unavailable", true)
			return
		}
		response, err := s.readyClient.Do(req)
		if err != nil {
			writeError(writer, http.StatusServiceUnavailable, "上游不可用："+target.name, "upstream_unavailable", true)
			return
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			writeError(writer, http.StatusServiceUnavailable, "上游未就绪："+target.name, "upstream_not_ready", true)
			return
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "slideforge-gateway",
	})
}

func (s *Server) newEngineProxy() http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(s.config.EngineUpstream)
	originalDirector := proxy.Director
	proxy.Director = func(request *http.Request) {
		forwardedHost := request.Host
		originalDirector(request)
		request.Host = s.config.EngineUpstream.Host
		request.Header.Set("X-Forwarded-Host", forwardedHost)
		if request.Header.Get("X-Forwarded-Proto") == "" {
			request.Header.Set("X-Forwarded-Proto", "http")
		}
	}
	proxy.ErrorHandler = func(writer http.ResponseWriter, request *http.Request, err error) {
		s.logger.Error("engine upstream request failed", "error", err, "path", request.URL.Path)
		writeError(writer, http.StatusBadGateway, "引擎上游请求失败", "upstream_bad_gateway", true)
	}
	return proxy
}

func (s *Server) withRequestLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		started := time.Now()
		requestID := request.Header.Get("X-Request-ID")
		if requestID == "" || len(requestID) > 128 {
			requestID = newRequestID()
		}
		request.Header.Set("X-Request-ID", requestID)
		writer.Header().Set("X-Request-ID", requestID)
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(writer, request)
		s.logger.Info("http request completed",
			"request_id", requestID,
			"method", request.Method,
			"path", request.URL.Path,
			"duration_ms", time.Since(started).Milliseconds(),
		)
	})
}

func newRequestID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return time.Now().UTC().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(value[:])
}

func writeError(writer http.ResponseWriter, status int, message string, code string, retryable bool) {
	writeJSON(writer, status, map[string]any{
		"error":      message,
		"error_code": code,
		"retryable":  retryable,
	})
}

func writeJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}

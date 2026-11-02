package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"slideforge/services/gateway/internal/config"
	"slideforge/services/gateway/internal/httpapi"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid gateway configuration", "error", err)
		os.Exit(1)
	}
	application, err := httpapi.New(cfg, logger)
	if err != nil {
		logger.Error("failed to initialize gateway stores", "error", err)
		os.Exit(1)
	}
	defer application.Close()
	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           application.Handler(),
		ReadHeaderTimeout: cfg.ReadHeaderTimeout,
		ReadTimeout:       cfg.ReadTimeout,
		WriteTimeout:      cfg.WriteTimeout,
		IdleTimeout:       cfg.IdleTimeout,
	}

	serveErrors := make(chan error, 1)
	go func() {
		logger.Info("slideforge gateway listening", "address", server.Addr, "engine_upstream", cfg.EngineUpstream.String())
		serveErrors <- server.ListenAndServe()
	}()

	signals, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case err := <-serveErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("gateway stopped unexpectedly", "error", err)
			os.Exit(1)
		}
	case <-signals.Done():
		logger.Info("gateway shutdown requested")
		ctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			logger.Error("gateway graceful shutdown failed", "error", err)
			_ = server.Close()
			os.Exit(1)
		}
		logger.Info("gateway stopped", "at", time.Now().UTC())
	}
}

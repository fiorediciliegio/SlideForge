package jobs

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"slideforge/services/gateway/internal/billing"
)

type HTTPHandler struct {
	store         StoreAPI
	billing       billing.StoreAPI
	internalToken string
}

func NewHTTPHandler(store StoreAPI, billingStore billing.StoreAPI, internalToken string) *HTTPHandler {
	return &HTTPHandler{store: store, billing: billingStore, internalToken: internalToken}
}

func (h *HTTPHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/internal/jobs", h.handleInternal)
	mux.HandleFunc("/internal/jobs/agent", h.handleAgent)
	mux.HandleFunc("GET /decks", h.handleList)
	mux.HandleFunc("GET /decks/{id}", h.handleGet)
	mux.HandleFunc("GET /decks/{id}/events", h.handleEvents)
	mux.HandleFunc("POST /decks/{id}/cancel", h.handleCancel)
	mux.HandleFunc("POST /decks/{id}/webhooks", h.handleWebhook)
}

func (h *HTTPHandler) handleAgent(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || h.internalToken == "" || subtle.ConstantTimeCompare([]byte(request.Header.Get("X-Internal-Token")), []byte(h.internalToken)) != 1 {
		writeJobError(writer, 404, "not found", "not_found")
		return
	}
	var command AgentCommand
	if err := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 8*1024*1024)).Decode(&command); err != nil {
		writeJobError(writer, 400, "JSON 请求体格式错误", "bad_request")
		return
	}
	job, err := h.store.MutateAgent(command)
	if err != nil {
		code := "conflict"
		status := 409
		if errors.Is(err, ErrBudgetExhausted) {
			code = "budget_exhausted"
			status = 402
		}
		if errors.Is(err, ErrBudgetInFlight) {
			code = "budget_inflight"
		}
		if errors.Is(err, ErrUnknownCall) {
			code = "unknown_calls"
		}
		writeJobError(writer, status, err.Error(), code)
		return
	}
	writeJobJSON(writer, 200, map[string]any{"job": job})
}

func (h *HTTPHandler) handleInternal(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || h.internalToken == "" || subtle.ConstantTimeCompare([]byte(request.Header.Get("X-Internal-Token")), []byte(h.internalToken)) != 1 {
		writeJobError(writer, http.StatusNotFound, "not found", "not_found")
		return
	}
	var body struct {
		Action string `json:"action"`
		DeckID string `json:"deck_id"`
		Job    Job    `json:"job"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 4*1024*1024)).Decode(&body); err != nil {
		writeJobError(writer, http.StatusBadRequest, "JSON 请求体格式错误", "bad_request")
		return
	}
	switch body.Action {
	case "create":
		if err := h.store.Create(body.Job); err != nil {
			writeJobError(writer, http.StatusConflict, err.Error(), "conflict")
			return
		}
		writeJobJSON(writer, http.StatusOK, map[string]any{"job": body.Job})
	case "get":
		job, ok := h.store.Get(body.DeckID)
		if !ok {
			writeJobJSON(writer, http.StatusOK, map[string]any{"job": nil})
			return
		}
		writeJobJSON(writer, http.StatusOK, map[string]any{"job": job})
	case "list":
		writeJobJSON(writer, http.StatusOK, map[string]any{"jobs": h.store.List()})
	case "save":
		if err := h.store.Save(body.Job); err != nil {
			writeJobError(writer, http.StatusNotFound, err.Error(), "not_found")
			return
		}
		writeJobJSON(writer, http.StatusOK, map[string]any{"job": body.Job})
	case "delete":
		h.store.Delete(body.DeckID)
		writeJobJSON(writer, http.StatusOK, map[string]any{"ok": true})
	default:
		writeJobError(writer, http.StatusBadRequest, "unknown job action", "bad_request")
	}
}

func (h *HTTPHandler) handleList(writer http.ResponseWriter, request *http.Request) {
	owner, ok := h.authorize(writer, request)
	if !ok {
		return
	}
	jobs := make([]map[string]any, 0)
	for _, job := range h.store.List() {
		if job.OwnerKeyHash == owner {
			jobs = append(jobs, publicJob(job, 2))
		}
	}
	writeJobJSON(writer, http.StatusOK, jobs)
}

func (h *HTTPHandler) handleGet(writer http.ResponseWriter, request *http.Request) {
	job, ok := h.ownedJob(writer, request, request.PathValue("id"))
	if !ok {
		return
	}
	writeJobJSON(writer, http.StatusOK, publicJob(job, 8))
}

func (h *HTTPHandler) handleCancel(writer http.ResponseWriter, request *http.Request) {
	_, ok := h.ownedJob(writer, request, request.PathValue("id"))
	if !ok {
		return
	}
	job, _, err := h.store.Cancel(request.PathValue("id"))
	if err != nil {
		writeJobError(writer, http.StatusInternalServerError, err.Error(), "internal_error")
		return
	}
	writeJobJSON(writer, http.StatusOK, publicJob(job, 8))
}

func (h *HTTPHandler) handleWebhook(writer http.ResponseWriter, request *http.Request) {
	_, ok := h.ownedJob(writer, request, request.PathValue("id"))
	if !ok {
		return
	}
	var body WebhookConfig
	if err := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 64*1024)).Decode(&body); err != nil {
		writeJobError(writer, http.StatusBadRequest, "JSON 请求体格式错误", "bad_request")
		return
	}
	parsed, err := url.Parse(body.URL)
	loopback := parsed != nil && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1")
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopback)) {
		writeJobError(writer, http.StatusBadRequest, "webhook 必须使用 HTTPS，本地开发仅允许 loopback HTTP", "bad_request")
		return
	}
	if len(body.Secret) < 16 {
		writeJobError(writer, http.StatusBadRequest, "webhook secret 至少 16 字符", "bad_request")
		return
	}
	if err := h.store.SetWebhook(request.PathValue("id"), body); err != nil {
		writeJobError(writer, http.StatusNotFound, err.Error(), "not_found")
		return
	}
	writeJobJSON(writer, http.StatusOK, map[string]any{"url": body.URL})
}

func (h *HTTPHandler) handleEvents(writer http.ResponseWriter, request *http.Request) {
	job, ok := h.ownedJob(writer, request, request.PathValue("id"))
	if !ok {
		return
	}
	flusher, ok := writer.(http.Flusher)
	if !ok {
		writeJobError(writer, http.StatusInternalServerError, "SSE unavailable", "internal_error")
		return
	}
	writer.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-cache")
	writer.Header().Set("Connection", "keep-alive")
	writeSSE(writer, job)
	flusher.Flush()
	updates, unsubscribe := h.store.Subscribe(job.ID)
	defer unsubscribe()
	for {
		select {
		case <-request.Context().Done():
			return
		case update := <-updates:
			writeSSE(writer, update)
			flusher.Flush()
		}
	}
}

func (h *HTTPHandler) authorize(writer http.ResponseWriter, request *http.Request) (string, bool) {
	apiKey := request.Header.Get("X-API-Key")
	ok, reason, err := h.billing.Check(apiKey)
	if err != nil {
		writeJobError(writer, http.StatusInternalServerError, err.Error(), "internal_error")
		return "", false
	}
	if !ok {
		writeJobError(writer, http.StatusPaymentRequired, reason, "payment_required")
		return "", false
	}
	return billing.HashAPIKey(apiKey), true
}

func (h *HTTPHandler) ownedJob(writer http.ResponseWriter, request *http.Request, id string) (Job, bool) {
	owner, ok := h.authorize(writer, request)
	if !ok {
		return Job{}, false
	}
	job, exists := h.store.Get(id)
	if !exists || job.OwnerKeyHash != owner {
		writeJobError(writer, http.StatusNotFound, "deck 不存在", "not_found")
		return Job{}, false
	}
	return job, true
}

func publicJob(job Job, eventLimit int) map[string]any {
	events := job.Events
	if len(events) > eventLimit {
		events = events[len(events)-eventLimit:]
	}
	result := map[string]any{
		"deck_id": job.ID, "status": job.Status, "title": job.Title,
		"recent_events": events, "overflow_pages": job.OverflowPages,
		"billing": job.Billing, "error": job.Error, "cancelled": job.Cancelled,
	}
	if job.Agent != nil {
		run := job.Agent
		unknown := []map[string]any{}
		qualityState := "draft"
		if run.QualityRevision != "" && run.QualityRevision == revisionOf(run.ProjectRef) {
			qualityState = "checked"
		}
		for id, call := range run.Calls {
			if call.Status == "unknown" {
				unknown = append(unknown, map[string]any{"call_id": id, "reserved_cny": call.Cost})
			}
		}
		result["agent"] = map[string]any{"version": run.Version, "run_seq": run.RunSeq, "checkpoint_seq": run.Checkpoint, "phase": run.Phase, "options": run.Options, "draft_revision": run.DraftRevision, "preview_revision": revisionOf(run.ProjectRef), "budget": run.Budget, "request": run.Request, "unknown_calls": unknown, "error": run.Error, "quality_state": qualityState}
		waits := map[string]int{}
		for _, state := range run.WorkStates {
			if state != "local" {
				waits[state]++
			}
		}
		result["agent"].(map[string]any)["resource_waits"] = waits
	}
	return result
}

func writeSSE(writer http.ResponseWriter, job Job) {
	data, _ := json.Marshal(publicJob(job, 8))
	_, _ = fmt.Fprintf(writer, "event: job\ndata: %s\n\n", strings.ReplaceAll(string(data), "\n", ""))
}

func writeJobError(writer http.ResponseWriter, status int, message, code string) {
	writeJobJSON(writer, status, map[string]any{"error": message, "error_code": code, "retryable": status >= 500})
}

func writeJobJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}

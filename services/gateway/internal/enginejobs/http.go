package enginejobs

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"slideforge/services/gateway/internal/billing"
	"slideforge/services/gateway/internal/files"
)

type HTTPHandler struct {
	store   *Store
	token   string
	billing billing.StoreAPI
	files   files.StoreAPI
}

func NewHTTPHandler(s *Store, b billing.StoreAPI, f files.StoreAPI, token string) *HTTPHandler {
	return &HTTPHandler{s, token, b, f}
}
func (h *HTTPHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /internal/engine/artifacts", h.authorized(h.artifacts))
	mux.HandleFunc("POST /internal/engine/jobs", h.authorized(h.jobs))
	mux.HandleFunc("POST /internal/engine/claim", h.authorized(h.claim))
}
func respond(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}
func failure(w http.ResponseWriter, err error) {
	code := 500
	if errors.Is(err, ErrConflict) {
		code = 409
	} else if errors.Is(err, ErrNotFound) {
		code = 404
	} else if errors.Is(err, ErrQueueFull) {
		code = 429
	}
	respond(w, code, map[string]any{"error": err.Error(), "error_code": "engine_error", "retryable": false})
}
func (h *HTTPHandler) authorized(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.token == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Internal-Token")), []byte(h.token)) != 1 {
			respond(w, 404, map[string]string{"error": "not found"})
			return
		}
		next(w, r)
	}
}
func decode(w http.ResponseWriter, r *http.Request, value any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 96*1024*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		respond(w, 400, map[string]string{"error": "JSON 请求无效或过大"})
		return false
	}
	return true
}
func (h *HTTPHandler) artifacts(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action  string `json:"action"`
		ID      string `json:"artifact_id"`
		Owner   string `json:"owner_key_hash"`
		Deck    string `json:"deck_id"`
		Media   string `json:"media_type"`
		Content string `json:"content_base64"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Action == "read" {
		content, err := h.store.ReadArtifact(body.ID, body.Owner)
		if err != nil {
			failure(w, err)
			return
		}
		respond(w, 200, map[string]string{"content_base64": base64.StdEncoding.EncodeToString(content)})
		return
	}
	if body.Action != "put" {
		respond(w, 400, map[string]string{"error": "未知私有文件操作"})
		return
	}
	content, err := base64.StdEncoding.DecodeString(body.Content)
	if err != nil {
		respond(w, 400, map[string]string{"error": "content_base64 无效"})
		return
	}
	a, err := h.store.PutArtifact(body.Owner, body.Deck, body.Media, content)
	if err != nil {
		failure(w, err)
		return
	}
	respond(w, 200, map[string]any{"artifact": a})
}
func (h *HTTPHandler) claim(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Worker string `json:"worker_id"`
	}
	if !decode(w, r, &body) {
		return
	}
	j, err := h.store.Claim(body.Worker)
	if err != nil {
		failure(w, err)
		return
	}
	respond(w, 200, map[string]any{"job": j})
}
func (h *HTTPHandler) jobs(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action  string   `json:"action"`
		Request *Request `json:"request"`
		ID      string   `json:"job_id"`
		Owner   string   `json:"owner_key_hash"`
		Token   string   `json:"lease_token"`
		Result  string   `json:"result_ref"`
		Error   string   `json:"error"`
	}
	if !decode(w, r, &body) {
		return
	}
	var j Job
	var err error
	switch body.Action {
	case "submit":
		if body.Request == nil {
			respond(w, 400, map[string]string{"error": "缺少 request"})
			return
		}
		j, err = h.store.Submit(*body.Request)
	case "get":
		j, err = h.store.Get(body.ID)
		if err == nil && j.Owner != body.Owner {
			err = ErrNotFound
		}
	case "cancel":
		j, err = h.store.Cancel(body.ID, body.Owner)
	case "heartbeat", "complete", "fail":
		j, err = h.store.Update(body.ID, body.Token, body.Action, body.Result, body.Error)
	case "deliver":
		receipt, err := h.deliver(body.ID, body.Owner)
		if err != nil {
			failure(w, err)
			return
		}
		respond(w, 200, receipt)
		return
	default:
		respond(w, 400, map[string]string{"error": "未知引擎任务操作"})
		return
	}
	if err != nil {
		failure(w, err)
		return
	}
	respond(w, 200, map[string]any{"job": j})
}

// File transfer is outside the scheduler transaction. Billing and file publication
// both use the same durable job ID, so concurrent/lost acknowledgements converge.
func (h *HTTPHandler) deliver(id, owner string) (json.RawMessage, error) {
	j, err := h.store.Get(id)
	if err != nil {
		return nil, err
	}
	if j.Owner != owner {
		return nil, ErrNotFound
	}
	if j.State != "completed" || j.Kind != "export" {
		return nil, ErrConflict
	}
	if len(j.Delivery) > 0 {
		return j.Delivery, nil
	}
	output, err := h.store.ReadArtifact(j.ResultRef, owner)
	if err != nil {
		return nil, err
	}
	var result struct {
		FileRef    string   `json:"file_ref"`
		Name       string   `json:"name"`
		Media      string   `json:"media_type"`
		SlideCount int      `json:"slide_count"`
		Warnings   []string `json:"warnings"`
	}
	if err = json.Unmarshal(output, &result); err != nil {
		return nil, err
	}
	a, content, err := h.store.readArtifact(result.FileRef, owner)
	if err != nil {
		return nil, err
	}
	if a.DeckID != j.DeckID {
		return nil, ErrNotFound
	}
	charge, err := h.billing.ChargeOwner(owner, j.DeckID, "engine-export:"+id, 10)
	if err != nil {
		return nil, err
	}
	file, err := h.files.PublishOnce(id, j.DeckID, result.Name, result.Media, owner, content)
	if err != nil {
		return nil, err
	}
	receipt, err := json.Marshal(map[string]any{"file_id": file.ID, "download_url": file.DownloadURL, "sizeBytes": file.SizeBytes, "slideCount": result.SlideCount, "warnings": result.Warnings, "billing": charge, "export_id": id, "idempotent": true})
	if err != nil {
		return nil, err
	}
	err = h.store.tx(true, func(st *state) error {
		current, ok := st.Jobs[id]
		if !ok || current.State != "completed" {
			return ErrConflict
		}
		if len(current.Delivery) > 0 {
			receipt = current.Delivery
			return nil
		}
		current.Delivery = receipt
		st.Jobs[id] = current
		return nil
	})
	return receipt, err
}

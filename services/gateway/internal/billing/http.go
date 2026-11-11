package billing

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
)

type HTTPHandler struct {
	store         StoreAPI
	internalToken string
	adminToken    string
}

func NewHTTPHandler(store StoreAPI, internalToken, adminToken string) *HTTPHandler {
	return &HTTPHandler{store: store, internalToken: internalToken, adminToken: adminToken}
}

func (h *HTTPHandler) Register(mux *http.ServeMux) {
	mux.Handle("/internal/auth/check", h.internal(h.check))
	mux.Handle("/internal/billing/settle", h.internal(h.settle))
	mux.Handle("/internal/billing/charge", h.internal(h.charge))
	mux.Handle("/internal/billing/usage", h.internal(h.usage))
	mux.Handle("/internal/billing/ledger", h.internal(h.ledger))
	mux.Handle("/admin/keys", h.admin(h.keys))
	mux.Handle("/admin/keys/recharge", h.admin(h.recharge))
}

func (h *HTTPHandler) internal(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if h.internalToken == "" || subtle.ConstantTimeCompare([]byte(request.Header.Get("X-Internal-Token")), []byte(h.internalToken)) != 1 {
			writeAPIError(writer, http.StatusNotFound, "not found", "not_found", false)
			return
		}
		if request.Method != http.MethodPost {
			writeAPIError(writer, http.StatusMethodNotAllowed, "method not allowed", "method_not_allowed", false)
			return
		}
		next(writer, request)
	})
}

func (h *HTTPHandler) admin(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if h.adminToken != "" && request.Header.Get("X-Admin-Token") != h.adminToken {
			writeAPIError(writer, http.StatusUnauthorized, "admin unauthorized", "unauthorized", false)
			return
		}
		next(writer, request)
	})
}

func (h *HTTPHandler) check(writer http.ResponseWriter, request *http.Request) {
	var body struct {
		APIKey string `json:"api_key"`
	}
	if !decode(writer, request, &body) {
		return
	}
	ok, reason, err := h.store.Check(body.APIKey)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, err.Error(), "internal_error", true)
		return
	}
	writeAPIJSON(writer, http.StatusOK, map[string]any{"ok": ok, "reason": reason})
}

func (h *HTTPHandler) settle(writer http.ResponseWriter, request *http.Request) {
	var body struct {
		APIKey           string  `json:"api_key"`
		DeckID           string  `json:"deck_id"`
		PromptTokens     float64 `json:"prompt_tokens"`
		CompletionTokens float64 `json:"completion_tokens"`
		InputPerK        float64 `json:"input_points_per_k"`
		OutputPerK       float64 `json:"output_points_per_k"`
	}
	if !decode(writer, request, &body) {
		return
	}
	if body.InputPerK == 0 {
		body.InputPerK = 0.2
	}
	if body.OutputPerK == 0 {
		body.OutputPerK = 0.8
	}
	receipt, err := h.store.Settle(body.APIKey, body.DeckID, body.PromptTokens, body.CompletionTokens, body.InputPerK, body.OutputPerK)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, err.Error(), "internal_error", true)
		return
	}
	writeAPIJSON(writer, http.StatusOK, receipt)
}

func (h *HTTPHandler) charge(writer http.ResponseWriter, request *http.Request) {
	var body struct {
		APIKey      string  `json:"api_key"`
		DeckID      string  `json:"deck_id"`
		Kind        string  `json:"kind"`
		Points      float64 `json:"points"`
		OperationID string  `json:"operation_id"`
		OwnerHash   string  `json:"owner_key_hash"`
	}
	if !decode(writer, request, &body) {
		return
	}
	if body.Kind != "export" {
		writeAPIError(writer, http.StatusBadRequest, "unsupported charge kind", "bad_request", false)
		return
	}
	var receipt ChargeReceipt
	var err error
	if body.OwnerHash != "" && body.APIKey == "" {
		receipt, err = h.store.ChargeOwner(body.OwnerHash, body.DeckID, body.OperationID, body.Points)
	} else {
		receipt, err = h.store.Charge(body.APIKey, body.DeckID, body.OperationID, body.Points)
	}
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, err.Error(), "internal_error", true)
		return
	}
	writeAPIJSON(writer, http.StatusOK, receipt)
}

func (h *HTTPHandler) usage(writer http.ResponseWriter, request *http.Request) {
	var body struct {
		APIKey string `json:"api_key"`
	}
	if !decode(writer, request, &body) {
		return
	}
	usage, err := h.store.Usage(body.APIKey)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, err.Error(), "internal_error", true)
		return
	}
	writeAPIJSON(writer, http.StatusOK, usage)
}

func (h *HTTPHandler) ledger(writer http.ResponseWriter, request *http.Request) {
	var body struct {
		Limit int `json:"limit"`
	}
	if !decode(writer, request, &body) {
		return
	}
	result, err := h.store.Ledger(body.Limit)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, err.Error(), "internal_error", true)
		return
	}
	writeAPIJSON(writer, http.StatusOK, result)
}

func (h *HTTPHandler) keys(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		keys, err := h.store.List()
		if err != nil {
			writeAPIError(writer, http.StatusInternalServerError, err.Error(), "internal_error", true)
			return
		}
		writeAPIJSON(writer, http.StatusOK, keys)
	case http.MethodPost:
		var body struct {
			Name   string  `json:"name"`
			Points float64 `json:"points"`
		}
		if !decode(writer, request, &body) {
			return
		}
		if strings.TrimSpace(body.Name) == "" {
			writeAPIError(writer, http.StatusBadRequest, "name 不能为空", "bad_request", false)
			return
		}
		key, balance, err := h.store.Issue(strings.TrimSpace(body.Name), body.Points)
		if err != nil {
			writeAPIError(writer, http.StatusBadRequest, err.Error(), "bad_request", false)
			return
		}
		writeAPIJSON(writer, http.StatusOK, map[string]any{"key": key, "balance": balance})
	default:
		writeAPIError(writer, http.StatusMethodNotAllowed, "method not allowed", "method_not_allowed", false)
	}
}

func (h *HTTPHandler) recharge(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method not allowed", "method_not_allowed", false)
		return
	}
	var body struct {
		Key    string  `json:"key"`
		Points float64 `json:"points"`
	}
	if !decode(writer, request, &body) {
		return
	}
	balance, err := h.store.Recharge(body.Key, body.Points)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error(), "bad_request", false)
		return
	}
	writeAPIJSON(writer, http.StatusOK, map[string]any{"balance": balance})
}

func decode(writer http.ResponseWriter, request *http.Request, target any) bool {
	defer request.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 1024*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "JSON 请求体格式错误", "bad_request", false)
		return false
	}
	return true
}

func writeAPIError(writer http.ResponseWriter, status int, message, code string, retryable bool) {
	writeAPIJSON(writer, status, map[string]any{"error": message, "error_code": code, "retryable": retryable})
}

func writeAPIJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}

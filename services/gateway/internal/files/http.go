package files

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strconv"
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
	mux.HandleFunc("/internal/files", h.handlePublish)
	mux.HandleFunc("GET /files/{id}", h.handleDownload)
	mux.HandleFunc("GET /decks/{id}/files", h.handleList)
}

func (h *HTTPHandler) handlePublish(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || h.internalToken == "" || subtle.ConstantTimeCompare([]byte(request.Header.Get("X-Internal-Token")), []byte(h.internalToken)) != 1 {
		writeFileError(writer, http.StatusNotFound, "not found")
		return
	}
	var body struct {
		DeckID       string `json:"deck_id"`
		Name         string `json:"name"`
		MediaType    string `json:"media_type"`
		Content      string `json:"content_base64"`
		OwnerKeyHash string `json:"ownerKeyHash"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 96*1024*1024)).Decode(&body); err != nil {
		writeFileError(writer, http.StatusBadRequest, "JSON 请求体格式错误或过大")
		return
	}
	content, err := DecodeBase64(body.Content)
	if err != nil {
		writeFileError(writer, http.StatusBadRequest, err.Error())
		return
	}
	record, err := h.store.Publish(body.DeckID, body.Name, body.MediaType, body.OwnerKeyHash, content)
	if err != nil {
		writeFileError(writer, http.StatusBadRequest, err.Error())
		return
	}
	writeFileJSON(writer, http.StatusOK, publicRecord(record))
}

func (h *HTTPHandler) handleDownload(writer http.ResponseWriter, request *http.Request) {
	owner, ok := h.authorize(writer, request)
	if !ok {
		return
	}
	record, exists, err := h.store.Get(request.PathValue("id"))
	if err != nil {
		writeFileError(writer, http.StatusInternalServerError, err.Error())
		return
	}
	if !exists || record.OwnerKeyHash != owner {
		writeFileError(writer, http.StatusNotFound, "file 不存在")
		return
	}
	content, err := h.store.Read(record)
	if err != nil {
		writeFileError(writer, http.StatusNotFound, "file 内容不存在")
		return
	}
	writer.Header().Set("Content-Type", record.MediaType)
	writer.Header().Set("Content-Length", strconv.Itoa(len(content)))
	writer.Header().Set("Content-Disposition", "attachment; filename=\""+strings.ReplaceAll(record.Name, "\"", "_")+"\"")
	writer.Header().Set("Cache-Control", "private, no-store")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(content)
}

func (h *HTTPHandler) handleList(writer http.ResponseWriter, request *http.Request) {
	owner, ok := h.authorize(writer, request)
	if !ok {
		return
	}
	records, err := h.store.ListDeck(request.PathValue("id"), owner)
	if err != nil {
		writeFileError(writer, http.StatusInternalServerError, err.Error())
		return
	}
	result := make([]map[string]any, 0, len(records))
	for _, record := range records {
		result = append(result, publicRecord(record))
	}
	writeFileJSON(writer, http.StatusOK, result)
}

func (h *HTTPHandler) authorize(writer http.ResponseWriter, request *http.Request) (string, bool) {
	apiKey := request.Header.Get("X-API-Key")
	ok, reason, err := h.billing.Check(apiKey)
	if err != nil {
		writeFileError(writer, http.StatusInternalServerError, err.Error())
		return "", false
	}
	if !ok {
		writeFileError(writer, http.StatusPaymentRequired, reason)
		return "", false
	}
	return billing.HashAPIKey(apiKey), true
}

func publicRecord(record Record) map[string]any {
	return map[string]any{
		"file_id": record.ID, "deck_id": record.DeckID, "name": record.Name,
		"media_type": record.MediaType, "size_bytes": record.SizeBytes,
		"download_url": record.DownloadURL, "created_at": record.CreatedAt,
	}
}

func writeFileError(writer http.ResponseWriter, status int, message string) {
	writeFileJSON(writer, status, map[string]any{
		"error": message, "error_code": "file_error", "retryable": status >= 500,
	})
}

func writeFileJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}

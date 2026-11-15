package files

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const MaxFileBytes = 64 * 1024 * 1024

type Record struct {
	ID           string `json:"file_id"`
	DeckID       string `json:"deck_id"`
	Name         string `json:"name"`
	MediaType    string `json:"media_type"`
	SizeBytes    int    `json:"size_bytes"`
	DownloadURL  string `json:"download_url"`
	OwnerKeyHash string `json:"ownerKeyHash"`
	ObjectPath   string `json:"object_path"`
	CreatedAt    string `json:"created_at"`
}

type StoreAPI interface {
	Publish(deckID, name, mediaType, ownerKeyHash string, content []byte) (Record, error)
	PublishOnce(operationID, deckID, name, mediaType, ownerKeyHash string, content []byte) (Record, error)
	Get(id string) (Record, bool, error)
	ListDeck(deckID, ownerKeyHash string) ([]Record, error)
	Read(record Record) ([]byte, error)
}

type Store struct {
	dataDir string
	mu      sync.Mutex
	files   map[string]Record
	loaded  bool
}

func NewStore(dataDir string) *Store {
	return &Store{dataDir: dataDir, files: map[string]Record{}}
}

func (s *Store) Publish(deckID, name, mediaType, ownerKeyHash string, content []byte) (Record, error) {
	return s.publish("", deckID, name, mediaType, ownerKeyHash, content)
}
func deliveryFileID(operationID, deckID, owner string) string {
	sum := sha256.Sum256([]byte(owner + "\x00" + deckID + "\x00" + operationID))
	return "file-" + hex.EncodeToString(sum[:])
}
func (s *Store) PublishOnce(operationID, deckID, name, mediaType, owner string, content []byte) (Record, error) {
	return s.publish(deliveryFileID(operationID, deckID, owner), deckID, name, mediaType, owner, content)
}
func (s *Store) publish(id, deckID, name, mediaType, ownerKeyHash string, content []byte) (Record, error) {
	if !strings.HasPrefix(deckID, "deck-") || ownerKeyHash == "" {
		return Record{}, errors.New("deck_id 或文件归属无效")
	}
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	if name == "" || name == "." || strings.ContainsAny(name, "\r\n") {
		return Record{}, errors.New("文件名无效")
	}
	if mediaType != "application/vnd.openxmlformats-officedocument.presentationml.presentation" && mediaType != "application/pdf" {
		return Record{}, errors.New("仅支持 PPTX 或 PDF 文件")
	}
	if len(content) == 0 || len(content) > MaxFileBytes {
		return Record{}, errors.New("文件为空或超过 64 MiB 上限")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return Record{}, err
	}
	if id != "" {
		if existing, ok := s.files[id]; ok {
			return existing, nil
		}
	} else {
		var err error
		id, err = newFileID()
		if err != nil {
			return Record{}, err
		}
	}
	objectDir := filepath.Join(s.dataDir, "file-objects")
	if err := os.MkdirAll(objectDir, 0o750); err != nil {
		return Record{}, err
	}
	objectPath := filepath.Join(objectDir, id)
	if err := os.WriteFile(objectPath, content, 0o600); err != nil {
		return Record{}, err
	}
	record := Record{
		ID: id, DeckID: deckID, Name: name, MediaType: mediaType, SizeBytes: len(content),
		DownloadURL: "/files/" + id, OwnerKeyHash: ownerKeyHash, ObjectPath: objectPath,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	s.files[id] = record
	if err := s.saveLocked(); err != nil {
		delete(s.files, id)
		return Record{}, err
	}
	return record, nil
}

func (s *Store) Get(id string) (Record, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return Record{}, false, err
	}
	record, ok := s.files[id]
	return record, ok, nil
}

func (s *Store) ListDeck(deckID, ownerKeyHash string) ([]Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return nil, err
	}
	result := make([]Record, 0)
	for _, record := range s.files {
		if record.DeckID == deckID && record.OwnerKeyHash == ownerKeyHash {
			result = append(result, record)
		}
	}
	return result, nil
}

func DecodeBase64(content string) ([]byte, error) {
	decoded, err := base64.StdEncoding.DecodeString(content)
	if err != nil {
		return nil, errors.New("content_base64 格式错误")
	}
	return decoded, nil
}

func (s *Store) metadataFile() string {
	return filepath.Join(s.dataDir, "files.json")
}

func (s *Store) loadLocked() error {
	if s.loaded {
		return nil
	}
	data, err := os.ReadFile(s.metadataFile())
	if errors.Is(err, os.ErrNotExist) {
		s.loaded = true
		return nil
	}
	if err != nil {
		return err
	}
	var saved []Record
	if err := json.Unmarshal(data, &saved); err != nil {
		return err
	}
	for _, record := range saved {
		s.files[record.ID] = record
	}
	s.loaded = true
	return nil
}

func (s *Store) saveLocked() error {
	if err := os.MkdirAll(s.dataDir, 0o750); err != nil {
		return err
	}
	records := make([]Record, 0, len(s.files))
	for _, record := range s.files {
		records = append(records, record)
	}
	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}
	temporary := s.metadataFile() + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, s.metadataFile()); err != nil {
		if removeErr := os.Remove(s.metadataFile()); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return err
		}
		return os.Rename(temporary, s.metadataFile())
	}
	return nil
}

func (s *Store) Read(record Record) ([]byte, error) {
	return os.ReadFile(record.ObjectPath)
}

func newFileID() (string, error) {
	value := make([]byte, 12)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return "file-" + hex.EncodeToString(value), nil
}

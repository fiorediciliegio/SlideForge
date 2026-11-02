package files

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type S3Config struct {
	Endpoint        string
	Bucket          string
	Region          string
	AccessKeyID     string
	SecretAccessKey string
	ForcePathStyle  bool
}

type S3ObjectStore struct {
	config S3Config
	client *http.Client
	now    func() time.Time
}

func NewS3ObjectStore(config S3Config, client *http.Client) (*S3ObjectStore, error) {
	if config.Endpoint == "" || config.Bucket == "" || config.Region == "" || config.AccessKeyID == "" || config.SecretAccessKey == "" {
		return nil, fmt.Errorf("S3_ENDPOINT、S3_BUCKET、S3_REGION 和访问凭证不能为空")
	}
	if _, err := url.ParseRequestURI(config.Endpoint); err != nil {
		return nil, fmt.Errorf("S3_ENDPOINT 无效: %w", err)
	}
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	return &S3ObjectStore{config: config, client: client, now: time.Now}, nil
}

func (s *S3ObjectStore) Put(key string, content []byte) error {
	request, err := s.newRequest(http.MethodPut, key, content)
	if err != nil {
		return err
	}
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("S3 PutObject %d: %s", response.StatusCode, body)
	}
	return nil
}

func (s *S3ObjectStore) EnsureBucket() error {
	request, err := s.newRequest(http.MethodPut, "", nil)
	if err != nil {
		return err
	}
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 && response.StatusCode != http.StatusConflict {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("S3 CreateBucket %d: %s", response.StatusCode, body)
	}
	return nil
}

func (s *S3ObjectStore) Get(key string) ([]byte, error) {
	request, err := s.newRequest(http.MethodGet, key, nil)
	if err != nil {
		return nil, err
	}
	response, err := s.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("S3 GetObject %d", response.StatusCode)
	}
	return io.ReadAll(response.Body)
}

func (s *S3ObjectStore) Delete(key string) error {
	request, err := s.newRequest(http.MethodDelete, key, nil)
	if err != nil {
		return err
	}
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("S3 DeleteObject %d", response.StatusCode)
	}
	return nil
}

func (s *S3ObjectStore) newRequest(method, key string, content []byte) (*http.Request, error) {
	endpoint, err := url.Parse(s.config.Endpoint)
	if err != nil {
		return nil, err
	}
	if s.config.ForcePathStyle {
		endpoint.Path = strings.TrimSuffix(endpoint.Path, "/") + "/" + s.config.Bucket + "/" + key
	} else {
		endpoint.Host = s.config.Bucket + "." + endpoint.Host
		endpoint.Path = strings.TrimSuffix(endpoint.Path, "/") + "/" + key
	}
	payloadHash := sha256.Sum256(content)
	request, err := http.NewRequest(method, endpoint.String(), bytes.NewReader(content))
	if err != nil {
		return nil, err
	}
	now := s.now().UTC()
	request.Header.Set("X-Amz-Date", now.Format("20060102T150405Z"))
	request.Header.Set("X-Amz-Content-Sha256", hex.EncodeToString(payloadHash[:]))
	s.sign(request, now, payloadHash)
	return request, nil
}

func (s *S3ObjectStore) sign(request *http.Request, now time.Time, payloadHash [32]byte) {
	date := now.Format("20060102")
	amzDate := now.Format("20060102T150405Z")
	canonicalHeaders := "host:" + request.Host + "\n" +
		"x-amz-content-sha256:" + hex.EncodeToString(payloadHash[:]) + "\n" +
		"x-amz-date:" + amzDate + "\n"
	canonicalRequest := request.Method + "\n" + request.URL.EscapedPath() + "\n" + request.URL.RawQuery + "\n" +
		canonicalHeaders + "\nhost;x-amz-content-sha256;x-amz-date\n" + hex.EncodeToString(payloadHash[:])
	canonicalHash := sha256.Sum256([]byte(canonicalRequest))
	scope := date + "/" + s.config.Region + "/s3/aws4_request"
	stringToSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(canonicalHash[:])
	dateKey := hmacSHA256([]byte("AWS4"+s.config.SecretAccessKey), date)
	regionKey := hmacSHA256(dateKey, s.config.Region)
	serviceKey := hmacSHA256(regionKey, "s3")
	signingKey := hmacSHA256(serviceKey, "aws4_request")
	signature := hmacSHA256(signingKey, stringToSign)
	request.Header.Set("Authorization",
		"AWS4-HMAC-SHA256 Credential="+s.config.AccessKeyID+"/"+scope+
			", SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature="+hex.EncodeToString(signature),
	)
}

func hmacSHA256(key []byte, value string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}

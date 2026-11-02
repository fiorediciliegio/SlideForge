package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port              int
	GatewayReplicas   int
	EngineUpstream    *url.URL
	NodeEngineURL     *url.URL
	BrainURL          *url.URL
	ReadHeaderTimeout time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	IdleTimeout       time.Duration
	ShutdownTimeout   time.Duration
	UpstreamTimeout   time.Duration
	DataDir           string
	InternalToken     string
	AdminToken        string
	DatabaseURL       string
	JobsDatabaseURL   string
	FilesDatabaseURL  string
	MigrateJSON       bool
	S3Endpoint        string
	S3Bucket          string
	S3Region          string
	S3AccessKeyID     string
	S3SecretAccessKey string
	S3ForcePathStyle  bool
}

func Load() (Config, error) {
	return Parse(os.Getenv)
}

func Parse(getenv func(string) string) (Config, error) {
	port, err := positiveInt(getenv("GATEWAY_PORT"), 8080)
	if err != nil {
		return Config{}, fmt.Errorf("GATEWAY_PORT: %w", err)
	}
	replicas, err := positiveInt(getenv("GATEWAY_REPLICAS"), 1)
	if err != nil || replicas > 100 {
		return Config{}, fmt.Errorf("GATEWAY_REPLICAS 必须是 1–100 的整数")
	}
	upstream, err := serviceURL(getenv("ENGINE_UPSTREAM_URL"), "http://127.0.0.1:3210", "ENGINE_UPSTREAM_URL")
	if err != nil {
		return Config{}, err
	}
	nodeEngine, err := serviceURL(getenv("NODE_ENGINE_URL"), "http://127.0.0.1:3211", "NODE_ENGINE_URL")
	if err != nil {
		return Config{}, err
	}
	brain, err := serviceURL(getenv("BRAIN_URL"), "http://127.0.0.1:3212", "BRAIN_URL")
	if err != nil {
		return Config{}, err
	}
	dataDir := strings.TrimSpace(getenv("SLIDEFORGE_DATA_DIR"))
	if dataDir == "" {
		dataDir = "../../data"
	}
	jobsDatabaseURL := strings.TrimSpace(getenv("JOBS_DATABASE_URL"))
	if jobsDatabaseURL == "" {
		jobsDatabaseURL = strings.TrimSpace(getenv("DATABASE_URL"))
	}
	filesDatabaseURL := strings.TrimSpace(getenv("FILES_DATABASE_URL"))
	if filesDatabaseURL == "" {
		filesDatabaseURL = strings.TrimSpace(getenv("DATABASE_URL"))
	}
	cfg := Config{
		Port:              port,
		GatewayReplicas:   replicas,
		EngineUpstream:    upstream,
		NodeEngineURL:     nodeEngine,
		BrainURL:          brain,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      15 * time.Minute,
		IdleTimeout:       60 * time.Second,
		ShutdownTimeout:   30 * time.Second,
		UpstreamTimeout:   5 * time.Second,
		DataDir:           dataDir,
		InternalToken:     strings.TrimSpace(getenv("GATEWAY_INTERNAL_TOKEN")),
		AdminToken:        strings.TrimSpace(getenv("SLIDEFORGE_ADMIN_TOKEN")),
		DatabaseURL:       strings.TrimSpace(getenv("DATABASE_URL")),
		JobsDatabaseURL:   jobsDatabaseURL,
		FilesDatabaseURL:  filesDatabaseURL,
		MigrateJSON:       strings.TrimSpace(getenv("SLIDEFORGE_MIGRATE_JSON")) == "true",
		S3Endpoint:        strings.TrimSpace(getenv("S3_ENDPOINT")),
		S3Bucket:          strings.TrimSpace(getenv("S3_BUCKET")),
		S3Region:          strings.TrimSpace(getenv("S3_REGION")),
		S3AccessKeyID:     strings.TrimSpace(getenv("S3_ACCESS_KEY_ID")),
		S3SecretAccessKey: strings.TrimSpace(getenv("S3_SECRET_ACCESS_KEY")),
		S3ForcePathStyle:  strings.TrimSpace(getenv("S3_FORCE_PATH_STYLE")) != "false",
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if c.GatewayReplicas <= 1 {
		return nil
	}
	if c.MigrateJSON {
		return fmt.Errorf("多副本启动时禁止 SLIDEFORGE_MIGRATE_JSON=true，请先单实例完成迁移")
	}
	missing := []string{}
	if c.DatabaseURL == "" {
		missing = append(missing, "DATABASE_URL")
	}
	if c.JobsDatabaseURL == "" {
		missing = append(missing, "JOBS_DATABASE_URL")
	}
	if c.FilesDatabaseURL == "" {
		missing = append(missing, "FILES_DATABASE_URL")
	}
	for name, value := range map[string]string{
		"S3_ENDPOINT": c.S3Endpoint, "S3_BUCKET": c.S3Bucket, "S3_REGION": c.S3Region,
		"S3_ACCESS_KEY_ID": c.S3AccessKeyID, "S3_SECRET_ACCESS_KEY": c.S3SecretAccessKey,
	} {
		if value == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("GATEWAY_REPLICAS>1 缺少共享存储配置：%s", strings.Join(missing, ", "))
	}
	return nil
}

func serviceURL(raw, fallback, name string) (*url.URL, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		value = fallback
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("%s 必须是完整的 HTTP(S) 地址", name)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("%s 仅支持 HTTP(S)", name)
	}
	return parsed, nil
}

func positiveInt(raw string, fallback int) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 || value > 65535 {
		return 0, fmt.Errorf("必须是 1–65535 的整数")
	}
	return value, nil
}

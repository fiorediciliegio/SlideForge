package config

import "testing"

func TestParseDefaults(t *testing.T) {
	cfg, err := Parse(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Port != 8080 {
		t.Fatalf("unexpected port: %d", cfg.Port)
	}
	if cfg.EngineUpstream.String() != "http://127.0.0.1:3210" {
		t.Fatalf("unexpected upstream: %s", cfg.EngineUpstream)
	}
}

func TestParseRejectsInvalidConfiguration(t *testing.T) {
	for name, values := range map[string]map[string]string{
		"port":     {"GATEWAY_PORT": "0"},
		"upstream": {"ENGINE_UPSTREAM_URL": "file:///tmp/engine"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(func(key string) string { return values[key] }); err == nil {
				t.Fatal("expected configuration error")
			}
		})
	}
}

func TestReplicaGateRequiresSharedStorageAndSingleMigration(t *testing.T) {
	if _, err := Parse(func(key string) string {
		if key == "GATEWAY_REPLICAS" {
			return "2"
		}
		return ""
	}); err == nil {
		t.Fatal("replicas without shared storage must be rejected")
	}
	values := map[string]string{
		"GATEWAY_REPLICAS":     "2",
		"DATABASE_URL":         "postgres://billing",
		"JOBS_DATABASE_URL":    "postgres://jobs",
		"FILES_DATABASE_URL":   "postgres://files",
		"S3_ENDPOINT":          "https://s3.example.com",
		"S3_BUCKET":            "exports",
		"S3_REGION":            "test",
		"S3_ACCESS_KEY_ID":     "access",
		"S3_SECRET_ACCESS_KEY": "secret",
	}
	if _, err := Parse(func(key string) string { return values[key] }); err != nil {
		t.Fatalf("complete replica configuration should pass: %v", err)
	}
	values["SLIDEFORGE_MIGRATE_JSON"] = "true"
	if _, err := Parse(func(key string) string { return values[key] }); err == nil {
		t.Fatal("concurrent migration must be rejected")
	}
}

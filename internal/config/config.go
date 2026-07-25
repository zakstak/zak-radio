package config

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	MetadataRoot      string
	Archive           string
	DBPath            string
	ReaderLibrary     string
	StaticDir         string
	TimedLyricsRoot   string
	AllowedHosts      string
	AllowedOrigins    string
	TrustedProxies    string
	TrustedIngress    string
	ClientIPv6Prefix  int
	DeferStartupAudit bool
	Host              string
	Port              int
}

func Load() (Config, error) {
	wd, err := os.Getwd()
	if err != nil {
		return Config{}, err
	}
	metadataRoot := env("ZAK_RADIO_METADATA_ROOT", "/data/zak-radio")
	port, err := envPort("ZAK_RADIO_PORT", 8793)
	if err != nil {
		return Config{}, err
	}
	ipv6Prefix, err := envInt("ZAK_RADIO_CLIENT_IPV6_PREFIX", 64)
	if err != nil {
		return Config{}, err
	}
	deferStartupAudit, err := envBool("ZAK_RADIO_DEFER_STARTUP_AUDIT", false)
	if err != nil {
		return Config{}, err
	}
	return Config{
		MetadataRoot:      metadataRoot,
		Archive:           env("ZAK_RADIO_ARCHIVE", filepath.Join(metadataRoot, "music-library")),
		DBPath:            env("ZAK_RADIO_DB", filepath.Join(metadataRoot, "station.sqlite3")),
		ReaderLibrary:     env("ZAK_RADIO_READER_LIBRARY", filepath.Join(metadataRoot, "reader-library")),
		StaticDir:         env("ZAK_RADIO_STATIC", filepath.Join(wd, "static")),
		TimedLyricsRoot:   env("ZAK_RADIO_TIMED_LYRICS", ""),
		AllowedHosts:      env("ZAK_RADIO_ALLOWED_HOSTS", "loopback"),
		AllowedOrigins:    env("ZAK_RADIO_ALLOWED_ORIGINS", "loopback"),
		TrustedProxies:    env("ZAK_RADIO_TRUSTED_PROXIES", ""),
		TrustedIngress:    env("ZAK_RADIO_TRUSTED_INGRESS", ""),
		ClientIPv6Prefix:  ipv6Prefix,
		DeferStartupAudit: deferStartupAudit,
		Host:              env("ZAK_RADIO_HOST", "127.0.0.1"),
		Port:              port,
	}, nil
}

func envBool(key string, fallback bool) (bool, error) {
	value, present := os.LookupEnv(key)
	if !present || value == "" {
		return fallback, nil
	}
	result, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return result, nil
}

func envInt(key string, fallback int) (int, error) {
	value, present := os.LookupEnv(key)
	if !present || value == "" {
		return fallback, nil
	}
	result, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	return result, nil
}

func (c Config) Normalized() (Config, error) {
	var err error
	for name, value := range map[string]*string{
		"metadata root": &c.MetadataRoot, "archive": &c.Archive, "database": &c.DBPath,
		"reader library": &c.ReaderLibrary, "static directory": &c.StaticDir,
		"timed lyrics": &c.TimedLyricsRoot,
	} {
		if *value == "" {
			continue
		}
		*value, err = filepath.Abs(*value)
		if err != nil {
			return Config{}, fmt.Errorf("%s path: %w", name, err)
		}
	}
	return c, nil
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envPort(key string, fallback int) (int, error) {
	value, present := os.LookupEnv(key)
	if !present || value == "" {
		return fallback, nil
	}
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("%s must be an integer from 1 to 65535", key)
	}
	return port, nil
}

func ValidateListener(cfg Config) error {
	if cfg.Port < 1 || cfg.Port > 65535 {
		return fmt.Errorf("listener port must be from 1 to 65535")
	}
	if hasExternalHost(cfg.AllowedHosts) && strings.TrimSpace(cfg.TrustedProxies) == "" {
		return fmt.Errorf("external allowed hosts require exact trusted proxy IPs or CIDRs")
	}
	if hasExternalHost(cfg.AllowedHosts) && strings.TrimSpace(cfg.TrustedIngress) == "" {
		return fmt.Errorf("external allowed hosts require exact trusted ingress IPs or CIDRs")
	}
	for name, configured := range map[string]string{
		"trusted proxies": cfg.TrustedProxies,
		"trusted ingress": cfg.TrustedIngress,
	} {
		if strings.TrimSpace(configured) == "" {
			continue
		}
		if name == "trusted ingress" && strings.TrimSpace(configured) == "*" {
			continue
		}
		for _, value := range strings.Split(configured, ",") {
			value = strings.TrimSpace(value)
			if value == "" {
				return fmt.Errorf("%s contains an empty entry", name)
			}
			if net.ParseIP(value) == nil {
				if _, _, err := net.ParseCIDR(value); err != nil {
					return fmt.Errorf("%s entry %q is not an IP address or CIDR", name, value)
				}
			}
		}
	}
	if cfg.ClientIPv6Prefix != 0 && (cfg.ClientIPv6Prefix < 48 || cfg.ClientIPv6Prefix > 128) {
		return fmt.Errorf("client IPv6 prefix must be from 48 to 128")
	}
	return nil
}

func hasExternalHost(configured string) bool {
	for _, value := range strings.Split(configured, ",") {
		value = strings.TrimSpace(value)
		if value != "" && value != "loopback" {
			return true
		}
	}
	return false
}

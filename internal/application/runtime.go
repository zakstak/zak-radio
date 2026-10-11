package application

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	appconfig "zak-radio/internal/config"
	lifecycle "zak-radio/internal/lifecycle"
)

func Run() error {
	cfg, err := appconfig.Load()
	if err != nil {
		return err
	}
	flag.StringVar(&cfg.Host, "host", cfg.Host, "bind host")
	flag.IntVar(&cfg.Port, "port", cfg.Port, "bind port")
	flag.StringVar(&cfg.Archive, "archive", cfg.Archive, "music archive path")
	flag.StringVar(&cfg.DBPath, "db", cfg.DBPath, "SQLite database path")
	flag.StringVar(&cfg.ReaderLibrary, "reader-library", cfg.ReaderLibrary, "reader library path")
	flag.StringVar(&cfg.TimedLyricsRoot, "timed-lyrics", cfg.TimedLyricsRoot, "optional immutable timed-lyrics bundle")
	flag.StringVar(&cfg.AllowedHosts, "allowed-hosts", cfg.AllowedHosts, "comma-separated exact external Host values, plus optional loopback")
	flag.StringVar(&cfg.AllowedOrigins, "allowed-origins", cfg.AllowedOrigins, "comma-separated exact browser origins, plus optional loopback")
	flag.StringVar(&cfg.TrustedProxies, "trusted-proxies", cfg.TrustedProxies, "comma-separated proxy IPs or CIDRs allowed to set X-Real-IP")
	flag.StringVar(&cfg.TrustedIngress, "trusted-ingress", cfg.TrustedIngress, "comma-separated ingress IPs or CIDRs allowed to reach external Hosts")
	flag.IntVar(&cfg.ClientIPv6Prefix, "client-ipv6-prefix", cfg.ClientIPv6Prefix, "IPv6 prefix length used for abuse-control identity")
	validateRoot := flag.String("validate-volume", "", "validate a retained volume read-only, then exit")
	validateMigrationRoot := flag.String(
		"validate-migration-source-volume", "",
		"validate a supported stopped migration source read-only, then exit")
	flag.Parse()
	if *validateRoot != "" {
		if validateVolumeErr := validateVolume(context.Background(), *validateRoot); validateVolumeErr != nil {
			return validateVolumeErr
		}
		fmt.Printf("validated retained volume %s\n", *validateRoot)
		return nil
	}
	if *validateMigrationRoot != "" {
		if validateMigrationSourceVolumeErr := validateMigrationSourceVolume(context.Background(), *validateMigrationRoot); validateMigrationSourceVolumeErr != nil {
			return validateMigrationSourceVolumeErr
		}
		fmt.Printf("validated migration source volume %s\n", *validateMigrationRoot)
		return nil
	}
	if validateListenerErr := appconfig.ValidateListener(cfg); validateListenerErr != nil {
		return validateListenerErr
	}
	if prepareRuntimeIdentityErr := prepareRuntimeIdentity(cfg); prepareRuntimeIdentityErr != nil {
		return prepareRuntimeIdentityErr
	}
	volumeLock, err := lifecycle.AcquireRuntimeVolumeLock(cfg.MetadataRoot)
	if err != nil {
		return err
	}
	defer func() { _ = volumeLock.Close() }() // Best-effort cleanup; operation errors are checked separately.
	address := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", address, err)
	}

	app, err := NewApp(cfg)
	if err != nil {
		_ = listener.Close()
		return err
	}

	server := &http.Server{
		Addr:              listener.Addr().String(),
		Handler:           app.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	stop, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	log.Printf("Zak Radio Go serving %d tracks from %s", len(app.catalog.Tracks), app.cfg.Archive)
	log.Printf("Listening on http://%s", server.Addr)
	serveFailure := serveUntilStopped(server, listener, stop.Done())
	app.cancel()
	shutdownErr := shutdownHTTPServer(server, 10*time.Second)
	appErr := app.Close()
	return errors.Join(serveFailure, shutdownErr, appErr)
}

func serveUntilStopped(server *http.Server, listener net.Listener, stopped <-chan struct{}) error {
	serveErrors := make(chan error, 1)
	go func() {
		serveErrors <- server.Serve(listener)
	}()
	select {
	case <-stopped:
		return nil
	case err := <-serveErrors:
		if err == nil || errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve: %w", err)
	}
}

func shutdownHTTPServer(server *http.Server, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		return errors.Join(fmt.Errorf("graceful shutdown: %w", err), server.Close())
	}
	return nil
}

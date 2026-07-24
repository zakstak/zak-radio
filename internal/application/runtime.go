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
)

func Run() error {
	cfg, err := defaultConfig()
	if err != nil {
		return err
	}
	flag.StringVar(&cfg.Host, "host", cfg.Host, "bind host")
	flag.IntVar(&cfg.Port, "port", cfg.Port, "bind port")
	flag.StringVar(&cfg.Archive, "archive", cfg.Archive, "music archive path")
	flag.StringVar(&cfg.DBPath, "db", cfg.DBPath, "SQLite database path")
	flag.StringVar(&cfg.ReaderLibrary, "reader-library", cfg.ReaderLibrary, "reader library path")
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
	if err := validatePackagedRouting(cfg); err != nil {
		return err
	}
	if *validateRoot != "" {
		if err := validateVolume(context.Background(), *validateRoot); err != nil {
			return err
		}
		fmt.Printf("validated retained volume %s\n", *validateRoot)
		return nil
	}
	if *validateMigrationRoot != "" {
		if err := validateMigrationSourceVolume(context.Background(), *validateMigrationRoot); err != nil {
			return err
		}
		fmt.Printf("validated migration source volume %s\n", *validateMigrationRoot)
		return nil
	}
	if err := validateListenerConfig(cfg); err != nil {
		return err
	}
	if err := prepareRuntimeIdentity(cfg); err != nil {
		return err
	}
	volumeLock, err := acquireRuntimeVolumeLock(cfg.MetadataRoot)
	if err != nil {
		return err
	}
	defer volumeLock.Close()
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
	log.Printf("Zak Radio Go serving %d tracks from %s", len(app.tracks), app.cfg.Archive)
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

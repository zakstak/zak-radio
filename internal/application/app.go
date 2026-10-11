package application

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	catalogmodel "zak-radio/internal/catalog"
	appconfig "zak-radio/internal/config"
	appevents "zak-radio/internal/events"
	httpguard "zak-radio/internal/httpguard"
)

type App struct {
	staticFS         http.Handler
	ctx              context.Context
	staticRoot       *os.Root
	readerParseCalls map[string]*readerParseCall
	events           *appevents.Broadcaster
	metadataRoot     *os.Root
	db               *sql.DB
	cancel           context.CancelFunc
	archiveRoot      *os.Root
	readerRoot       *os.Root
	readerImages     map[string]readerImageCache
	trackReads       chan struct{}
	readerParses     chan struct{}
	station          *StationService
	timedLyricsRoot  *os.Root
	digestFailures   map[string]string
	integrity        map[string]bool
	catalog          catalogmodel.Catalog
	trackStatsCache  []byte
	catalogDigests   []retainedDigest
	cfg              appconfig.Config
	wg               sync.WaitGroup
	trackStatsRev    int64
	readerImageBytes int64
	auditIndex       int
	integrityMu      sync.RWMutex
	trackStatsMu     sync.RWMutex
	readerImagesMu   sync.Mutex
	auditMu          sync.Mutex
}

func NewApp(cfg appconfig.Config) (*App, error) {
	var err error
	if cfg, err = cfg.Normalized(); err != nil {
		return nil, err
	}
	if validateDataPathsErr := validateDataPaths(cfg); validateDataPathsErr != nil {
		return nil, validateDataPathsErr
	}
	if cleanupMigrationTemporaryFilesErr := cleanupMigrationTemporaryFiles(cfg.DBPath); cleanupMigrationTemporaryFilesErr != nil {
		return nil, fmt.Errorf("clean interrupted migration artifacts: %w", cleanupMigrationTemporaryFilesErr)
	}
	if validateRetainedTreeBudgetErr := validateRetainedTreeBudget(cfg.MetadataRoot); validateRetainedTreeBudgetErr != nil {
		return nil, fmt.Errorf("validate retained-volume budget: %w", validateRetainedTreeBudgetErr)
	}
	archiveRoot, err := os.OpenRoot(cfg.Archive)
	if err != nil {
		return nil, err
	}
	metadataRoot, err := os.OpenRoot(cfg.MetadataRoot)
	if err != nil {
		_ = archiveRoot.Close() // Preserve the primary result while releasing resources.
		return nil, err
	}
	readerRoot, err := os.OpenRoot(cfg.ReaderLibrary)
	if err != nil {
		_ = archiveRoot.Close()  // Preserve the primary result while releasing resources.
		_ = metadataRoot.Close() // Preserve the primary result while releasing resources.
		return nil, err
	}
	staticRoot, err := os.OpenRoot(cfg.StaticDir)
	if err != nil {
		_ = archiveRoot.Close()  // Preserve the primary result while releasing resources.
		_ = metadataRoot.Close() // Preserve the primary result while releasing resources.
		_ = readerRoot.Close()   // Preserve the primary result while releasing resources.
		return nil, err
	}
	var timedLyricsRoot *os.Root
	if cfg.TimedLyricsRoot != "" {
		timedLyricsRoot, err = os.OpenRoot(cfg.TimedLyricsRoot)
		if err != nil {
			_ = archiveRoot.Close()  // Preserve the primary result while releasing resources.
			_ = metadataRoot.Close() // Preserve the primary result while releasing resources.
			_ = readerRoot.Close()   // Preserve the primary result while releasing resources.
			_ = staticRoot.Close()   // Preserve the primary result while releasing resources.
			return nil, err
		}
	}
	rootsOpen := true
	defer func() {
		if rootsOpen {
			_ = archiveRoot.Close()  // Preserve the primary result while releasing resources.
			_ = metadataRoot.Close() // Preserve the primary result while releasing resources.
			_ = readerRoot.Close()   // Preserve the primary result while releasing resources.
			_ = staticRoot.Close()   // Preserve the primary result while releasing resources.
			if timedLyricsRoot != nil {
				_ = timedLyricsRoot.Close() // Preserve the primary result while releasing resources.
			}
		}
	}()
	catalog, err := loadCatalog(cfg, archiveRoot, metadataRoot, timedLyricsRoot)
	if err != nil {
		return nil, err
	}
	catalogDigests := []retainedDigest{
		{root: archiveRoot, rootPath: cfg.Archive, path: filepath.Join(cfg.Archive, "index.json")},
		{root: metadataRoot, rootPath: cfg.MetadataRoot, path: filepath.Join(cfg.MetadataRoot, "curated-tracks.json")},
	}
	if timedLyricsRoot != nil {
		subjectsPath := filepath.Join(cfg.TimedLyricsRoot, timedLyricsSubjects)
		if safeOptionalFile(subjectsPath, cfg.TimedLyricsRoot) {
			catalogDigests = append(catalogDigests, retainedDigest{
				root: timedLyricsRoot, rootPath: cfg.TimedLyricsRoot,
				path: subjectsPath,
			})
		}
	}
	for index := range catalog.Tracks {
		track := &catalog.Tracks[index]
		if track.TimedLyricsPath != "" {
			root, rootPath := archiveRoot, cfg.Archive
			if track.TimedLyricsBundled {
				root, rootPath = timedLyricsRoot, cfg.TimedLyricsRoot
			}
			catalogDigests = append(catalogDigests, retainedDigest{
				root: root, rootPath: rootPath,
				path: track.TimedLyricsPath, digest: track.TimedLyricsSHA256,
			})
		}
	}
	for index := range catalogDigests {
		if catalogDigests[index].digest != "" {
			continue
		}
		catalogDigests[index].digest, err = rootedDigest(
			catalogDigests[index].root, catalogDigests[index].rootPath, catalogDigests[index].path)
		if err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	db, err := openDatabase(ctx, cfg.DBPath, cfg.MetadataRoot)
	if err != nil {
		cancel()
		return nil, err
	}
	if err := databaseStructuralIntegrity(ctx, db); err != nil {
		_ = db.Close() // Preserve the primary result while releasing resources.
		cancel()
		return nil, fmt.Errorf("validate retained database: %w", err)
	}
	if err := retainedAdmissionIntegrity(ctx, db); err != nil {
		_ = db.Close() // Preserve the primary result while releasing resources.
		cancel()
		return nil, fmt.Errorf("validate retained-data admission: %w", err)
	}
	if err := reconcileReaderStorage(
		ctx, db, cfg.DBPath, cfg.MetadataRoot, cfg.ReaderLibrary,
	); err != nil {
		_ = db.Close() // Preserve the primary result while releasing resources.
		cancel()
		return nil, err
	}
	if err := clearMigrationBackupReceipt(ctx, cfg.DBPath); err != nil {
		_ = db.Close() // Preserve the primary result while releasing resources.
		cancel()
		return nil, fmt.Errorf("finalize protected migration backup: %w", err)
	}
	if err := readerRelationalIntegrity(ctx, db); err != nil {
		_ = db.Close() // Preserve the primary result while releasing resources.
		cancel()
		return nil, fmt.Errorf("validate retained Reader relationships: %w", err)
	}
	events := appevents.NewBroadcaster()
	service := NewStationService(db, catalog, events)
	if err := service.EnsureMain(ctx); err != nil {
		_ = db.Close() // Preserve the primary result while releasing resources.
		cancel()
		return nil, err
	}
	if err := service.Advance(ctx); err != nil {
		_ = db.Close() // Preserve the primary result while releasing resources.
		cancel()
		return nil, err
	}
	app := &App{
		cfg: cfg, db: db, catalog: catalog,
		station: service, events: events, cancel: cancel,
		ctx:              ctx,
		staticFS:         http.StripPrefix("/static/", http.FileServer(http.FS(staticRoot.FS()))),
		readerImages:     make(map[string]readerImageCache),
		readerParses:     make(chan struct{}, 2),
		readerParseCalls: make(map[string]*readerParseCall),
		trackReads:       make(chan struct{}, 2),
		integrity:        pendingIntegrityChecks(),
		catalogDigests:   catalogDigests,
		digestFailures:   make(map[string]string),
		archiveRoot:      archiveRoot, metadataRoot: metadataRoot,
		readerRoot: readerRoot, staticRoot: staticRoot,
		timedLyricsRoot: timedLyricsRoot,
	}
	rootsOpen = false
	// Readiness never becomes green until every trusted retained-media digest
	// has been checked at least once for this process. Kiln candidates defer
	// that bounded audit so the listener can return 503 while the audit runs,
	// instead of leaving Kiln's health connection waiting on process startup.
	if cfg.DeferStartupAudit {
		app.wg.Add(1)
		go func() {
			defer app.wg.Done()
			app.auditAllIntegrity(ctx)
		}()
	} else {
		app.auditAllIntegrity(ctx)
	}
	app.wg.Add(3)
	go func() {
		defer app.wg.Done()
		app.advancementLoop(ctx, 250*time.Millisecond)
	}()
	go func() {
		defer app.wg.Done()
		app.integrityLoop(ctx, 5*time.Minute)
	}()
	go func() {
		defer app.wg.Done()
		app.clockPersistenceLoop(ctx, time.Second)
	}()
	return app, nil
}

func (a *App) Close() error {
	if a.cancel != nil {
		a.cancel()
	}
	a.wg.Wait()
	persistContext, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	clockErr := a.station.persistLogicalClock(persistContext)
	cancel()
	dbErr := a.db.Close()
	for _, root := range []*os.Root{
		a.archiveRoot, a.metadataRoot, a.readerRoot, a.staticRoot, a.timedLyricsRoot,
	} {
		if root != nil {
			_ = root.Close()
		}
	}
	return errors.Join(clockErr, dbErr)
}

func (a *App) advancementLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := a.station.Advance(ctx); err != nil && ctx.Err() == nil {
				log.Printf("advance stations: %v", err)
			}
		case <-ctx.Done():
			return
		}
	}
}

func (a *App) clockPersistenceLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			cycle, cancel := context.WithTimeout(ctx, 2*time.Second)
			if err := a.station.persistLogicalClock(cycle); err != nil && ctx.Err() == nil {
				log.Printf("persist logical clock: %v", err)
			}
			cancel()
		case <-ctx.Done():
			return
		}
	}
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", a.handle)
	return httpguard.WrapConfig(mux, a.cfg.AllowedHosts, a.cfg.AllowedOrigins,
		a.cfg.TrustedProxies, a.cfg.TrustedIngress, a.cfg.ClientIPv6Prefix)
}

func (a *App) handle(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	allowed := routeAllowedMethods(path)
	if len(allowed) == 0 {
		http.NotFound(w, r)
		return
	}
	if !methodIn(r.Method, allowed) {
		w.Header().Set("Allow", strings.Join(allowed, ", "))
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		switch {
		case path == "/" || path == "/library" || path == "/library/" ||
			path == "/reader" || path == "/reader/":
			serveRootContent(w, r, a.staticRoot, a.cfg.StaticDir,
				filepath.Join(a.cfg.StaticDir, "index.html"), "no-store", "text/html; charset=utf-8")
		case path == "/health":
			a.health(w, r)
		case path == "/live":
			writeJSON(w, map[string]any{
				"ok": true, "runtime": "go", "release": releaseIdentity,
			})
		case path == "/api":
			writeJSON(w, map[string]any{
				"name": "Zak Radio Station API", "version": 4,
				"runtime": "go", "release": releaseIdentity,
			})
		case path == "/api/tracks":
			a.apiTracks(w, r)
		case path == "/api/stations":
			a.listStations(w, r)
		case path == "/api/station":
			a.apiStation(w, r)
		case path == "/api/station/events":
			a.stationEvents(w, r)
		case strings.HasPrefix(path, "/api/track/"):
			a.apiTrackText(w, r)
		case strings.HasPrefix(path, "/media/"):
			a.media(w, r)
		case path == "/api/reader":
			writeJSON(w, map[string]any{
				"name": "Zak Reader API", "version": 3,
				"runtime": "go", "release": releaseIdentity,
			})
		case path == "/api/reader/items":
			a.readerItems(w, r)
		case strings.HasPrefix(path, "/api/reader/items/"):
			a.readerItemSubroute(w, r)
		case path == "/api/reader/playback":
			a.readerPlayback(w, r)
		case strings.HasPrefix(path, "/reader-media/"):
			a.readerMedia(w, r)
		case strings.HasPrefix(path, "/reader-image/"):
			a.readerImage(w, r)
		case strings.HasPrefix(path, "/reader-source/"):
			a.readerSource(w, r)
		case strings.HasPrefix(path, "/static/"):
			w.Header().Set("Cache-Control", "no-cache")
			a.staticFS.ServeHTTP(w, r)
		default:
			http.NotFound(w, r)
		}
		return
	}
	if strings.HasPrefix(path, "/api/stations/") &&
		(r.Method == http.MethodPatch || r.Method == http.MethodDelete) {
		a.savedStation(w, r)
		return
	}
	if r.Method == http.MethodPost {
		switch path {
		case "/api/stations":
			a.createStation(w, r)
		case "/api/control":
			a.apiControl(w, r)
		case "/api/reaction":
			a.apiReaction(w, r)
		case "/api/reader/playback":
			a.setReaderPlayback(w, r)
		default:
			http.NotFound(w, r)
		}
		return
	}
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}

func routeAllowedMethods(path string) []string {
	getHead := []string{http.MethodGet, http.MethodHead}
	switch {
	case path == "/" || path == "/library" || path == "/library/" ||
		path == "/reader" || path == "/reader/" ||
		path == "/health" || path == "/live" ||
		strings.HasPrefix(path, "/media/") ||
		strings.HasPrefix(path, "/reader-media/") ||
		strings.HasPrefix(path, "/reader-image/") ||
		strings.HasPrefix(path, "/reader-source/") ||
		strings.HasPrefix(path, "/static/"):
		return getHead
	case path == "/api" || path == "/api/tracks" || path == "/api/station" ||
		path == "/api/station/events" || path == "/api/reader" ||
		path == "/api/reader/items" ||
		strings.HasPrefix(path, "/api/track/") ||
		strings.HasPrefix(path, "/api/reader/items/"):
		return []string{http.MethodGet}
	case path == "/api/stations":
		return []string{http.MethodGet, http.MethodPost}
	case strings.HasPrefix(path, "/api/stations/"):
		return []string{http.MethodPatch, http.MethodDelete}
	case path == "/api/control" ||
		path == "/api/reaction":
		return []string{http.MethodPost}
	case path == "/api/reader/playback":
		return []string{http.MethodGet, http.MethodPost}
	default:
		return nil
	}
}

func methodIn(method string, allowed []string) bool {
	for _, candidate := range allowed {
		if method == candidate {
			return true
		}
	}
	return false
}

func (a *App) health(w http.ResponseWriter, r *http.Request) {
	checks := a.integritySnapshot()
	probeContext, cancel := context.WithTimeout(r.Context(), 25*time.Millisecond)
	if err := a.db.PingContext(probeContext); err != nil {
		checks["database_runtime"] = false
	}
	cancel()
	ok := true
	for _, passed := range checks {
		ok = ok && passed
	}
	status := http.StatusOK
	if !ok {
		status = http.StatusServiceUnavailable
	}
	writeJSONStatus(w, status, map[string]any{
		"ok": ok, "runtime": "go", "release": releaseIdentity,
		"tracks": len(a.catalog.Tracks), "checks": checks,
	})
}

func regularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

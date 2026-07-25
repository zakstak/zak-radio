package httpguard

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	MaxJSONBodyBytes    = 64 << 10
	maxRangeHeaderBytes = 200
	maxRateEntries      = 4096
)

type rateRule struct {
	limit  int
	window time.Duration
}

type rateEntry struct {
	start time.Time
	count int
	seen  time.Time
}

type RequestLimiter struct {
	mu      sync.Mutex
	entries map[string]rateEntry
	ring    []string
	cursor  int
}

type StreamLimiter struct {
	mu       sync.Mutex
	total    int
	byClient map[string]int
	maxTotal int
	maxEach  int
}

func Wrap(next http.Handler, allowedHosts, allowedOrigins, trustedProxies string) http.Handler {
	return WrapConfig(next, allowedHosts, allowedOrigins, trustedProxies, "*", 64)
}

func WrapConfig(next http.Handler, allowedHosts, allowedOrigins, trustedProxies,
	trustedIngress string, clientIPv6Prefix int,
) http.Handler {
	limiter := NewRequestLimiter()
	streamStarts := NewRequestLimiter()
	streams := NewStreamLimiter(64, 16)
	assets := NewStreamLimiter(128, 16)
	content := NewStreamLimiter(64, 4)
	writes := NewStreamLimiter(32, 2)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(2 * time.Minute))
		setSecurityHeaders(w)
		requestHost := effectiveRequestHost(r, trustedProxies)
		if !allowedHost(requestHost, allowedHosts) {
			http.Error(w, "unrecognized request host", http.StatusMisdirectedRequest)
			return
		}
		if !authorizedIngress(r, trustedIngress) {
			http.Error(w, "request did not arrive through the authorized ingress", http.StatusForbidden)
			return
		}
		if r.Method == http.MethodOptions {
			if !sameOriginRequest(r, requestHost, allowedOrigins) {
				http.Error(w, "cross-origin request forbidden", http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
			isPrivateReadRoute(r.URL.Path) && crossSiteBrowserRequest(r) {
			http.Error(w, "cross-origin request forbidden", http.StatusForbidden)
			return
		}
		if (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
			InvalidRangeRequest(r.Header.Get("Range")) && !isSizeAwareRangeRoute(r.URL.Path) {
			http.Error(w, "multiple or oversized byte ranges are not supported", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		if r.Method == http.MethodPost {
			if !sameOriginRequest(r, requestHost, allowedOrigins) {
				http.Error(w, "cross-origin request forbidden", http.StatusForbidden)
				return
			}
			if rule, ok := writeRateRule(r.URL.Path); ok &&
				!limiter.allow(ClientAddressWithPrefix(r, trustedProxies, clientIPv6Prefix), r.URL.Path, rule) {
				w.Header().Set("Retry-After", strconv.Itoa(int(rule.window.Seconds())))
				http.Error(w, "request rate limit exceeded", http.StatusTooManyRequests)
				return
			}
			release, ok := writes.acquire(
				ClientAddressWithPrefix(r, trustedProxies, clientIPv6Prefix))
			if !ok {
				http.Error(w, "write request capacity reached", http.StatusTooManyRequests)
				return
			}
			defer release()
		}
		if r.Method == http.MethodGet && r.URL.Path == "/api/station/events" {
			client := ClientAddressWithPrefix(r, trustedProxies, clientIPv6Prefix)
			rule := rateRule{limit: 24, window: time.Minute}
			if !streamStarts.allow(client, r.URL.Path, rule) {
				w.Header().Set("Retry-After", strconv.Itoa(int(rule.window.Seconds())))
				http.Error(w, "event stream start rate limit exceeded", http.StatusTooManyRequests)
				return
			}
			release, ok := streams.acquire(client)
			if !ok {
				http.Error(w, "event stream capacity reached", http.StatusTooManyRequests)
				return
			}
			defer release()
		}
		if (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
			IsPageAssetRoute(r.URL.Path) {
			release, ok := assets.acquire(
				ClientAddressWithPrefix(r, trustedProxies, clientIPv6Prefix))
			if !ok {
				http.Error(w, "page asset capacity reached", http.StatusTooManyRequests)
				return
			}
			defer release()
		} else if (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
			IsContentRoute(r.URL.Path) {
			release, ok := content.acquire(
				ClientAddressWithPrefix(r, trustedProxies, clientIPv6Prefix))
			if !ok {
				http.Error(w, "content stream capacity reached", http.StatusTooManyRequests)
				return
			}
			defer release()
		}
		next.ServeHTTP(w, r)
	})
}

func IsPageAssetRoute(path string) bool {
	return path == "/" || path == "/library" || path == "/library/" ||
		path == "/reader" || path == "/reader/" ||
		strings.HasPrefix(path, "/static/")
}

func authorizedIngress(r *http.Request, trustedIngress string) bool {
	if trustedIngress == "*" {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	remote := net.ParseIP(strings.TrimSpace(host))
	hostname := strings.Trim(strings.ToLower(hostName(r.Host)), "[]")
	requestsLoopback := hostname == "localhost" || net.ParseIP(hostname).IsLoopback()
	if requestsLoopback {
		return remote != nil && (remote.IsLoopback() ||
			trustedIngress != "*" && proxyTrusted(remote, trustedIngress))
	}
	return remote != nil && proxyTrusted(remote, trustedIngress)
}

func IsContentRoute(path string) bool {
	return path == "/" || path == "/health" || path == "/library" || path == "/library/" ||
		path == "/reader" || path == "/reader/" ||
		strings.HasPrefix(path, "/static/") ||
		path == "/api/tracks" ||
		path == "/api/station" ||
		path == "/api/reader/playback" ||
		strings.HasPrefix(path, "/api/track/") ||
		strings.HasPrefix(path, "/api/reader/items") ||
		strings.HasPrefix(path, "/media/") ||
		strings.HasPrefix(path, "/reader-media/") ||
		strings.HasPrefix(path, "/reader-image/") ||
		strings.HasPrefix(path, "/reader-source/")
}

func isPrivateReadRoute(path string) bool {
	return path == "/health" || strings.HasPrefix(path, "/api/") || IsContentRoute(path)
}

func isSizeAwareRangeRoute(path string) bool {
	return strings.HasPrefix(path, "/reader-media/") ||
		(strings.HasPrefix(path, "/media/") && strings.HasSuffix(path, "/audio"))
}

func InvalidRangeRequest(value string) bool {
	return len(value) > maxRangeHeaderBytes || strings.Contains(value, ",")
}

func crossSiteBrowserRequest(r *http.Request) bool {
	switch strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))) {
	case "cross-site", "same-site":
		return true
	default:
		return false
	}
}

func setSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
}

func sameOriginRequest(r *http.Request, requestHost, allowedOrigins string) bool {
	if strings.EqualFold(r.Header.Get("Sec-Fetch-Site"), "cross-site") {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	return strings.EqualFold(parsed.Host, requestHost) && allowedOrigin(parsed, allowedOrigins)
}

func effectiveRequestHost(r *http.Request, trustedProxies string) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || host == "" {
		host = r.RemoteAddr
	}
	remote := net.ParseIP(strings.TrimSpace(host))
	if remote == nil || !proxyTrusted(remote, trustedProxies) {
		return r.Host
	}
	forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
	if forwarded == "" || strings.ContainsAny(forwarded, ", \t\r\n") {
		return r.Host
	}
	return forwarded
}

func allowedHost(host, configured string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	hostname := strings.Trim(strings.ToLower(strings.TrimSpace(hostName(host))), "[]")
	for _, allowed := range strings.Split(configured, ",") {
		allowed = strings.ToLower(strings.TrimSpace(allowed))
		if allowed == "loopback" {
			if hostname == "localhost" || net.ParseIP(hostname).IsLoopback() {
				return true
			}
			continue
		}
		if allowed != "" && host == allowed {
			return true
		}
	}
	return false
}

func allowedOrigin(origin *url.URL, configured string) bool {
	hostname := strings.Trim(strings.ToLower(origin.Hostname()), "[]")
	for _, allowed := range strings.Split(configured, ",") {
		allowed = strings.ToLower(strings.TrimSpace(allowed))
		if allowed == "loopback" && (hostname == "localhost" || net.ParseIP(hostname).IsLoopback()) {
			return true
		}
		if allowed != "" && strings.EqualFold(origin.Scheme+"://"+origin.Host, allowed) {
			return true
		}
	}
	return false
}

func hostName(host string) string {
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		return parsed
	}
	return host
}

func writeRateRule(path string) (rateRule, bool) {
	if strings.HasPrefix(path, "/api/stations/") {
		return rateRule{limit: 120, window: time.Minute}, true
	}
	switch path {
	case "/api/stations":
		return rateRule{limit: 20, window: time.Hour}, true
	case "/api/control", "/api/like", "/api/reaction":
		return rateRule{limit: 120, window: time.Minute}, true
	case "/api/reader/playback":
		return rateRule{limit: 240, window: time.Minute}, true
	default:
		return rateRule{}, false
	}
}

func ClientAddress(r *http.Request, trustedProxies string) string {
	return ClientAddressWithPrefix(r, trustedProxies, 128)
}

func ClientAddressWithPrefix(r *http.Request, trustedProxies string, ipv6Prefix int) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || host == "" {
		host = r.RemoteAddr
	}
	remote := net.ParseIP(host)
	if remote != nil && proxyTrusted(remote, trustedProxies) {
		forwarded := net.ParseIP(strings.TrimSpace(r.Header.Get("X-Real-IP")))
		if forwarded != nil {
			return normalizedClientIP(forwarded, ipv6Prefix)
		}
	}
	if remote != nil {
		return normalizedClientIP(remote, ipv6Prefix)
	}
	return host
}

func normalizedClientIP(ip net.IP, ipv6Prefix int) string {
	if ip.To4() != nil {
		return ip.String()
	}
	if ipv6Prefix < 48 || ipv6Prefix > 128 {
		ipv6Prefix = 64
	}
	mask := net.CIDRMask(ipv6Prefix, 128)
	return ip.Mask(mask).String() + "/" + strconv.Itoa(ipv6Prefix)
}

func proxyTrusted(remote net.IP, configured string) bool {
	for _, value := range strings.Split(configured, ",") {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if ip := net.ParseIP(value); ip != nil && ip.Equal(remote) {
			return true
		}
		if _, network, err := net.ParseCIDR(value); err == nil && network.Contains(remote) {
			return true
		}
	}
	return false
}

func (l *RequestLimiter) allow(client, path string, rule rateRule) bool {
	now := time.Now()
	key := client + "\x00" + path
	l.mu.Lock()
	defer l.mu.Unlock()
	entry, exists := l.entries[key]
	if !exists {
		if len(l.entries) >= maxRateEntries {
			if len(l.ring) != maxRateEntries {
				l.ring = l.ring[:0]
				for candidate := range l.entries {
					l.ring = append(l.ring, candidate)
				}
				l.cursor = 0
			}
			delete(l.entries, l.ring[l.cursor])
			l.ring[l.cursor] = key
			l.cursor = (l.cursor + 1) % maxRateEntries
		} else {
			l.ring = append(l.ring, key)
		}
	}
	if entry.start.IsZero() || now.Sub(entry.start) >= rule.window {
		entry = rateEntry{start: now}
	}
	entry.count++
	entry.seen = now
	l.entries[key] = entry
	return entry.count <= rule.limit
}

func NewRequestLimiter() *RequestLimiter {
	return &RequestLimiter{entries: make(map[string]rateEntry)}
}

func (l *RequestLimiter) Allow(client, path string, limit int, window time.Duration) bool {
	return l.allow(client, path, rateRule{limit: limit, window: window})
}

func (l *RequestLimiter) EntryCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.entries)
}

func (l *StreamLimiter) acquire(client string) (func(), bool) {
	maxTotal, maxEach := l.maxTotal, l.maxEach
	if maxTotal <= 0 {
		maxTotal = 64
	}
	if maxEach <= 0 {
		maxEach = 4
	}
	l.mu.Lock()
	if l.total >= maxTotal || l.byClient[client] >= maxEach {
		l.mu.Unlock()
		return nil, false
	}
	l.total++
	l.byClient[client]++
	l.mu.Unlock()
	return func() {
		l.mu.Lock()
		l.total--
		l.byClient[client]--
		if l.byClient[client] == 0 {
			delete(l.byClient, client)
		}
		l.mu.Unlock()
	}, true
}

func NewStreamLimiter(maxTotal, maxEach int) *StreamLimiter {
	return &StreamLimiter{
		byClient: make(map[string]int),
		maxTotal: maxTotal,
		maxEach:  maxEach,
	}
}

func (l *StreamLimiter) Acquire(client string) (func(), bool) {
	return l.acquire(client)
}

func (l *StreamLimiter) Active() (total, clients int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.total, len(l.byClient)
}

func DecodeJSON(w http.ResponseWriter, r *http.Request, target any, allowEmpty bool) bool {
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		http.Error(w, "Content-Type must be application/json", http.StatusUnsupportedMediaType)
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxJSONBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		if allowEmpty && errors.Is(err, io.EOF) {
			return true
		}
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		}
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "request body must contain one JSON object", http.StatusBadRequest)
		}
		return false
	}
	return true
}

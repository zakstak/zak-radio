package application

import (
	"net/http"

	"zak-radio-apphost/internal/httpguard"
)

const maxJSONBodyBytes = httpguard.MaxJSONBodyBytes

func secureHTTP(next http.Handler, allowedHosts, allowedOrigins, trustedProxies string) http.Handler {
	return httpguard.Wrap(next, allowedHosts, allowedOrigins, trustedProxies)
}

func secureHTTPConfig(next http.Handler, allowedHosts, allowedOrigins, trustedProxies,
	trustedIngress string, clientIPv6Prefix int,
) http.Handler {
	return httpguard.WrapConfig(
		next,
		allowedHosts,
		allowedOrigins,
		trustedProxies,
		trustedIngress,
		clientIPv6Prefix,
	)
}

func clientAddress(r *http.Request, trustedProxies string) string {
	return httpguard.ClientAddress(r, trustedProxies)
}

func clientAddressWithPrefix(r *http.Request, trustedProxies string, ipv6Prefix int) string {
	return httpguard.ClientAddressWithPrefix(r, trustedProxies, ipv6Prefix)
}

func isContentRoute(path string) bool {
	return httpguard.IsContentRoute(path)
}

func invalidRangeRequest(value string) bool {
	return httpguard.InvalidRangeRequest(value)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any, allowEmpty bool) bool {
	return httpguard.DecodeJSON(w, r, target, allowEmpty)
}

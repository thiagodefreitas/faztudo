package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/auth"
)

const localCookieName = "fz_local"
const localCookieAge = 365 * 24 * time.Hour

func (a *API) localAuthenticated(r *http.Request) (bool, bool) {
	if a.localAuthBypass {
		return true, false
	}
	if a.LocalTokenPath == "" {
		return false, false
	}
	token, err := auth.ReadLocalToken(a.LocalTokenPath)
	if err != nil {
		return false, false
	}
	if cookie, err := r.Cookie(localCookieName); err == nil && auth.EqualSecret(cookie.Value, auth.LocalCookieValue(token)) {
		return true, false
	}
	value := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if value == "" || value == r.Header.Get("Authorization") {
		return false, false
	}
	if a.LocalLimiter == nil {
		return false, false
	}
	if !a.LocalLimiter.Attempt(r.RemoteAddr) {
		return false, true
	}
	if !auth.EqualSecret(value, token) {
		return false, false
	}
	a.LocalLimiter.Forget(r.RemoteAddr)
	return true, false
}

func (a *API) localPost(w http.ResponseWriter, r *http.Request) {
	if a.isLANRequest(r) || !isLoopbackAddr(r.RemoteAddr) || !a.hostAllowed(r.Host) || !validLoopbackOrigin(r) {
		fail(w, 403, "forbidden", "local origin required")
		return
	}
	if a.LocalLimiter == nil || !a.LocalLimiter.Attempt(r.RemoteAddr) {
		fail(w, 429, "rate_limited", "too many failed token attempts")
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if !decode(w, r, &body) {
		return
	}
	token, err := auth.ReadLocalToken(a.LocalTokenPath)
	if err != nil || !auth.EqualSecret(body.Token, token) {
		fail(w, 401, "unauthorized", "invalid local token")
		return
	}
	a.LocalLimiter.Forget(r.RemoteAddr)
	secure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	http.SetCookie(w, &http.Cookie{
		Name: localCookieName, Value: auth.LocalCookieValue(token), Path: "/",
		MaxAge: int(localCookieAge / time.Second), HttpOnly: true,
		Secure: secure, SameSite: http.SameSiteStrictMode,
	})
	respond(w, 200, map[string]bool{"ok": true})
}

const localPageHTML = `<!doctype html><html><head><meta charset="utf-8"><title>Open faztudo</title></head>
<body><p>Opening faztudo...</p><script>
const token = location.hash.slice(1);
history.replaceState(null, "", "/auth/local");
if (!/^[0-9a-f]{64}$/.test(token)) {
  document.body.textContent = "Open faztudo with faztudo open";
} else {
  fetch("/api/v1/auth/local", {method: "POST", credentials: "same-origin",
    headers: {"content-type": "application/json"}, body: JSON.stringify({token})})
    .then(r => { if (!r.ok) throw new Error(); location.replace("/"); })
    .catch(() => { document.body.textContent = "Open faztudo with faztudo open"; });
}
</script></body></html>`

const localGateHTML = `<!doctype html><html><head><meta charset="utf-8"><title>faztudo</title></head><body><p>Open faztudo with <code>faztudo open</code></p></body></html>`

func (a *API) localPage(w http.ResponseWriter, r *http.Request) {
	if a.isLANRequest(r) || !isLoopbackAddr(r.RemoteAddr) || !a.hostAllowed(r.Host) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(localPageHTML))
}

// LocalWeb gates local app pages and static assets before the SPA is served.
// API and MCP requests retain their own authentication rules.
func (a *API) LocalWeb(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p == "/auth/local" || p == "/api" || strings.HasPrefix(p, "/api/") || p == "/mcp" || strings.HasPrefix(p, "/mcp/") || p == "/ca.crt" {
			next.ServeHTTP(w, r)
			return
		}
		if a.isLANRequest(r) {
			next.ServeHTTP(w, r)
			return
		}
		if !isLoopbackAddr(r.RemoteAddr) || !a.hostAllowed(r.Host) {
			http.Error(w, "forbidden", 403)
			return
		}
		authed, limited := a.localAuthenticated(r)
		if !authed {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			if limited {
				w.WriteHeader(429)
			} else {
				w.WriteHeader(401)
			}
			w.Write([]byte(localGateHTML))
			return
		}
		next.ServeHTTP(w, r)
	})
}

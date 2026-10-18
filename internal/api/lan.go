package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

const (
	sessionCookieName = "fz_session"
	sessionTTL        = 30 * 24 * time.Hour
	pairingTTL        = 5 * time.Minute
)

type lanConnKey struct{}
type sessionKey struct{}

type streamHandle struct {
	conn   *websocket.Conn
	cancel context.CancelFunc
}

type PairingResponse struct {
	Token         string    `json:"token"`
	URL           string    `json:"url"`
	QRSVG         string    `json:"qr_svg"`
	CAFingerprint string    `json:"ca_fingerprint"`
	CAHTTPURL     string    `json:"ca_http_url,omitempty"`
	ExpiresAt     time.Time `json:"expires_at"`
}

// LANHandler marks every request served through it as a LAN connection.
func (a *API) LANHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), lanConnKey{}, true)))
	})
}

func (a *API) now() time.Time {
	if a.Now != nil {
		return a.Now().UTC()
	}
	return time.Now().UTC()
}

func isLoopbackAddr(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (a *API) isLANRequest(r *http.Request) bool {
	if v, ok := r.Context().Value(lanConnKey{}).(bool); ok && v {
		return true
	}
	if !a.LANEnabled {
		return false
	}
	if r.TLS != nil {
		return true
	}
	return !isLoopbackAddr(r.RemoteAddr) || !loopbackHost(r.Host)
}

func validLANOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || r.Host == "" {
		return false
	}
	return origin == "https://"+r.Host
}

func validLoopbackOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	return origin == "" || origin == "http://"+r.Host || origin == "https://"+r.Host
}

func currentSessionID(r *http.Request) string {
	v, _ := r.Context().Value(sessionKey{}).(string)
	return v
}

func setSessionCookie(w http.ResponseWriter, token string, expiresAt time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		Expires:  expiresAt.UTC(),
		MaxAge:   int(sessionTTL / time.Second),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

func defaultDeviceName(ua string) string {
	lower := strings.ToLower(ua)
	switch {
	case strings.Contains(lower, "iphone"):
		return "iPhone"
	case strings.Contains(lower, "ipad"):
		return "iPad"
	case strings.Contains(lower, "android"):
		return "Android phone"
	default:
		return "Browser"
	}
}

func (a *API) publicPost(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.isLANRequest(r) {
			if !validLANOrigin(r) {
				fail(w, 403, "forbidden", "invalid origin")
				return
			}
			next(w, r.WithContext(context.WithValue(r.Context(), lanConnKey{}, true)))
			return
		}
		if !isLoopbackAddr(r.RemoteAddr) {
			fail(w, 403, "forbidden", "local requests only")
			return
		}
		if !loopbackHost(r.Host) {
			fail(w, 403, "forbidden", "invalid host")
			return
		}
		if !validLoopbackOrigin(r) {
			fail(w, 403, "forbidden", "invalid origin")
			return
		}
		next(w, r)
	}
}

func (a *API) serveCACert(w http.ResponseWriter, r *http.Request) {
	if len(a.CACertPEM) == 0 {
		fail(w, 404, "not_found", "ca certificate not configured")
		return
	}
	w.Header().Set("Content-Type", "application/x-x509-ca-cert")
	w.Header().Set("Content-Disposition", `attachment; filename="faztudo-ca.crt"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(a.CACertPEM)
}

func (a *API) serveMCP(w http.ResponseWriter, r *http.Request) {
	if a.isLANRequest(r) || !isLoopbackAddr(r.RemoteAddr) || !loopbackHost(r.Host) {
		fail(w, 403, "forbidden", "mcp is loopback only")
		return
	}
	if a.MCP != nil {
		a.MCP.ServeHTTP(w, r)
		return
	}
	fail(w, 404, "not_found", "endpoint not found")
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	if a.Limiter == nil {
		a.Limiter = auth.NewLoginRateLimiter()
	}
	if !a.Limiter.Allowed(r.RemoteAddr) {
		fail(w, 429, "rate_limited", "too many failed login attempts")
		return
	}
	var req struct {
		Password   string `json:"password"`
		DeviceName string `json:"device_name"`
	}
	if !decode(w, r, &req) {
		return
	}
	hash, err := a.Store.PasswordHash(r.Context())
	if err != nil || !auth.CheckPassword(hash, req.Password) {
		a.Limiter.RecordFailure(r.RemoteAddr)
		fail(w, 401, "unauthorized", "invalid password")
		return
	}
	token, err := auth.NewSessionToken()
	if err != nil {
		fail(w, 500, "internal", "internal error")
		return
	}
	deviceName := strings.TrimSpace(req.DeviceName)
	if deviceName == "" {
		deviceName = defaultDeviceName(r.UserAgent())
	}
	now := a.now()
	expiresAt := now.Add(sessionTTL)
	dev, err := a.Store.CreateSession(r.Context(), auth.HashToken(token), a.HumanID, deviceName, r.UserAgent(), now, expiresAt)
	if err != nil {
		failErr(w, err)
		return
	}
	dev.Current = true
	dev.OK = true
	setSessionCookie(w, token, expiresAt)
	respond(w, 200, dev)
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookieName); err == nil && cookie.Value != "" {
		if id, delErr := a.Store.DeleteSessionByTokenHash(r.Context(), auth.HashToken(cookie.Value)); delErr == nil && id != "" {
			a.closeDeviceStreams(id)
		}
	}
	clearSessionCookie(w)
	respond(w, 200, map[string]bool{"ok": true})
}

func (a *API) devices(w http.ResponseWriter, r *http.Request) {
	list, err := a.Store.Devices(r.Context(), a.now())
	if err != nil {
		failErr(w, err)
		return
	}
	cur := currentSessionID(r)
	for i := range list {
		list[i].Current = cur != "" && list[i].ID == cur
	}
	respond(w, 200, list)
}

func (a *API) revokeDevice(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := a.Store.DeleteDevice(r.Context(), id); err != nil {
		failErr(w, err)
		return
	}
	a.closeDeviceStreams(id)
	respond(w, 200, map[string]bool{"ok": true})
}

func (a *API) createPairing(w http.ResponseWriter, r *http.Request) {
	if a.isLANRequest(r) || !isLoopbackAddr(r.RemoteAddr) || !loopbackHost(r.Host) {
		fail(w, 403, "forbidden", "pairings can only be created from loopback")
		return
	}
	token, err := auth.NewPairingToken()
	if err != nil {
		fail(w, 500, "internal", "internal error")
		return
	}
	now := a.now()
	expiresAt := now.Add(pairingTTL)
	if _, err := a.Store.CreatePairing(r.Context(), auth.HashToken(token), now, expiresAt); err != nil {
		failErr(w, err)
		return
	}
	baseURL := a.primaryLANURL()
	pairURL := baseURL + "/pair#" + token
	qrSVG, err := auth.RenderQRSVG(pairURL)
	if err != nil {
		fail(w, 500, "internal", "internal error")
		return
	}
	respond(w, 200, PairingResponse{
		Token:         token,
		URL:           pairURL,
		QRSVG:         qrSVG,
		CAFingerprint: a.CAFingerprint,
		CAHTTPURL:     a.CAHTTPURL,
		ExpiresAt:     expiresAt,
	})
}

func (a *API) caInfo(w http.ResponseWriter, r *http.Request) {
	respond(w, 200, map[string]any{
		"ca_fingerprint": a.CAFingerprint,
		"ca_http_url":    a.CAHTTPURL,
		"lan_urls":       a.LANURLs,
	})
}

func (a *API) pair(w http.ResponseWriter, r *http.Request) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		fail(w, 400, "bad_request", "application/json required")
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	// Burn any presented token on first use, whether the request succeeds or not.
	var peek struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(raw, &peek)
	var consumeErr error
	if trimmedTok := strings.TrimSpace(peek.Token); trimmedTok != "" {
		consumeErr = a.Store.ConsumePairing(r.Context(), auth.HashToken(trimmedTok), a.now())
	} else {
		consumeErr = store.ErrNotFound
	}

	var req struct {
		Token      string `json:"token"`
		DeviceName string `json:"device_name"`
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	if strings.TrimSpace(req.Token) == "" {
		fail(w, 400, "bad_request", "token required")
		return
	}
	deviceName := strings.TrimSpace(req.DeviceName)
	if deviceName == "" {
		fail(w, 400, "bad_request", "device_name required")
		return
	}
	if consumeErr != nil {
		fail(w, 401, "unauthorized", "invalid or expired pairing token")
		return
	}

	sessToken, err := auth.NewSessionToken()
	if err != nil {
		fail(w, 500, "internal", "internal error")
		return
	}
	now := a.now()
	expiresAt := now.Add(sessionTTL)
	dev, err := a.Store.CreateSession(r.Context(), auth.HashToken(sessToken), a.HumanID, deviceName, r.UserAgent(), now, expiresAt)
	if err != nil {
		failErr(w, err)
		return
	}
	dev.Current = true
	dev.OK = true
	setSessionCookie(w, sessToken, expiresAt)
	respond(w, 200, dev)
}

func (a *API) primaryLANURL() string {
	if len(a.LANURLs) > 0 && a.LANURLs[0] != "" {
		return strings.TrimRight(a.LANURLs[0], "/")
	}
	listen := a.LANListen
	if listen == "" {
		listen = "0.0.0.0:7458"
	}
	_, ips, _ := auth.DefaultHostAndIPs()
	if urls := auth.LANURLs(ips, listen); len(urls) > 0 {
		return strings.TrimRight(urls[0], "/")
	}
	_, port, err := net.SplitHostPort(listen)
	if err != nil || port == "" {
		port = "7458"
	}
	return "https://" + net.JoinHostPort("localhost", port)
}

func (a *API) registerStream(sessionID string, h *streamHandle) {
	if sessionID == "" {
		return
	}
	a.streamsMu.Lock()
	defer a.streamsMu.Unlock()
	if a.streams == nil {
		a.streams = map[string]map[*streamHandle]struct{}{}
	}
	if a.streams[sessionID] == nil {
		a.streams[sessionID] = map[*streamHandle]struct{}{}
	}
	a.streams[sessionID][h] = struct{}{}
}

func (a *API) unregisterStream(sessionID string, h *streamHandle) {
	if sessionID == "" {
		return
	}
	a.streamsMu.Lock()
	defer a.streamsMu.Unlock()
	if set := a.streams[sessionID]; set != nil {
		delete(set, h)
		if len(set) == 0 {
			delete(a.streams, sessionID)
		}
	}
}

func (a *API) closeDeviceStreams(sessionID string) {
	if sessionID == "" {
		return
	}
	a.streamsMu.Lock()
	set := a.streams[sessionID]
	delete(a.streams, sessionID)
	handles := make([]*streamHandle, 0, len(set))
	for h := range set {
		handles = append(handles, h)
	}
	a.streamsMu.Unlock()
	for _, h := range handles {
		h.cancel()
		_ = h.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "device revoked"), time.Now().Add(time.Second))
		_ = h.conn.Close()
	}
}

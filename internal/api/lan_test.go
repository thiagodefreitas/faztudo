package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func setupLANTestAPI(t *testing.T, password string) (*store.Store, *API, domain.Member, domain.Channel) {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })

	human := domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: "user", DisplayName: "User", Presence: domain.PresenceOnline}
	if _, err := s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: human}); err != nil {
		t.Fatal(err)
	}
	ch := domain.Channel{ID: store.NewID(), Name: "general", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic, MemberIDs: []string{human.ID}}
	if _, err := s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: ch.ID, Payload: ch}); err != nil {
		t.Fatal(err)
	}
	if password != "" {
		hash, err := auth.HashPassword(password)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.SetPasswordHash(ctx, hash); err != nil {
			t.Fatal(err)
		}
	}

	h := newTestAPI(s, human.ID, "test")
	h.LANEnabled = true
	h.LANListen = "0.0.0.0:7458"
	h.LANURLs = []string{"https://192.168.1.10:7458"}
	h.CAHTTPURL = "http://192.168.1.10:7459"
	h.CACertPEM = []byte("-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n")
	h.CAFingerprint = "AA:BB:CC:DD"
	return s, h, human, ch
}

func TestLANWithoutSessionGets401WhileLocalBearerWorks(t *testing.T) {
	_, h, human, _ := setupLANTestAPI(t, "synthetic-pass")
	h.localAuthBypass = false
	h.LocalTokenPath = auth.LocalTokenPath(t.TempDir())
	token, err := auth.EnsureLocalToken(h.LocalTokenPath)
	if err != nil {
		t.Fatal(err)
	}

	// Loopback uses the local token even while LAN mode is on.
	loopReq := httptest.NewRequest("GET", "/api/v1/me", nil)
	loopReq.RemoteAddr = "127.0.0.1:12345"
	loopReq.Host = "127.0.0.1:7457"
	loopReq.Header.Set("Authorization", "Bearer "+token)
	loopRec := httptest.NewRecorder()
	h.ServeHTTP(loopRec, loopReq)
	if loopRec.Code != http.StatusOK {
		t.Fatalf("loopback status %d, want 200: %s", loopRec.Code, loopRec.Body.String())
	}
	var got domain.Member
	if err := json.Unmarshal(loopRec.Body.Bytes(), &got); err != nil || got.ID != human.ID {
		t.Fatalf("loopback me: %+v %v", got, err)
	}

	// LAN request without session cookie gets 401.
	lanReq := httptest.NewRequest("GET", "/api/v1/me", nil)
	lanReq.RemoteAddr = "192.168.1.50:54321"
	lanReq.Host = "192.168.1.10:7458"
	lanRec := httptest.NewRecorder()
	h.ServeHTTP(lanRec, lanReq)
	if lanRec.Code != http.StatusUnauthorized {
		t.Fatalf("LAN unauthenticated status %d, want 401: %s", lanRec.Code, lanRec.Body.String())
	}
}

func TestLoginSetsCookieFlagsAndRateLimitsWrongPasswords(t *testing.T) {
	_, h, _, _ := setupLANTestAPI(t, "synthetic-pass")
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	h.Now = func() time.Time { return now }
	h.Limiter.Now = func() time.Time { return now }

	// 5 wrong password attempts return 401, then the 6th returns 429.
	for i := range 5 {
		req := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(`{"password":"wrong-password","device_name":"Phone"}`))
		req.RemoteAddr = "192.168.1.77:40000"
		req.Host = "192.168.1.10:7458"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "https://192.168.1.10:7458")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d status %d, want 401", i+1, rec.Code)
		}
	}
	rateReq := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(`{"password":"synthetic-pass","device_name":"Phone"}`))
	rateReq.RemoteAddr = "192.168.1.77:40001"
	rateReq.Host = "192.168.1.10:7458"
	rateReq.Header.Set("Content-Type", "application/json")
	rateReq.Header.Set("Origin", "https://192.168.1.10:7458")
	rateRec := httptest.NewRecorder()
	h.ServeHTTP(rateRec, rateReq)
	if rateRec.Code != http.StatusTooManyRequests {
		t.Fatalf("6th attempt status %d, want 429: %s", rateRec.Code, rateRec.Body.String())
	}

	// Login from a non-rate-limited address succeeds and sets fz_session with required flags.
	loginReq := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(`{"password":"synthetic-pass","device_name":"Pixel"}`))
	loginReq.RemoteAddr = "192.168.1.88:40000"
	loginReq.Host = "192.168.1.10:7458"
	loginReq.Header.Set("Content-Type", "application/json")
	loginReq.Header.Set("Origin", "https://192.168.1.10:7458")
	loginRec := httptest.NewRecorder()
	h.ServeHTTP(loginRec, loginReq)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login status %d, want 200: %s", loginRec.Code, loginRec.Body.String())
	}

	cookies := loginRec.Result().Cookies()
	var sessionCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == "fz_session" {
			sessionCookie = c
			break
		}
	}
	if sessionCookie == nil {
		t.Fatal("fz_session cookie not set")
	}
	if !sessionCookie.HttpOnly {
		t.Fatal("cookie HttpOnly must be true")
	}
	if !sessionCookie.Secure {
		t.Fatal("cookie Secure must be true")
	}
	if sessionCookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie SameSite %v, want Strict", sessionCookie.SameSite)
	}
	if sessionCookie.Path != "/" {
		t.Fatalf("cookie Path %q, want /", sessionCookie.Path)
	}
	if sessionCookie.MaxAge != 30*24*60*60 {
		t.Fatalf("cookie MaxAge %d, want %d", sessionCookie.MaxAge, 30*24*60*60)
	}
	if len(sessionCookie.Value) != 64 {
		t.Fatalf("cookie token length %d, want 64 hex chars", len(sessionCookie.Value))
	}

	// Authenticated LAN request using the cookie succeeds.
	meReq := httptest.NewRequest("GET", "/api/v1/me", nil)
	meReq.RemoteAddr = "192.168.1.88:40000"
	meReq.Host = "192.168.1.10:7458"
	meReq.AddCookie(sessionCookie)
	meRec := httptest.NewRecorder()
	h.ServeHTTP(meRec, meReq)
	if meRec.Code != http.StatusOK {
		t.Fatalf("LAN /me with session status %d, want 200", meRec.Code)
	}
}

func TestPairingTokenSingleUseAndExpiresAndPhoneResolvesApproval(t *testing.T) {
	s, h, human, ch := setupLANTestAPI(t, "")
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	h.Now = func() time.Time { return now }

	// Creating a pairing from LAN is refused with 403.
	lanPairCreate := httptest.NewRequest("POST", "/api/v1/auth/pairings", strings.NewReader(`{}`))
	lanPairCreate.RemoteAddr = "192.168.1.50:1234"
	lanPairCreate.Host = "192.168.1.10:7458"
	lanPairCreate.Header.Set("Content-Type", "application/json")
	lanPairCreate.Header.Set("Origin", "https://192.168.1.10:7458")
	lanPairRec := httptest.NewRecorder()
	h.ServeHTTP(lanPairRec, lanPairCreate)
	if lanPairRec.Code != http.StatusForbidden && lanPairRec.Code != http.StatusUnauthorized {
		t.Fatalf("LAN pairing creation status %d, want 401/403", lanPairRec.Code)
	}

	createPairingFromLoopback := func() PairingResponse {
		t.Helper()
		req := httptest.NewRequest("POST", "/api/v1/auth/pairings", strings.NewReader(`{}`))
		req.RemoteAddr = "127.0.0.1:1234"
		req.Host = "127.0.0.1:7457"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("loopback create pairing status %d: %s", rec.Code, rec.Body.String())
		}
		var out PairingResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Token) != 32 || !strings.HasSuffix(out.URL, "/pair#"+out.Token) || !strings.Contains(out.QRSVG, "<svg") {
			t.Fatalf("unexpected pairing response: %+v", out)
		}
		return out
	}

	// 1. Failed first use (empty device_name) still burns the token.
	p1 := createPairingFromLoopback()
	badRedeem := httptest.NewRequest("POST", "/api/v1/auth/pair", strings.NewReader(`{"token":"`+p1.Token+`","device_name":""}`))
	badRedeem.RemoteAddr = "192.168.1.60:1234"
	badRedeem.Host = "192.168.1.10:7458"
	badRedeem.Header.Set("Content-Type", "application/json")
	badRedeem.Header.Set("Origin", "https://192.168.1.10:7458")
	badRec := httptest.NewRecorder()
	h.ServeHTTP(badRec, badRedeem)
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("empty device_name status %d, want 400", badRec.Code)
	}
	retryBurned := httptest.NewRequest("POST", "/api/v1/auth/pair", strings.NewReader(`{"token":"`+p1.Token+`","device_name":"Phone"}`))
	retryBurned.RemoteAddr = "192.168.1.60:1234"
	retryBurned.Host = "192.168.1.10:7458"
	retryBurned.Header.Set("Content-Type", "application/json")
	retryBurned.Header.Set("Origin", "https://192.168.1.10:7458")
	retryBurnedRec := httptest.NewRecorder()
	h.ServeHTTP(retryBurnedRec, retryBurned)
	if retryBurnedRec.Code != http.StatusUnauthorized {
		t.Fatalf("burned token status %d, want 401", retryBurnedRec.Code)
	}

	// 2. Expired token (after 5 minutes) is rejected.
	p2 := createPairingFromLoopback()
	now = now.Add(5*time.Minute + time.Second)
	expRedeem := httptest.NewRequest("POST", "/api/v1/auth/pair", strings.NewReader(`{"token":"`+p2.Token+`","device_name":"Phone"}`))
	expRedeem.RemoteAddr = "192.168.1.60:1234"
	expRedeem.Host = "192.168.1.10:7458"
	expRedeem.Header.Set("Content-Type", "application/json")
	expRedeem.Header.Set("Origin", "https://192.168.1.10:7458")
	expRec := httptest.NewRecorder()
	h.ServeHTTP(expRec, expRedeem)
	if expRec.Code != http.StatusUnauthorized {
		t.Fatalf("expired token status %d, want 401", expRec.Code)
	}

	// 3. Valid token succeeds once and cannot be reused.
	p3 := createPairingFromLoopback()
	okRedeem := httptest.NewRequest("POST", "/api/v1/auth/pair", strings.NewReader(`{"token":"`+p3.Token+`","device_name":"My Phone"}`))
	okRedeem.RemoteAddr = "192.168.1.60:1234"
	okRedeem.Host = "192.168.1.10:7458"
	okRedeem.Header.Set("Content-Type", "application/json")
	okRedeem.Header.Set("Origin", "https://192.168.1.10:7458")
	okRec := httptest.NewRecorder()
	h.ServeHTTP(okRec, okRedeem)
	if okRec.Code != http.StatusOK {
		t.Fatalf("valid pair status %d, want 200: %s", okRec.Code, okRec.Body.String())
	}
	var pairedCookie *http.Cookie
	for _, c := range okRec.Result().Cookies() {
		if c.Name == "fz_session" {
			pairedCookie = c
		}
	}
	if pairedCookie == nil {
		t.Fatal("pairing did not set fz_session cookie")
	}

	// Reusing p3 fails with 401.
	reuseReq := httptest.NewRequest("POST", "/api/v1/auth/pair", strings.NewReader(`{"token":"`+p3.Token+`","device_name":"Second Phone"}`))
	reuseReq.RemoteAddr = "192.168.1.60:1234"
	reuseReq.Host = "192.168.1.10:7458"
	reuseReq.Header.Set("Content-Type", "application/json")
	reuseReq.Header.Set("Origin", "https://192.168.1.10:7458")
	reuseRec := httptest.NewRecorder()
	h.ServeHTTP(reuseRec, reuseReq)
	if reuseRec.Code != http.StatusUnauthorized {
		t.Fatalf("reused pairing token status %d, want 401", reuseRec.Code)
	}

	// Even with a valid LAN session, POST /api/v1/auth/pairings is refused on LAN.
	lanCreateWithSession := httptest.NewRequest("POST", "/api/v1/auth/pairings", strings.NewReader(`{}`))
	lanCreateWithSession.RemoteAddr = "192.168.1.60:1234"
	lanCreateWithSession.Host = "192.168.1.10:7458"
	lanCreateWithSession.Header.Set("Content-Type", "application/json")
	lanCreateWithSession.Header.Set("Origin", "https://192.168.1.10:7458")
	lanCreateWithSession.AddCookie(pairedCookie)
	lanCreateRec := httptest.NewRecorder()
	h.ServeHTTP(lanCreateRec, lanCreateWithSession)
	if lanCreateRec.Code != http.StatusForbidden {
		t.Fatalf("LAN pairing creation with session status %d, want 403", lanCreateRec.Code)
	}

	// Phone resolves a pending approval over LAN.
	approval := domain.Approval{
		ID:          store.NewID(),
		ChannelID:   ch.ID,
		RequestedBy: "agent-1",
		Title:       "Approve synthetic branch",
		State:       domain.ApprovalPending,
		Options:     []domain.ApprovalOption{{Key: "yes", Label: "Yes"}},
	}
	if _, err := s.Append(context.Background(), events.Draft{Type: events.ApprovalRequested, Actor: events.Agent("agent-1"), ChannelID: ch.ID, Payload: approval}); err != nil {
		t.Fatal(err)
	}
	resolveReq := httptest.NewRequest("POST", "/api/v1/approvals/"+approval.ID+"/resolve", strings.NewReader(`{"option":"yes"}`))
	resolveReq.RemoteAddr = "192.168.1.60:1234"
	resolveReq.Host = "192.168.1.10:7458"
	resolveReq.Header.Set("Content-Type", "application/json")
	resolveReq.Header.Set("Origin", "https://192.168.1.10:7458")
	resolveReq.AddCookie(pairedCookie)
	resolveRec := httptest.NewRecorder()
	h.ServeHTTP(resolveRec, resolveReq)
	if resolveRec.Code != http.StatusOK {
		t.Fatalf("phone approval resolve status %d: %s", resolveRec.Code, resolveRec.Body.String())
	}
	resolved, err := s.Approval(context.Background(), approval.ID)
	if err != nil || resolved.State != domain.ApprovalResolved || resolved.Resolution == nil || resolved.Resolution.By != human.ID {
		t.Fatalf("approval resolution mismatch: %+v %v", resolved, err)
	}
}

func TestRevokedDeviceLosesAPIAndWebSocketAccess(t *testing.T) {
	s, h, _, ch := setupLANTestAPI(t, "synthetic-pass")
	srv := httptest.NewTLSServer(h.LANHandler())
	defer srv.Close()

	client := srv.Client()
	origin := srv.URL

	// Login over LAN TLS server.
	loginReq, _ := http.NewRequest("POST", srv.URL+"/api/v1/auth/login", bytes.NewBufferString(`{"password":"synthetic-pass","device_name":"Phone"}`))
	loginReq.Header.Set("Content-Type", "application/json")
	loginReq.Header.Set("Origin", origin)
	loginRes, err := client.Do(loginReq)
	if err != nil {
		t.Fatal(err)
	}
	var dev store.Device
	_ = json.NewDecoder(loginRes.Body).Decode(&dev)
	cookies := loginRes.Cookies()
	loginRes.Body.Close()
	if loginRes.StatusCode != http.StatusOK || dev.ID == "" || len(cookies) == 0 {
		t.Fatalf("login failed: %d %+v", loginRes.StatusCode, dev)
	}

	// Open WebSocket stream with the session cookie and matching Origin.
	dialer := websocket.Dialer{TLSClientConfig: client.Transport.(*http.Transport).TLSClientConfig}
	wsHeader := http.Header{"Origin": []string{origin}, "Cookie": []string{cookies[0].Name + "=" + cookies[0].Value}}
	wsURL := "wss" + srv.URL[5:] + "/api/v1/stream"
	ws, _, err := dialer.Dial(wsURL, wsHeader)
	if err != nil {
		t.Fatalf("websocket dial failed: %v", err)
	}
	defer ws.Close()
	if err := ws.WriteMessage(websocket.TextMessage, []byte(`{"op":"subscribe","after_seq":0}`)); err != nil {
		t.Fatal(err)
	}
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := ws.ReadMessage(); err != nil {
		t.Fatalf("initial ws read failed: %v", err)
	}

	// List devices and verify our device is present.
	listReq, _ := http.NewRequest("GET", srv.URL+"/api/v1/auth/devices", nil)
	listReq.AddCookie(cookies[0])
	listRes, err := client.Do(listReq)
	if err != nil {
		t.Fatal(err)
	}
	var devices []store.Device
	_ = json.NewDecoder(listRes.Body).Decode(&devices)
	listRes.Body.Close()
	if len(devices) != 1 || devices[0].ID != dev.ID || !devices[0].Current {
		t.Fatalf("devices list: %+v", devices)
	}

	// Revoke the device from loopback.
	revokeReq := httptest.NewRequest("DELETE", "/api/v1/auth/devices/"+dev.ID, nil)
	revokeReq.RemoteAddr = "127.0.0.1:1234"
	revokeReq.Host = "127.0.0.1:7457"
	revokeRec := httptest.NewRecorder()
	h.ServeHTTP(revokeRec, revokeReq)
	if revokeRec.Code != http.StatusOK {
		t.Fatalf("revoke status %d: %s", revokeRec.Code, revokeRec.Body.String())
	}

	// API access with the revoked session cookie immediately returns 401.
	meReq, _ := http.NewRequest("GET", srv.URL+"/api/v1/me", nil)
	meReq.AddCookie(cookies[0])
	meRes, err := client.Do(meReq)
	if err != nil {
		t.Fatal(err)
	}
	meRes.Body.Close()
	if meRes.StatusCode != http.StatusUnauthorized {
		t.Fatalf("API after revoke status %d, want 401", meRes.StatusCode)
	}

	// Open WebSocket is closed immediately and does not receive new events.
	_, _ = s.Append(context.Background(), events.Draft{
		Type:      events.MessagePosted,
		Actor:     events.System,
		ChannelID: ch.ID,
		Payload:   domain.Message{ID: store.NewID(), ChannelID: ch.ID, AuthorID: "system", Body: "after revoke", CreatedAt: time.Now().UTC()},
	})
	ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, msgBytes, err := ws.ReadMessage()
		if err != nil {
			break // Expected: connection closed!
		}
		if strings.Contains(string(msgBytes), "after revoke") {
			t.Fatal("revoked WebSocket received event posted after revocation")
		}
	}

	// Re-dialing WebSocket with revoked cookie fails.
	if _, wsRes, err := dialer.Dial(wsURL, wsHeader); err == nil {
		t.Fatal("expected WebSocket dial with revoked cookie to fail")
	} else if wsRes != nil && wsRes.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked ws dial status %d, want 401", wsRes.StatusCode)
	}
}

func TestCrossOriginOnLANAndMCPRefused(t *testing.T) {
	_, h, _, ch := setupLANTestAPI(t, "synthetic-pass")
	srv := httptest.NewTLSServer(h.LANHandler())
	defer srv.Close()
	client := srv.Client()
	origin := srv.URL

	// Login to get a valid LAN session cookie.
	loginReq, _ := http.NewRequest("POST", srv.URL+"/api/v1/auth/login", bytes.NewBufferString(`{"password":"synthetic-pass","device_name":"Phone"}`))
	loginReq.Header.Set("Content-Type", "application/json")
	loginReq.Header.Set("Origin", origin)
	loginRes, err := client.Do(loginReq)
	if err != nil {
		t.Fatal(err)
	}
	cookies := loginRes.Cookies()
	loginRes.Body.Close()

	// Cross-origin POST on LAN is refused with 403.
	for _, badOrigin := range []string{"https://evil.example", "http://127.0.0.1:7457", ""} {
		postReq, _ := http.NewRequest("POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", bytes.NewBufferString(`{"body":"hello"}`))
		postReq.Header.Set("Content-Type", "application/json")
		if badOrigin != "" {
			postReq.Header.Set("Origin", badOrigin)
		}
		postReq.AddCookie(cookies[0])
		postRes, err := client.Do(postReq)
		if err != nil {
			t.Fatal(err)
		}
		postRes.Body.Close()
		if postRes.StatusCode != http.StatusForbidden {
			t.Fatalf("POST with Origin %q status %d, want 403", badOrigin, postRes.StatusCode)
		}
	}

	// Cross-origin WebSocket upgrade on LAN is refused with 403.
	dialer := websocket.Dialer{TLSClientConfig: client.Transport.(*http.Transport).TLSClientConfig}
	wsURL := "wss" + srv.URL[5:] + "/api/v1/stream"
	for _, badOrigin := range []string{"https://evil.example", "http://localhost:7457", ""} {
		hdr := http.Header{"Cookie": []string{cookies[0].Name + "=" + cookies[0].Value}}
		if badOrigin != "" {
			hdr.Set("Origin", badOrigin)
		}
		_, wsRes, err := dialer.Dial(wsURL, hdr)
		if err == nil {
			t.Fatalf("expected WS upgrade with Origin %q to fail", badOrigin)
		}
		if wsRes == nil || wsRes.StatusCode != http.StatusForbidden {
			t.Fatalf("WS upgrade with Origin %q status %v, want 403", badOrigin, wsRes)
		}
	}

	// /mcp refuses LAN requests with 403 even with a valid session.
	for _, path := range []string{"/mcp", "/mcp/messages"} {
		mcpReq, _ := http.NewRequest("POST", srv.URL+path, bytes.NewBufferString(`{}`))
		mcpReq.Header.Set("Content-Type", "application/json")
		mcpReq.Header.Set("Origin", origin)
		mcpReq.AddCookie(cookies[0])
		mcpRes, err := client.Do(mcpReq)
		if err != nil {
			t.Fatal(err)
		}
		mcpRes.Body.Close()
		if mcpRes.StatusCode != http.StatusForbidden {
			t.Fatalf("LAN %s status %d, want 403", path, mcpRes.StatusCode)
		}
	}

	// GET /ca.crt works over LAN without a session.
	caRes, err := client.Get(srv.URL + "/ca.crt")
	if err != nil {
		t.Fatal(err)
	}
	caRes.Body.Close()
	if caRes.StatusCode != http.StatusOK {
		t.Fatalf("GET /ca.crt status %d, want 200", caRes.StatusCode)
	}
}

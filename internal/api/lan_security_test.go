package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func lanLoginReq(remote, password string) *http.Request {
	req := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(`{"password":"`+password+`","device_name":"Phone"}`))
	req.RemoteAddr = remote
	req.Host = "192.168.1.10:7458"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://192.168.1.10:7458")
	return req
}

// Finding 1: a burst of parallel wrong passwords must not slip past the limiter.
func TestLoginBurstIsRateLimited(t *testing.T) {
	_, h, _, _ := setupLANTestAPI(t, "synthetic-pass")
	const n = 12
	codes := make([]int, n)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, lanLoginReq("203.0.113.10:9", "wrong-password-"+string(rune('a'+i))))
			codes[i] = rec.Code
		}()
	}
	close(start)
	wg.Wait()
	notLimited := 0
	for _, c := range codes {
		if c != http.StatusTooManyRequests {
			notLimited++
		}
	}
	if notLimited > 5 {
		t.Fatalf("%d of %d burst logins were not rate limited (codes %v), want at most 5", notLimited, n, codes)
	}
}

// Finding 1: textual aliases of one address share one bucket.
func TestLoginRateLimitNormalizesIPAliases(t *testing.T) {
	_, h, _, _ := setupLANTestAPI(t, "synthetic-pass")
	for i := range 5 {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, lanLoginReq("192.0.2.8:1", "wrong-password"))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d status %d, want 401", i+1, rec.Code)
		}
	}
	for _, alias := range []string{"[::ffff:192.0.2.8]:2", "[0:0:0:0:0:ffff:c000:208]:3"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, lanLoginReq(alias, "wrong-password"))
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("alias %s status %d, want 429", alias, rec.Code)
		}
	}
	for i := range 5 {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, lanLoginReq("[2001:db8::1]:1", "wrong-password"))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("v6 attempt %d status %d, want 401", i+1, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, lanLoginReq("[2001:0db8:0:0:0:0:0:1]:2", "wrong-password"))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expanded IPv6 alias status %d, want 429", rec.Code)
	}
}

// Finding 2: forwarding headers on a loopback request must not auto-sign-in when LAN mode is on.
func TestForwardedHeadersOnLoopbackNeedSessionWhenLANEnabled(t *testing.T) {
	_, h, _, ch := setupLANTestAPI(t, "synthetic-pass")
	h.AllowedHosts = []string{"pc.example.ts.net"}
	trig := &countTrigger{}
	h.Trigger = trig
	for _, hdr := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded"} {
		req := httptest.NewRequest("POST", "/api/v1/channels/"+ch.ID+"/messages", strings.NewReader(`{"body":"@coder ship it"}`))
		req.RemoteAddr = "127.0.0.1:5000"
		req.Host = "127.0.0.1:7457"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(hdr, "pc.example.ts.net")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized && rec.Code != http.StatusForbidden {
			t.Fatalf("%s: status %d, want 401: %s", hdr, rec.Code, rec.Body.String())
		}
		get := httptest.NewRequest("GET", "/api/v1/channels", nil)
		get.RemoteAddr = "127.0.0.1:5000"
		get.Host = "localhost:7457"
		get.Header.Set(hdr, "100.64.0.8")
		grec := httptest.NewRecorder()
		h.ServeHTTP(grec, get)
		if grec.Code != http.StatusUnauthorized {
			t.Fatalf("%s GET: status %d, want 401", hdr, grec.Code)
		}
	}
	if trig.count != 0 {
		t.Fatalf("trigger ran %d times, want 0", trig.count)
	}
	// Desktop request with no forwarding headers keeps auto sign-in.
	req := httptest.NewRequest("GET", "/api/v1/channels", nil)
	req.RemoteAddr = "127.0.0.1:5000"
	req.Host = "127.0.0.1:7457"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("desktop status %d, want 200", rec.Code)
	}
}

// Finding 3: an open stream closes once its session row is gone, even when
// the deletion came from another process.
func TestStreamClosesWhenSessionRowDisappears(t *testing.T) {
	s, h, _, _ := setupLANTestAPI(t, "synthetic-pass")
	h.SessionRecheck = 50 * time.Millisecond
	srv := httptest.NewTLSServer(h.LANHandler())
	defer srv.Close()
	client := srv.Client()
	loginReq, _ := http.NewRequest("POST", srv.URL+"/api/v1/auth/login", bytes.NewBufferString(`{"password":"synthetic-pass","device_name":"Phone"}`))
	loginReq.Header.Set("Content-Type", "application/json")
	loginReq.Header.Set("Origin", srv.URL)
	res, err := client.Do(loginReq)
	if err != nil {
		t.Fatal(err)
	}
	var dev store.Device
	_ = json.NewDecoder(res.Body).Decode(&dev)
	cookies := res.Cookies()
	res.Body.Close()
	if len(cookies) == 0 || dev.ID == "" {
		t.Fatalf("login failed: %d", res.StatusCode)
	}
	dialer := websocket.Dialer{TLSClientConfig: client.Transport.(*http.Transport).TLSClientConfig}
	hdr := http.Header{"Origin": []string{srv.URL}, "Cookie": []string{cookies[0].Name + "=" + cookies[0].Value}}
	ws, _, err := dialer.Dial("wss"+srv.URL[5:]+"/api/v1/stream", hdr)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if err := ws.WriteMessage(websocket.TextMessage, []byte(`{"op":"subscribe","after_seq":0}`)); err != nil {
		t.Fatal(err)
	}
	// Delete the row behind the daemon's back; no in-process revoke runs.
	if err := s.DeleteDevice(context.Background(), dev.ID); err != nil {
		t.Fatal(err)
	}
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, _, err := ws.ReadMessage()
		if err == nil {
			continue
		}
		var ne interface{ Timeout() bool }
		if errors.As(err, &ne) && ne.Timeout() {
			t.Fatal("stream stayed open after its session row was deleted")
		}
		return
	}
}

// Finding 4: a pairing token mints exactly one session under concurrency.
func TestConcurrentPairingMintsOneSession(t *testing.T) {
	s, h, _, _ := setupLANTestAPI(t, "synthetic-pass")
	tok, err := auth.NewPairingToken()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err := s.CreatePairing(context.Background(), auth.HashToken(tok), now, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	const n = 8
	codes := make([]int, n)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest("POST", "/api/v1/auth/pair", strings.NewReader(`{"token":"`+tok+`","device_name":"Phone"}`))
			req.RemoteAddr = "192.168.1.60:1234"
			req.Host = "192.168.1.10:7458"
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", "https://192.168.1.10:7458")
			<-start
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			codes[i] = rec.Code
		}()
	}
	close(start)
	wg.Wait()
	ok := 0
	for _, c := range codes {
		if c == http.StatusOK {
			ok++
		}
	}
	if ok != 1 {
		t.Fatalf("%d successful pairings (codes %v), want exactly 1", ok, codes)
	}
}

// Finding 5 (API side): an unset password still answers 401 like a wrong one.
func TestLoginWithNoPasswordSetIs401(t *testing.T) {
	_, h, _, _ := setupLANTestAPI(t, "")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, lanLoginReq("192.168.1.77:1", "anything"))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", rec.Code)
	}
}

// Finding 6: health on the LAN listener reveals no version.
func TestLANHealthHidesVersion(t *testing.T) {
	_, h, _, _ := setupLANTestAPI(t, "synthetic-pass")
	req := httptest.NewRequest("GET", "/api/v1/health", nil)
	req.RemoteAddr = "192.168.1.50:1"
	req.Host = "192.168.1.10:7458"
	rec := httptest.NewRecorder()
	h.LANHandler().ServeHTTP(rec, req)
	if strings.Contains(rec.Body.String(), "version") || strings.Contains(rec.Body.String(), "test") {
		t.Fatalf("LAN health leaks version: %s", rec.Body.String())
	}
	// Loopback keeps the full body.
	req = httptest.NewRequest("GET", "/api/v1/health", nil)
	req.RemoteAddr = "127.0.0.1:1"
	req.Host = "127.0.0.1:7457"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), `"version":"test"`) {
		t.Fatalf("loopback health lost version: %s", rec.Body.String())
	}
}

// Finding 8: internal approval errors are logged, not echoed.
func TestResolveApprovalErrorIsNotEchoed(t *testing.T) {
	s, h, _, ch := setupLANTestAPI(t, "synthetic-pass")
	var logs bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })
	h.ResolveApproval = func(context.Context, domain.Approval, string, string) (string, error) {
		return "", errors.New("hook refused: secret-value-SHOULD-NOT-LEAK")
	}
	approval := domain.Approval{
		ID: store.NewID(), ChannelID: ch.ID, RunID: "run-1", RequestedBy: "agent-1", Title: "t",
		State: domain.ApprovalPending, Options: []domain.ApprovalOption{{Key: "yes", Label: "Yes"}},
	}
	appendApproval(t, s, approval)
	req := httptest.NewRequest("POST", "/api/v1/approvals/"+approval.ID+"/resolve", strings.NewReader(`{"option":"yes"}`))
	req.RemoteAddr = "127.0.0.1:1"
	req.Host = "127.0.0.1:7457"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "SHOULD-NOT-LEAK") {
		t.Fatalf("response leaks internal error: %s", rec.Body.String())
	}
	if !strings.Contains(logs.String(), "SHOULD-NOT-LEAK") {
		t.Fatalf("internal error was not logged: %s", logs.String())
	}
}

func appendApproval(t *testing.T, s *store.Store, a domain.Approval) {
	t.Helper()
	if _, err := s.Append(context.Background(), events.Draft{Type: events.ApprovalRequested, Actor: events.Agent("agent-1"), ChannelID: a.ChannelID, Payload: a}); err != nil {
		t.Fatal(err)
	}
}

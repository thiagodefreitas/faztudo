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

	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func localFixture(t *testing.T) (*API, string) {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	human := domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: "human", DisplayName: "Human"}
	if _, err := s.Append(context.Background(), events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: human}); err != nil {
		t.Fatal(err)
	}
	a := New(s, human.ID, "test")
	a.LocalTokenPath = auth.LocalTokenPath(t.TempDir())
	token, err := auth.EnsureLocalToken(a.LocalTokenPath)
	if err != nil {
		t.Fatal(err)
	}
	return a, token
}

func localRequest(a *API, method, path, body, bearer string, cookie *http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://127.0.0.1:7457"+path, strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:12345"
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	a.ServeHTTP(rec, req)
	return rec
}

func TestLocalAPIRequiresTokenForReadsAndWrites(t *testing.T) {
	a, token := localFixture(t)
	for _, tc := range []struct{ method, path, body string }{
		{"GET", "/api/v1/me", ""},
		{"POST", "/api/v1/channels", `{"name":"test"}`},
		{"POST", "/api/v1/approvals/missing/resolve", `{"option":"merge"}`},
		{"POST", "/api/v1/auth/pairings", `{}`},
	} {
		if got := localRequest(a, tc.method, tc.path, tc.body, "", nil).Code; got != 401 {
			t.Errorf("%s %s without token = %d", tc.method, tc.path, got)
		}
	}
	if got := localRequest(a, "GET", "/api/v1/me", "", token, nil).Code; got != 200 {
		t.Fatalf("bearer GET = %d", got)
	}
	if got := localRequest(a, "POST", "/api/v1/channels", `{"name":"test"}`, token, nil).Code; got != 201 {
		t.Fatalf("bearer POST = %d", got)
	}
	if got := localRequest(a, "GET", "/api/v1/health", "", "", nil).Code; got != 200 {
		t.Fatalf("health = %d", got)
	}
}

func TestLocalCookieFlowAndRotation(t *testing.T) {
	a, token := localFixture(t)
	page := localRequest(a, "GET", "/auth/local", "", "", nil)
	if page.Code != 200 || !bytes.Contains(page.Body.Bytes(), []byte("location.hash")) {
		t.Fatalf("local page = %d", page.Code)
	}
	wrong := localRequest(a, "POST", "/api/v1/auth/local", `{"token":"wrong"}`, "", nil)
	if wrong.Code != 401 {
		t.Fatalf("wrong token = %d", wrong.Code)
	}
	set := localRequest(a, "POST", "/api/v1/auth/local", `{"token":"`+token+`"}`, "", nil)
	if set.Code != 200 {
		t.Fatalf("set cookie = %d: %s", set.Code, set.Body.String())
	}
	cookies := set.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != "fz_local" || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].MaxAge != 365*24*60*60 || cookies[0].Value == token {
		t.Fatalf("cookie flags/value: %+v", cookies)
	}
	if got := localRequest(a, "GET", "/api/v1/me", "", "", cookies[0]).Code; got != 200 {
		t.Fatalf("cookie GET = %d", got)
	}
	if _, err := auth.RotateLocalToken(a.LocalTokenPath); err != nil {
		t.Fatal(err)
	}
	if got := localRequest(a, "GET", "/api/v1/me", "", "", cookies[0]).Code; got != 401 {
		t.Fatalf("rotated cookie GET = %d", got)
	}
	if got := localRequest(a, "GET", "/api/v1/me", "", token, nil).Code; got != 401 {
		t.Fatalf("rotated bearer GET = %d", got)
	}
}

func TestLocalWebGateAndMCPException(t *testing.T) {
	a, token := localFixture(t)
	a.MCP = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer run-token" {
			w.WriteHeader(401)
			return
		}
		w.WriteHeader(200)
	})
	ui := a.LocalWeb(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/mcp" {
			a.ServeHTTP(w, r)
			return
		}
		w.WriteHeader(200)
	}))
	request := func(path, bearer string) int {
		req := httptest.NewRequest("GET", "http://127.0.0.1:7457"+path, nil)
		req.RemoteAddr = "127.0.0.1:12345"
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		rec := httptest.NewRecorder()
		ui.ServeHTTP(rec, req)
		return rec.Code
	}
	if got := request("/", ""); got != 401 {
		t.Fatalf("app without cookie = %d", got)
	}
	if got := request("/", token); got != 200 {
		t.Fatalf("app with bearer = %d", got)
	}
	if got := request("/mcp", "run-token"); got != 200 {
		t.Fatalf("MCP run token = %d", got)
	}
}

func TestLocalTokenBehindProxyAndLANSessionBoundary(t *testing.T) {
	a, token := localFixture(t)
	a.AllowedHosts = []string{"private.example.test"}
	req := httptest.NewRequest("POST", "https://private.example.test/api/v1/auth/local", strings.NewReader(`{"token":"`+token+`"}`))
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("Origin", "https://private.example.test")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	a.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("local proxy cookie = %d: %s", rec.Code, rec.Body.String())
	}
	cookie := rec.Result().Cookies()[0]
	if !cookie.Secure {
		t.Fatal("HTTPS proxy cookie is not Secure")
	}
	get := httptest.NewRequest("GET", "https://private.example.test/api/v1/me", nil)
	get.RemoteAddr = "127.0.0.1:12345"
	get.Header.Set("X-Forwarded-Proto", "https")
	get.AddCookie(cookie)
	got := httptest.NewRecorder()
	a.ServeHTTP(got, get)
	if got.Code != 200 {
		t.Fatalf("proxy with LAN off = %d", got.Code)
	}
	a.LANEnabled = true
	blocked := httptest.NewRecorder()
	a.ServeHTTP(blocked, get)
	if blocked.Code != 401 {
		t.Fatalf("proxy with LAN on and only local cookie = %d", blocked.Code)
	}
}

func TestLocalBearerFailuresAreLimited(t *testing.T) {
	a, _ := localFixture(t)
	for i := 0; i < 5; i++ {
		if got := localRequest(a, "GET", "/api/v1/me", "", "wrong", nil).Code; got != 401 {
			t.Fatalf("attempt %d = %d", i, got)
		}
	}
	if got := localRequest(a, "GET", "/api/v1/me", "", "wrong", nil).Code; got != 429 {
		t.Fatalf("sixth auth status = %d", got)
	}
	if a.LocalLimiter.Attempt("127.0.0.1:12345") {
		t.Fatal("failed bearer attempts did not fill rate limit")
	}
}

func TestStreamRefusesOtherLoopbackPorts(t *testing.T) {
	a, token := localFixture(t)
	cookie := &http.Cookie{Name: localCookieName, Value: auth.LocalCookieValue(token)}
	for _, origin := range []string{"http://127.0.0.1:9999", "http://localhost:3000"} {
		req := httptest.NewRequest("GET", "http://127.0.0.1:7457/api/v1/stream", nil)
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("Origin", origin)
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		a.ServeHTTP(rec, req)
		if rec.Code != 403 {
			t.Fatalf("stream from %s: %d, want 403", origin, rec.Code)
		}
	}
}

func TestOneTimeCodeSetsCookieOnce(t *testing.T) {
	a, token := localFixture(t)
	if rec := localRequest(a, "POST", "/api/v1/auth/local/code", "", "", nil); rec.Code != 401 {
		t.Fatalf("code without the token: %d", rec.Code)
	}
	rec := localRequest(a, "POST", "/api/v1/auth/local/code", "", token, nil)
	if rec.Code != 200 {
		t.Fatalf("code: %d %s", rec.Code, rec.Body)
	}
	var out struct{ Code string }
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Code) != 32 {
		t.Fatalf("code body %s", rec.Body)
	}
	first := localRequest(a, "POST", "/api/v1/auth/local", `{"token":"`+out.Code+`"}`, "", nil)
	if first.Code != 200 || len(first.Result().Cookies()) == 0 {
		t.Fatalf("exchange: %d", first.Code)
	}
	if again := localRequest(a, "POST", "/api/v1/auth/local", `{"token":"`+out.Code+`"}`, "", nil); again.Code != 401 {
		t.Fatalf("a used code worked again: %d", again.Code)
	}
	expired := localRequest(a, "POST", "/api/v1/auth/local/code", "", token, nil)
	_ = json.Unmarshal(expired.Body.Bytes(), &out)
	a.Now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	if late := localRequest(a, "POST", "/api/v1/auth/local", `{"token":"`+out.Code+`"}`, "", nil); late.Code != 401 {
		t.Fatalf("an expired code worked: %d", late.Code)
	}
}

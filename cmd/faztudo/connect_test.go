package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

// connectFixture runs the real API on a loopback listener.
func connectFixture(t *testing.T) (listen, tokenPath, token string) {
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
	h := api.New(s, human.ID, "9.9.9")
	tokenPath = auth.LocalTokenPath(t.TempDir())
	h.LocalTokenPath = tokenPath
	token, err = auth.EnsureLocalToken(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return strings.TrimPrefix(srv.URL, "http://"), tokenPath, token
}

func redeem(t *testing.T, listen, code string) int {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"token": code})
	req, _ := http.NewRequest("POST", "http://"+listen+"/api/v1/auth/local", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func TestConnectJSONHasCodeAndNoToken(t *testing.T) {
	listen, path, token := connectFixture(t)
	var out bytes.Buffer
	if err := runConnect(listen, path, []string{"--json"}, &out); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), token) {
		t.Fatal("output contains the local token")
	}
	var got struct{ URL, Code, Version string }
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.URL != "http://"+listen || len(got.Code) != 32 || got.Version != "9.9.9" {
		t.Fatalf("unexpected output: url=%s version=%s", got.URL, got.Version)
	}
	if redeem(t, listen, got.Code) != 200 {
		t.Fatal("code did not sign in")
	}
	if redeem(t, listen, got.Code) == 200 {
		t.Fatal("code worked twice")
	}
}

func TestConnectPlainPrintsLinkNotToken(t *testing.T) {
	listen, path, token := connectFixture(t)
	var out bytes.Buffer
	if err := runConnect(listen, path, nil, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "http://"+listen+"/auth/local#") || strings.Contains(out.String(), token) {
		t.Fatal("unexpected link output")
	}
}

func TestConnectRefusesNonLoopback(t *testing.T) {
	path := auth.LocalTokenPath(t.TempDir())
	token, err := auth.EnsureLocalToken(path)
	if err != nil {
		t.Fatal(err)
	}
	hit := false
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hit = true }))
	defer srv.Close()
	// The same server, reached through a non-loopback spelling of the address.
	port := srv.URL[strings.LastIndex(srv.URL, ":")+1:]
	err = runConnect("0.0.0.0:"+port, path, []string{"--json"}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "loopback") || strings.Contains(err.Error(), token) || hit {
		t.Fatalf("expected a loopback refusal without any request, got %v (hit=%v)", err, hit)
	}
}

func TestConnectWhenNotRunning(t *testing.T) {
	path := auth.LocalTokenPath(t.TempDir())
	if _, err := auth.EnsureLocalToken(path); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.NotFoundHandler())
	listen := strings.TrimPrefix(srv.URL, "http://")
	srv.Close()
	err := runConnect(listen, path, []string{"--json"}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "is it running") {
		t.Fatalf("expected a not-running error, got %v", err)
	}
}

func TestConnectMissingToken(t *testing.T) {
	err := runConnect("127.0.0.1:1", auth.LocalTokenPath(t.TempDir()), nil, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "local token") {
		t.Fatalf("expected a token error, got %v", err)
	}
}

func TestConnectRejectsUnknownFlag(t *testing.T) {
	if err := runConnect("127.0.0.1:1", "x", []string{"--bogus"}, &bytes.Buffer{}); err == nil {
		t.Fatal("expected usage error")
	}
}

package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestSeedFirstStart(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("PATH", dir)
	t.Setenv("USER", "tester")
	s, err := store.Open(filepath.Join(dir, "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	id, err := seed(context.Background(), s, config.Defaults())
	if err != nil {
		t.Fatal(err)
	}
	again, err := seed(context.Background(), s, config.Defaults())
	if err != nil || again != id {
		t.Fatalf("second seed: %s %v", again, err)
	}
	members, err := s.Members(context.Background())
	if err != nil || len(members) != 1 || members[0].Handle != "tester" {
		t.Fatalf("members: %+v %v", members, err)
	}
	channels, err := s.Channels(context.Background())
	if err != nil || len(channels) != 1 || channels[0].Name != "general" {
		t.Fatalf("channels: %+v %v", channels, err)
	}
}

func TestSeedDetectedCLIAndPersona(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("PATH", dir)
	t.Setenv("USER", "tester")
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte("synthetic"), 0700); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(filepath.Join(dir, "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c := config.Defaults()
	c.Lanes.Lane = []config.Lane{{ID: "codex/custom", CLI: "codex", Capacity: 2, CostClass: "standard"}}
	c.Lanes.Persona = []config.Persona{{Handle: "coder", DisplayName: "Coder", Lanes: []string{"codex/custom"}, Mode: "write"}}
	if _, err = seed(context.Background(), s, c); err != nil {
		t.Fatal(err)
	}
	for _, handle := range []string{"codex", "coder"} {
		m, err := s.MemberByHandle(context.Background(), handle)
		if err != nil || m.Agent == nil || len(m.Agent.Lanes) != 1 || m.Agent.Lanes[0] != "codex/custom" {
			t.Fatalf("member %s: %+v %v", handle, m, err)
		}
	}
}

func TestShouldOpenBrowser(t *testing.T) {
	tests := []struct {
		name               string
		configured, noOpen bool
		terminal           bool
		display, wayland   string
		want               bool
	}{
		{name: "X display", configured: true, terminal: true, display: ":0", want: true},
		{name: "Wayland display", configured: true, terminal: true, wayland: "wayland-0", want: true},
		{name: "disabled in config", terminal: true, display: ":0"},
		{name: "flag override", configured: true, noOpen: true, terminal: true, display: ":0"},
		{name: "stdout is not a terminal", configured: true, display: ":0"},
		{name: "no display", configured: true, terminal: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldOpenBrowser(tt.configured, tt.noOpen, tt.terminal, tt.display, tt.wayland); got != tt.want {
				t.Fatalf("shouldOpenBrowser() = %t, want %t", got, tt.want)
			}
		})
	}
}

func TestPasswdAndLANStartup(t *testing.T) {
	dir := t.TempDir()
	p := config.Paths{
		ConfigDir:    filepath.Join(dir, "config"),
		ConfigFile:   filepath.Join(dir, "config", "config.toml"),
		DataDir:      filepath.Join(dir, "data"),
		DBFile:       filepath.Join(dir, "data", "faztudo.db"),
		WorktreesDir: filepath.Join(dir, "data", "worktrees"),
		RunsDir:      filepath.Join(dir, "data", "runs"),
		TLSDir:       filepath.Join(dir, "data", "tls"),
	}
	if err := os.MkdirAll(p.DataDir, 0700); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(p.DBFile)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c := config.Defaults()
	c.LAN.Enabled = true
	c.LAN.Listen = "127.0.0.1:0"
	c.LAN.CAListen = "127.0.0.1:0"
	humanID, err := seed(context.Background(), s, c)
	if err != nil {
		t.Fatal(err)
	}
	handler := api.New(s, humanID, "test")

	// LAN mode must refuse to start when no password is set and no device is paired.
	if _, err := startLAN(context.Background(), s, c, p, handler, nil, io.Discard); err == nil {
		t.Fatal("expected startLAN to refuse without password or paired device")
	}

	// Mismatched confirmation in runPasswd fails.
	var out bytes.Buffer
	if err := runPasswd(p, strings.NewReader("alpha-pass\nbeta-pass\n"), &out); err == nil {
		t.Fatal("expected mismatched passwords to fail")
	}

	// Valid runPasswd stores bcrypt hash in DB.
	out.Reset()
	if err := runPasswd(p, strings.NewReader("synthetic-lan-secret\nsynthetic-lan-secret\n"), &out); err != nil {
		t.Fatalf("runPasswd: %v", err)
	}
	hash, err := s.PasswordHash(context.Background())
	if err != nil || !auth.CheckPassword(hash, "synthetic-lan-secret") {
		t.Fatalf("stored password hash invalid: %v", err)
	}

	// Now startLAN succeeds, prints LAN URLs, and serves HTTPS + CA helper.
	out.Reset()
	srv, err := startLAN(context.Background(), s, c, p, handler, nil, &out)
	if err != nil {
		t.Fatalf("startLAN: %v", err)
	}
	defer srv.Close()
	if !strings.Contains(out.String(), "LAN: https://") {
		t.Fatalf("expected LAN URLs in output, got %q", out.String())
	}

	// Verify CA helper serves fingerprint page and /ca.crt, and 404s everything else.
	caResp, err := http.Get("http://" + srv.caAddr + "/")
	if err != nil {
		t.Fatalf("GET ca helper /: %v", err)
	}
	caPage, _ := io.ReadAll(caResp.Body)
	caResp.Body.Close()
	if caResp.StatusCode != 200 || !strings.Contains(string(caPage), srv.fingerprint) {
		t.Fatalf("ca helper /: %d %s", caResp.StatusCode, string(caPage))
	}
	crtResp, err := http.Get("http://" + srv.caAddr + "/ca.crt")
	if err != nil {
		t.Fatalf("GET ca helper /ca.crt: %v", err)
	}
	caPEM, _ := io.ReadAll(crtResp.Body)
	crtResp.Body.Close()
	if crtResp.StatusCode != 200 || !strings.Contains(string(caPEM), "BEGIN CERTIFICATE") {
		t.Fatalf("ca helper /ca.crt: %d", crtResp.StatusCode)
	}
	otherResp, err := http.Get("http://" + srv.caAddr + "/api/v1/health")
	if err != nil {
		t.Fatalf("GET ca helper /api/v1/health: %v", err)
	}
	otherResp.Body.Close()
	if otherResp.StatusCode != 404 {
		t.Fatalf("expected 404 on ca helper for non-CA path, got %d", otherResp.StatusCode)
	}

	// Verify HTTPS LAN listener uses the generated CA and enforces LAN auth.
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		t.Fatal("failed to parse CA PEM")
	}
	tlsClient := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				RootCAs:    pool,
				ServerName: "localhost",
			},
		},
	}
	unauthResp, err := tlsClient.Get("https://" + srv.lanAddr + "/api/v1/channels")
	if err != nil {
		t.Fatalf("GET https LAN /api/v1/channels: %v", err)
	}
	unauthResp.Body.Close()
	if unauthResp.StatusCode != 401 {
		t.Fatalf("expected 401 for unauthenticated LAN request, got %d", unauthResp.StatusCode)
	}
}

package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/config"
)

func TestOpenUsesOneTimeCodeNotToken(t *testing.T) {
	dir := t.TempDir()
	path := auth.LocalTokenPath(dir)
	token, err := auth.EnsureLocalToken(path)
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "xdg-open")
	out := filepath.Join(dir, "url")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nprintf '%s' \"$1\" > \""+out+"\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/v1/auth/local/code" || r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "no", 401)
			return
		}
		_, _ = w.Write([]byte(`{"code":"0123456789abcdef0123456789abcdef"}`))
	}))
	defer srv.Close()
	listen := strings.TrimPrefix(srv.URL, "http://")
	if err := openLocalBrowser(listen, path); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	// The browser launcher's command line is readable by other local users,
	// so it carries a single-use code, never the token.
	if got := string(b); got != "http://"+listen+"/auth/local#0123456789abcdef0123456789abcdef" || strings.Contains(got, token) {
		t.Fatalf("open URL: %s", strings.Split(got, "#")[0])
	}
}

func TestTokenRotateCommandReplacesToken(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_DATA_HOME", root)
	path := auth.LocalTokenPath(config.PathsFromEnv().DataDir)
	before, err := auth.EnsureLocalToken(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"token", "--rotate"}); err != nil {
		t.Fatal(err)
	}
	after, err := auth.ReadLocalToken(path)
	if err != nil || before == after {
		t.Fatalf("token not rotated: %v", err)
	}
}

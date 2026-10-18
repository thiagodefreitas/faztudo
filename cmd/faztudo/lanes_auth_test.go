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

func TestLanesCommandSendsLocalBearer(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(root, "data"))
	p := config.PathsFromEnv()
	token, err := auth.EnsureLocalToken(auth.LocalTokenPath(p.DataDir))
	if err != nil {
		t.Fatal(err)
	}
	seen := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/lanes" || r.Header.Get("Authorization") != "Bearer "+token {
			t.Errorf("request path or bearer incorrect")
			w.WriteHeader(401)
			return
		}
		seen = true
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	if err := os.MkdirAll(p.ConfigDir, 0700); err != nil {
		t.Fatal(err)
	}
	configText := "[server]\nlisten = \"" + strings.TrimPrefix(srv.URL, "http://") + "\"\n"
	if err := os.WriteFile(p.ConfigFile, []byte(configText), 0600); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"lanes"}); err != nil {
		t.Fatal(err)
	}
	if !seen {
		t.Fatal("lanes did not use API")
	}
}

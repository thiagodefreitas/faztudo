package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/config"
)

func TestOpenUsesFragmentToken(t *testing.T) {
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
	if err := openLocalBrowser("127.0.0.1:7457", path); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(b); got != "http://127.0.0.1:7457/auth/local#"+token {
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

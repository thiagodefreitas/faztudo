package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func apparmorRoot(t *testing.T, restrict string, profile bool) string {
	t.Helper()
	root := t.TempDir()
	if restrict != "" {
		dir := filepath.Join(root, "proc/sys/kernel")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "apparmor_restrict_unprivileged_userns"), []byte(restrict+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if profile {
		dir := filepath.Join(root, "etc/apparmor.d")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "faztudo"), []byte("profile faztudo {}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestApparmorStatus(t *testing.T) {
	for _, tc := range []struct {
		name, restrict string
		profile        bool
		exe, want      string
	}{
		{"no restriction file", "", true, packagedBinary, ""},
		{"restriction off", "0", false, "/home/me/.local/bin/faztudo", ""},
		{"profile missing", "1", false, packagedBinary, "/etc/apparmor.d/faztudo is missing"},
		{"other path", "1", true, "/home/me/.local/bin/faztudo", "runs from /home/me/.local/bin/faztudo"},
		{"packaged", "1", true, packagedBinary, "profile /etc/apparmor.d/faztudo installed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := apparmorStatus(apparmorRoot(t, tc.restrict, tc.profile), tc.exe)
			if tc.want == "" && got != "" || tc.want != "" && !strings.Contains(got, tc.want) {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

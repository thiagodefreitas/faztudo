package computers

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testManager(t *testing.T) *Manager {
	t.Helper()
	m, err := New(t.TempDir(), true, "1M")
	if err != nil {
		t.Fatal(err)
	}
	m.StopSlice = func(context.Context, string) error { return nil }
	m.SlicePIDs = func(context.Context, string) (bool, error) { return false, nil }
	return m
}

func TestOneWriteRunPerComputer(t *testing.T) {
	m := testManager(t)
	release, err := m.Acquire(context.Background(), "coder", nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	noticed := false
	if _, err := m.Acquire(ctx, "coder", func() { noticed = true }); err == nil || !noticed {
		t.Fatalf("second run did not wait: %v", err)
	}
	release()
	release2, err := m.Acquire(context.Background(), "coder", nil)
	if err != nil {
		t.Fatal(err)
	}
	release2()
}

func TestScanDoesNotFollowSymlinkAndScansCaches(t *testing.T) {
	m := testManager(t)
	home, caches, err := m.Prepare("coder")
	if err != nil {
		t.Fatal(err)
	}
	token := []byte("secret-token-abcdefghijklmnopqrstuvwxyz")
	host := filepath.Join(t.TempDir(), "host-auth")
	if err := os.WriteFile(host, token, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(host, filepath.Join(home, "linked-auth")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(home, "copied"), filepath.Join(caches, "copied")} {
		if err := os.WriteFile(path, append([]byte("prefix"), token...), 0600); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := m.Scan("coder", [][]byte{token})
	if err != nil || removed != 2 {
		t.Fatalf("scan removed %d: %v", removed, err)
	}
	if b, err := os.ReadFile(host); err != nil || string(b) != string(token) {
		t.Fatalf("host credential changed: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(home, "linked-auth")); err != nil {
		t.Fatal("symlink was removed")
	}
}

func TestResetRefusesLiveRunAndPID(t *testing.T) {
	m := testManager(t)
	home, _, err := m.Prepare("coder")
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(home, "keep")
	if err := os.WriteFile(marker, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	release, err := m.Acquire(context.Background(), "coder", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Reset(context.Background(), "coder"); err == nil || !strings.Contains(err.Error(), "running") {
		t.Fatalf("reset while locked: %v", err)
	}
	release()
	m.SlicePIDs = func(context.Context, string) (bool, error) { return true, nil }
	if _, err := m.Reset(context.Background(), "coder"); err == nil || !strings.Contains(err.Error(), "live processes") {
		t.Fatalf("reset with pid: %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("live reset deleted home")
	}
	m.SlicePIDs = func(context.Context, string) (bool, error) { return false, nil }
	status, err := m.Reset(context.Background(), "coder")
	if err != nil || status.LastReset == nil {
		t.Fatalf("reset: %+v %v", status, err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("home not removed: %v", err)
	}
}

func TestPrepareRefusesCredentialPaths(t *testing.T) {
	m := testManager(t)
	home, _, err := m.Prepare("coder")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".config", "gh"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.Prepare("coder"); err == nil {
		t.Fatal("accepted planted gh config")
	}
}

func TestDiskLimitDoesNotFollowSymlinks(t *testing.T) {
	m := testManager(t)
	home, _, err := m.Prepare("coder")
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "large")
	if err := os.WriteFile(outside, make([]byte, 2<<20), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(home, "link")); err != nil {
		t.Fatal(err)
	}
	status, err := m.Status("coder")
	if err != nil || status.State != "idle" || status.DiskBytes != 0 {
		t.Fatalf("followed outside symlink: %+v %v", status, err)
	}
	if err := os.WriteFile(filepath.Join(home, "local"), make([]byte, 1<<20), 0600); err != nil {
		t.Fatal(err)
	}
	status, err = m.Status("coder")
	if err != nil || status.State != "full" {
		t.Fatalf("soft limit: %+v %v", status, err)
	}
}

func TestSecretLike(t *testing.T) {
	for _, tc := range []struct {
		key, value string
		want       bool
	}{
		{"access_token", "abcdefghijklmnopqrstuv", true},
		{"refreshtoken", "abcdefghijklmnopqrstuv", true},
		{"expires_at", "short", false},
		{"email", "someone@example.invalid.long", false},
		{"opaque", strings.Repeat("Ab1", 15), true},
		{"url", "https://auth.example.invalid/oauth/authorize/long/path", false},
	} {
		if got := secretLike(tc.key, tc.value); got != tc.want {
			t.Errorf("secretLike(%q, %q) = %v, want %v", tc.key, tc.value, got, tc.want)
		}
	}
}

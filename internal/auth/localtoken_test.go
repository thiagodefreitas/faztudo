package auth

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLocalTokenLifecycle(t *testing.T) {
	path := LocalTokenPath(t.TempDir())
	first, err := EnsureLocalToken(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 64 {
		t.Fatalf("token length %d", len(first))
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("token mode: %v %v", info, err)
	}
	second, err := EnsureLocalToken(path)
	if err != nil || second != first {
		t.Fatalf("token changed on start: %v", err)
	}
	cookie := LocalCookieValue(first)
	if cookie == first || !EqualSecret(cookie, LocalCookieValue(first)) {
		t.Fatal("cookie derivation")
	}
	rotated, err := RotateLocalToken(path)
	if err != nil || rotated == first {
		t.Fatalf("rotation: %v", err)
	}
	if got, err := ReadLocalToken(path); err != nil || got != rotated {
		t.Fatalf("read rotation: %v", err)
	}
	if EqualSecret(cookie, LocalCookieValue(rotated)) {
		t.Fatal("old cookie still valid")
	}
}

func TestLocalTokenRejectsUnsafeFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "local-token")
	if err := os.WriteFile(path, []byte("bad"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureLocalToken(path); err == nil {
		t.Fatal("accepted unsafe file")
	}
}

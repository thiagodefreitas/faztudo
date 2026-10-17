package secrets

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPermissions(t *testing.T) {
	p := filepath.Join(t.TempDir(), "secrets")
	if err := os.WriteFile(p, []byte(`{"synthetic":"value"}`), 0600); err != nil {
		t.Fatal(err)
	}
	s := New("faztudo-test", p)
	if _, err := s.read(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.read(); err == nil {
		t.Fatal("readable secret accepted")
	}
}

func TestFallbackSetRejectsUnsafeFile(t *testing.T) {
	old := keyringSet
	keyringSet = func(string, string, string) error { return os.ErrPermission }
	defer func() { keyringSet = old }()
	p := filepath.Join(t.TempDir(), "secrets")
	s := New("test", p)
	if err := s.Set("synthetic", "value"); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(p)
	if err != nil || fi.Mode().Perm() != 0600 {
		t.Fatalf("mode: %v %v", fi, err)
	}
	if err = os.Chmod(p, 0644); err != nil {
		t.Fatal(err)
	}
	if err = s.Set("synthetic", "next"); err == nil {
		t.Fatal("unsafe file accepted")
	}
}

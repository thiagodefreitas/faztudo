package agentsdetect

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetectWithoutLaunching(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte("invalid executable"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(home, ".codex"), 0700); err != nil {
		t.Fatal(err)
	}
	a := Detect(dir, home)
	if len(a) != 6 {
		t.Fatal(len(a))
	}
	if a[1].Path == "" || len(a[1].ConfigDirs) != 1 {
		t.Fatal(a[1])
	}
}

func TestDetectNoneAndAllSix(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()
	none := Detect(dir, home)
	for _, a := range none {
		if a.Path != "" || len(a.ConfigDirs) != 0 {
			t.Fatalf("unexpected detection: %+v", a)
		}
	}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("invalid executable"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	all := Detect(dir, home)
	if len(all) != 6 {
		t.Fatal(len(all))
	}
	for _, a := range all {
		if a.Path == "" {
			t.Fatalf("missing %s", a.Name)
		}
	}
}

package usage

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// copyTestdata copies testdata/rel into a fresh temp home dir and touches
// every file so the 8 day mtime filter accepts them. It returns the temp
// home dir, which is what the readers take as root.
func copyTestdata(t *testing.T, rel string) string {
	t.Helper()
	src := filepath.Join("testdata", rel)
	home := t.TempDir()
	dst := filepath.Join(home, rel)
	err := filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relPath, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, relPath)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			return err
		}
		now := time.Now()
		return os.Chtimes(target, now, now)
	})
	if err != nil {
		t.Fatalf("copyTestdata %s: %v", rel, err)
	}
	return home
}

// writeLog writes data into root/rel as a fresh log file.
func writeLog(t *testing.T, root, rel, data string) string {
	t.Helper()
	path := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := os.Chtimes(path, now, now); err != nil {
		t.Fatal(err)
	}
	return path
}

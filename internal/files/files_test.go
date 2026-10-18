package files

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPutStoresByHashAndDedupes(t *testing.T) {
	s := Store{Dir: filepath.Join(t.TempDir(), "files")}
	id, n, err := s.Put(strings.NewReader("hello"), 100)
	if err != nil || n != 5 || !ValidID(id) {
		t.Fatalf("put: %q %d %v", id, n, err)
	}
	id2, _, err := s.Put(strings.NewReader("hello"), 100)
	if err != nil || id2 != id {
		t.Fatalf("same content must give the same id: %q %q %v", id, id2, err)
	}
	fi, err := os.Stat(filepath.Join(s.Dir, id))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm()&0111 != 0 {
		t.Fatalf("stored file must not be executable: %v", fi.Mode())
	}
	entries, _ := os.ReadDir(s.Dir)
	if len(entries) != 1 {
		t.Fatalf("temp files left behind: %v", entries)
	}
}

func TestPutRefusesOversizeAndCleansUp(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	_, _, err := s.Put(bytes.NewReader(make([]byte, 11)), 10)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("want ErrTooLarge, got %v", err)
	}
	if _, _, err := s.Put(bytes.NewReader(make([]byte, 10)), 10); err != nil {
		t.Fatalf("exactly the limit must pass: %v", err)
	}
	entries, _ := os.ReadDir(s.Dir)
	if len(entries) != 1 {
		t.Fatalf("oversize upload left files: %v", entries)
	}
}

func TestOpenRejectsTraversalAndUnknownIDs(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "secret"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	s := Store{Dir: filepath.Join(root, "files")}
	for _, id := range []string{"../secret", "..", "", "secret", strings.Repeat("g", 64), strings.Repeat("a", 63), strings.Repeat("A", 64), strings.Repeat("a", 64) + "/../../secret"} {
		if _, err := s.Open(id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Open(%q) = %v, want ErrNotFound", id, err)
		}
	}
	if _, err := s.Open(strings.Repeat("a", 64)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing file: %v", err)
	}
}

func TestSniffIgnoresClaimedTypeAndNeverInlinesActiveContent(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	if typ, ok := Sniff(png); typ != "image/png" || !ok {
		t.Fatalf("png: %q %v", typ, ok)
	}
	for _, body := range []string{"<html><script>alert(1)</script></html>", "<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>", "#!/bin/sh\necho hi\n", "plain text"} {
		typ, ok := Sniff([]byte(body))
		if ok || typ != "application/octet-stream" {
			t.Fatalf("%q must be a download, got %q %v", body, typ, ok)
		}
	}
}

func TestInfoUsesContentNotName(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	id, _, err := s.Put(strings.NewReader("<html>not an image</html>"), 1000)
	if err != nil {
		t.Fatal(err)
	}
	typ, size, err := s.Info(id)
	if err != nil || typ != "application/octet-stream" || size != 25 {
		t.Fatalf("info: %q %d %v", typ, size, err)
	}
}

func TestCleanName(t *testing.T) {
	cases := map[string]string{
		"../../etc/passwd":  "passwd",
		`C:\dir\report.pdf`: "report.pdf",
		"a\"b\x00c.txt":     "abc.txt",
		"":                  "file",
		"..":                "file",
		"photo.png":         "photo.png",
	}
	for in, want := range cases {
		if got := CleanName(in); got != want {
			t.Fatalf("CleanName(%q) = %q, want %q", in, got, want)
		}
	}
	if got := CleanName(strings.Repeat("a", 500)); len(got) != 120 {
		t.Fatalf("long name length %d", len(got))
	}
}

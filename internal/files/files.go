// Package files keeps uploaded attachments on disk, addressed by the SHA-256
// of their content. Files are written 0400 in a 0700 directory, so nothing
// stored here is executable, and the id is the only thing a caller can name:
// it is checked against a fixed pattern before it touches a path.
package files

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

// ErrTooLarge is returned by Put when the content passes the size limit.
var ErrTooLarge = errors.New("file too large")

// ErrNotFound is returned for an unknown or malformed id.
var ErrNotFound = errors.New("file not found")

var idPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Store is a directory of content-addressed files.
type Store struct{ Dir string }

// ValidID reports whether id looks like a content hash.
func ValidID(id string) bool { return idPattern.MatchString(id) }

// Put copies r into the store, refusing more than max bytes, and returns the
// content hash and size. Identical content is stored once.
func (s Store) Put(r io.Reader, max int64) (string, int64, error) {
	if err := os.MkdirAll(s.Dir, 0700); err != nil {
		return "", 0, err
	}
	tmp, err := os.CreateTemp(s.Dir, "upload-*.tmp")
	if err != nil {
		return "", 0, err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(r, max+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", 0, err
	}
	if n > max {
		return "", 0, ErrTooLarge
	}
	id := hex.EncodeToString(h.Sum(nil))
	dest := filepath.Join(s.Dir, id)
	if _, err := os.Stat(dest); err == nil {
		return id, n, nil
	}
	if err := os.Chmod(tmp.Name(), 0400); err != nil {
		return "", 0, err
	}
	if err := os.Rename(tmp.Name(), dest); err != nil {
		return "", 0, err
	}
	return id, n, nil
}

// Open returns the stored file for id.
func (s Store) Open(id string) (*os.File, error) {
	if !ValidID(id) || s.Dir == "" {
		return nil, ErrNotFound
	}
	f, err := os.Open(filepath.Join(s.Dir, id))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return f, nil
}

// inline lists the only types a browser may render from our origin. Anything
// else, including HTML and SVG, is served as a download.
var inline = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// Sniff decides the served content type from the first bytes of the file and
// ignores whatever name or type the uploader claimed. The second result says
// whether the type is safe to show inline.
func Sniff(head []byte) (string, bool) {
	t := http.DetectContentType(head)
	if i := strings.IndexByte(t, ';'); i >= 0 {
		t = t[:i]
	}
	if inline[t] {
		return t, true
	}
	return "application/octet-stream", false
}

// Info reads the content type and size of a stored file.
func (s Store) Info(id string) (contentType string, size int64, err error) {
	f, err := s.Open(id)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return "", 0, err
	}
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	t, _ := Sniff(head[:n])
	return t, fi.Size(), nil
}

// CleanName reduces a client supplied file name to a short, printable base
// name: no directories, no control characters, no quotes.
func CleanName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndexByte(name, '/'); i >= 0 {
		name = name[i+1:]
	}
	var b strings.Builder
	for _, r := range name {
		if r < 0x20 || r == 0x7f || r == '"' || r == utf8.RuneError {
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	for len(out) > 120 {
		_, size := utf8.DecodeLastRuneInString(out)
		out = out[:len(out)-size]
	}
	if out == "" || out == "." || out == ".." {
		return "file"
	}
	return out
}

// IsText reports whether data is plain text an agent can read inline.
func IsText(data []byte) bool {
	return utf8.Valid(data) && !strings.ContainsRune(string(data), 0)
}

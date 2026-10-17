// Package usage reads agent CLI logs and probes and turns them into
// domain.LaneWindow values. Numbers come only from what the CLIs already
// write locally; when a number is not available, UsedPct stays nil and the
// source is "unknown". No message content is ever read into the results.
package usage

import (
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Default limits that keep reads cheap on busy machines.
const (
	defaultMaxFileAge   = 8 * 24 * time.Hour
	defaultMaxFileBytes = 4 << 20 // 4 MiB per file
)

// Options controls how logs are scanned. The zero value is usable.
type Options struct {
	// Now is the reference time for windows and the mtime filter.
	// Defaults to time.Now.
	Now time.Time
	// MaxFileAge skips log files not modified within this duration
	// before Now. Defaults to 8 days.
	MaxFileAge time.Duration
	// MaxFileBytes caps how many bytes are read from each file.
	// Defaults to 4 MiB.
	MaxFileBytes int64
	// PlanLimitTokens is an optional manual daily plan limit for
	// token-based CLIs. When > 0, Claude windows get a UsedPct computed
	// against this limit. Defaults to 0 (no percentage).
	PlanLimitTokens int64
}

func (o Options) withDefaults() Options {
	if o.Now.IsZero() {
		o.Now = time.Now()
	}
	if o.MaxFileAge <= 0 {
		o.MaxFileAge = defaultMaxFileAge
	}
	if o.MaxFileBytes <= 0 {
		o.MaxFileBytes = defaultMaxFileBytes
	}
	return o
}

// recentLogFiles returns the paths of files under root (at any depth) whose
// names match want, modified within opts.MaxFileAge before opts.Now,
// sorted oldest mtime first.
func recentLogFiles(root string, opts Options, want func(name string) bool) []string {
	cutoff := opts.Now.Add(-opts.MaxFileAge)
	type found struct {
		path string
		mt   time.Time
	}
	var out []found
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !want(d.Name()) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		mt := info.ModTime()
		if mt.Before(cutoff) {
			return nil
		}
		out = append(out, found{path, mt})
		return nil
	})
	// newest last so newer snapshots win ties in the readers
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1].mt.After(out[j].mt); j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	paths := make([]string, len(out))
	for i, f := range out {
		paths[i] = f.path
	}
	return paths
}

// openCapped opens path and returns a reader that yields at most
// opts.MaxFileBytes bytes.
func openCapped(path string, opts Options) (io.ReadCloser, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return struct {
		io.Reader
		io.Closer
	}{io.LimitReader(f, opts.MaxFileBytes), f}, nil
}

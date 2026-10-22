package computers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var handlePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)

type Status struct {
	ID          string     `json:"id"`
	State       string     `json:"state"`
	DiskBytes   int64      `json:"disk_bytes"`
	DiskSoftMax int64      `json:"disk_soft_max"`
	LastReset   *time.Time `json:"last_reset,omitempty"`
}

type Manager struct {
	Base        string
	Enabled     bool
	DiskSoftMax int64
	StopSlice   func(context.Context, string) error
	SlicePIDs   func(context.Context, string) (bool, error)
	mu          sync.Mutex
	busy        map[string]bool
	changed     chan struct{}
}

func New(base string, enabled bool, softMax string) (*Manager, error) {
	limit, err := parseSize(softMax)
	if err != nil {
		return nil, err
	}
	return &Manager{Base: base, Enabled: enabled, DiskSoftMax: limit, busy: map[string]bool{}, changed: make(chan struct{}), StopSlice: stopSlice, SlicePIDs: slicePIDs}, nil
}

func parseSize(value string) (int64, error) {
	if value == "" {
		value = "10G"
	}
	unit := int64(1)
	if strings.ContainsAny(value[len(value)-1:], "KMGT") {
		switch value[len(value)-1] {
		case 'K':
			unit = 1 << 10
		case 'M':
			unit = 1 << 20
		case 'G':
			unit = 1 << 30
		case 'T':
			unit = 1 << 40
		}
		value = value[:len(value)-1]
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 1 || n > (1<<63-1)/unit {
		return 0, errors.New("invalid computer disk soft limit")
	}
	return n * unit, nil
}

func (m *Manager) dir(id string) (string, error) {
	if !handlePattern.MatchString(id) {
		return "", errors.New("invalid computer id")
	}
	return filepath.Join(m.Base, id), nil
}

func (m *Manager) Paths(id string) (string, string, error) {
	dir, err := m.dir(id)
	if err != nil {
		return "", "", err
	}
	return filepath.Join(dir, "home"), filepath.Join(dir, "caches"), nil
}

func (m *Manager) Prepare(id string) (string, string, error) {
	home, caches, err := m.Paths(id)
	if err != nil {
		return "", "", err
	}
	for _, path := range []string{filepath.Dir(home), home, caches} {
		if info, err := os.Lstat(path); err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
			return "", "", fmt.Errorf("unsafe computer path: %s", path)
		} else if err != nil && !os.IsNotExist(err) {
			return "", "", err
		}
		if err := os.MkdirAll(path, 0700); err != nil {
			return "", "", err
		}
	}
	root, err := os.OpenRoot(home)
	if err != nil {
		return "", "", err
	}
	defer root.Close()
	for _, name := range []string{".ssh", ".config/gh", ".git-credentials", ".netrc"} {
		if _, err := root.Lstat(name); err == nil {
			return "", "", fmt.Errorf("computer home contains forbidden path %s", name)
		} else if !os.IsNotExist(err) {
			return "", "", err
		}
	}
	return home, caches, nil
}

func (m *Manager) Acquire(ctx context.Context, id string, wait func()) (func(), error) {
	if _, err := m.dir(id); err != nil {
		return nil, err
	}
	notified := false
	for {
		m.mu.Lock()
		if !m.busy[id] {
			m.busy[id] = true
			m.mu.Unlock()
			release := func() {
				m.mu.Lock()
				delete(m.busy, id)
				close(m.changed)
				m.changed = make(chan struct{})
				m.mu.Unlock()
			}
			// A daemon restart loses the in-memory lock while a recovered scope
			// may still be running. Wait for that scope before a new write run.
			for {
				live, err := m.SlicePIDs(ctx, id)
				if err != nil {
					release()
					return nil, err
				}
				if !live {
					return release, nil
				}
				if !notified && wait != nil {
					wait()
					notified = true
				}
				select {
				case <-ctx.Done():
					release()
					return nil, ctx.Err()
				case <-time.After(time.Second):
				}
			}
		}
		ch := m.changed
		m.mu.Unlock()
		if !notified && wait != nil {
			wait()
			notified = true
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ch:
		}
	}
}

func (m *Manager) Status(id string) (Status, error) {
	dir, err := m.dir(id)
	if err != nil {
		return Status{}, err
	}
	s := Status{ID: id, State: "off", DiskSoftMax: m.DiskSoftMax}
	if !m.Enabled {
		return s, nil
	}
	s.State = "idle"
	s.DiskBytes, err = diskBytes(dir)
	if err != nil {
		return s, err
	}
	if b, err := os.ReadFile(filepath.Join(dir, "last_reset")); err == nil {
		if ts, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(string(b))); err == nil {
			s.LastReset = &ts
		}
	}
	m.mu.Lock()
	busy := m.busy[id]
	m.mu.Unlock()
	if !busy {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		live, err := m.SlicePIDs(ctx, id)
		cancel()
		if err != nil {
			return s, err
		}
		busy = live
	}
	if busy {
		s.State = "running"
	} else if s.DiskBytes >= m.DiskSoftMax {
		s.State = "full"
	}
	return s, nil
}

func diskBytes(dir string) (int64, error) {
	if info, err := os.Lstat(dir); err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
		return 0, errors.New("unsafe computer directory")
	} else if err != nil && !os.IsNotExist(err) {
		return 0, err
	}
	var total int64
	for _, name := range []string{"home", "caches"} {
		err := filepath.WalkDir(filepath.Join(dir, name), func(path string, entry os.DirEntry, err error) error {
			if os.IsNotExist(err) {
				return nil
			}
			if err != nil {
				return err
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if info.Mode().IsRegular() {
				total += info.Size()
			}
			return nil
		})
		if err != nil {
			return 0, err
		}
	}
	return total, nil
}

func sliceName(id string) string { return "faztudo-computer-" + id + ".slice" }
func stopSlice(ctx context.Context, id string) error {
	state, err := exec.CommandContext(ctx, "systemctl", "--user", "show", sliceName(id), "--property=LoadState", "--value").Output()
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(state)) == "not-found" {
		return nil
	}
	out, err := exec.CommandContext(ctx, "systemctl", "--user", "stop", sliceName(id)).CombinedOutput()
	if err != nil {
		return fmt.Errorf("stop computer slice: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
func slicePIDs(ctx context.Context, id string) (bool, error) {
	out, err := exec.CommandContext(ctx, "systemctl", "--user", "show", sliceName(id), "--property=TasksCurrent", "--value").Output()
	if err != nil {
		return false, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return false, nil
	} // An inactive unit reports [not set].
	return n > 0, nil
}

func (m *Manager) Reset(ctx context.Context, id string) (Status, error) {
	dir, err := m.dir(id)
	if err != nil {
		return Status{}, err
	}
	if !m.Enabled {
		return Status{}, errors.New("computers are off")
	}
	if info, err := os.Lstat(dir); err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
		return Status{}, errors.New("unsafe computer directory")
	} else if err != nil && !os.IsNotExist(err) {
		return Status{}, err
	}
	m.mu.Lock()
	if m.busy[id] {
		m.mu.Unlock()
		return Status{}, errors.New("computer has a running write run")
	}
	m.busy[id] = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.busy, id)
		close(m.changed)
		m.changed = make(chan struct{})
		m.mu.Unlock()
	}()
	if err := m.StopSlice(ctx, id); err != nil {
		return Status{}, err
	}
	live, err := m.SlicePIDs(ctx, id)
	if err != nil {
		return Status{}, err
	}
	if live {
		return Status{}, errors.New("computer slice still has live processes")
	}
	root, err := os.OpenRoot(dir)
	if os.IsNotExist(err) {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return Status{}, err
		}
		root, err = os.OpenRoot(dir)
	}
	if err != nil {
		return Status{}, err
	}
	defer root.Close()
	for _, name := range []string{"home", "caches"} {
		if err := root.RemoveAll(name); err != nil {
			return Status{}, err
		}
	}
	if err := root.WriteFile("last_reset", []byte(time.Now().UTC().Format(time.RFC3339Nano)), 0600); err != nil {
		return Status{}, err
	}
	status, err := m.Status(id)
	if err == nil {
		status.State = "idle"
	}
	return status, err
}

// Tokens extracts credential values from the CLI's bound refresh files. It
// never treats an arbitrary short JSON string as a secret.
func Tokens(paths []string) [][]byte {
	var values [][]byte
	for _, path := range paths {
		b, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var node any
		if json.Unmarshal(b, &node) == nil {
			var visit func(any, string)
			visit = func(v any, key string) {
				switch x := v.(type) {
				case map[string]any:
					for k, v := range x {
						visit(v, strings.ToLower(k))
					}
				case []any:
					for _, v := range x {
						visit(v, key)
					}
				case string:
					if len(x) >= 20 && (strings.Contains(key, "token") || strings.Contains(key, "secret") || strings.Contains(key, "credential") || strings.Contains(key, "api_key")) {
						values = append(values, []byte(x))
					}
				}
			}
			visit(node, "")
		} else if len(bytes.TrimSpace(b)) >= 20 && len(b) < 4096 {
			values = append(values, bytes.TrimSpace(b))
		}
	}
	return values
}

// Scan removes only regular files containing a bound token verbatim. A root
// handle confines all reads and removals to the computer, even under races.
func (m *Manager) Scan(id string, tokens [][]byte) (int, error) {
	dir, err := m.dir(id)
	if err != nil {
		return 0, err
	}
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return 0, errors.New("unsafe computer directory")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return 0, err
	}
	defer root.Close()
	removed := 0
	var visit func(string) error
	visit = func(rel string) error {
		info, err := root.Lstat(rel)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if info.IsDir() {
			f, err := root.Open(rel)
			if err != nil {
				return err
			}
			names, err := f.Readdirnames(-1)
			f.Close()
			if err != nil {
				return err
			}
			for _, name := range names {
				if err := visit(filepath.Join(rel, name)); err != nil {
					return err
				}
			}
			return nil
		}
		if !info.Mode().IsRegular() || info.Size() > 32<<20 {
			return nil
		}
		f, err := root.OpenFile(rel, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		b, err := io.ReadAll(io.LimitReader(f, 32<<20+1))
		f.Close()
		if err != nil {
			return err
		}
		for _, token := range tokens {
			if len(token) >= 20 && bytes.Contains(b, token) {
				if err := root.Remove(rel); err != nil {
					return err
				}
				removed++
				break
			}
		}
		return nil
	}
	for _, name := range []string{"home", "caches"} {
		if err := visit(name); err != nil {
			return removed, err
		}
	}
	return removed, nil
}

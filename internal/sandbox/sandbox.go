// Package sandbox builds a small bubblewrap filesystem for write runs.
package sandbox

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Options struct {
	Worktree   string
	GitDir     string
	Home       string
	CLI        string
	Executable string
	Network    bool
	// ReadOnly holds per-run files such as a temporary MCP config.
	ReadOnly []string
}

// Build returns bubblewrap arguments before the command and its arguments.
// The caller must pass absolute worktree and git paths.
func Build(o Options) ([]string, error) {
	if !filepath.IsAbs(o.Worktree) || !filepath.IsAbs(o.GitDir) || !filepath.IsAbs(o.Home) {
		return nil, errors.New("sandbox paths must be absolute")
	}
	args := []string{"--unshare-all"}
	if o.Network {
		args = append(args, "--share-net")
	}
	args = append(args, "--die-with-parent", "--new-session")
	for _, p := range []string{"/usr", "/bin", "/lib", "/lib64", "/lib32"} {
		if _, err := os.Stat(p); err == nil {
			args = append(args, "--ro-bind", p, p)
		}
	}
	args = append(args, "--dir", "/etc")
	for _, p := range []string{"/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/ssl", "/etc/pki", "/etc/gitconfig", "/etc/localtime"} {
		if _, err := os.Stat(p); err == nil {
			args = append(args, "--ro-bind", p, p)
		}
	}
	args = append(args, "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp")
	dirs := map[string]bool{"/": true, "/usr": true, "/bin": true, "/lib": true, "/lib64": true, "/lib32": true, "/etc": true, "/proc": true, "/dev": true, "/tmp": true}
	bind := func(path, mode string) error {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return fmt.Errorf("invalid sandbox bind path %q", path)
		}
		// Add parents from the root down; bwrap creates them in order.
		var missing []string
		for p := filepath.Dir(path); !dirs[p]; p = filepath.Dir(p) {
			missing = append(missing, p)
		}
		for i := len(missing) - 1; i >= 0; i-- {
			args = append(args, "--dir", missing[i])
			dirs[missing[i]] = true
		}
		args = append(args, mode, path, path)
		dirs[path] = true
		return nil
	}
	for _, path := range []string{o.Worktree, o.GitDir} {
		if err := bind(path, "--bind"); err != nil {
			return nil, err
		}
	}
	paths := authPaths(o.Home, o.CLI)
	paths = append(paths, o.ReadOnly...)
	for _, path := range paths {
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("sandbox bind path is a symlink: %s", path)
		}
		mode := "--bind"
		if contains(o.ReadOnly, path) {
			mode = "--ro-bind"
		}
		if err := bind(path, mode); err != nil {
			return nil, err
		}
	}
	if o.Executable != "" && !systemPath(o.Executable) {
		if !filepath.IsAbs(o.Executable) || within(filepath.Join(o.Home, ".ssh"), o.Executable) || within(o.Worktree, o.Executable) {
			return nil, fmt.Errorf("unsafe CLI executable path %q", o.Executable)
		}
		info, err := os.Lstat(o.Executable)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
			return nil, fmt.Errorf("CLI executable is not a regular executable: %s", o.Executable)
		}
		if err := bind(o.Executable, "--ro-bind"); err != nil {
			return nil, err
		}
	}
	args = append(args, "--chdir", o.Worktree, "--setenv", "HOME", o.Home, "--setenv", "TMPDIR", "/tmp")
	for _, name := range []string{"SSH_AUTH_SOCK", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"} {
		args = append(args, "--unsetenv", name)
	}
	return args, nil
}

func within(base, path string) bool {
	return path == base || strings.HasPrefix(path, base+string(os.PathSeparator))
}

func systemPath(path string) bool {
	for _, base := range []string{"/usr", "/bin", "/lib", "/lib64", "/lib32"} {
		if within(base, path) {
			return true
		}
	}
	return false
}

func contains(paths []string, path string) bool {
	for _, p := range paths {
		if p == path {
			return true
		}
	}
	return false
}

func authPaths(home, cli string) []string {
	join := func(s string) string { return filepath.Join(home, s) }
	switch cli {
	case "claude":
		return []string{join(".claude"), join(".claude.json")}
	case "codex":
		return []string{join(".codex")}
	case "grok":
		return []string{join(".grok")}
	case "kimi":
		return []string{join(".kimi-code"), join(".kimi")}
	case "agy":
		paths, _ := filepath.Glob(join(".gemini/antigravity*"))
		return paths
	case "opencode":
		return []string{join(".config/opencode"), join(".local/share/opencode")}
	}
	return nil
}

// Probe tests the namespaces that the selected network policy needs.
func Probe(ctx context.Context, network bool) error {
	if _, err := exec.LookPath("bwrap"); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	args := []string{"--unshare-all"}
	if network {
		args = append(args, "--share-net")
	}
	args = append(args, "--ro-bind", "/", "/", "--", "/bin/true")
	out, err := exec.CommandContext(ctx, "bwrap", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("bubblewrap user namespace unavailable: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Check verifies the run's actual mount layout before starting an agent.
func Check(ctx context.Context, args []string) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	check := append(append([]string(nil), args...), "--", "/bin/true")
	out, err := exec.CommandContext(ctx, "bwrap", check...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("bubblewrap mount setup failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// ScopeArgs retains the bwrap command as a child of systemd-run, so the
// runner can still wait for and signal its process group.
func ScopeArgs(memory string, tasks int, command []string) []string {
	// A scope runs the command in the foreground with its own stdin and
	// stdout; systemd-run rejects --wait and --pipe with --scope.
	args := []string{"--user", "--scope", "--quiet", "--collect", "--property=MemoryMax=" + memory, fmt.Sprintf("--property=TasksMax=%d", tasks), "--"}
	return append(args, command...)
}

func ScopeAvailable(ctx context.Context, memory string, tasks int) bool {
	if _, err := exec.LookPath("systemd-run"); err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "systemd-run", ScopeArgs(memory, tasks, []string{"/bin/true"})...).Run() == nil
}

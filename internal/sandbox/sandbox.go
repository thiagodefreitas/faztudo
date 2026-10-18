// Package sandbox builds a small bubblewrap filesystem for write runs.
package sandbox

import (
	"context"
	"errors"
	"fmt"
	"io"
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
	StateDir   string
	// ReadOnly holds toolchain roots and per-run files such as an MCP config.
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
	for _, p := range []string{"/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/ssl", "/etc/pki", "/etc/gitconfig", "/etc/localtime", "/etc/alternatives", "/etc/ld.so.cache", "/etc/os-release"} {
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
	if err := bind(o.Worktree, "--bind"); err != nil {
		return nil, err
	}
	if err := bind(o.GitDir, "--ro-bind"); err != nil {
		return nil, err
	}
	// Git's shared configuration, hooks and attributes remain read-only.
	// A linked worktree needs its own index and HEAD, and object and ref
	// updates still need writable storage while the agent runs.
	for _, rel := range []string{"objects", "refs", "logs", "packed-refs"} {
		path := filepath.Join(o.GitDir, rel)
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("git bind path is a symlink: %s", path)
		}
		if err := bind(path, "--bind"); err != nil {
			return nil, err
		}
	}
	admin := filepath.Join(o.GitDir, "worktrees", filepath.Base(o.Worktree))
	if info, err := os.Lstat(admin); err == nil && info.IsDir() {
		source := admin
		if o.StateDir != "" {
			source = filepath.Join(o.StateDir, "git-admin")
			if err := copyGitAdmin(admin, source); err != nil {
				return nil, err
			}
		}
		args = append(args, "--bind", source, admin)
	} else if err != nil && !os.IsNotExist(err) {
		return nil, err
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
		if err := bind(path, "--ro-bind"); err != nil {
			return nil, err
		}
	}
	// OAuth refresh is the narrow exception to read-only credentials. These
	// files contain credentials, not executable CLI settings or hooks.
	for _, path := range refreshPaths(o.Home, o.CLI) {
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("credential path is not a regular file: %s", path)
		}
		if err := bind(path, "--bind"); err != nil {
			return nil, err
		}
	}
	if o.StateDir != "" {
		if err := bind(o.StateDir, "--bind"); err != nil {
			return nil, err
		}
		for _, rel := range sessionPaths(o.CLI) {
			target := filepath.Join(o.Home, rel)
			info, err := os.Lstat(target)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return nil, err
			}
			if !info.IsDir() {
				return nil, fmt.Errorf("session path is not a directory: %s", target)
			}
			source := filepath.Join(o.StateDir, "sessions", rel)
			if err := os.MkdirAll(source, 0700); err != nil {
				return nil, err
			}
			args = append(args, "--bind", source, target)
		}
		for _, rel := range sessionFiles(o.CLI) {
			target := filepath.Join(o.Home, rel)
			info, err := os.Lstat(target)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return nil, err
			}
			if !info.Mode().IsRegular() {
				return nil, fmt.Errorf("session file is not regular: %s", target)
			}
			source := filepath.Join(o.StateDir, "sessions", rel)
			if err := os.MkdirAll(filepath.Dir(source), 0700); err != nil {
				return nil, err
			}
			if err := copyGitAdminFile(target, source); err != nil {
				return nil, err
			}
			args = append(args, "--bind", source, target)
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

// A run gets a copy of its Git administration directory. Git can update its
// index, while config.worktree and commondir edits never reach host-side Git.
func copyGitAdmin(source, target string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		dest := filepath.Join(target, rel)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("git admin path is a symlink: %s", path)
		}
		if entry.IsDir() {
			return os.MkdirAll(dest, 0700)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("git admin path is not a regular file: %s", path)
		}
		return copyGitAdminFile(path, dest)
	})
}

func copyGitAdminFile(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
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

func refreshPaths(home, cli string) []string {
	switch cli {
	case "claude":
		return []string{filepath.Join(home, ".claude", ".credentials.json")}
	case "codex":
		return []string{filepath.Join(home, ".codex", "auth.json")}
	case "grok":
		return []string{filepath.Join(home, ".grok", "auth.json")}
	case "kimi":
		var paths []string
		for _, pattern := range []string{".kimi-code/credentials/*", ".kimi-code/oauth/*"} {
			matches, _ := filepath.Glob(filepath.Join(home, pattern))
			paths = append(paths, matches...)
		}
		return paths
	case "agy":
		return []string{filepath.Join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")}
	case "opencode":
		return []string{filepath.Join(home, ".local", "share", "opencode", "auth.json")}
	}
	return nil
}

func sessionFiles(cli string) []string {
	switch cli {
	case "codex":
		return []string{".codex/session_index.jsonl", ".codex/history.jsonl", ".codex/log.txt"}
	case "grok":
		return []string{".grok/active_sessions.json", ".grok/active_sessions.lock", ".grok/auth.json.lock"}
	case "kimi":
		return []string{".kimi-code/session_index.jsonl"}
	}
	return nil
}

func sessionPaths(cli string) []string {
	switch cli {
	case "claude":
		return []string{".claude/projects", ".claude/todos", ".claude/tasks", ".claude/debug", ".claude/shell-snapshots", ".claude/sessions"}
	case "codex":
		return []string{".codex/sessions", ".codex/tmp", ".codex/log"}
	case "grok":
		return []string{".grok/sessions"}
	case "kimi":
		return []string{".kimi-code/sessions", ".kimi-code/logs"}
	case "agy":
		return []string{".gemini/antigravity/sessions"}
	case "opencode":
		return []string{".local/share/opencode/session"}
	}
	return nil
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
func Check(ctx context.Context, args []string, executable string, environment []string) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	check := append(append([]string(nil), args...), "--", executable, "--version")
	cmd := exec.CommandContext(ctx, "bwrap", check...)
	cmd.Env = environment
	out, err := cmd.CombinedOutput()
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

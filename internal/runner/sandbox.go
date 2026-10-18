package runner

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/sandbox"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

func sandboxCommand(ctx context.Context, command adapters.Cmd, cli string, req adapters.Request, opts *WriteOptions) (adapters.Cmd, error) {
	worktree := req.Workdir
	fallback := func(cause error) (adapters.Cmd, error) {
		if opts.SandboxMode == "required" {
			return command, fmt.Errorf("write run requires bubblewrap: %w", cause)
		}
		if opts.OnFallback != nil {
			opts.OnFallback("Write run is not sandboxed: " + cause.Error())
		}
		return command, nil
	}
	if err := sandbox.Probe(ctx, opts.Network); err != nil {
		return fallback(err)
	}
	program, err := exec.LookPath(command.Path)
	if err != nil {
		return fallback(err)
	}
	program, err = filepath.EvalSymlinks(program)
	if err != nil {
		return fallback(err)
	}
	// Resolve the common directory through the trusted checkout. The run's
	// worktree .git file is agent-controlled once an unsandboxed fallback starts.
	git := exec.CommandContext(ctx, "git", "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-C", opts.Repo, "rev-parse", "--git-common-dir")
	out, err := git.Output()
	if err != nil {
		return fallback(fmt.Errorf("find git directory: %w", err))
	}
	gitDir := strings.TrimSpace(string(out))
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(opts.Repo, gitDir)
	}
	gitDir, err = filepath.Abs(gitDir)
	if err != nil {
		return fallback(err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fallback(err)
	}
	var readOnly []string
	if cli == "claude" && req.MCP != nil {
		readOnly = []string{filepath.Join(req.MCP.Dir, "mcp.json")}
	}
	if err := os.MkdirAll(opts.runStateDir, 0700); err != nil {
		return fallback(err)
	}
	cache := map[string]string{
		"GOCACHE":          filepath.Join(opts.runStateDir, "go-cache"),
		"NPM_CONFIG_CACHE": filepath.Join(opts.runStateDir, "npm-cache"),
		"XDG_CACHE_HOME":   filepath.Join(opts.runStateDir, "xdg-cache"),
		"XDG_DATA_HOME":    filepath.Join(opts.runStateDir, "xdg-data"),
		"XDG_STATE_HOME":   filepath.Join(opts.runStateDir, "xdg-state"),
	}
	for _, path := range cache {
		if err := os.MkdirAll(path, 0700); err != nil {
			return fallback(err)
		}
	}
	for _, path := range opts.ReadOnly {
		if path == home || path == filepath.Join(home, ".ssh") || strings.HasPrefix(path, filepath.Join(home, ".ssh")+string(os.PathSeparator)) {
			return fallback(fmt.Errorf("unsafe read-only path: %s", path))
		}
		if coversWritable(path, worktree, gitDir, opts.runStateDir) {
			return fallback(fmt.Errorf("read-only path covers writable run path: %s", path))
		}
		info, err := os.Lstat(path)
		if err != nil {
			return fallback(fmt.Errorf("read-only path %s: %w", path, err))
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fallback(fmt.Errorf("read-only path is a symlink: %s", path))
		}
	}
	readOnly = append(readOnly, toolchainRoots(home, opts.ReadOnly, worktree, gitDir, opts.runStateDir)...)
	if modcache := goModCache(home); modcache != "" {
		if coversWritable(modcache, worktree, gitDir, opts.runStateDir) {
			return fallback(fmt.Errorf("Go module cache covers a writable run path: %s", modcache))
		}
		readOnly = append(readOnly, modcache)
		cache["GOMODCACHE"] = modcache
	}
	args, err := sandbox.Build(sandbox.Options{Worktree: worktree, GitDir: filepath.Clean(gitDir), Home: home, CLI: cli, Executable: program, Network: opts.Network, StateDir: opts.runStateDir, Branch: "fz/" + filepath.Base(worktree), CodexHome: os.Getenv("CODEX_HOME"), ReadOnly: readOnly})
	if err != nil {
		return fallback(err)
	}
	if err := sandbox.Check(ctx, args, program, stripEnv(os.Environ(), nil, cache, envKeys(cache)...)); err != nil {
		return fallback(err)
	}
	command.Args = outerSandboxArgs(cli, command.Args)
	opts.sandboxArgs = append([]string(nil), args...)
	opts.sandboxEnv = cache
	if command.EnvAdd == nil {
		command.EnvAdd = map[string]string{}
	}
	for key, value := range cache {
		command.EnvAdd[key] = value
		command.EnvAllow = append(command.EnvAllow, key)
	}
	args = append(args, "--", program)
	args = append(args, command.Args...)
	path, err := exec.LookPath("bwrap")
	if err != nil {
		return fallback(err)
	}
	command.Path = path
	command.Args = args
	if opts.MemoryMax != "" && opts.TasksMax > 0 && sandbox.ScopeAvailable(ctx, opts.MemoryMax, opts.TasksMax) {
		command.Args = sandbox.ScopeArgs(opts.MemoryMax, opts.TasksMax, append([]string{command.Path}, command.Args...))
		command.Path, _ = exec.LookPath("systemd-run")
	}
	return command, nil
}

// Codex's own workspace sandbox needs user namespaces and conflicts with the
// outer bubblewrap mount plan. Only after bubblewrap passes Probe and Check do
// we disable that nested sandbox; bubblewrap still encloses the whole CLI.
func outerSandboxArgs(cli string, args []string) []string {
	if cli != "codex" {
		return args
	}
	out := make([]string, 0, len(args)+1)
	for i := 0; i < len(args); i++ {
		if (args[i] == "-s" || args[i] == "--sandbox") && i+1 < len(args) {
			i++
			continue
		}
		out = append(out, args[i])
	}
	if len(out) > 0 && out[0] == "exec" {
		out = append(out[:1], append([]string{"--dangerously-bypass-approvals-and-sandbox"}, out[1:]...)...)
	}
	return out
}

func envKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	return keys
}

func toolchainRoots(home string, configured []string, writable ...string) []string {
	seen := map[string]bool{}
	var paths []string
	add := func(path string) {
		path = filepath.Clean(path)
		if !filepath.IsAbs(path) || path == home || strings.HasPrefix(path, filepath.Join(home, ".ssh")+"/") || path == filepath.Join(home, ".ssh") || seen[path] {
			return
		}
		if coversWritable(path, writable...) {
			return
		}
		if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink == 0 {
			seen[path] = true
			paths = append(paths, path)
		}
	}
	for _, path := range configured {
		add(path)
	}
	for _, path := range filepath.SplitList(os.Getenv("PATH")) {
		if !strings.HasPrefix(path, home+string(os.PathSeparator)) {
			continue
		}
		// A PATH entry should name executable tools, not a whole home or
		// configuration tree. Other layouts can use sandbox_read_only.
		switch filepath.Base(path) {
		case "bin", "shims", "scripts":
		default:
			continue
		}
		if strings.Contains(path, string(os.PathSeparator)+"toolchains"+string(os.PathSeparator)) || strings.Contains(path, string(os.PathSeparator)+"versions"+string(os.PathSeparator)) {
			if filepath.Base(path) == "bin" {
				path = filepath.Dir(path)
			}
		}
		add(path)
	}
	return paths
}

func coversWritable(path string, roots ...string) bool {
	for _, root := range roots {
		if root != "" && (path == root || strings.HasPrefix(root, path+string(os.PathSeparator))) {
			return true
		}
	}
	return false
}

func goModCache(home string) string {
	path := os.Getenv("GOMODCACHE")
	if path == "" {
		path = filepath.Join(home, "go", "pkg", "mod")
	}
	if !filepath.IsAbs(path) || path == home {
		return ""
	}
	if info, err := os.Lstat(path); err == nil && info.IsDir() {
		return path
	}
	return ""
}

func (r *Runner) verifyWrite(ctx context.Context, w worktree.Worktree, testCommand string, timeout time.Duration, opts WriteOptions) error {
	if testCommand == "" {
		return nil
	}
	if len(opts.sandboxArgs) == 0 {
		return opts.Worktrees.Verify(ctx, w, testCommand, timeout)
	}
	if timeout <= 0 {
		return fmt.Errorf("verification timeout required")
	}
	verifyCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	args := append(append([]string(nil), opts.sandboxArgs...), "--", "/bin/sh", "-c", testCommand)
	cmd := exec.Command("bwrap", args...)
	cmd.Dir = w.Path
	cmd.Env = stripEnv(os.Environ(), r.ExtraEnvRemove, opts.sandboxEnv, envKeys(opts.sandboxEnv)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("verification failed: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("verification failed: %w", err)
		}
		return nil
	case <-verifyCtx.Done():
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		return verifyCtx.Err()
	}
}

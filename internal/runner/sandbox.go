package runner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/sandbox"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

func sandboxCommand(ctx context.Context, command adapters.Cmd, cli string, req adapters.Request, opts *WriteOptions) (adapters.Cmd, error) {
	worktree := req.Workdir
	if opts.ComputerHome != "" {
		opts.SandboxMode = "required"
	}
	fallback := func(cause error) (adapters.Cmd, error) {
		if opts.SandboxMode == "required" {
			return command, fmt.Errorf("write run requires bubblewrap (sandbox = \"required\"): %w. Install bubblewrap and allow unprivileged user namespaces, or set sandbox = \"auto\" under [runs] or on the lane to run unsandboxed", cause)
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
	if opts.ComputerHome != "" {
		if opts.ComputerCaches == "" || opts.ComputerID == "" {
			return command, errors.New("computer paths and id required")
		}
		pins, err := computerPins(filepath.Dir(opts.runStateDir), opts.ComputerCaches)
		if err != nil {
			return command, err
		}
		for key, value := range pins {
			cache[key] = value
		}
		readOnly = append(readOnly, pins["GIT_CONFIG_GLOBAL"], pins["NPM_CONFIG_USERCONFIG"])
	}
	if cli == "opencode" {
		cache["XDG_CONFIG_HOME"] = filepath.Join(opts.runStateDir, "xdg-config")
	}
	if opts.ComputerHome != "" {
		cache["XDG_CONFIG_HOME"] = filepath.Join(opts.runStateDir, "xdg-config")
	}
	for _, key := range []string{"GOCACHE", "NPM_CONFIG_CACHE", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"} {
		path := cache[key]
		if err := os.MkdirAll(path, 0700); err != nil {
			return fallback(err)
		}
	}
	if path := cache["XDG_CONFIG_HOME"]; path != "" {
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
	toolchainPaths := append([]string(nil), opts.ReadOnly...)
	// A locally built daemon may have been started by systemd with /usr/bin
	// before its build toolchain on PATH. Use that toolchain for agent commands
	// and verification when it still exists on this host. Released binaries
	// whose build-machine GOROOT is absent keep the configured PATH.
	if root := availableGoRoot(home, worktree, gitDir, opts.runStateDir); root != "" {
		toolchainPaths = append(toolchainPaths, root)
		cache["PATH"] = filepath.Join(root, "bin") + string(os.PathListSeparator) + os.Getenv("PATH")
	}
	readOnly = append(readOnly, toolchainRoots(home, toolchainPaths, worktree, gitDir, opts.runStateDir)...)
	if opts.ComputerHome != "" {
		hostBin := filepath.Join(home, ".local", "bin")
		if info, err := os.Lstat(hostBin); err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
			readOnly = append(readOnly, hostBin)
		}
		cache["PATH"] = computerPATH(readOnly)
	}
	if modcache := goModCache(home); modcache != "" {
		if coversWritable(modcache, worktree, gitDir, opts.runStateDir) {
			return fallback(fmt.Errorf("Go module cache covers a writable run path: %s", modcache))
		}
		readOnly = append(readOnly, modcache)
		cache["GOMODCACHE"] = modcache
	}
	args, err := sandbox.Build(sandbox.Options{Worktree: worktree, GitDir: filepath.Clean(gitDir), Home: home, ComputerHome: opts.ComputerHome, CLI: cli, Executable: program, Network: opts.Network, StateDir: opts.runStateDir, Branch: "fz/" + filepath.Base(worktree), CodexHome: os.Getenv("CODEX_HOME"), ReadOnly: readOnly})
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
	opts.scopeUsed = opts.MemoryMax != "" && opts.TasksMax > 0 && sandbox.ScopeAvailable(ctx, opts.MemoryMax, opts.TasksMax)
	if opts.ComputerID != "" {
		if !opts.scopeUsed {
			return command, errors.New("computer write run requires a systemd user scope")
		}
		if err := sandbox.EnsureComputerSlice(ctx, opts.ComputerID, opts.MemoryMax, opts.TasksMax, opts.CPUQuota); err != nil {
			return command, err
		}
	}
	command.Path, command.Args, err = sandboxLaunch(args, opts)
	if err != nil {
		return fallback(err)
	}
	return command, nil
}

func computerPins(stateDir, cachesDir string) (map[string]string, error) {
	gitConfig := filepath.Join(stateDir, "computer-gitconfig")
	npmConfig := filepath.Join(stateDir, "computer-npmrc")
	if err := os.WriteFile(gitConfig, []byte("[core]\n\thooksPath = /dev/null\n"), 0600); err != nil {
		return nil, err
	}
	if err := os.WriteFile(npmConfig, nil, 0600); err != nil {
		return nil, err
	}
	zdot := filepath.Join(stateDir, "computer-zdotdir")
	if err := os.MkdirAll(zdot, 0700); err != nil {
		return nil, err
	}
	return map[string]string{
		// GOCACHE stays per run: Go replaces action-cache entries, executables
		// included, so a persistent build cache would hand the next run a
		// binary to execute (ADR 0006).
		"NPM_CONFIG_CACHE": filepath.Join(cachesDir, "npm"), "XDG_CACHE_HOME": filepath.Join(cachesDir, "xdg"),
		"GIT_CONFIG_GLOBAL": gitConfig, "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": "/dev/null", "GOENV": "off", "NPM_CONFIG_USERCONFIG": npmConfig,
		"SHELL": "/bin/sh", "ENV": "", "BASH_ENV": "", "ZDOTDIR": zdot,
	}, nil
}

func computerPATH(readOnly []string) string {
	var executablePaths []string
	for _, root := range readOnly {
		if filepath.Base(root) == "bin" || filepath.Base(root) == "shims" {
			executablePaths = append(executablePaths, root)
		}
		if info, err := os.Stat(filepath.Join(root, "bin")); err == nil && info.IsDir() {
			executablePaths = append(executablePaths, filepath.Join(root, "bin"))
		}
	}
	return strings.Join(append(executablePaths, "/usr/local/bin", "/usr/bin", "/bin"), string(os.PathListSeparator))
}

func availableGoRoot(home string, writable ...string) string {
	root := filepath.Clean(runtime.GOROOT())
	if !filepath.IsAbs(root) || coversWritable(root, append(writable, home)...) || strings.HasPrefix(root, filepath.Join(home, ".ssh")+string(os.PathSeparator)) {
		return ""
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ""
	}
	goBin := filepath.Join(root, "bin", "go")
	info, err = os.Lstat(goBin)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return ""
	}
	return root
}

// sandboxLaunch gives the agent and its verification command the same scope.
func sandboxLaunch(args []string, opts *WriteOptions) (string, []string, error) {
	path, err := exec.LookPath("bwrap")
	if err != nil {
		return "", nil, err
	}
	if opts.scopeUsed {
		scope, err := exec.LookPath("systemd-run")
		if err != nil {
			return "", nil, err
		}
		sh, err := exec.LookPath("sh")
		if err != nil {
			return "", nil, err
		}
		// This host-side shell remains in the scope after bubblewrap exits.
		// It reads cgroup counters before --collect removes the scope.
		// The sandbox can write runStateDir; keep the diagnostic in its
		// parent so agent-written files cannot forge an OOM result.
		opts.scopeReport = filepath.Join(filepath.Dir(opts.runStateDir), "scope.report")
		wrapped := append([]string{sh, "-c", scopeReportScript, "scope-report", opts.scopeReport, path}, args...)
		if opts.ComputerID != "" {
			return scope, sandbox.ComputerScopeArgs(opts.MemoryMax, opts.TasksMax, "faztudo-computer-"+opts.ComputerID+".slice", opts.CPUQuota, wrapped), nil
		}
		return scope, sandbox.ScopeArgs(opts.MemoryMax, opts.TasksMax, wrapped), nil
	}
	return path, args, nil
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

// verificationTail keeps the end of both command streams without retaining an
// unbounded compiler or test log in the run record.
type verificationTail struct {
	mu        sync.Mutex
	data      []byte
	truncated bool
}

func (t *verificationTail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.data = append(t.data, p...)
	const maxBytes = 256 * 1024
	if len(t.data) > maxBytes {
		t.data = append([]byte(nil), t.data[len(t.data)-maxBytes:]...)
		t.truncated = true
	}
	const maxLines = 200
	if lines := bytes.Count(t.data, []byte{'\n'}); lines > maxLines {
		drop := lines - maxLines
		for drop > 0 {
			idx := bytes.IndexByte(t.data, '\n')
			t.data = t.data[idx+1:]
			drop--
		}
		t.truncated = true
	}
	return len(p), nil
}

func (t *verificationTail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.truncated {
		return "[earlier verification output omitted]\n" + string(t.data)
	}
	return string(t.data)
}

func runVerification(ctx context.Context, cmd *exec.Cmd, timeout time.Duration) (string, error) {
	if timeout <= 0 {
		return "", fmt.Errorf("verification timeout required")
	}
	verifyCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	tail := &verificationTail{}
	cmd.Stdin = nil
	cmd.Stdout, cmd.Stderr = tail, tail
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return tail.String(), fmt.Errorf("verification failed: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return tail.String(), fmt.Errorf("verification failed: %w", err)
		}
		return tail.String(), nil
	case <-verifyCtx.Done():
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		return tail.String(), fmt.Errorf("verification failed: %w", verifyCtx.Err())
	}
}

func (r *Runner) verifyWrite(ctx context.Context, run *domain.Run, w worktree.Worktree, testCommand string, timeout time.Duration, opts WriteOptions) (string, error) {
	if testCommand == "" {
		return "", nil
	}
	if len(opts.sandboxArgs) == 0 {
		if opts.SandboxMode == "required" || opts.SandboxMode == "auto" {
			// The agent ran without its sandbox (auto fell back). Its tests
			// would execute agent-written code as the user, so do not run them.
			return "", fmt.Errorf("verification not run: the write run was meant to be sandboxed but was not; review the change by hand or fix bubblewrap")
		}
		cmd := exec.Command("sh", "-c", testCommand)
		cmd.Dir = w.Path
		return runVerification(ctx, cmd, timeout)
	}
	args := append(append([]string(nil), opts.sandboxArgs...), "--", "/bin/sh", "-c", testCommand)
	path, args, err := sandboxLaunch(args, &opts)
	if err != nil {
		return "", fmt.Errorf("verification failed: %w", err)
	}
	cmd := exec.Command(path, args...)
	cmd.Dir = w.Path
	cmd.Env = stripEnv(os.Environ(), r.ExtraEnvRemove, opts.sandboxEnv, envKeys(opts.sandboxEnv)...)
	_ = os.Remove(opts.scopeReport)
	output, verifyErr := runVerification(ctx, cmd, timeout)
	code := -1
	var exit *exec.ExitError
	if errors.As(verifyErr, &exit) {
		code = exit.ExitCode()
	}
	if oom, reason := scopeFailure(run, code, &opts); oom && !errors.Is(verifyErr, context.DeadlineExceeded) {
		return output, scopeOOMError(reason)
	}
	return output, verifyErr
}

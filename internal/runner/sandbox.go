package runner

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/sandbox"
)

func sandboxCommand(ctx context.Context, command adapters.Cmd, cli string, req adapters.Request, opts WriteOptions) (adapters.Cmd, error) {
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
	git := exec.CommandContext(ctx, "git", "-C", worktree, "rev-parse", "--git-common-dir")
	out, err := git.Output()
	if err != nil {
		return fallback(fmt.Errorf("find git directory: %w", err))
	}
	gitDir := strings.TrimSpace(string(out))
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(worktree, gitDir)
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
	args, err := sandbox.Build(sandbox.Options{Worktree: worktree, GitDir: filepath.Clean(gitDir), Home: home, CLI: cli, Executable: program, Network: opts.Network, ReadOnly: readOnly})
	if err != nil {
		return fallback(err)
	}
	if err := sandbox.Check(ctx, args); err != nil {
		return fallback(err)
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

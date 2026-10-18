package runner

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
)

func TestSandboxFallbackPolicy(t *testing.T) {
	command := adapters.Cmd{Path: "faztudo-missing-cli-for-test"}
	req := adapters.Request{Workdir: t.TempDir()}
	var notices []string
	opts := WriteOptions{SandboxMode: "auto", Network: true, OnFallback: func(s string) { notices = append(notices, s) }}
	got, err := sandboxCommand(context.Background(), command, "codex", req, &opts)
	if err != nil || got.Path != command.Path || len(notices) != 1 || !strings.Contains(notices[0], "not sandboxed") {
		t.Fatalf("auto fallback: %+v, %v, %q", got, err, notices)
	}
	opts.SandboxMode = "required"
	if _, err := sandboxCommand(context.Background(), command, "codex", req, &opts); err == nil || !strings.Contains(err.Error(), "requires bubblewrap") {
		t.Fatalf("required mode: %v", err)
	}
	if len(notices) != 1 {
		t.Fatalf("required mode sent a fallback notice: %q", notices)
	}
}

func TestCodexUsesOuterSandboxOnly(t *testing.T) {
	args := []string{"exec", "-s", "workspace-write", "-C", "/tmp/project", "prompt"}
	got := outerSandboxArgs("codex", args)
	if strings.Contains(strings.Join(got, " "), "workspace-write") || !strings.Contains(strings.Join(got, " "), "--dangerously-bypass-approvals-and-sandbox") {
		t.Fatalf("codex kept its nested sandbox: %q", got)
	}
	if strings.Join(outerSandboxArgs("claude", args), " ") != strings.Join(args, " ") {
		t.Fatal("changed another CLI")
	}
}

func TestToolchainRootsDoNotCoverWritableRunPaths(t *testing.T) {
	home := t.TempDir()
	data := filepath.Join(home, "data")
	worktree := filepath.Join(data, "worktrees", "run")
	tool := filepath.Join(home, ".local", "toolchains", "go1", "bin")
	for _, p := range []string{worktree, tool} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", data+string(os.PathListSeparator)+tool)
	got := toolchainRoots(home, []string{data}, worktree)
	for _, path := range got {
		if path == data {
			t.Fatal("read-only toolchain bind covered writable worktree")
		}
	}
	if len(got) != 1 || got[0] != filepath.Dir(tool) {
		t.Fatalf("toolchain root: %q", got)
	}
	configDir := filepath.Join(home, ".config")
	if err := os.Mkdir(configDir, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", configDir+string(os.PathListSeparator)+tool)
	for _, path := range toolchainRoots(home, nil, worktree) {
		if path == configDir {
			t.Fatal("automatic PATH mount exposed a configuration directory")
		}
	}
}

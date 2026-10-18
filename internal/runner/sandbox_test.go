package runner

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
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
	_, err = sandboxCommand(context.Background(), command, "codex", req, &opts)
	if err == nil || !strings.Contains(err.Error(), `sandbox = "auto"`) {
		t.Fatalf("required failure does not say how to opt into auto: %v", err)
	}
}

func TestVerificationNeverRunsUnsandboxedForSandboxedRuns(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "ran")
	r := &Runner{}
	for _, mode := range []string{"auto", "required"} {
		_, err := r.verifyWrite(context.Background(), worktree.Worktree{Path: t.TempDir()}, "touch "+marker, time.Minute, WriteOptions{SandboxMode: mode})
		if err == nil || !strings.Contains(err.Error(), "verification not run") {
			t.Fatalf("%s: %v", mode, err)
		}
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("verification command ran without a sandbox")
	}
	if _, err := r.verifyWrite(context.Background(), worktree.Worktree{Path: t.TempDir()}, "touch "+marker, time.Minute, WriteOptions{SandboxMode: "off"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("sandbox = off must still verify")
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

func TestVerificationReusesAgentScope(t *testing.T) {
	opts := WriteOptions{MemoryMax: "4G", TasksMax: 512, scopeUsed: true}
	path, args, err := sandboxLaunch([]string{"--unshare-all"}, &opts)
	if err != nil || filepath.Base(path) != "systemd-run" || !strings.Contains(strings.Join(args, " "), "--property=MemoryMax=4G") || !strings.Contains(strings.Join(args, " "), "--property=TasksMax=512") || !strings.Contains(strings.Join(args, " "), "bwrap --unshare-all") {
		t.Fatalf("verification scope: %s %q %v", path, args, err)
	}
}

func TestVerificationTailKeepsLastLines(t *testing.T) {
	var tail verificationTail
	for i := 0; i < 250; i++ {
		if _, err := tail.Write([]byte(fmt.Sprintf("line-%03d\n", i))); err != nil {
			t.Fatal(err)
		}
	}
	got := tail.String()
	if strings.Contains(got, "line-000") || !strings.Contains(got, "line-249") || !strings.Contains(got, "earlier verification output omitted") {
		t.Fatalf("wrong tail: %q", got)
	}
	if _, err := tail.Write([]byte(strings.Repeat("x", 300*1024))); err != nil {
		t.Fatal(err)
	}
	if len(tail.String()) > 257*1024 {
		t.Fatalf("verification tail grew without bound: %d", len(tail.String()))
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

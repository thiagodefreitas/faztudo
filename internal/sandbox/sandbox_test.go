package sandbox

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestBuild(t *testing.T) {
	home := t.TempDir()
	worktree := filepath.Join(t.TempDir(), "worktree")
	git := filepath.Join(t.TempDir(), ".git")
	for _, path := range []string{worktree, git, filepath.Join(home, ".claude"), filepath.Join(home, ".codex"), filepath.Join(home, ".grok"), filepath.Join(home, ".kimi-code"), filepath.Join(home, ".kimi"), filepath.Join(home, ".gemini", "antigravity-test"), filepath.Join(home, ".config", "opencode"), filepath.Join(home, ".local", "share", "opencode")} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		cli  string
		want []string
	}{
		{"claude", []string{".claude", ".claude.json"}},
		{"codex", []string{".codex"}},
		{"grok", []string{".grok"}},
		{"kimi", []string{".kimi-code", ".kimi"}},
		{"agy", []string{".gemini/antigravity-test"}},
		{"opencode", []string{".config/opencode", ".local/share/opencode"}},
	} {
		t.Run(tc.cli, func(t *testing.T) {
			args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: tc.cli, Network: false})
			if err != nil {
				t.Fatal(err)
			}
			for _, path := range append([]string{worktree, git}, tc.want...) {
				if !filepath.IsAbs(path) {
					path = filepath.Join(home, path)
				}
				if !hasBind(args, "--bind", path) {
					t.Fatalf("missing bind for %s: %v", path, args)
				}
			}
			if hasBind(args, "--bind", home) || hasBind(args, "--ro-bind", home) || strings.Contains(strings.Join(args, " "), filepath.Join(home, ".ssh")) {
				t.Fatal("home or ssh bound")
			}
			if !reflect.DeepEqual(args[:3], []string{"--unshare-all", "--die-with-parent", "--new-session"}) {
				t.Fatalf("namespace flags: %v", args[:3])
			}
		})
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "codex", Network: true})
	if err != nil {
		t.Fatal(err)
	}
	if args[1] != "--share-net" {
		t.Fatalf("network flag missing: %v", args[:3])
	}
	executable := filepath.Join(home, ".local", "bin", "agent")
	if err := os.MkdirAll(filepath.Dir(executable), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	args, err = Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "codex", Executable: executable, Network: true})
	if err != nil || !hasBind(args, "--ro-bind", executable) || hasBind(args, "--bind", home) {
		t.Fatalf("CLI executable bind: %v, %v", args, err)
	}
}

func hasBind(args []string, mode, path string) bool {
	for i := 0; i+2 < len(args); i++ {
		if args[i] == mode && args[i+1] == path && args[i+2] == path {
			return true
		}
	}
	return false
}

func TestSandboxCannotReadUnboundHome(t *testing.T) {
	if err := Probe(context.Background(), true); err != nil {
		t.Skipf("bubblewrap or user namespaces unavailable: %v", err)
	}
	home := filepath.Join(t.TempDir(), "home")
	worktree := filepath.Join(t.TempDir(), "worktree")
	git := filepath.Join(t.TempDir(), ".git")
	for _, path := range []string{home, worktree, git} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(home, "private.txt"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "codex", Network: true})
	if err != nil {
		t.Fatal(err)
	}
	args = append(args, "--", "/bin/sh", "-c", "echo ok > result; test ! -r \"$HOME/private.txt\"")
	cmd := exec.Command("bwrap", args...)
	cmd.Dir = worktree
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("sandbox command: %v: %s", err, out)
	}
	if b, err := os.ReadFile(filepath.Join(worktree, "result")); err != nil || string(b) != "ok\n" {
		t.Fatalf("worktree write: %q, %v", b, err)
	}
	for _, rel := range []string{".local/bin/agent", ".codex/bin/agent"} {
		executable := filepath.Join(home, rel)
		if err := os.MkdirAll(filepath.Dir(executable), 0700); err != nil {
			t.Fatal(err)
		}
		body, err := os.ReadFile("/bin/true")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(executable, body, 0700); err != nil {
			t.Fatal(err)
		}
		args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "codex", Executable: executable, Network: true})
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command("bwrap", append(args, "--", executable)...)
		cmd.Dir = worktree
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("home CLI %s: %v: %s", rel, err, out)
		}
	}
}

func TestScopeArgsAreAcceptedBySystemd(t *testing.T) {
	args := ScopeArgs("64M", 16, []string{"/bin/true"})
	for _, flag := range []string{"--wait", "--pipe", "--pty"} {
		for _, a := range args {
			if a == flag {
				t.Fatalf("%s is rejected by systemd-run in --scope mode: %v", flag, args)
			}
		}
	}
	if _, err := exec.LookPath("systemd-run"); err != nil {
		t.Skip("systemd-run not installed")
	}
	if out, err := exec.Command("systemd-run", args...).CombinedOutput(); err != nil {
		t.Skipf("no systemd user manager here (%v: %s)", err, out)
	}
	if !ScopeAvailable(context.Background(), "64M", 16) {
		t.Fatal("scope runs from the shell but ScopeAvailable says no")
	}
}

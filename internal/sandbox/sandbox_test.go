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
			if !hasBind(args, "--bind", worktree) || !hasBind(args, "--ro-bind", git) {
				t.Fatal("worktree or git mount has wrong mode")
			}
			for _, path := range tc.want {
				if !filepath.IsAbs(path) {
					path = filepath.Join(home, path)
				}
				if !hasBind(args, "--ro-bind", path) {
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

func TestGitMetadataIsReadOnly(t *testing.T) {
	home := t.TempDir()
	worktree := filepath.Join(t.TempDir(), "run")
	git := filepath.Join(t.TempDir(), ".git")
	for _, p := range []string{worktree, filepath.Join(git, "objects"), filepath.Join(git, "refs"), filepath.Join(git, "logs"), filepath.Join(git, "worktrees", "run")} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "codex", Network: true})
	if err != nil {
		t.Fatal(err)
	}
	if !hasBind(args, "--ro-bind", git) || hasBind(args, "--bind", git) {
		t.Fatal("shared git metadata is writable")
	}
	if !hasBind(args, "--bind", filepath.Join(git, "objects")) {
		t.Fatal("missing writable git objects")
	}
	if !hasMount(args, "--bind", filepath.Join(git, "worktrees", "run"), filepath.Join(git, "worktrees", "run")) {
		t.Fatal("missing writable git worktree admin")
	}
	for _, p := range []string{"refs", "logs", "packed-refs", "config", "hooks", "info"} {
		if hasBind(args, "--bind", filepath.Join(git, p)) {
			t.Fatalf("git %s is writable", p)
		}
	}
}

func TestToolchainAndRunStateMounts(t *testing.T) {
	home := t.TempDir()
	worktree := filepath.Join(t.TempDir(), "tree")
	git := filepath.Join(t.TempDir(), ".git")
	state := filepath.Join(t.TempDir(), "state")
	tool := filepath.Join(home, ".local", "toolchains", "go1")
	for _, p := range []string{worktree, git, state, tool} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "codex", StateDir: state, ReadOnly: []string{tool}})
	if err != nil {
		t.Fatal(err)
	}
	if !hasBind(args, "--ro-bind", tool) {
		t.Fatal("toolchain not read-only")
	}
	if !hasBind(args, "--bind", state) {
		t.Fatal("run state not writable")
	}
	if hasBind(args, "--bind", home) {
		t.Fatal("home writable")
	}
}

func TestGitAdminUsesPerRunCopy(t *testing.T) {
	home := t.TempDir()
	worktree := filepath.Join(t.TempDir(), "run")
	git := filepath.Join(t.TempDir(), ".git")
	state := filepath.Join(t.TempDir(), "state")
	admin := filepath.Join(git, "worktrees", "run")
	for _, p := range []string{worktree, admin, state} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(admin, "commondir"), []byte("../..\n"), 0600); err != nil {
		t.Fatal(err)
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "codex", StateDir: state})
	if err != nil {
		t.Fatal(err)
	}
	shadow := filepath.Join(state, "git-admin")
	if !hasMount(args, "--bind", shadow, admin) {
		t.Fatal("git admin directory is not shadowed")
	}
	if err := os.WriteFile(filepath.Join(shadow, "commondir"), []byte("evil\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(admin, "commondir")); err != nil || string(got) != "../..\n" {
		t.Fatalf("host git metadata changed: %q, %v", got, err)
	}
}

func TestSessionFileUsesPerRunCopy(t *testing.T) {
	home := t.TempDir()
	worktree := filepath.Join(t.TempDir(), "run")
	git := filepath.Join(t.TempDir(), ".git")
	state := filepath.Join(t.TempDir(), "state")
	sessions := filepath.Join(home, ".grok", "active_sessions.json")
	for _, p := range []string{worktree, git, state, filepath.Dir(sessions)} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(sessions, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "grok", StateDir: state})
	if err != nil {
		t.Fatal(err)
	}
	copy := filepath.Join(state, "sessions", ".grok", "active_sessions.json")
	if !hasMount(args, "--bind", copy, sessions) {
		t.Fatal("session file does not have a private writable copy")
	}
}

func hasMount(args []string, mode, source, target string) bool {
	for i := 0; i+2 < len(args); i++ {
		if args[i] == mode && args[i+1] == source && args[i+2] == target {
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

func TestSandboxCannotRewriteHostGitOrCLISettings(t *testing.T) {
	if err := Probe(context.Background(), true); err != nil {
		t.Skipf("bubblewrap unavailable: %v", err)
	}
	home := t.TempDir()
	worktree := filepath.Join(t.TempDir(), "run")
	git := filepath.Join(t.TempDir(), ".git")
	admin := filepath.Join(git, "worktrees", "run")
	state := filepath.Join(t.TempDir(), "state")
	for _, p := range []string{worktree, admin, filepath.Join(home, ".grok"), state} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []string{filepath.Join(git, "config"), filepath.Join(admin, "commondir"), filepath.Join(home, ".grok", "config.toml"), filepath.Join(home, ".grok", "auth.json"), filepath.Join(home, ".grok", "active_sessions.json")} {
		if err := os.WriteFile(p, []byte("original"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "grok", Network: true, StateDir: state})
	if err != nil {
		t.Fatal(err)
	}
	script := "if echo changed > '" + filepath.Join(git, "config") + "'; then exit 11; fi; " +
		"if echo changed > '" + filepath.Join(home, ".grok", "config.toml") + "'; then exit 12; fi; " +
		"echo changed > '" + filepath.Join(admin, "commondir") + "'; " +
		"echo changed > '" + filepath.Join(home, ".grok", "active_sessions.json") + "'; " +
		"echo refreshed > '" + filepath.Join(home, ".grok", "auth.json") + "'; " +
		"echo work > result"
	cmd := exec.Command("bwrap", append(args, "--", "/bin/sh", "-c", script)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("sandbox command: %v: %s", err, out)
	}
	for _, p := range []string{filepath.Join(git, "config"), filepath.Join(admin, "commondir"), filepath.Join(home, ".grok", "config.toml"), filepath.Join(home, ".grok", "active_sessions.json")} {
		if got, err := os.ReadFile(p); err != nil || string(got) != "original" {
			t.Fatalf("host file %s changed: %q, %v", p, got, err)
		}
	}
	if got, err := os.ReadFile(filepath.Join(home, ".grok", "auth.json")); err != nil || string(got) != "refreshed\n" {
		t.Fatalf("OAuth refresh exception failed: %q, %v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(worktree, "result")); err != nil || string(got) != "work\n" {
		t.Fatalf("worktree write failed: %q, %v", got, err)
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

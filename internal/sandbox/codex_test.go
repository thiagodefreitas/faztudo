package sandbox

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// codexFixture is a host ~/.codex with credentials, settings, big read-only
// trees and state that a run must not share.
func codexFixture(t *testing.T) (home, worktree, git, state string) {
	t.Helper()
	root := t.TempDir()
	home, worktree, git, state = filepath.Join(root, "home"), filepath.Join(root, "tree"), filepath.Join(root, "repo", ".git"), filepath.Join(root, "state")
	codex := filepath.Join(home, ".codex")
	for _, p := range []string{worktree, git, state, filepath.Join(codex, "packages", "v1"), filepath.Join(codex, "plugins"), filepath.Join(codex, "sessions"), filepath.Join(codex, "skills")} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for name, body := range map[string]string{
		"auth.json": "tokens", "config.toml": "model = 'x'", "AGENTS.md": "rules",
		"history.jsonl": "private history", "state_5.sqlite": "host db", "packages/v1/codex": "binary",
	} {
		if err := os.WriteFile(filepath.Join(codex, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return home, worktree, git, state
}

func TestCodexGetsAPerRunHome(t *testing.T) {
	home, worktree, git, state := codexFixture(t)
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "codex", StateDir: state, Network: true})
	if err != nil {
		t.Fatal(err)
	}
	codex := filepath.Join(home, ".codex")
	run := filepath.Join(state, "codex-home")
	if hasBind(args, "--ro-bind", codex) || hasBind(args, "--bind", codex) {
		t.Fatalf("the host codex directory is mounted as is: %v", args)
	}
	for _, rel := range []string{"config.toml", "AGENTS.md", "packages", "plugins", "skills"} {
		if !hasMount(args, "--ro-bind", filepath.Join(codex, rel), filepath.Join(run, rel)) {
			t.Fatalf("%s is not a read-only bind: %v", rel, args)
		}
	}
	if !hasMount(args, "--bind", filepath.Join(codex, "auth.json"), filepath.Join(run, "auth.json")) {
		t.Fatalf("auth.json must stay writable for OAuth refresh: %v", args)
	}
	for _, rel := range []string{"history.jsonl", "state_5.sqlite", "sessions"} {
		for i, a := range args {
			if a == filepath.Join(codex, rel) {
				t.Fatalf("%s from the host is mounted (arg %d)", rel, i)
			}
		}
	}
	if !contains3(args, "--setenv", "CODEX_HOME", run) {
		t.Fatalf("CODEX_HOME is not set to the run directory: %v", args)
	}
}

func contains3(args []string, a, b, c string) bool {
	for i := 0; i+2 < len(args); i++ {
		if args[i] == a && args[i+1] == b && args[i+2] == c {
			return true
		}
	}
	return false
}

func TestCodexHomeFollowsCODEXHOME(t *testing.T) {
	home, worktree, git, state := codexFixture(t)
	other := filepath.Join(filepath.Dir(home), "elsewhere")
	if err := os.MkdirAll(other, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(other, "auth.json"), []byte("t"), 0600); err != nil {
		t.Fatal(err)
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "codex", StateDir: state, CodexHome: other})
	if err != nil {
		t.Fatal(err)
	}
	if !hasMount(args, "--bind", filepath.Join(other, "auth.json"), filepath.Join(state, "codex-home", "auth.json")) {
		t.Fatalf("auth.json does not come from CODEX_HOME: %v", args)
	}
}

func TestCodexStateIsFreshAndOnlyAuthIsShared(t *testing.T) {
	if err := Probe(context.Background(), true); err != nil {
		t.Skipf("bubblewrap unavailable: %v", err)
	}
	home, worktree, git, state := codexFixture(t)
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "codex", StateDir: state, Network: true})
	if err != nil {
		t.Fatal(err)
	}
	script := "cd \"$CODEX_HOME\" || exit 10; " +
		"if echo x > config.toml 2>/dev/null; then exit 11; fi; " +
		"if echo x > AGENTS.md 2>/dev/null; then exit 12; fi; " +
		"if echo x > packages/v1/codex 2>/dev/null; then exit 13; fi; " +
		"test ! -e history.jsonl && test ! -e state_5.sqlite || exit 14; " +
		"mkdir -p sessions tmp && echo db > state_5.sqlite && echo s > sessions/a.jsonl || exit 15; " +
		"echo refreshed > auth.json || exit 16; " +
		"test ! -e \"$HOME/.codex\" || exit 17"
	cmd := exec.Command("bwrap", append(args, "--", "/bin/sh", "-c", script)...)
	cmd.Dir = worktree
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("codex home script: %v: %s", err, out)
	}
	codex := filepath.Join(home, ".codex")
	for name, want := range map[string]string{"auth.json": "refreshed\n", "config.toml": "model = 'x'", "AGENTS.md": "rules", "history.jsonl": "private history", "state_5.sqlite": "host db"} {
		if got, err := os.ReadFile(filepath.Join(codex, name)); err != nil || string(got) != want {
			t.Fatalf("host %s = %q, %v; want %q", name, got, err, want)
		}
	}
	if _, err := os.Stat(filepath.Join(codex, "sessions", "a.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("run session reached the host sessions: %v", err)
	}
}

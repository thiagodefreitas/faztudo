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

func TestComputerHomeBindPrecedesReadOnlyBinds(t *testing.T) {
	hostHome := filepath.Join(t.TempDir(), "host")
	computerHome := filepath.Join(t.TempDir(), "computer-home")
	worktree := filepath.Join(t.TempDir(), "worktree")
	git := filepath.Join(t.TempDir(), "git")
	settings := filepath.Join(hostHome, ".claude", "settings.json")
	for _, dir := range []string{computerHome, worktree, git, filepath.Dir(settings)} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(settings, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: hostHome, ComputerHome: computerHome, CLI: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	bindAt := -1
	settingsAt := -1
	for i := 0; i+2 < len(args); i++ {
		if args[i] == "--bind" && args[i+1] == computerHome && args[i+2] == hostHome {
			bindAt = i
		}
		if args[i] == "--ro-bind" && args[i+1] == filepath.Join(hostHome, ".claude") {
			settingsAt = i
		}
	}
	if bindAt < 0 || settingsAt <= bindAt {
		t.Fatalf("unsafe bind order: %v", args)
	}
	for _, name := range []string{".profile", ".bashrc", ".zshenv"} {
		covered := false
		for i := bindAt; i+2 < len(args); i++ {
			if args[i] == "--ro-bind" && args[i+1] == "/dev/null" && args[i+2] == filepath.Join(hostHome, name) {
				covered = true
			}
		}
		if !covered {
			t.Errorf("%s is not covered after the home bind", name)
		}
	}
}

func TestComputerHomeNestedSourceMounts(t *testing.T) {
	t.Setenv(NestedEnv, "")
	if err := Probe(context.Background(), true); err != nil {
		t.Skip(err)
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	hostHome, err := os.MkdirTemp(userHome, "faztudo-computer-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(hostHome) })
	computerHome := filepath.Join(hostHome, ".local", "share", "faztudo", "computers", "coder", "home")
	worktree := filepath.Join(hostHome, "worktrees", "run")
	git := filepath.Join(hostHome, "repo", ".git")
	state := filepath.Join(hostHome, "runs", "run", "sandbox")
	hostBin := filepath.Join(hostHome, ".local", "bin")
	for _, dir := range []string{computerHome, worktree, git, state, hostBin, filepath.Join(computerHome, ".local", "bin")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for path, body := range map[string]string{filepath.Join(computerHome, "persisted"): "home", filepath.Join(worktree, "project-file"): "worktree", filepath.Join(state, "state-file"): "state"} {
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(hostBin, "trusted"), []byte("host"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(computerHome, ".local", "bin", "planted"), []byte("agent"), 0600); err != nil {
		t.Fatal(err)
	}
	pin := filepath.Join(filepath.Dir(state), "computer-gitconfig")
	if err := os.WriteFile(pin, []byte("[core]\n hooksPath=/dev/null\n"), 0600); err != nil {
		t.Fatal(err)
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: hostHome, ComputerHome: computerHome, StateDir: state, Network: true, ReadOnly: []string{hostBin, pin}})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bwrap", append(args, "--", "/bin/sh", "-c", `test -f "$HOME/persisted" && test -f "$PWD/project-file" && test -f "`+state+`/state-file" && test -f "$HOME/.local/bin/trusted" && test ! -e "$HOME/.local/bin/planted" && ! (echo planted > "`+pin+`" 2>/dev/null)`)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("computer mounts: %v: %s", err, out)
	}
}

func TestComputerSliceUnitAndScope(t *testing.T) {
	runtimeDir := t.TempDir()
	toolsDir := t.TempDir()
	log := filepath.Join(runtimeDir, "systemctl.log")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + log + "\n"
	if err := os.WriteFile(filepath.Join(toolsDir, "systemctl"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", toolsDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("XDG_RUNTIME_DIR", runtimeDir)
	if err := EnsureComputerSlice(context.Background(), "coder", "2G", 512, "200%"); err != nil {
		t.Fatal(err)
	}
	unit, err := os.ReadFile(filepath.Join(runtimeDir, "systemd", "user", "faztudo-computer-coder.slice"))
	if err != nil || !strings.Contains(string(unit), "MemoryMax=2G") || !strings.Contains(string(unit), "TasksMax=512") || !strings.Contains(string(unit), "CPUQuota=200%") {
		t.Fatalf("unit: %q %v", unit, err)
	}
	args := ComputerScopeArgs("2G", 512, "faztudo-computer-coder.slice", "200%", []string{"/bin/true"})
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--slice=faztudo-computer-coder.slice") || !strings.Contains(joined, "--property=MemoryMax=2G") || !strings.Contains(joined, "--property=CPUQuota=200%") {
		t.Fatalf("scope args: %v", args)
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
	for _, p := range []string{worktree, filepath.Join(git, "objects", "info"), filepath.Join(git, "refs"), filepath.Join(git, "logs"), filepath.Join(git, "worktrees", "run")} {
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
	if !hasBind(args, "--ro-bind", filepath.Join(git, "objects", "info")) {
		t.Fatal("objects/info is writable")
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

func TestSandboxObjectsInfoCannotBeChanged(t *testing.T) {
	if err := Probe(context.Background(), true); err != nil {
		t.Skipf("bubblewrap unavailable: %v", err)
	}
	home, root := t.TempDir(), t.TempDir()
	worktree, git := filepath.Join(root, "run"), filepath.Join(root, "git")
	for _, p := range []string{worktree, filepath.Join(git, "objects", "info")} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "claude", Network: true})
	if err != nil {
		t.Fatal(err)
	}
	script := "if echo bad > '" + filepath.Join(git, "objects", "info", "alternates") + "'; then exit 11; fi; echo object > '" + filepath.Join(git, "objects", "new-object") + "'"
	cmd := exec.Command("bwrap", append(args, "--", "/bin/sh", "-c", script)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("sandbox objects: %v: %s", err, out)
	}
	if _, err := os.Stat(filepath.Join(git, "objects", "info", "alternates")); !os.IsNotExist(err) {
		t.Fatalf("objects/info changed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(git, "objects", "new-object")); err != nil {
		t.Fatalf("object store not writable: %v", err)
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

func TestKimiHasPrivateWritableHome(t *testing.T) {
	home, root := t.TempDir(), t.TempDir()
	worktree, git, state := filepath.Join(root, "run"), filepath.Join(root, "git"), filepath.Join(root, "state")
	kimi := filepath.Join(home, ".kimi-code")
	for _, p := range []string{worktree, git, state, filepath.Join(kimi, "bin"), filepath.Join(kimi, "credentials"), filepath.Join(kimi, "oauth")} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(kimi, "config.toml"), []byte("settings"), 0600); err != nil {
		t.Fatal(err)
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "kimi", StateDir: state})
	if err != nil {
		t.Fatal(err)
	}
	if !hasMount(args, "--bind", filepath.Join(state, "kimi-home"), kimi) {
		t.Fatal("kimi state is not private")
	}
	if !hasMount(args, "--ro-bind", filepath.Join(kimi, "config.toml"), filepath.Join(kimi, "config.toml")) {
		t.Fatal("kimi config is writable")
	}
	if !hasMount(args, "--bind", filepath.Join(kimi, "credentials"), filepath.Join(kimi, "credentials")) {
		t.Fatal("kimi cannot refresh credentials")
	}
}

func TestOpenCodeAuthFollowsPrivateXDGData(t *testing.T) {
	home, root := t.TempDir(), t.TempDir()
	worktree, git, state := filepath.Join(root, "run"), filepath.Join(root, "git"), filepath.Join(root, "state")
	auth := filepath.Join(home, ".local", "share", "opencode", "auth.json")
	config := filepath.Join(home, ".config", "opencode", "opencode.json")
	for _, p := range []string{worktree, git, state, filepath.Dir(auth), filepath.Dir(config)} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(auth, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "opencode", StateDir: state})
	if err != nil {
		t.Fatal(err)
	}
	if !hasMount(args, "--ro-bind", auth, filepath.Join(state, "xdg-data", "opencode", "auth.json")) {
		t.Fatal("OpenCode auth is not read-only in private XDG data")
	}
	if !hasMount(args, "--ro-bind", config, filepath.Join(state, "xdg-config", "opencode", "opencode.json")) {
		t.Fatal("OpenCode config is not read-only in private XDG config")
	}
	if hasBind(args, "--bind", auth) || hasBind(args, "--ro-bind", filepath.Dir(auth)) || hasBind(args, "--ro-bind", filepath.Dir(config)) {
		t.Fatal("OpenCode host state or config directory is exposed")
	}
	if !containsPair(args, "--setenv", "XDG_CONFIG_HOME", filepath.Join(state, "xdg-config")) {
		t.Fatal("OpenCode does not use private XDG config")
	}
}

func containsPair(args []string, flag, key, value string) bool {
	for i := 0; i+2 < len(args); i++ {
		if args[i] == flag && args[i+1] == key && args[i+2] == value {
			return true
		}
	}
	return false
}

func TestKimiPrivateHomeMountsWork(t *testing.T) {
	if err := Probe(context.Background(), true); err != nil {
		t.Skipf("bubblewrap unavailable: %v", err)
	}
	home, root := t.TempDir(), t.TempDir()
	worktree, git, state := filepath.Join(root, "run"), filepath.Join(root, "git"), filepath.Join(root, "state")
	kimi := filepath.Join(home, ".kimi-code")
	for _, p := range []string{worktree, git, state, filepath.Join(kimi, "bin"), filepath.Join(kimi, "credentials")} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(kimi, "config.toml"), []byte("original\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(kimi, "credentials", "token"), []byte("old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "kimi", StateDir: state, Network: true})
	if err != nil {
		t.Fatal(err)
	}
	script := "test \"$(cat " + filepath.Join(kimi, "config.toml") + ")\" = original || exit 11; " +
		"if echo bad > " + filepath.Join(kimi, "config.toml") + "; then exit 12; fi; " +
		"echo new > " + filepath.Join(kimi, "credentials", "token") + "; " +
		"echo private > " + filepath.Join(kimi, "session.db")
	cmd := exec.Command("bwrap", append(args, "--", "/bin/sh", "-c", script)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("kimi mount script: %v: %s", err, out)
	}
	if got, err := os.ReadFile(filepath.Join(kimi, "config.toml")); err != nil || string(got) != "original\n" {
		t.Fatalf("host config changed: %q, %v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(kimi, "credentials", "token")); err != nil || string(got) != "new\n" {
		t.Fatalf("OAuth refresh failed: %q, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(kimi, "session.db")); !os.IsNotExist(err) {
		t.Fatalf("host session changed: %v", err)
	}
}

func TestAgyPrivateHomeMountsWork(t *testing.T) {
	if err := Probe(context.Background(), true); err != nil {
		t.Skipf("bubblewrap unavailable: %v", err)
	}
	home, root := t.TempDir(), t.TempDir()
	worktree, git, state := filepath.Join(root, "run"), filepath.Join(root, "git"), filepath.Join(root, "state")
	agy := filepath.Join(home, ".gemini", "antigravity-cli")
	projects := filepath.Join(home, ".gemini", "config", "projects")
	for _, p := range []string{worktree, git, state, filepath.Join(agy, "bin"), filepath.Join(agy, "conversations"), projects} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(agy, "settings.json"), []byte("original\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(agy, "antigravity-oauth-token"), []byte("old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(agy, "bin", "encoder"), []byte("tool\n"), 0700); err != nil {
		t.Fatal(err)
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: home, CLI: "agy", StateDir: state, Network: true})
	if err != nil {
		t.Fatal(err)
	}
	if !hasMount(args, "--bind", filepath.Join(state, "agy-home"), agy) {
		t.Fatal("agy home not private")
	}
	if !hasMount(args, "--bind", filepath.Join(state, "agy-projects"), projects) {
		t.Fatal("agy project config not private")
	}
	script := "test \"$(cat " + filepath.Join(agy, "settings.json") + ")\" = original || exit 11; " +
		"if echo bad > " + filepath.Join(agy, "settings.json") + "; then exit 12; fi; " +
		"echo new > " + filepath.Join(agy, "antigravity-oauth-token") + "; " +
		"echo private > " + filepath.Join(agy, "conversations", "new.json") + "; " +
		"echo private > " + filepath.Join(projects, "new.json") + "; " +
		"echo launcher > " + filepath.Join(agy, "bin", "agentapi") + " || exit 13; " +
		"test \"$(cat " + filepath.Join(agy, "bin", "encoder") + ")\" = tool || exit 14; " +
		"if echo bad > " + filepath.Join(agy, "bin", "encoder") + "; then exit 15; fi"
	cmd := exec.Command("bwrap", append(args, "--", "/bin/sh", "-c", script)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("agy mount script: %v: %s", err, out)
	}
	if _, err := os.Stat(filepath.Join(agy, "bin", "agentapi")); !os.IsNotExist(err) {
		t.Fatalf("host agy bin changed: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(agy, "bin", "encoder")); err != nil || string(got) != "tool\n" {
		t.Fatalf("host agy tool changed: %q, %v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(agy, "settings.json")); err != nil || string(got) != "original\n" {
		t.Fatalf("host settings changed: %q, %v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(agy, "antigravity-oauth-token")); err != nil || string(got) != "new\n" {
		t.Fatalf("OAuth refresh failed: %q, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(agy, "conversations", "new.json")); !os.IsNotExist(err) {
		t.Fatalf("host conversation changed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projects, "new.json")); !os.IsNotExist(err) {
		t.Fatalf("host project config changed: %v", err)
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

func TestProbeRefusesInsideASandbox(t *testing.T) {
	t.Setenv(NestedEnv, "1")
	if err := Probe(context.Background(), true); err == nil {
		t.Fatal("Probe accepted a nested sandbox")
	}
}

func TestBuildMarksTheSandboxForNestedProbes(t *testing.T) {
	dir := t.TempDir()
	worktree, git := filepath.Join(dir, "w"), filepath.Join(dir, "g")
	for _, p := range []string{worktree, git} {
		if err := os.MkdirAll(p, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	args, err := Build(Options{Worktree: worktree, GitDir: git, Home: dir, StateDir: filepath.Join(dir, "s")})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(args, " "), "--setenv "+NestedEnv+" 1") {
		t.Fatalf("sandbox does not set %s: %v", NestedEnv, args)
	}
}

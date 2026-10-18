package runner

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/eventstest"
	"github.com/thiagodefreitas/faztudo/internal/lanes"
	"github.com/thiagodefreitas/faztudo/internal/sandbox"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

type fakeAdapter struct{ path string }

func (a fakeAdapter) Name() string { return "fake" }
func (a fakeAdapter) Command(r adapters.Request) (adapters.Cmd, error) {
	c := adapters.Cmd{Path: a.path, Dir: r.Workdir}
	for _, k := range []string{"FAKE_CHILD_PID_FILE", "FAKE_SLEEP_MS", "FAKE_EXIT", "FAKE_COUNT_FILE", "FAKE_STDERR", "FAKE_STDOUT", "FAKE_WRITE_FILE", "FAKE_WRITE_CONTENT", "FAKE_LONG_LINE"} {
		if v, ok := os.LookupEnv(k); ok {
			if c.EnvAdd == nil {
				c.EnvAdd = map[string]string{}
			}
			c.EnvAdd[k] = v
			c.EnvAllow = append(c.EnvAllow, k)
		}
	}
	return c, nil
}
func (a fakeAdapter) Classify(code int, s string) (domain.FailureClass, adapters.LaneSignal, string) {
	return (adapters.Codex{}).Classify(code, s)
}

func fakeBinary(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "fakecli")
	cmd := exec.Command("go", "build", "-o", p, "../adapters/testdata/fakecli")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s: %v", out, err)
	}
	return p
}
func TestConfigFileSurvivesRetries(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "mcp.json")
	if err := os.WriteFile(target, []byte("synthetic"), 0600); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dir, "tried")
	script := filepath.Join(dir, "tool.sh")
	body := "#!/bin/sh\nset -eu\ntest -f \"$1\"\nif test -f \"$2\"; then\n  exit 0\nfi\ntouch \"$2\"\necho 'HTTP 503' >&2\nexit 1\n"
	if err := os.WriteFile(script, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	r := Runner{RunDir: dir, Backoff: []time.Duration{time.Millisecond}}
	run := domain.Run{ID: "retry1", Mode: domain.RunRead, State: domain.RunQueued, LaneID: "lane"}
	err := r.Execute(context.Background(), &run, removeAdapter{script: script, target: target, marker: marker}, adapters.Request{Mode: domain.RunRead, Workdir: dir, Prompt: "x"})
	if err != nil || run.State != domain.RunDone {
		t.Fatalf("%v %s", err, run.State)
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Fatal("config file still present")
	}
	if _, statErr := os.Stat(marker); statErr != nil {
		t.Fatal(statErr)
	}
}

type removeAdapter struct{ script, target, marker string }

func (a removeAdapter) Name() string { return "fake" }
func (a removeAdapter) Command(adapters.Request) (adapters.Cmd, error) {
	return adapters.Cmd{Path: a.script, Args: []string{a.target, a.marker}, Remove: []string{a.target}}, nil
}
func (a removeAdapter) Classify(code int, tail string) (domain.FailureClass, adapters.LaneSignal, string) {
	return (adapters.Codex{}).Classify(code, tail)
}

func TestTransitionsAndCapacity(t *testing.T) {
	if err := Transition(domain.RunQueued, domain.RunRunning); err != nil {
		t.Fatal(err)
	}
	if err := Transition(domain.RunDone, domain.RunRunning); err == nil {
		t.Fatal("accepted illegal transition")
	}
	c := NewCapacity(map[string]int{"a": 1, "b": 1})
	if err := c.Acquire("a", "b"); err != nil {
		t.Fatal(err)
	}
	if err := c.Acquire("a"); err == nil {
		t.Fatal("accepted full lane")
	}
	c.Release("a", "b")
	if err := c.Acquire("a"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := c.WaitAcquire(ctx, "a", "b"); err == nil {
		t.Fatal("acquired while a is full")
	}
	c.Release("a")
	if err := c.WaitAcquire(context.Background(), "a", "b"); err != nil {
		t.Fatal(err)
	}
}
func TestTimeoutKillsGrandchild(t *testing.T) {
	path := fakeBinary(t)
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "child.pid")
	log := &eventstest.Appender{}
	r := Runner{RunDir: dir, Appender: log, Grace: 20 * time.Millisecond}
	old := os.Getenv("FAKE_CHILD_PID_FILE")
	t.Setenv("FAKE_CHILD_PID_FILE", pidFile)
	t.Setenv("FAKE_SLEEP_MS", "5000")
	defer os.Setenv("FAKE_CHILD_PID_FILE", old)
	run := domain.Run{ID: "timeout", Mode: domain.RunRead, State: domain.RunQueued}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()
	if err := r.Execute(ctx, &run, fakeAdapter{path}, adapters.Request{Mode: domain.RunRead, Workdir: dir, Prompt: "x"}); err == nil {
		t.Fatal("timeout succeeded")
	}
	if run.State != domain.RunFailed {
		t.Fatal(run.State)
	}
	data, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(string(data))
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("grandchild %d still alive", pid)
}
func TestCancelAndCrash(t *testing.T) {
	path := fakeBinary(t)
	dir := t.TempDir()
	r := Runner{RunDir: dir, Grace: 20 * time.Millisecond}
	t.Setenv("FAKE_SLEEP_MS", "5000")
	run := domain.Run{ID: "cancel", Mode: domain.RunRead, State: domain.RunQueued}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(80 * time.Millisecond); cancel() }()
	if err := r.Execute(ctx, &run, fakeAdapter{path}, adapters.Request{Mode: domain.RunRead, Workdir: dir, Prompt: "x"}); err == nil || run.State != domain.RunCancelled {
		t.Fatalf("%v %s", err, run.State)
	}
	t.Setenv("FAKE_SLEEP_MS", "")
	t.Setenv("FAKE_EXIT", "3")
	crash := domain.Run{ID: "crash", Mode: domain.RunRead, State: domain.RunQueued}
	if err := r.Execute(context.Background(), &crash, fakeAdapter{path}, adapters.Request{Mode: domain.RunRead, Workdir: dir, Prompt: "x"}); err == nil || crash.State != domain.RunFailed {
		t.Fatalf("%v %s", err, crash.State)
	}
	duplicate := domain.Run{ID: "crash", Mode: domain.RunRead, State: domain.RunQueued}
	if err := r.Execute(context.Background(), &duplicate, fakeAdapter{path}, adapters.Request{Mode: domain.RunRead, Workdir: dir, Prompt: "x"}); err == nil {
		t.Fatal("accepted duplicate run id")
	}
}
func TestRecoveryIdentity(t *testing.T) {
	path := fakeBinary(t)
	dir := t.TempDir()
	cmd := exec.Command(path)
	cmd.Env = append(os.Environ(), "FAKE_SLEEP_MS=5000")
	cmd.SysProcAttr = processGroup()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { killGroup(cmd.Process.Pid, 0); cmd.Wait() }()
	start, err := startTime(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{RunDir: dir, Capacity: NewCapacity(map[string]int{"lane": 1})}
	meta := Metadata{Run: domain.Run{ID: "live", LaneID: "lane", State: domain.RunRunning}, PID: cmd.Process.Pid, PGID: cmd.Process.Pid, StartTime: start}
	if err := r.save(meta); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	recovered, err := r.Recover(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(recovered) != 1 || recovered[0].State != domain.RunRunning {
		t.Fatalf("%+v", recovered)
	}
	if err := r.Capacity.Acquire("lane"); err == nil {
		t.Fatal("recovery did not reserve lane capacity")
	}
	meta.Run.ID = "stale"
	meta.StartTime = "wrong"
	if err := r.save(meta); err != nil {
		t.Fatal(err)
	}
	recovered, err = r.Recover(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(recovered) != 2 || recovered[1].State != domain.RunFailed {
		t.Fatalf("%+v", recovered)
	}
	if recovered[1].FailureClass != domain.FailureTransient || recovered[1].FailureReason != "outcome unknown after daemon restart" {
		t.Fatalf("stale recovery: %+v", recovered[1])
	}
	if !processAlive(cmd.Process.Pid) {
		t.Fatal("killed reused process")
	}
}

func TestCancelRecoveredRun(t *testing.T) {
	path := fakeBinary(t)
	dir := t.TempDir()
	cmd := exec.Command(path)
	cmd.Env = append(os.Environ(), "FAKE_SLEEP_MS=5000")
	cmd.SysProcAttr = processGroup()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { killGroup(cmd.Process.Pid, 0); cmd.Wait() }()
	start, err := startTime(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{RunDir: dir, Grace: 10 * time.Millisecond}
	meta := Metadata{Run: domain.Run{ID: "recovered", State: domain.RunRunning}, PID: cmd.Process.Pid, PGID: cmd.Process.Pid, StartTime: start}
	if err := r.save(meta); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !r.CancelRecovered("recovered") {
		t.Fatal("recovered run was not cancellable")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		m, err := r.load("recovered")
		if err == nil && m.Run.State == domain.RunCancelled {
			if processAlive(cmd.Process.Pid) {
				t.Fatal("cancelled process is still alive")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("recovered run was not cancelled")
}

func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	c := exec.Command("git", args...)
	c.Dir = dir
	out, err := c.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %s %v", args, out, err)
	}
	return strings.TrimSpace(string(out))
}
func TestExecuteWriteVerification(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	os.Mkdir(repo, 0700)
	gitRun(t, repo, "init", "-q")
	os.WriteFile(filepath.Join(repo, "file.txt"), []byte("old\n"), 0600)
	gitRun(t, repo, "add", "file.txt")
	tree := gitRun(t, repo, "write-tree")
	base := gitRun(t, repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", tree, "-m", "base")
	gitRun(t, repo, "update-ref", "HEAD", base)
	path := fakeBinary(t)
	r := Runner{RunDir: filepath.Join(root, "runs")}
	m := worktree.Manager{BaseDir: filepath.Join(root, "trees")}
	for _, tc := range []struct {
		id, verify string
		wantOK     bool
	}{{"pass", "test -f added.txt", true}, {"fail", "exit 7", false}, {"mutates", "printf changed >> added.txt", false}} {
		t.Setenv("FAKE_WRITE_FILE", filepath.Join(m.BaseDir, tc.id, "added.txt"))
		t.Setenv("FAKE_WRITE_CONTENT", "hello\n")
		run := domain.Run{ID: tc.id, Mode: domain.RunWrite, State: domain.RunQueued}
		err := r.ExecuteWrite(context.Background(), &run, fakeAdapter{path}, adapters.Request{Mode: domain.RunWrite, Prompt: "x"}, WriteOptions{Repo: repo, Worktrees: m, TestCommand: tc.verify, TestTimeout: time.Second})
		if tc.wantOK && (err != nil || run.State != domain.RunWaitingApproval || run.DiffStat == nil || run.DiffStat.Files != 1) {
			t.Fatalf("%s: %+v %v", tc.id, run, err)
		}
		if !tc.wantOK && (err == nil || run.State != domain.RunFailed || run.FailureClass != domain.FailureSemantic) {
			t.Fatalf("%s: %+v %v", tc.id, run, err)
		}
	}
}

type sandboxShell struct{ script string }

func (sandboxShell) Name() string { return "sh" }
func (a sandboxShell) Command(r adapters.Request) (adapters.Cmd, error) {
	script := a.script
	if script == "" {
		script = "printf new > file.txt; git status --short >/dev/null"
	}
	return adapters.Cmd{Path: "/bin/bash", Args: []string{"-c", script}, Dir: r.Workdir}, nil
}
func (sandboxShell) Classify(code int, tail string) (domain.FailureClass, adapters.LaneSignal, string) {
	return (adapters.Codex{}).Classify(code, tail)
}

func TestExecuteWriteInSandbox(t *testing.T) {
	if err := sandbox.Probe(context.Background(), true); err != nil {
		t.Skipf("bubblewrap or user namespaces unavailable: %v", err)
	}
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	gitRun(t, repo, "init", "-q")
	if err := os.WriteFile(filepath.Join(repo, "file.txt"), []byte("old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitRun(t, repo, "add", "file.txt")
	tree := gitRun(t, repo, "write-tree")
	base := gitRun(t, repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", tree, "-m", "base")
	gitRun(t, repo, "update-ref", "HEAD", base)
	r := Runner{RunDir: filepath.Join(root, "runs"), Backoff: []time.Duration{}}
	run := domain.Run{ID: "sandbox", Mode: domain.RunWrite, State: domain.RunQueued}
	err := r.ExecuteWrite(context.Background(), &run, sandboxShell{}, adapters.Request{Mode: domain.RunWrite, Prompt: "x"}, WriteOptions{
		Repo: repo, Worktrees: worktree.Manager{BaseDir: filepath.Join(root, "trees")}, SandboxMode: "required", Network: true,
	})
	if err != nil || run.State != domain.RunWaitingApproval {
		t.Fatalf("sandboxed write: %+v: %v", run, err)
	}
	timed := domain.Run{ID: "timeout", Mode: domain.RunWrite, State: domain.RunQueued}
	err = r.ExecuteWrite(context.Background(), &timed, sandboxShell{script: "sleep 1; printf leaked > leaked.txt"}, adapters.Request{Mode: domain.RunWrite, Prompt: "x", Timeout: 100 * time.Millisecond}, WriteOptions{
		Repo: repo, Worktrees: worktree.Manager{BaseDir: filepath.Join(root, "trees")}, SandboxMode: "required", Network: true,
	})
	if err == nil || timed.State != domain.RunFailed {
		t.Fatalf("sandboxed timeout: %+v: %v", timed, err)
	}
	time.Sleep(1200 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(timed.Worktree, "leaked.txt")); !os.IsNotExist(err) {
		t.Fatalf("sandboxed child outlived timeout: %v", err)
	}
}

func TestSandboxedVerificationCannotReadHostFile(t *testing.T) {
	if err := sandbox.Probe(context.Background(), true); err != nil {
		t.Skipf("bubblewrap unavailable: %v", err)
	}
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	gitRun(t, repo, "init", "-q")
	if err := os.WriteFile(filepath.Join(repo, "file.txt"), []byte("old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitRun(t, repo, "add", "file.txt")
	gitRun(t, repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "base")
	secret := filepath.Join(root, "secret")
	if err := os.WriteFile(secret, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SECRET_IN_HOST", "yes")
	r := Runner{RunDir: filepath.Join(root, "runs"), Backoff: []time.Duration{}}
	run := domain.Run{ID: "verify", Mode: domain.RunWrite, State: domain.RunQueued}
	err := r.ExecuteWrite(context.Background(), &run, sandboxShell{script: "printf new > file.txt"}, adapters.Request{Mode: domain.RunWrite, Prompt: "x"}, WriteOptions{
		Repo: repo, Worktrees: worktree.Manager{BaseDir: filepath.Join(root, "trees")}, SandboxMode: "required", Network: true,
		TestCommand: "test ! -r " + secret + " && test -z \"${SECRET_IN_HOST:-}\"",
	})
	if err != nil || run.State != domain.RunWaitingApproval {
		t.Fatalf("verification escaped sandbox: %v, %s", err, run.State)
	}
}

type toolchainCLI struct{ name string }

func (a toolchainCLI) Name() string { return a.name }
func (a toolchainCLI) Command(r adapters.Request) (adapters.Cmd, error) {
	return adapters.Cmd{Path: a.name, Args: []string{"--version"}, Dir: r.Workdir}, nil
}
func (a toolchainCLI) Classify(code int, tail string) (domain.FailureClass, adapters.LaneSignal, string) {
	return (adapters.Codex{}).Classify(code, tail)
}

func TestSandboxedWriteRunHasGoAndNpmToolchains(t *testing.T) {
	if err := sandbox.Probe(context.Background(), true); err != nil {
		t.Skipf("bubblewrap unavailable: %v", err)
	}
	if _, err := exec.LookPath("npm"); err != nil {
		t.Skipf("npm unavailable: %v", err)
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skipf("go unavailable: %v", err)
	}
	for _, cli := range []string{"claude", "codex"} {
		t.Run(cli, func(t *testing.T) {
			if _, err := exec.LookPath(cli); err != nil {
				t.Skipf("%s unavailable: %v", cli, err)
			}
			root := t.TempDir()
			repo := filepath.Join(root, "repo")
			if err := os.Mkdir(repo, 0700); err != nil {
				t.Fatal(err)
			}
			gitRun(t, repo, "init", "-q")
			for name, body := range map[string]string{
				"go.mod":          "module example.invalid/fixture\n\ngo 1.25.0\n",
				"fixture_test.go": "package fixture\nimport \"testing\"\nfunc TestFixture(t *testing.T) {}\n",
				"package.json":    `{"scripts":{"test":"node -e \"process.exit(0)\""}}`,
			} {
				if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0600); err != nil {
					t.Fatal(err)
				}
			}
			gitRun(t, repo, "add", ".")
			gitRun(t, repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "base")
			r := Runner{RunDir: filepath.Join(root, "runs"), Backoff: []time.Duration{}}
			run := domain.Run{ID: cli, Mode: domain.RunWrite, State: domain.RunQueued}
			err := r.ExecuteWrite(context.Background(), &run, toolchainCLI{name: cli}, adapters.Request{Mode: domain.RunWrite, Prompt: "check", Timeout: 20 * time.Second}, WriteOptions{
				Repo: repo, Worktrees: worktree.Manager{BaseDir: filepath.Join(root, "trees")}, SandboxMode: "required", Network: true,
				TestCommand: "go test ./... && npm test", TestTimeout: 30 * time.Second,
			})
			if err != nil || run.State != domain.RunDone {
				t.Fatalf("%s sandboxed toolchains: %v, %s", cli, err, run.State)
			}
			if _, err := os.Stat(filepath.Join(root, "runs", cli, "sandbox")); !os.IsNotExist(err) {
				t.Fatalf("per-run cache and session state were retained: %v", err)
			}
		})
	}
}

func TestLiveSandboxedCLIWriteRun(t *testing.T) {
	if os.Getenv("FAZTUDO_LIVE_SANDBOX") != "1" {
		t.Skip("set FAZTUDO_LIVE_SANDBOX=1 for model-backed smoke test")
	}
	if err := sandbox.Probe(context.Background(), true); err != nil {
		t.Skipf("bubblewrap unavailable: %v", err)
	}
	if _, err := exec.LookPath("npm"); err != nil {
		t.Skipf("npm unavailable: %v", err)
	}
	for _, tc := range []struct {
		name    string
		adapter adapters.Adapter
	}{{"claude", adapters.Claude{}}, {"codex", adapters.Codex{}}} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := exec.LookPath(tc.name); err != nil {
				t.Skipf("%s unavailable: %v", tc.name, err)
			}
			root := t.TempDir()
			repo := filepath.Join(root, "repo")
			if err := os.Mkdir(repo, 0700); err != nil {
				t.Fatal(err)
			}
			gitRun(t, repo, "init", "-q")
			for name, body := range map[string]string{
				"go.mod":          "module example.invalid/fixture\n\ngo 1.25.0\n",
				"fixture_test.go": "package fixture\nimport \"testing\"\nfunc TestFixture(t *testing.T) {}\n",
				"package.json":    `{"scripts":{"test":"node -e \"process.exit(0)\""}}`,
				"README.md":       "Before.\n",
			} {
				if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0600); err != nil {
					t.Fatal(err)
				}
			}
			gitRun(t, repo, "add", ".")
			gitRun(t, repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "base")
			r := Runner{RunDir: filepath.Join(root, "runs"), Backoff: []time.Duration{}}
			run := domain.Run{ID: tc.name, Mode: domain.RunWrite, State: domain.RunQueued}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer cancel()
			err := r.ExecuteWrite(ctx, &run, tc.adapter, adapters.Request{Mode: domain.RunWrite, Prompt: "Change README.md to say After. Run go test ./... and npm test. Do not commit.", Timeout: 2 * time.Minute}, WriteOptions{
				Repo: repo, Worktrees: worktree.Manager{BaseDir: filepath.Join(root, "trees")}, SandboxMode: "required", Network: true,
				TestCommand: "go test ./... && npm test", TestTimeout: time.Minute,
			})
			if err != nil || run.State != domain.RunWaitingApproval {
				t.Fatalf("%s live write: %v, state=%s, reason=%s", tc.name, err, run.State, run.FailureReason)
			}
		})
	}
}
func TestRetryAndSanitizedEnv(t *testing.T) {
	path := fakeBinary(t)
	dir := t.TempDir()
	count := filepath.Join(dir, "count")
	t.Setenv("FAKE_COUNT_FILE", count)
	t.Setenv("FAKE_STDERR", "HTTP 503")
	t.Setenv("FAKE_EXIT", "1")
	r := Runner{RunDir: dir, Backoff: []time.Duration{time.Millisecond, time.Millisecond}}
	run := domain.Run{ID: "retry", Mode: domain.RunRead, State: domain.RunQueued}
	if err := r.Execute(context.Background(), &run, fakeAdapter{path}, adapters.Request{Mode: domain.RunRead, Prompt: "x", Workdir: dir}); err == nil {
		t.Fatal("retry succeeded")
	}
	b, err := os.ReadFile(count)
	if err != nil || len(b) != 3 {
		t.Fatalf("attempts %q %v", b, err)
	}
	got := stripEnv([]string{"PATH=/bin", "ANTHROPIC_API_KEY=secret", "AWS_ACCESS_KEY_ID=secret", "GH_TOKEN=secret", "MY_TOKEN=secret", "OK=yes"}, []string{"OK"}, map[string]string{"MY_SECRET": "bad", "GOOD": "value"})
	if len(got) != 1 || got[0] != "PATH=/bin" {
		t.Fatalf("environment: %q", got)
	}
}

func TestEnvironmentAllowlist(t *testing.T) {
	got := stripEnv([]string{"PATH=/bin", "HOME=/tmp/home", "LANG=C", "LC_ALL=C", "XDG_CONFIG_HOME=/tmp/config", "SSH_AUTH_SOCK=/tmp/agent", "GOOGLE_APPLICATION_CREDENTIALS=/tmp/key", "GIT_ASKPASS=/tmp/askpass", "CUSTOM_PASSWORD=secret"}, nil, nil)
	want := []string{"PATH=/bin", "HOME=/tmp/home", "LANG=C", "LC_ALL=C", "XDG_CONFIG_HOME=/tmp/config"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("child environment: %q, want %q", got, want)
	}
	got = stripEnv([]string{"CODEX_HOME=/tmp/codex", "CLAUDE_CONFIG_DIR=/tmp/claude", "ANTHROPIC_API_KEY=secret"}, nil, nil, "CODEX_HOME")
	if len(got) != 1 || got[0] != "CODEX_HOME=/tmp/codex" {
		t.Fatalf("adapter environment: %q", got)
	}
}

func TestCancelDuringBackoffDoesNotRetry(t *testing.T) {
	path := fakeBinary(t)
	dir := t.TempDir()
	count := filepath.Join(dir, "count")
	t.Setenv("FAKE_COUNT_FILE", count)
	t.Setenv("FAKE_STDERR", "HTTP 503")
	t.Setenv("FAKE_EXIT", "1")
	r := Runner{RunDir: dir, Backoff: []time.Duration{time.Second}, Grace: 300 * time.Millisecond}
	run := domain.Run{ID: "backoff", Mode: domain.RunRead, State: domain.RunQueued}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- r.Execute(ctx, &run, fakeAdapter{path}, adapters.Request{Mode: domain.RunRead, Prompt: "x", Workdir: dir})
	}()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(count); err == nil && len(b) == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if b, err := os.ReadFile(count); err != nil || len(b) != 1 {
		cancel()
		t.Fatalf("first attempt: %q %v", b, err)
	}
	time.Sleep(100 * time.Millisecond)
	startedCancel := time.Now()
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("cancel did not finish")
	}
	b, err := os.ReadFile(count)
	if err != nil || len(b) != 1 || run.State != domain.RunCancelled {
		t.Fatalf("cancel state %s, attempts %q: %v", run.State, b, err)
	}
	if elapsed := time.Since(startedCancel); elapsed > 200*time.Millisecond {
		t.Fatalf("cancel during backoff took %s; a new attempt may have started", elapsed)
	}
}

func TestDaemonKilledMidRun(t *testing.T) {
	if os.Getenv("FAZTUDO_TEST_DAEMON") == "1" {
		r := Runner{RunDir: os.Getenv("FAZTUDO_TEST_RUN_DIR")}
		run := domain.Run{ID: "orphan", Mode: domain.RunRead, State: domain.RunQueued}
		_ = r.Execute(context.Background(), &run, fakeAdapter{os.Getenv("FAZTUDO_TEST_CLI")}, adapters.Request{Mode: domain.RunRead, Prompt: "x", Workdir: os.Getenv("FAZTUDO_TEST_RUN_DIR")})
		return
	}
	root := t.TempDir()
	path := fakeBinary(t)
	dir := filepath.Join(root, "runs")
	helper := exec.Command(os.Args[0], "-test.run=^TestDaemonKilledMidRun$")
	helper.Env = append(os.Environ(), "FAZTUDO_TEST_DAEMON=1", "FAZTUDO_TEST_CLI="+path, "FAZTUDO_TEST_RUN_DIR="+dir, "FAKE_SLEEP_MS=1000", "FAKE_STDOUT=recovered-output")
	if err := helper.Start(); err != nil {
		t.Fatal(err)
	}
	r := Runner{RunDir: dir}
	deadline := time.Now().Add(time.Second)
	var meta Metadata
	for time.Now().Before(deadline) {
		m, err := r.load("orphan")
		if err == nil && m.PID > 0 {
			meta = m
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if meta.PID == 0 {
		helper.Process.Kill()
		helper.Wait()
		t.Fatal("child metadata was not written")
	}
	helper.Process.Kill()
	helper.Wait()
	defer cleanupGroup(meta.PGID, meta.StartTime, 0)
	if !processAlive(meta.PID) {
		t.Fatal("child died with daemon")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	recovered, err := r.Recover(ctx)
	if err != nil || len(recovered) != 1 || recovered[0].State != domain.RunRunning {
		t.Fatalf("%+v %v", recovered, err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		m, err := r.load("orphan")
		if err == nil && m.Run.State == domain.RunFailed {
			if m.Run.FailureClass != domain.FailureTransient || m.Run.FailureReason != "outcome unknown after daemon restart" {
				t.Fatalf("recovery classification: %s %q", m.Run.FailureClass, m.Run.FailureReason)
			}
			b, err := os.ReadFile(filepath.Join(dir, "orphan", "stdout.log"))
			if err != nil || !strings.Contains(string(b), "recovered-output") {
				t.Fatalf("output %q %v", b, err)
			}
			if m.OutputSeq < 1 || m.OutputOffsets["stdout"] == 0 {
				t.Fatalf("output cursor not saved: %+v", m)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("recovered run did not finish")
}

func TestQuotaSwitchesNextPick(t *testing.T) {
	path := fakeBinary(t)
	dir := t.TempDir()
	t.Setenv("FAKE_STDERR", "HTTP 402 quota exceeded")
	t.Setenv("FAKE_EXIT", "1")
	log := &eventstest.Appender{}
	registry, err := lanes.New([]lanes.LaneConfig{{ID: "codex/default", Capacity: 1}, {ID: "claude/opus", Capacity: 1}}, []lanes.PersonaConfig{{Handle: "coder", Lanes: []string{"codex/default", "claude/opus"}}}, log)
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{RunDir: dir, Appender: log, Lanes: registry, PersonaForRun: func(domain.Run) string { return "coder" }}
	run := domain.Run{ID: "quota", ChannelID: "channel", LaneID: "codex/default", Mode: domain.RunRead, State: domain.RunQueued}
	if err := r.Execute(context.Background(), &run, fakeAdapter{path}, adapters.Request{Mode: domain.RunRead, Prompt: "x", Workdir: dir}); err == nil {
		t.Fatal("quota run succeeded")
	}
	next, skipped, err := registry.Pick("coder", "")
	if err != nil || next.ID != "claude/opus" || len(skipped) != 1 {
		t.Fatalf("%+v %+v %v", next, skipped, err)
	}
	var switched, notice bool
	for _, d := range log.Snapshot() {
		if d.Type == "lane.switched" && d.ChannelID == "channel" {
			switched = true
		}
		if d.Type == "notice" && d.ChannelID == "channel" {
			notice = true
		}
	}
	if !switched || !notice {
		t.Fatalf("missing switch or notice: %+v", log.Snapshot())
	}
}

func TestOutputLinesBoundedAndSequenced(t *testing.T) {
	path := fakeBinary(t)
	dir := t.TempDir()
	t.Setenv("FAKE_LONG_LINE", "40000")
	log := &eventstest.Appender{}
	r := Runner{RunDir: dir, Appender: log}
	run := domain.Run{ID: "output", ChannelID: "room", Mode: domain.RunRead, State: domain.RunQueued}
	if err := r.Execute(context.Background(), &run, fakeAdapter{path}, adapters.Request{Mode: domain.RunRead, Prompt: "x", Workdir: dir}); err != nil {
		t.Fatal(err)
	}
	seq := 0
	total := 0
	for _, d := range log.Snapshot() {
		if d.Type != events.RunOutput {
			continue
		}
		p, ok := d.Payload.(events.RunOutputPayload)
		if !ok {
			t.Fatal("wrong payload")
		}
		seq++
		total += len(p.Text)
		if len(p.Text) > 16*1024 || p.Seq != seq || d.ChannelID != "room" {
			t.Fatalf("event %+v", p)
		}
	}
	if total != 40001 {
		t.Fatalf("output bytes %d", total)
	}
}

type agyFake struct{ fakeAdapter }

func (a agyFake) ClassifyOutput(code int, stdout, stderr string) (domain.FailureClass, adapters.LaneSignal, string) {
	return (adapters.Agy{}).ClassifyOutput(code, stdout, stderr)
}

func TestAgyQuotaWithExitZeroExhaustsLane(t *testing.T) {
	path := fakeBinary(t)
	dir := t.TempDir()
	t.Setenv("FAKE_STDOUT", `AGY_ERROR {"error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h54m14s"}`)
	t.Setenv("FAKE_EXIT", "0")
	log := &eventstest.Appender{}
	registry, err := lanes.New([]lanes.LaneConfig{{ID: "agy/opus", Capacity: 1}, {ID: "codex/default", Capacity: 1}}, []lanes.PersonaConfig{{Handle: "coder", Lanes: []string{"agy/opus", "codex/default"}}}, log)
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{RunDir: dir, Appender: log, Lanes: registry, PersonaForRun: func(domain.Run) string { return "coder" }}
	run := domain.Run{ID: "agyq", ChannelID: "channel", LaneID: "agy/opus", Mode: domain.RunRead, State: domain.RunQueued}
	if err := r.Execute(context.Background(), &run, agyFake{fakeAdapter{path}}, adapters.Request{Mode: domain.RunRead, Prompt: "x", Workdir: dir}); err == nil {
		t.Fatal("exhausted run reported success")
	}
	if run.State != domain.RunFailed || run.FailureClass != domain.FailureSemantic {
		t.Fatalf("%s %s", run.State, run.FailureClass)
	}
	l, _ := registry.Snapshot("agy/opus")
	if l.Health != domain.LaneExhausted {
		t.Fatalf("lane %s", l.Health)
	}
	next, _, err := registry.Pick("coder", "")
	if err != nil || next.ID != "codex/default" {
		t.Fatalf("%+v %v", next, err)
	}
}

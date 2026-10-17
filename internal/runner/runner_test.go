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
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

type fakeAdapter struct{ path string }

func (a fakeAdapter) Name() string { return "fake" }
func (a fakeAdapter) Command(r adapters.Request) (adapters.Cmd, error) {
	return adapters.Cmd{Path: a.path, Dir: r.Workdir}, nil
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
	if !processAlive(cmd.Process.Pid) {
		t.Fatal("killed reused process")
	}
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
	if len(got) != 2 || got[0] != "PATH=/bin" || got[1] != "GOOD=value" {
		t.Fatalf("environment: %q", got)
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

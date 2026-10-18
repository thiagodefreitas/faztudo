package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/app"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

type fakeCodex struct{ path string }

func (fakeCodex) Name() string { return "codex" }
func (a fakeCodex) Command(r adapters.Request) (adapters.Cmd, error) {
	c, err := (adapters.Codex{}).Command(r)
	c.Path = a.path
	return c, err
}
func (fakeCodex) Classify(code int, tail string) (domain.FailureClass, adapters.LaneSignal, string) {
	return (adapters.Codex{}).Classify(code, tail)
}

func setupWire(t *testing.T, c config.Config) (*store.Store, *app.App, *httptest.Server, config.Paths) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	t.Setenv("USER", "tester")
	p := config.PathsFromEnv()
	s, err := store.Open(p.DBFile)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	humanID, err := seed(context.Background(), s, c)
	if err != nil {
		t.Fatal(err)
	}
	a, err := app.New(context.Background(), s, c, p)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	h := api.New(s, humanID, "test")
	a.Bind(h)
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return s, a, srv, p
}

func requestJSON(t *testing.T, method, url, body string, want int, out any) {
	t.Helper()
	req, err := http.NewRequest(method, url, bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != want {
		var detail any
		_ = json.NewDecoder(res.Body).Decode(&detail)
		t.Fatalf("%s %s: status %d, want %d: %v", method, url, res.StatusCode, want, detail)
	}
	if out != nil {
		if err := json.NewDecoder(res.Body).Decode(out); err != nil {
			t.Fatal(err)
		}
	}
}

func gitTest(t *testing.T, dir string, args ...string) string {
	t.Helper()
	c := exec.Command("git", args...)
	c.Dir = dir
	out, err := c.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func waitFor[T any](t *testing.T, read func() (T, bool)) T {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if v, ok := read(); ok {
			return v
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("timed out waiting for event")
	var zero T
	return zero
}

func TestWireWriteRunAndMergeApproval(t *testing.T) {
	c := config.Defaults()
	c.Lanes.Lane = []config.Lane{{ID: "codex/default", CLI: "codex", Capacity: 1}}
	c.Lanes.Persona = []config.Persona{{Handle: "codex", Lanes: []string{"codex/default"}, Mode: "write"}}
	s, a, srv, p := setupWire(t, c)
	t.Setenv("GIT_AUTHOR_NAME", "Synthetic Human")
	t.Setenv("GIT_AUTHOR_EMAIL", "human@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Synthetic Human")
	t.Setenv("GIT_COMMITTER_EMAIL", "human@example.invalid")
	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "init", "-q")
	identity, err := os.OpenFile(filepath.Join(repo, ".git", "config"), os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := identity.WriteString("\n[user]\n name = Synthetic Human\n email = human@example.invalid\n"); err != nil {
		t.Fatal(err)
	}
	if err := identity.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "add", "base.txt")
	tree := gitTest(t, repo, "write-tree")
	base := gitTest(t, repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", tree, "-m", "base")
	gitTest(t, repo, "update-ref", "HEAD", base)
	fake := filepath.Join(p.DataDir, "codex")
	script := "#!/bin/sh\nprintf 'synthetic result\\n' > added.txt\nprintf 'Added a synthetic file.\\n'\n"
	if err := os.WriteFile(fake, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", p.DataDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	a.Adapters["codex"] = fakeCodex{fake}
	var ch domain.Channel
	requestJSON(t, "POST", srv.URL+"/api/v1/channels", `{"name":"work"}`, 201, &ch)
	requestJSON(t, "PATCH", srv.URL+"/api/v1/channels/"+ch.ID, `{"repo_path":"/no/such/repo"}`, 400, nil)
	body, _ := json.Marshal(map[string]string{"repo_path": repo, "test_command": "test -f added.txt"})
	requestJSON(t, "PATCH", srv.URL+"/api/v1/channels/"+ch.ID, string(body), 200, &ch)
	if ch.RepoPath != repo || ch.TestCommand != "test -f added.txt" {
		t.Fatalf("channel patch: %+v", ch)
	}
	requestJSON(t, "POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", `{"body":"@codex add a file"}`, 201, nil)
	approval := waitFor(t, func() (domain.Approval, bool) {
		v, _ := s.Approvals(context.Background(), "pending")
		if len(v) == 1 {
			return v[0], true
		}
		return domain.Approval{}, false
	})
	run, err := s.Run(context.Background(), approval.RunID)
	if err != nil || run.State != domain.RunWaitingApproval {
		t.Fatalf("run: %+v %v", run, err)
	}
	outputs, err := s.RunOutput(context.Background(), run.ID, 0)
	if err != nil || len(outputs) == 0 {
		t.Fatalf("output: %+v %v", outputs, err)
	}
	messages, err := s.Messages(context.Background(), ch.ID, "", 20)
	if err != nil || len(messages) != 2 || messages[1].RunID != run.ID || !strings.Contains(messages[1].Body, "Added a synthetic file") {
		t.Fatalf("messages: %+v %v", messages, err)
	}
	// A local edit to a tracked file blocks the merge; untracked files do not.
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("local edit\n"), 0600); err != nil {
		t.Fatal(err)
	}
	requestJSON(t, "POST", srv.URL+"/api/v1/approvals/"+approval.ID+"/resolve", `{"option":"merge"}`, 409, nil)
	stillPending, err := s.Approval(context.Background(), approval.ID)
	if err != nil || stillPending.State != domain.ApprovalPending {
		t.Fatalf("failed merge resolved approval: %+v %v", stillPending, err)
	}
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	requestJSON(t, "POST", srv.URL+"/api/v1/approvals/"+approval.ID+"/resolve", `{"option":"merge"}`, 200, nil)
	diffRes, err := http.Get(srv.URL + "/api/v1/runs/" + run.ID + "/diff")
	if err != nil {
		t.Fatal(err)
	}
	var diff bytes.Buffer
	_, _ = diff.ReadFrom(diffRes.Body)
	diffRes.Body.Close()
	if diffRes.StatusCode != 200 || !strings.Contains(diff.String(), "+synthetic result") {
		t.Fatalf("persisted diff: %d %s", diffRes.StatusCode, diff.String())
	}
	if _, err := os.Stat(filepath.Join(repo, "added.txt")); err != nil {
		t.Fatal(err)
	}
	if gitTest(t, repo, "rev-parse", "HEAD") == base {
		t.Fatal("merge did not advance HEAD")
	}
	if _, err := os.Stat(run.Worktree); !os.IsNotExist(err) {
		t.Fatalf("merged worktree still exists: %v", err)
	}
}

func TestAgentCommitIsSquashedUnderHumanIdentity(t *testing.T) {
	c := config.Defaults()
	c.Lanes.Lane = []config.Lane{{ID: "codex/default", CLI: "codex", Capacity: 1}}
	c.Lanes.Persona = []config.Persona{{Handle: "coder", Lanes: []string{"codex/default"}, Mode: "write"}}
	s, a, srv, p := setupWire(t, c)
	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "init", "-q")
	configPath := filepath.Join(repo, ".git", "config")
	f, err := os.OpenFile(configPath, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("\n[user]\n name = Synthetic Human\n email = human@example.invalid\n"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "add", "base.txt")
	base := gitTest(t, repo, "-c", "user.name=Base", "-c", "user.email=base@example.invalid", "commit-tree", gitTest(t, repo, "write-tree"), "-m", "base")
	gitTest(t, repo, "update-ref", "HEAD", base)
	marker := filepath.Join(t.TempDir(), "hook-ran")
	hook := "#!/bin/sh\nprintf ran > '" + marker + "'\n"
	if err := os.WriteFile(filepath.Join(repo, ".git", "hooks", "pre-commit"), []byte(hook), 0700); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(p.DataDir, "fake-agent")
	script := "#!/bin/sh\ncase \"$*\" in *\"Do not commit changes in the worktree.\"*) ;; *) echo 'missing no-commit instruction' >&2; exit 9;; esac\nprintf 'synthetic change\\n' > added.txt\ngit add added.txt\ngit -c core.hooksPath=/tmp/no-hooks -c user.name=Agent -c user.email=agent@example.invalid commit -q -m 'agent change' -m 'Co-Authored-By: Agent <agent@example.invalid>'\nprintf 'synthetic answer\\n'\n"
	if err := os.WriteFile(fake, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	a.Adapters["codex"] = fakeCodex{fake}
	var ch domain.Channel
	body, _ := json.Marshal(map[string]string{"name": "work", "repo_path": repo})
	requestJSON(t, "POST", srv.URL+"/api/v1/channels", string(body), 201, &ch)
	requestJSON(t, "POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", `{"body":"@coder add a synthetic file"}`, 201, nil)
	approval := waitFor(t, func() (domain.Approval, bool) {
		v, _ := s.Approvals(context.Background(), "pending")
		if len(v) == 1 {
			return v[0], true
		}
		return domain.Approval{}, false
	})
	run, err := s.Run(context.Background(), approval.RunID)
	if err != nil || run.BaseCommit != base {
		t.Fatalf("base commit: %+v %v", run, err)
	}
	requestJSON(t, "POST", srv.URL+"/api/v1/approvals/"+approval.ID+"/resolve", `{"option":"merge"}`, 200, nil)
	if got := gitTest(t, repo, "rev-list", "--count", base+"..HEAD"); got != "1" {
		t.Fatalf("commit count %s", got)
	}
	if got := gitTest(t, repo, "log", "-1", "--format=%an <%ae>"); got != "Synthetic Human <human@example.invalid>" {
		t.Fatalf("author %q", got)
	}
	if msg := gitTest(t, repo, "log", "-1", "--format=%B"); strings.Contains(msg, "Co-Authored-By") {
		t.Fatalf("agent trailer survived: %q", msg)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("human commit hook: %v", err)
	}
}

func TestWireCancelRetryAndProbe(t *testing.T) {
	c := config.Defaults()
	c.Lanes.Lane = []config.Lane{{ID: "codex/default", CLI: "codex", Capacity: 1}}
	c.Lanes.Persona = []config.Persona{{Handle: "coder", Lanes: []string{"codex/default"}, Mode: "read"}}
	s, a, srv, p := setupWire(t, c)
	gate := filepath.Join(p.DataDir, "gate")
	if err := os.WriteFile(gate, []byte("wait"), 0600); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(p.DataDir, "fake-agent")
	script := "#!/bin/sh\nif [ -f '" + gate + "' ]; then sleep 5; fi\nprintf 'synthetic answer\\n'\n"
	if err := os.WriteFile(fake, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	a.Adapters["codex"] = fakeCodex{fake}
	var ch domain.Channel
	requestJSON(t, "POST", srv.URL+"/api/v1/channels", `{"name":"work"}`, 201, &ch)
	requestJSON(t, "POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", `{"body":"@coder synthetic work"}`, 201, nil)
	first := waitFor(t, func() (domain.Run, bool) {
		runs, _ := s.Runs(context.Background(), ch.ID, "running")
		if len(runs) == 1 {
			return runs[0], true
		}
		return domain.Run{}, false
	})
	eventsBefore, err := s.EventsAfter(context.Background(), 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	created := false
	for _, e := range eventsBefore {
		if e.Type == events.RunCreated {
			created = true
		}
	}
	if !created {
		t.Fatal("run.created was not emitted")
	}
	requestJSON(t, "POST", srv.URL+"/api/v1/runs/"+first.ID+"/cancel", `{}`, 202, nil)
	waitFor(t, func() (bool, bool) {
		r, _ := s.Run(context.Background(), first.ID)
		return true, r.State == domain.RunCancelled
	})
	if err := os.Remove(gate); err != nil {
		t.Fatal(err)
	}
	requestJSON(t, "POST", srv.URL+"/api/v1/runs/"+first.ID+"/retry", `{}`, 202, nil)
	second := waitFor(t, func() (domain.Run, bool) {
		runs, _ := s.Runs(context.Background(), ch.ID, "done")
		for _, run := range runs {
			if run.ID != first.ID {
				return run, true
			}
		}
		return domain.Run{}, false
	})
	if second.ID == first.ID {
		t.Fatal("retry reused run id")
	}
	before, err := s.EventsAfter(context.Background(), 0, 500)
	if err != nil {
		t.Fatal(err)
	}
	requestJSON(t, "POST", srv.URL+"/api/v1/lanes/codex/default/probe", `{}`, 200, nil)
	after, err := s.EventsAfter(context.Background(), 0, 500)
	if err != nil || len(after) <= len(before) || after[len(after)-1].Type != events.LaneUpdated {
		t.Fatalf("probe did not refresh lane: before %d after %d error %v", len(before), len(after), err)
	}
}

func TestWireRetryOnAnotherLane(t *testing.T) {
	c := config.Defaults()
	c.Lanes.Lane = []config.Lane{{ID: "codex/default", CLI: "codex", Capacity: 1}, {ID: "claude/default", CLI: "claude", Capacity: 1}}
	c.Lanes.Persona = []config.Persona{{Handle: "coder", Lanes: []string{"codex/default", "claude/default"}, Mode: "read"}}
	s, a, srv, p := setupWire(t, c)
	fail := filepath.Join(p.DataDir, "fail-agent")
	ok := filepath.Join(p.DataDir, "ok-agent")
	if err := os.WriteFile(fail, []byte("#!/bin/sh\necho 'synthetic failure' >&2\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ok, []byte("#!/bin/sh\necho 'synthetic answer'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	a.Adapters["codex"] = fakeCodex{fail}
	a.Adapters["claude"] = fakeCodex{ok}
	var ch domain.Channel
	requestJSON(t, "POST", srv.URL+"/api/v1/channels", `{"name":"work"}`, 201, &ch)
	requestJSON(t, "POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", `{"body":"@coder synthetic work"}`, 201, nil)
	first := waitFor(t, func() (domain.Run, bool) {
		runs, _ := s.Runs(context.Background(), ch.ID, "failed")
		if len(runs) == 1 {
			return runs[0], true
		}
		return domain.Run{}, false
	})
	requestJSON(t, "POST", srv.URL+"/api/v1/runs/"+first.ID+"/retry", `{"lane_id":"claude/default"}`, 202, nil)
	second := waitFor(t, func() (domain.Run, bool) {
		runs, _ := s.Runs(context.Background(), ch.ID, "done")
		for _, run := range runs {
			if run.ID != first.ID {
				return run, true
			}
		}
		return domain.Run{}, false
	})
	if second.LaneID != "claude/default" {
		t.Fatalf("retry lane %s", second.LaneID)
	}
}

func TestWriteApprovalKeepAndDiscard(t *testing.T) {
	c := config.Defaults()
	c.Lanes.Lane = []config.Lane{{ID: "codex/default", CLI: "codex", Capacity: 1}}
	s, a, srv, p := setupWire(t, c)
	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "init", "-q")
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "add", "base.txt")
	tree := gitTest(t, repo, "write-tree")
	base := gitTest(t, repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", tree, "-m", "base")
	gitTest(t, repo, "update-ref", "HEAD", base)
	body, _ := json.Marshal(map[string]string{"name": "work", "repo_path": repo})
	var ch domain.Channel
	requestJSON(t, "POST", srv.URL+"/api/v1/channels", string(body), 201, &ch)
	ctx := context.Background()
	for _, option := range []string{"keep", "discard"} {
		id := store.NewID()
		w, err := (worktree.Manager{BaseDir: p.WorktreesDir}).Create(ctx, repo, id)
		if err != nil {
			t.Fatal(err)
		}
		run := domain.Run{ID: id, ChannelID: ch.ID, Mode: domain.RunWrite, State: domain.RunWaitingApproval, Worktree: w.Path}
		if _, err := s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: ch.ID, Payload: run}); err != nil {
			t.Fatal(err)
		}
		approval := domain.Approval{ID: store.NewID(), RunID: id, ChannelID: ch.ID, State: domain.ApprovalPending}
		if _, err := a.ResolveApproval(ctx, approval, option, ""); err != nil {
			t.Fatalf("%s: %v", option, err)
		}
		_, statErr := os.Stat(w.Path)
		if option == "keep" && statErr != nil || option == "discard" && !os.IsNotExist(statErr) {
			t.Fatalf("%s worktree: %v", option, statErr)
		}
	}
}

func TestQuotaSwitchesNextCoderRun(t *testing.T) {
	c := config.Defaults()
	c.Lanes.Lane = []config.Lane{{ID: "codex/default", CLI: "codex", Capacity: 1}, {ID: "claude/default", CLI: "claude", Capacity: 1}}
	c.Lanes.Persona = []config.Persona{{Handle: "coder", Lanes: []string{"codex/default", "claude/default"}, Mode: "read"}}
	s, a, srv, _ := setupWire(t, c)
	dir := t.TempDir()
	fail := filepath.Join(dir, "fail")
	ok := filepath.Join(dir, "ok")
	if err := os.WriteFile(fail, []byte("#!/bin/sh\necho 'quota exhausted' >&2\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ok, []byte("#!/bin/sh\necho 'synthetic reply'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	a.Adapters["codex"] = fakeCodex{fail}
	a.Adapters["claude"] = fakeCodex{ok}
	var ch domain.Channel
	requestJSON(t, "POST", srv.URL+"/api/v1/channels", `{"name":"work"}`, 201, &ch)
	requestJSON(t, "POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", `{"body":"@coder first"}`, 201, nil)
	waitFor(t, func() (bool, bool) {
		l, _ := s.Lane(context.Background(), "codex/default")
		return true, l.Health == domain.LaneExhausted
	})
	requestJSON(t, "POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", `{"body":"@coder second"}`, 201, nil)
	second := waitFor(t, func() (domain.Run, bool) {
		runs, _ := s.Runs(context.Background(), ch.ID, "done")
		for _, r := range runs {
			if r.LaneID == "claude/default" {
				return r, true
			}
		}
		return domain.Run{}, false
	})
	if second.LaneID != "claude/default" {
		t.Fatal(second.LaneID)
	}
	eventsSeen, err := s.EventsAfter(context.Background(), 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	var switched, notice bool
	for _, e := range eventsSeen {
		switched = switched || e.Type == events.LaneSwitched
		notice = notice || e.Type == events.Notice
	}
	if !switched || !notice {
		t.Fatalf("switch and notice: %t %t", switched, notice)
	}
}

func TestLanesCommandReadsStoredHealth(t *testing.T) {
	c := config.Defaults()
	c.Lanes.Lane = []config.Lane{{ID: "codex/default", CLI: "codex", Capacity: 2}}
	s, _, _, p := setupWire(t, c)
	lane, err := s.Lane(context.Background(), "codex/default")
	if err != nil {
		t.Fatal(err)
	}
	lane.Health = domain.LaneExhausted
	lane.Running = 1
	if _, err := s.Append(context.Background(), events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: lane}); err != nil {
		t.Fatal(err)
	}
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	previous := os.Stdout
	os.Stdout = write
	defer func() { os.Stdout = previous }()
	if err := printLanes(p); err != nil {
		t.Fatal(err)
	}
	write.Close()
	out, err := io.ReadAll(read)
	read.Close()
	if err != nil || !strings.Contains(string(out), "codex/default") || !strings.Contains(string(out), "exhausted") {
		t.Fatalf("lanes output: %s %v", out, err)
	}
}

// mergeMovedSetup starts a write run whose agent adds added.txt, and returns
// once its approval is pending.
func mergeMovedSetup(t *testing.T) (*store.Store, *httptest.Server, string, string, domain.Approval) {
	t.Helper()
	c := config.Defaults()
	c.Lanes.Lane = []config.Lane{{ID: "codex/default", CLI: "codex", Capacity: 1}}
	c.Lanes.Persona = []config.Persona{{Handle: "coder", Lanes: []string{"codex/default"}, Mode: "write"}}
	s, a, srv, p := setupWire(t, c)
	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "init", "-q")
	f, err := os.OpenFile(filepath.Join(repo, ".git", "config"), os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("\n[user]\n name = Synthetic Human\n email = human@example.invalid\n"); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "add", "base.txt")
	gitTest(t, repo, "commit", "-q", "-m", "base")
	base := gitTest(t, repo, "rev-parse", "HEAD")
	fake := filepath.Join(p.DataDir, "fake-agent")
	script := "#!/bin/sh\nprintf 'agent line\\n' > added.txt\nprintf 'synthetic answer\\n'\n"
	if err := os.WriteFile(fake, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	a.Adapters["codex"] = fakeCodex{fake}
	var ch domain.Channel
	body, _ := json.Marshal(map[string]string{"name": "work", "repo_path": repo})
	requestJSON(t, "POST", srv.URL+"/api/v1/channels", string(body), 201, &ch)
	requestJSON(t, "POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", `{"body":"@coder add a file"}`, 201, nil)
	approval := waitFor(t, func() (domain.Approval, bool) {
		v, _ := s.Approvals(context.Background(), "pending")
		if len(v) == 1 {
			return v[0], true
		}
		return domain.Approval{}, false
	})
	return s, srv, repo, base, approval
}

func TestMergeReplaysRunWhenBranchMoved(t *testing.T) {
	_, srv, repo, base, approval := mergeMovedSetup(t)
	// Someone else lands a commit while the run waits for approval.
	if err := os.WriteFile(filepath.Join(repo, "other.txt"), []byte("other\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "add", "other.txt")
	gitTest(t, repo, "commit", "-q", "-m", "meanwhile")
	moved := gitTest(t, repo, "rev-parse", "HEAD")
	requestJSON(t, "POST", srv.URL+"/api/v1/approvals/"+approval.ID+"/resolve", `{"option":"merge"}`, 200, nil)
	if got := gitTest(t, repo, "rev-parse", "HEAD~1"); got != moved {
		t.Fatalf("run commit is not on top of the moved branch: parent %s, want %s (base %s)", got, moved, base)
	}
	for _, name := range []string{"added.txt", "other.txt"} {
		if _, err := os.Stat(filepath.Join(repo, name)); err != nil {
			t.Fatalf("%s missing after merge: %v", name, err)
		}
	}
	if got := gitTest(t, repo, "log", "-1", "--format=%an"); got != "Synthetic Human" {
		t.Fatalf("author %q", got)
	}
}

func TestMergeConflictKeepsApprovalAndNamesFiles(t *testing.T) {
	s, srv, repo, _, approval := mergeMovedSetup(t)
	if err := os.WriteFile(filepath.Join(repo, "added.txt"), []byte("human line\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "add", "added.txt")
	gitTest(t, repo, "commit", "-q", "-m", "conflicting")
	var res map[string]map[string]string
	requestJSON(t, "POST", srv.URL+"/api/v1/approvals/"+approval.ID+"/resolve", `{"option":"merge"}`, 409, &res)
	if msg := res["error"]["message"]; !strings.Contains(msg, "added.txt") {
		t.Fatalf("conflict message does not name the file: %q", msg)
	}
	still, err := s.Approval(context.Background(), approval.ID)
	if err != nil || still.State != domain.ApprovalPending {
		t.Fatalf("approval after conflict: %+v %v", still, err)
	}
	run, err := s.Run(context.Background(), approval.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if out := gitTest(t, run.Worktree, "status", "--porcelain"); strings.Contains(out, "UU") {
		t.Fatalf("worktree left mid-rebase: %s", out)
	}
	// Keep still works after a failed merge.
	requestJSON(t, "POST", srv.URL+"/api/v1/approvals/"+approval.ID+"/resolve", `{"option":"keep"}`, 200, nil)
}

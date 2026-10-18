package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

// noChangeRun sends a message to a write persona whose fake CLI changes
// nothing, in a channel with the given test command.
func noChangeRun(t *testing.T, testCommand string) (*store.Store, domain.Channel, domain.Run) {
	t.Helper()
	c := config.Defaults()
	c.Lanes.Lane = []config.Lane{{ID: "codex/default", CLI: "codex", Capacity: 1}}
	c.Lanes.Persona = []config.Persona{{Handle: "codex", Lanes: []string{"codex/default"}, Mode: "write"}}
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
	fake := filepath.Join(p.DataDir, "codex")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nprintf 'Nothing needed changing.\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	a.Adapters["codex"] = fakeCodex{fake}
	var ch domain.Channel
	requestJSON(t, "POST", srv.URL+"/api/v1/channels", `{"name":"work"}`, 201, &ch)
	patch, _ := json.Marshal(map[string]string{"repo_path": repo, "test_command": testCommand})
	requestJSON(t, "PATCH", srv.URL+"/api/v1/channels/"+ch.ID, string(patch), 200, &ch)
	requestJSON(t, "POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", `{"body":"@codex check the docs"}`, 201, nil)
	run := waitFor(t, func() (domain.Run, bool) {
		runs, _ := s.Runs(context.Background(), ch.ID, "")
		if len(runs) == 1 && runs[0].State.Terminal() {
			return runs[0], true
		}
		return domain.Run{}, false
	})
	return s, ch, run
}

func TestWriteRunWithoutChangesEndsDone(t *testing.T) {
	s, _, run := noChangeRun(t, "")
	if run.State != domain.RunDone || run.FailureReason != "" {
		t.Fatalf("run %+v", run)
	}
	waitFor(t, func() (bool, bool) { return true, hasNotice(noticeTexts(t, s), "No changes") })
	if pending, _ := s.Approvals(context.Background(), "pending"); len(pending) != 0 {
		t.Fatalf("an approval card for a run with no changes: %+v", pending)
	}
}

func TestWriteRunWithoutChangesStillFailsWhenTheTestCommandFails(t *testing.T) {
	_, _, run := noChangeRun(t, "exit 3")
	if run.State != domain.RunFailed || run.FailureReason == "" {
		t.Fatalf("run %+v", run)
	}
}

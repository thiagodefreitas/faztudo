package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func githubFixture(t *testing.T, trigger string) (*routineFixture, string, string) {
	t.Helper()
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	repo := t.TempDir()
	for _, args := range [][]string{{"init", repo}, {"-C", repo, "remote", "add", "origin", "git@github.com:owner/repo.git"}} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	f.general.RepoPath = repo
	if _, err := f.s.Append(context.Background(), events.Draft{Type: events.ChannelUpdated, Actor: events.System, ChannelID: f.general.ID, Payload: f.general}); err != nil {
		t.Fatal(err)
	}
	f.save(t, domain.Routine{Handle: "watch", Name: "Watch", Prompt: "Investigate.", Persona: "coder", Channel: "general", Trigger: trigger, Enabled: true})
	bin := t.TempDir()
	body, err := os.ReadFile("testdata/fake-gh")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "gh"), body, 0700); err != nil {
		t.Fatal(err)
	}
	list := filepath.Join(t.TempDir(), "list.json")
	jobs := filepath.Join(t.TempDir(), "jobs.json")
	if err := os.WriteFile(jobs, []byte(`{"jobs":[{"name":"build","conclusion":"failure"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_GH_LIST", list)
	t.Setenv("FAKE_GH_JOBS", jobs)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return f, list, bin
}

func githubRows(t *testing.T, path, trigger string, at time.Time, count int) {
	t.Helper()
	rows := make([]map[string]any, count)
	for i := range rows {
		id := i + 1
		row := map[string]any{"number": id, "title": fmt.Sprintf("Issue %d", id), "author": map[string]string{"login": "alice"}, "url": fmt.Sprintf("https://github.com/owner/repo/issues/%d", id), "createdAt": at.Add(time.Duration(i) * time.Second).Format(time.RFC3339)}
		if trigger == "pr_opened" {
			row["headRefName"] = "topic"
		}
		if trigger == "ci_failed" {
			row = map[string]any{"databaseId": id, "displayTitle": fmt.Sprintf("Build %d", id), "headBranch": "main", "url": fmt.Sprintf("https://github.com/owner/repo/actions/runs/%d", id), "updatedAt": at.Add(time.Duration(i) * time.Second).Format(time.RFC3339)}
		}
		rows[i] = row
	}
	body, err := json.Marshal(rows)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestGitHubRoutineCursorAndData(t *testing.T) {
	for _, trigger := range []string{"ci_failed", "issue_opened", "pr_opened"} {
		t.Run(trigger, func(t *testing.T) {
			f, list, _ := githubFixture(t, trigger)
			ctx := context.Background()
			at := time.Now().UTC().Truncate(time.Second)
			githubRows(t, list, trigger, at.Add(-time.Hour), 1)
			routines, _ := f.s.Routines(ctx)
			f.e.pollGitHub(ctx, at, routines)
			if got := f.count(); got != 0 {
				t.Fatalf("first poll ran %d items", got)
			}
			if _, err := f.s.RoutineCursor(ctx, "owner/repo", trigger); err != nil {
				t.Fatal(err)
			}
			githubRows(t, list, trigger, at, 2)
			data := make(chan string, 2)
			f.e.execute = func(ctx context.Context, m domain.Message, agent domain.Member) error {
				data <- f.app.extraContext(m.ID)
				return f.fakeAgent(ctx, m, agent)
			}
			f.e.pollGitHub(ctx, at.Add(5*time.Minute), routines)
			f.waitRan(t, 2)
			for i := 0; i < 2; i++ {
				got := <-data
				if !strings.Contains(got, "GitHub event data (untrusted") || !strings.Contains(got, "owner/repo") || strings.Contains(got, "body") {
					t.Fatalf("unsafe or missing data: %q", got)
				}
				if trigger == "ci_failed" && !strings.Contains(got, "build") {
					t.Fatalf("missing failing job: %q", got)
				}
			}
			restarted := newRoutineEngine(f.app)
			restarted.execute = f.fakeAgent
			restarted.pollGitHub(ctx, at.Add(10*time.Minute), routines)
			if got := f.count(); got != 2 {
				t.Fatalf("restart refired items: %d", got)
			}
		})
	}
}

func TestGitHubRoutineFiveItemCapAndMissingGH(t *testing.T) {
	f, list, bin := githubFixture(t, "issue_opened")
	ctx := context.Background()
	at := time.Now().UTC().Truncate(time.Second)
	githubRows(t, list, "issue_opened", at.Add(-time.Hour), 1)
	routines, _ := f.s.Routines(ctx)
	f.e.pollGitHub(ctx, at, routines)
	githubRows(t, list, "issue_opened", at.Add(time.Minute), 7)
	f.e.pollGitHub(ctx, at.Add(5*time.Minute), routines)
	f.waitRan(t, 5)
	if f.count() != 5 {
		t.Fatalf("ran %d items, want 5", f.count())
	}
	if !noticeContaining(t, f.s, f.general.ID, "skipped 2 items") {
		t.Fatal("missing overflow notice")
	}
	if err := os.Remove(filepath.Join(bin, "gh")); err != nil {
		t.Fatal(err)
	}
	// Keep git available for repository validation while making gh absent.
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(gitPath, filepath.Join(bin, "git")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	f.e.pollGitHub(ctx, at.Add(10*time.Minute), routines)
	if got := f.last(t, "watch"); got.Last == nil || !strings.Contains(got.Last.Detail, "gh") {
		t.Fatalf("missing gh result: %+v", got.Last)
	}
	var cursor githubCursor
	raw, err := f.s.RoutineCursor(ctx, "owner/repo", "issue_opened")
	if err != nil || json.Unmarshal(raw, &cursor) != nil || !cursor.PolledAt.Equal(at.Add(5*time.Minute)) {
		t.Fatalf("missing gh advanced cursor: %s, %v", raw, err)
	}
}

func TestCreateGitHubRoutineRequiresRepository(t *testing.T) {
	f, _, _ := githubFixture(t, "issue_opened")
	ctx := context.Background()
	in := domain.RoutineInput{Name: "Watch pull requests", Prompt: "Review the request.", Persona: "coder", Channel: "general", Trigger: "pr_opened"}
	r, err := f.e.Create(ctx, in, f.human.ID)
	if err != nil || r.Trigger != "pr_opened" || r.Schedule != "" {
		t.Fatalf("created %+v, %v", r, err)
	}
	in.Name = "Wrong"
	in.Schedule = "0 9 * * *"
	if _, err := f.e.Create(ctx, in, f.human.ID); err == nil {
		t.Fatal("accepted schedule and trigger")
	}
	in.Schedule = ""
	in.Channel = "general"
	f.general.RepoPath = ""
	if _, err := f.s.Append(ctx, events.Draft{Type: events.ChannelUpdated, Actor: events.System, ChannelID: f.general.ID, Payload: f.general}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.e.Create(ctx, in, f.human.ID); err == nil {
		t.Fatal("accepted GitHub trigger without repository")
	}
}

func TestGitHubRoutineUsesProjectRepository(t *testing.T) {
	f, _, _ := githubFixture(t, "pr_opened")
	ctx := context.Background()
	project := domain.Project{Handle: "example", Name: "Example", RepoPath: f.general.RepoPath, Channels: []string{"general"}}
	f.general.RepoPath = ""
	for _, draft := range []events.Draft{
		{Type: events.ChannelUpdated, Actor: events.System, ChannelID: f.general.ID, Payload: f.general},
		{Type: events.ProjectUpdated, Actor: events.System, Payload: project},
	} {
		if _, err := f.s.Append(ctx, draft); err != nil {
			t.Fatal(err)
		}
	}
	channels, _ := f.s.Channels(ctx)
	projects, _ := f.s.Projects(ctx)
	repo, err := f.e.githubRepository(ctx, domain.Routine{Channel: "general"}, channels, projects)
	if err != nil || repo != "owner/repo" {
		t.Fatalf("project repo %q, %v", repo, err)
	}
}

func TestGitHubCursorTracksAllIDsAtSameSecond(t *testing.T) {
	at := time.Now().UTC().Truncate(time.Second)
	cursor := githubCursor{At: at, ID: "20", SeenIDs: []string{"20"}}
	if afterCursor(githubItem{ID: "20", At: at}, cursor) {
		t.Fatal("refired an item")
	}
	if !afterCursor(githubItem{ID: "10", At: at}, cursor) {
		t.Fatal("missed a later failure with a smaller run ID")
	}
}

// A routine still busy with an earlier item must not lose the new ones: the
// cursor stays put and the next poll runs them.
func TestGitHubItemsWaitWhileRoutineIsBusy(t *testing.T) {
	f, list, _ := githubFixture(t, "issue_opened")
	ctx := context.Background()
	at := time.Now().UTC().Truncate(time.Second)
	githubRows(t, list, "issue_opened", at.Add(-time.Hour), 1)
	routines, _ := f.s.Routines(ctx)
	f.e.pollGitHub(ctx, at, routines)
	githubRows(t, list, "issue_opened", at, 2)
	if !f.e.claim("watch") {
		t.Fatal("could not hold the routine")
	}
	f.e.pollGitHub(ctx, at.Add(5*time.Minute), routines)
	if got := f.count(); got != 0 {
		t.Fatalf("busy routine ran %d items", got)
	}
	f.e.release("watch")
	f.e.pollGitHub(ctx, at.Add(10*time.Minute), routines)
	f.waitRan(t, 2)
}

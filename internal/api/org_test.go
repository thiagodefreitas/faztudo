package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

// whoTrigger records the handles of the agents that were asked to run.
type whoTrigger struct{ handles []string }

func (t *whoTrigger) OnMessage(_ context.Context, _ domain.Message, agents []domain.Member) {
	for _, a := range agents {
		t.handles = append(t.handles, a.Handle)
	}
}

type orgFixture struct {
	*threadFixture
	who  *whoTrigger
	proj domain.Channel
}

// newOrgFixture has an Engineering department led by coder, a project "faztudo"
// with Engineering assigned and its own channel, and the reviewer unassigned.
func newOrgFixture(t *testing.T) *orgFixture {
	t.Helper()
	f := &orgFixture{threadFixture: newThreadFixture(t), who: &whoTrigger{}}
	f.h.Trigger = f.who
	f.proj = domain.Channel{ID: store.NewID(), Name: "faztudo-dev", Kind: domain.ChannelProject, Visibility: domain.VisibilityPublic, MemberIDs: []string{f.human.ID, f.coder.ID, f.review.ID}}
	drafts := []events.Draft{
		{Type: events.ChannelCreated, ChannelID: f.proj.ID, Payload: f.proj},
		{Type: events.DepartmentUpdated, Payload: domain.Department{Handle: "engineering", DisplayName: "Engineering", Lead: "coder", Members: []string{"coder"}}},
		{Type: events.ProjectUpdated, Payload: domain.Project{Handle: "faztudo", Name: "Faztudo", Channels: []string{"faztudo-dev"}, Departments: []string{"engineering"}, Specialists: []string{}}},
	}
	for _, d := range drafts {
		d.Actor = events.System
		if _, err := f.h.Store.Append(context.Background(), d); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func (f *orgFixture) post(t *testing.T, ch domain.Channel, body string) {
	t.Helper()
	f.do(t, "POST", "/api/v1/channels/"+ch.ID+"/messages", `{"body":"`+body+`"}`, 201, nil)
}

func (f *orgFixture) notices(t *testing.T, ch domain.Channel) []events.NoticePayload {
	t.Helper()
	evs, err := f.h.Store.EventsAfter(context.Background(), 0, 500)
	if err != nil {
		t.Fatal(err)
	}
	var out []events.NoticePayload
	for _, e := range evs {
		if e.Type != events.Notice || e.ChannelID != ch.ID {
			continue
		}
		var n events.NoticePayload
		if err := json.Unmarshal(e.Payload, &n); err != nil {
			t.Fatal(err)
		}
		out = append(out, n)
	}
	return out
}

func TestProjectChannelRoutesToAssignedAgents(t *testing.T) {
	f := newOrgFixture(t)
	f.post(t, f.proj, "@coder fix the flaky test")
	f.post(t, f.proj, "@engineering add rate limiting")
	if want := []string{"coder", "coder"}; !slices.Equal(f.who.handles, want) {
		t.Fatalf("triggered %v, want %v", f.who.handles, want)
	}
	if n := f.notices(t, f.proj); len(n) != 0 {
		t.Fatalf("assigned agents produced notices: %+v", n)
	}

	f.post(t, f.proj, "@reviewer take a look")
	if len(f.who.handles) != 2 {
		t.Fatalf("unassigned reviewer ran: %v", f.who.handles)
	}
	n := f.notices(t, f.proj)
	if len(n) != 1 || n[0].Action == nil {
		t.Fatalf("want one notice with an action, got %+v", n)
	}
	if a := *n[0].Action; a.Kind != "assign" || a.Project != "faztudo" || a.Agent != "reviewer" {
		t.Fatalf("action %+v", a)
	}

	// The same mention outside a project keeps today's behavior.
	f.post(t, f.team, "@reviewer take a look")
	if len(f.who.handles) != 3 || f.who.handles[2] != "reviewer" {
		t.Fatalf("channel without a project: %v", f.who.handles)
	}
}

func TestAssignmentsAreHumanOnlyAndChangeRouting(t *testing.T) {
	f := newOrgFixture(t)
	base := "/api/v1/projects/faztudo/assignments"

	f.h.actorForRequest = func(*http.Request) (domain.Member, error) { return f.coder, nil }
	f.do(t, "POST", base, `{"kind":"specialist","handle":"reviewer"}`, 403, nil)
	f.do(t, "DELETE", base+"/department/engineering", "", 403, nil)
	f.h.actorForRequest = nil

	f.do(t, "POST", base, `{"kind":"specialist","handle":"nobody"}`, 400, nil)
	f.do(t, "POST", base, `{"kind":"department","handle":"nobody"}`, 400, nil)
	f.do(t, "POST", base, `{"kind":"team","handle":"reviewer"}`, 400, nil)
	f.do(t, "POST", "/api/v1/projects/missing/assignments", `{"kind":"specialist","handle":"reviewer"}`, 404, nil)

	var p domain.Project
	f.do(t, "POST", base, `{"kind":"specialist","handle":"reviewer"}`, 200, &p)
	f.do(t, "POST", base, `{"kind":"specialist","handle":"reviewer"}`, 200, &p)
	if !slices.Equal(p.Specialists, []string{"reviewer"}) {
		t.Fatalf("assigning twice: %v", p.Specialists)
	}
	f.post(t, f.proj, "@reviewer take a look")
	if !slices.Equal(f.who.handles, []string{"reviewer"}) {
		t.Fatalf("assigned reviewer: %v", f.who.handles)
	}

	f.do(t, "DELETE", base+"/specialist/reviewer", "", 200, &p)
	f.do(t, "DELETE", base+"/department/engineering", "", 200, &p)
	if len(p.Specialists) != 0 || len(p.Departments) != 0 {
		t.Fatalf("after removing: %+v", p)
	}
	f.post(t, f.proj, "@coder fix it")
	if len(f.who.handles) != 1 {
		t.Fatalf("coder ran after Engineering was removed: %v", f.who.handles)
	}

	var org orgView
	f.do(t, "GET", "/api/v1/org", "", 200, &org)
	if org.DirectorID != f.human.ID || len(org.Departments) != 1 || len(org.Projects) != 1 {
		t.Fatalf("org %+v", org)
	}
}

func TestProjectHandleGoesToTheProjectLead(t *testing.T) {
	f := newOrgFixture(t)
	lead := domain.Project{Handle: "launch", Name: "Launch", Lead: "reviewer", Channels: []string{"launch"}, Departments: []string{}, Specialists: []string{}}
	bare := domain.Project{Handle: "bare", Name: "Bare", Channels: []string{}, Departments: []string{}, Specialists: []string{}}
	for _, p := range []domain.Project{lead, bare} {
		if _, err := f.h.Store.Append(context.Background(), events.Draft{Type: events.ProjectUpdated, Actor: events.System, Payload: p}); err != nil {
			t.Fatal(err)
		}
	}
	launch := domain.Channel{ID: store.NewID(), Name: "launch", Kind: domain.ChannelProject, Visibility: domain.VisibilityPublic, MemberIDs: []string{f.human.ID}}
	if _, err := f.h.Store.Append(context.Background(), events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: launch.ID, Payload: launch}); err != nil {
		t.Fatal(err)
	}
	f.post(t, launch, "@launch plan the release")
	if !slices.Equal(f.who.handles, []string{"reviewer"}) {
		t.Fatalf("project lead is always assigned: %v", f.who.handles)
	}
	f.post(t, f.team, "@bare anyone?")
	if len(f.who.handles) != 1 {
		t.Fatalf("a project without a lead ran someone: %v", f.who.handles)
	}
	if n := f.notices(t, f.team); len(n) != 1 || n[0].Level != "warn" {
		t.Fatalf("want a notice about the missing lead, got %+v", n)
	}
}

func TestProjectsAreCreatedAndChangedByHumans(t *testing.T) {
	f := newOrgFixture(t)
	repo := t.TempDir()
	if out, err := exec.Command("git", "-C", repo, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}

	f.h.actorForRequest = func(*http.Request) (domain.Member, error) { return f.coder, nil }
	f.do(t, "POST", "/api/v1/projects", `{"handle":"launch"}`, 403, nil)
	f.do(t, "PATCH", "/api/v1/projects/faztudo", `{"name":"X"}`, 403, nil)
	f.h.actorForRequest = nil

	f.do(t, "POST", "/api/v1/projects", `{"handle":""}`, 400, nil)
	f.do(t, "POST", "/api/v1/projects", `{"handle":"bad handle"}`, 400, nil)
	f.do(t, "POST", "/api/v1/projects", `{"handle":"Faztudo"}`, 409, nil)
	f.do(t, "POST", "/api/v1/projects", `{"handle":"launch","lead":"nobody"}`, 400, nil)
	f.do(t, "POST", "/api/v1/projects", `{"handle":"launch","departments":["sales"]}`, 400, nil)
	f.do(t, "POST", "/api/v1/projects", `{"handle":"launch","specialists":["nobody"]}`, 400, nil)
	f.do(t, "POST", "/api/v1/projects", `{"handle":"launch","channels":["faztudo-dev"]}`, 400, nil)
	f.do(t, "POST", "/api/v1/projects", `{"handle":"launch","channels":["Bad Name"]}`, 400, nil)
	f.do(t, "POST", "/api/v1/projects", `{"handle":"launch","repo_path":"`+filepath.Join(repo, "missing")+`"}`, 400, nil)

	var p domain.Project
	body := `{"handle":"launch","name":" Launch ","repo_path":"` + repo + `","lead":"reviewer","channels":["launch","launch","launch-release"],"departments":["engineering"],"specialists":["reviewer"]}`
	f.do(t, "POST", "/api/v1/projects", body, 201, &p)
	if p.Handle != "launch" || p.Name != "Launch" || p.RepoPath != repo || p.Lead != "reviewer" {
		t.Fatalf("created %+v", p)
	}
	if !slices.Equal(p.Channels, []string{"launch", "launch-release"}) || !slices.Equal(p.Departments, []string{"engineering"}) || !slices.Equal(p.Specialists, []string{"reviewer"}) {
		t.Fatalf("created lists %+v", p)
	}
	// A name defaults to the handle.
	f.do(t, "POST", "/api/v1/projects", `{"handle":"bare"}`, 201, &p)
	if p.Name != "bare" || p.Channels == nil || p.Departments == nil || p.Specialists == nil {
		t.Fatalf("bare project %+v", p)
	}

	var org orgView
	f.do(t, "GET", "/api/v1/org", "", 200, &org)
	if len(org.Projects) != 3 {
		t.Fatalf("projects after creating: %+v", org.Projects)
	}

	// The lead of a new project is already allowed to run in its channels.
	launch := domain.Channel{ID: store.NewID(), Name: "launch", Kind: domain.ChannelProject, Visibility: domain.VisibilityPublic, MemberIDs: []string{f.human.ID, f.coder.ID, f.review.ID}}
	if _, err := f.h.Store.Append(context.Background(), events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: launch.ID, Payload: launch}); err != nil {
		t.Fatal(err)
	}
	f.post(t, launch, "@reviewer plan it")
	if !slices.Equal(f.who.handles, []string{"reviewer"}) {
		t.Fatalf("lead in a created project: %v", f.who.handles)
	}

	f.do(t, "PATCH", "/api/v1/projects/missing", `{"name":"X"}`, 404, nil)
	f.do(t, "PATCH", "/api/v1/projects/launch", `{"lead":"nobody"}`, 400, nil)
	f.do(t, "PATCH", "/api/v1/projects/launch", `{"name":" "}`, 400, nil)
	f.do(t, "PATCH", "/api/v1/projects/launch", `{"repo_path":"`+filepath.Join(repo, "missing")+`"}`, 400, nil)
	f.do(t, "PATCH", "/api/v1/projects/launch", `{"channels":["faztudo-dev"]}`, 400, nil)
	// A patch changes only the fields it names and never the assignments.
	f.do(t, "PATCH", "/api/v1/projects/launch", `{"name":"Launch 2","channels":["launch"],"specialists":[]}`, 200, &p)
	if p.Name != "Launch 2" || p.Lead != "reviewer" || p.RepoPath != repo || !slices.Equal(p.Channels, []string{"launch"}) || !slices.Equal(p.Specialists, []string{"reviewer"}) {
		t.Fatalf("patched %+v", p)
	}
	p = domain.Project{}
	f.do(t, "PATCH", "/api/v1/projects/launch", `{"lead":""}`, 200, &p)
	if p.Lead != "" || p.Name != "Launch 2" {
		t.Fatalf("lead not cleared: %+v", p)
	}
}

func TestProjectArchivePersistsAndRefusesLeadRouting(t *testing.T) {
	f := newOrgFixture(t)
	f.h.actorForRequest = func(*http.Request) (domain.Member, error) { return f.coder, nil }
	f.do(t, "PATCH", "/api/v1/projects/faztudo", `{"archived":true}`, 403, nil)
	f.do(t, "PATCH", "/api/v1/channels/"+f.proj.ID, `{"test_command":"go test ./..."}`, 403, nil)
	f.h.actorForRequest = nil
	var p domain.Project
	f.do(t, "PATCH", "/api/v1/projects/faztudo", `{"archived":true}`, 200, &p)
	if !p.Archived {
		t.Fatal("project was not archived")
	}
	if err := f.h.Store.Rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}
	p, err := f.h.Store.Project(context.Background(), "faztudo")
	if err != nil || !p.Archived {
		t.Fatalf("archive lost after rebuild: %+v, %v", p, err)
	}
	f.post(t, f.proj, "@faztudo plan the release")
	if len(f.who.handles) != 0 {
		t.Fatalf("archived lead ran: %v", f.who.handles)
	}
	if n := f.notices(t, f.proj); len(n) == 0 || !strings.Contains(n[len(n)-1].Text, "archived") {
		t.Fatalf("missing archive notice: %+v", n)
	}
	f.post(t, f.proj, "@coder work on the archive")
	if len(f.who.handles) != 0 {
		t.Fatalf("archived project ran an agent: %v", f.who.handles)
	}
	f.do(t, "PATCH", "/api/v1/projects/faztudo", `{"archived":false}`, 200, &p)
	if p.Archived {
		t.Fatal("project stayed archived")
	}
}

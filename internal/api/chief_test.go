package api

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

// withChief adds a Chief of Staff that the "general" channel opted in to.
func withChief(t *testing.T, f *orgFixture) domain.Member {
	t.Helper()
	chief := domain.Member{ID: store.NewID(), Kind: domain.MemberAgent, Handle: "chief", DisplayName: "Chief", Agent: &domain.AgentInfo{Lanes: []string{"x"}, ChiefOfStaff: true}}
	if _, err := f.h.Store.Append(context.Background(), events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: chief}); err != nil {
		t.Fatal(err)
	}
	f.h.Chief = func(channel string) (string, bool) { return "chief", channel == "general" }
	return chief
}

func TestUnaddressedMessageGoesToTheChiefOfStaffInOptedInChannels(t *testing.T) {
	f := newOrgFixture(t)
	withChief(t, f)

	f.post(t, f.team, "please ship the release notes")
	if !slices.Equal(f.who.handles, []string{"chief"}) {
		t.Fatalf("unaddressed request: %v", f.who.handles)
	}

	// A message that names someone goes to them, not to the chief.
	f.who.handles = nil
	f.post(t, f.team, "@coder fix the flaky test")
	if !slices.Equal(f.who.handles, []string{"coder"}) {
		t.Fatalf("addressed request: %v", f.who.handles)
	}
	// Naming a human is addressing someone too.
	f.who.handles = nil
	f.post(t, f.team, "@user did you see this")
	if len(f.who.handles) != 0 {
		t.Fatalf("a message to a human started %v", f.who.handles)
	}
	// Commands are not requests.
	f.post(t, f.team, "/status")
	if len(f.who.handles) != 0 {
		t.Fatalf("a command started %v", f.who.handles)
	}
	// A channel that did not opt in keeps today's behavior.
	f.post(t, f.proj, "please ship the release notes")
	if len(f.who.handles) != 0 {
		t.Fatalf("a channel that did not opt in started %v", f.who.handles)
	}
	// Direct channels are for the agent in them.
	f.h.Chief = func(string) (string, bool) { return "chief", true }
	f.post(t, f.dm2, "hello both")
	if len(f.who.handles) != 0 {
		t.Fatalf("a direct channel went to the chief: %v", f.who.handles)
	}
}

func TestThreadRepliesDoNotGoToTheChiefOfStaff(t *testing.T) {
	f := newOrgFixture(t)
	withChief(t, f)
	var root domain.Message
	f.do(t, "POST", "/api/v1/channels/"+f.team.ID+"/messages", `{"body":"ship it"}`, 201, &root)
	f.who.handles = nil
	f.do(t, "POST", "/api/v1/channels/"+f.team.ID+"/messages", `{"body":"A: yes","thread_id":"`+root.ID+`"}`, 201, nil)
	if len(f.who.handles) != 0 {
		t.Fatalf("a thread reply started %v", f.who.handles)
	}
}

func TestChiefOfStaffObeysTheProjectRule(t *testing.T) {
	f := newOrgFixture(t)
	withChief(t, f)
	f.h.Chief = func(channel string) (string, bool) { return "chief", channel == "faztudo-dev" }
	f.post(t, f.proj, "ship the release notes")
	if len(f.who.handles) != 0 {
		t.Fatalf("an unassigned chief ran in a project channel: %v", f.who.handles)
	}
	n := f.notices(t, f.proj)
	if len(n) != 1 || n[0].Action == nil || n[0].Action.Agent != "chief" {
		t.Fatalf("want a notice offering to assign the chief, got %+v", n)
	}
}

type fakeRoutines struct {
	list   []domain.Routine
	ran    []string
	runErr error
}

func (f *fakeRoutines) List(context.Context) ([]domain.Routine, error) { return f.list, nil }

func (f *fakeRoutines) SetEnabled(_ context.Context, handle string, enabled bool, _ string) (domain.Routine, error) {
	for i := range f.list {
		if f.list[i].Handle == handle {
			f.list[i].Enabled = enabled
			return f.list[i], nil
		}
	}
	return domain.Routine{}, store.ErrNotFound
}

func (f *fakeRoutines) RunNow(_ context.Context, handle string) error {
	if f.runErr != nil {
		return f.runErr
	}
	for _, r := range f.list {
		if r.Handle == handle {
			f.ran = append(f.ran, handle)
			return nil
		}
	}
	return store.ErrNotFound
}

type fakeClash struct{}

func (fakeClash) Error() string {
	return "routine daily-debrief is defined in lanes.toml; pick another name"
}
func (fakeClash) Is(target error) bool { return target == store.ErrConflict }

func (f *fakeRoutines) Create(_ context.Context, in domain.RoutineInput, by string) (domain.Routine, error) {
	if in.Persona != "coder" {
		return domain.Routine{}, domain.UserError{Message: "agent @" + in.Persona + " does not exist"}
	}
	if in.Name == "Daily debrief" {
		return domain.Routine{}, fakeClash{}
	}
	r := domain.Routine{Handle: "made", Name: in.Name, Prompt: in.Prompt, Persona: in.Persona, Channel: in.Channel, Schedule: in.Schedule, Enabled: true, Source: "app", CreatedBy: by}
	f.list = append(f.list, r)
	return r, nil
}

func (f *fakeRoutines) Delete(_ context.Context, handle, _ string) error {
	for i, r := range f.list {
		if r.Handle != handle {
			continue
		}
		if r.Source != "app" {
			return fakeClash{}
		}
		f.list = append(f.list[:i], f.list[i+1:]...)
		return nil
	}
	return store.ErrNotFound
}

func TestCreateAndDeleteRoutineEndpoints(t *testing.T) {
	f := newOrgFixture(t)
	fake := &fakeRoutines{list: []domain.Routine{{Handle: "daily-debrief", Name: "Daily debrief", Persona: "coder", Channel: "general", Schedule: "0 18 * * *", Enabled: true, Source: "config"}}}
	f.h.Routines = fake
	body := `{"name":"Check the build","prompt":"Check the build","persona":"coder","channel":"general","schedule":"0 9 * * 1-5"}`

	// Only a human makes or deletes routines.
	f.h.actorForRequest = func(*http.Request) (domain.Member, error) { return f.coder, nil }
	f.do(t, "POST", "/api/v1/routines", body, 403, nil)
	f.do(t, "DELETE", "/api/v1/routines/daily-debrief", "", 403, nil)
	f.h.actorForRequest = nil
	if len(fake.list) != 1 {
		t.Fatal("an agent changed the routines")
	}

	var made domain.Routine
	f.do(t, "POST", "/api/v1/routines", body, 201, &made)
	if made.Source != "app" || made.CreatedBy != f.human.ID || len(fake.list) != 2 {
		t.Fatalf("made %+v", made)
	}

	// Input the app refuses is a 400 with its text; a lanes.toml name is a 409.
	var failure struct {
		Error struct{ Message string } `json:"error"`
	}
	f.do(t, "POST", "/api/v1/routines", `{"name":"x","prompt":"p","persona":"nobody","channel":"general","schedule":"0 9 * * *"}`, 400, &failure)
	if !strings.Contains(failure.Error.Message, "@nobody") {
		t.Fatalf("refusal text %q", failure.Error.Message)
	}
	f.do(t, "POST", "/api/v1/routines", `{"name":"Daily debrief","prompt":"p","persona":"coder","channel":"general","schedule":"0 9 * * *"}`, 409, &failure)
	if !strings.Contains(failure.Error.Message, "lanes.toml") {
		t.Fatalf("clash text %q", failure.Error.Message)
	}
	f.do(t, "POST", "/api/v1/routines", `{"name":"x","prompt":"p","persona":"coder","channel":"nowhere","schedule":"0 9 * * *"}`, 400, nil)
	f.do(t, "POST", "/api/v1/routines", `{"name":"x","bogus":1}`, 400, nil)

	// A channel the caller cannot see answers as if it did not exist.
	secret := domain.Channel{ID: store.NewID(), Name: "secret", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPrivate, MemberIDs: []string{f.coder.ID, f.review.ID}}
	if _, err := f.h.Store.Append(context.Background(), events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: secret.ID, Payload: secret}); err != nil {
		t.Fatal(err)
	}
	f.do(t, "POST", "/api/v1/routines", `{"name":"x","prompt":"p","persona":"coder","channel":"secret","schedule":"0 9 * * *"}`, 400, nil)
	if len(fake.list) != 2 {
		t.Fatalf("a routine was made in a hidden channel: %+v", fake.list)
	}

	f.do(t, "DELETE", "/api/v1/routines/made", "", 204, nil)
	f.do(t, "DELETE", "/api/v1/routines/daily-debrief", "", 409, &failure)
	if !strings.Contains(failure.Error.Message, "lanes.toml") {
		t.Fatalf("delete refusal %q", failure.Error.Message)
	}
	f.do(t, "DELETE", "/api/v1/routines/missing", "", 404, nil)
}

func TestRoutineEndpoints(t *testing.T) {
	f := newOrgFixture(t)
	fake := &fakeRoutines{list: []domain.Routine{{Handle: "daily-debrief", Name: "Daily debrief", Persona: "coder", Channel: "general", Schedule: "0 18 * * *", Enabled: true}}}
	f.h.Routines = fake

	var list []domain.Routine
	f.do(t, "GET", "/api/v1/routines", "", 200, &list)
	if len(list) != 1 || list[0].Handle != "daily-debrief" {
		t.Fatalf("list %+v", list)
	}

	// Only a human switches or runs routines.
	f.h.actorForRequest = func(*http.Request) (domain.Member, error) { return f.coder, nil }
	f.do(t, "PATCH", "/api/v1/routines/daily-debrief", `{"enabled":false}`, 403, nil)
	f.do(t, "POST", "/api/v1/routines/daily-debrief/run", "", 403, nil)
	f.h.actorForRequest = nil
	if !fake.list[0].Enabled || len(fake.ran) != 0 {
		t.Fatal("an agent changed a routine")
	}

	var got domain.Routine
	f.do(t, "PATCH", "/api/v1/routines/daily-debrief", `{"enabled":false}`, 200, &got)
	if got.Enabled {
		t.Fatalf("still enabled: %+v", got)
	}
	f.do(t, "PATCH", "/api/v1/routines/daily-debrief", `{}`, 400, nil)
	f.do(t, "PATCH", "/api/v1/routines/missing", `{"enabled":true}`, 404, nil)

	f.do(t, "POST", "/api/v1/routines/daily-debrief/run", "", 202, nil)
	if !slices.Equal(fake.ran, []string{"daily-debrief"}) {
		t.Fatalf("ran %v", fake.ran)
	}
	f.do(t, "POST", "/api/v1/routines/missing/run", "", 404, nil)

	// A refusal the person should read comes back as a conflict with its text.
	fake.runErr = domain.UserError{Message: "lane claude/opus is in conserve"}
	var failure struct {
		Error struct{ Message string } `json:"error"`
	}
	f.do(t, "POST", "/api/v1/routines/daily-debrief/run", "", 409, &failure)
	if !strings.Contains(failure.Error.Message, "conserve") {
		t.Fatalf("refusal text %q", failure.Error.Message)
	}
}

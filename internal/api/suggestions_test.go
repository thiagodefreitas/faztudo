package api

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func fileSuggestion(t *testing.T, f *threadFixture, channelID, title string) domain.Suggestion {
	t.Helper()
	v := domain.Suggestion{ID: store.NewID(), ChannelID: channelID, Persona: "coder", RunID: store.NewID(), Title: title, Detail: "It breaks on **Tuesdays**.", Evidence: []string{"internal/x.go:12", "https://example.com/issues/3"}, State: domain.SuggestionOpen, CreatedAt: time.Now().UTC()}
	if _, err := f.h.Store.FileSuggestion(context.Background(), v, 5, events.Agent(f.coder.ID)); err != nil {
		t.Fatal(err)
	}
	return v
}

func eventsOfType(t *testing.T, f *threadFixture, typ events.Type) []events.Event {
	t.Helper()
	all, err := f.h.Store.EventsAfter(context.Background(), 0, 500)
	if err != nil {
		t.Fatal(err)
	}
	var out []events.Event
	for _, e := range all {
		if e.Type == typ {
			out = append(out, e)
		}
	}
	return out
}

func TestSuggestionsListAndAuth(t *testing.T) {
	f := newThreadFixture(t)
	f.h.Tasks = &fakeTasks{}
	a := fileSuggestion(t, f, f.team.ID, "First")
	fileSuggestion(t, f, f.team.ID, "Second")
	var open []domain.Suggestion
	f.do(t, "GET", "/api/v1/suggestions?state=open", "", 200, &open)
	if len(open) != 2 || open[0].Title != "Second" || open[1].ID != a.ID {
		t.Fatalf("newest first: %+v", open)
	}
	f.do(t, "GET", "/api/v1/suggestions?state=bogus", "", 400, nil)
	var none []domain.Suggestion
	f.do(t, "GET", "/api/v1/suggestions?state=dismissed", "", 200, &none)
	if len(none) != 0 {
		t.Fatalf("dismissed: %+v", none)
	}
	// An agent can read and resolve nothing.
	f.h.actorForRequest = func(*http.Request) (domain.Member, error) { return f.coder, nil }
	for _, tc := range []struct{ method, url, body string }{
		{"GET", "/api/v1/suggestions", ""},
		{"POST", "/api/v1/suggestions/" + a.ID + "/accept", `{}`},
		{"POST", "/api/v1/suggestions/" + a.ID + "/dismiss", `{"reason":"x"}`},
	} {
		f.do(t, tc.method, tc.url, tc.body, 403, nil)
	}
	f.h.actorForRequest = nil
	f.do(t, "POST", "/api/v1/suggestions/nope/accept", `{}`, 404, nil)
	var still []domain.Suggestion
	f.do(t, "GET", "/api/v1/suggestions?state=open", "", 200, &still)
	if len(still) != 2 {
		t.Fatalf("an agent changed state: %+v", still)
	}
}

func TestAcceptSuggestionMakesATask(t *testing.T) {
	f := newThreadFixture(t)
	fake := &fakeTasks{}
	f.h.Tasks = fake
	v := fileSuggestion(t, f, f.team.ID, "Fix the flaky job")
	var got domain.Suggestion
	f.do(t, "POST", "/api/v1/suggestions/"+v.ID+"/accept", `{"assignee":"tester"}`, 200, &got)
	if got.State != domain.SuggestionAccepted || got.TaskID != "t-new" || got.ResolvedBy != f.human.ID || got.ResolvedAt == nil {
		t.Fatalf("accepted: %+v", got)
	}
	if fake.channel != f.team.ID || fake.created.Title != v.Title || fake.created.Assignee != "tester" {
		t.Fatalf("task: channel %q input %+v", fake.channel, fake.created)
	}
	for _, want := range []string{"Tuesdays", "Evidence:", "- internal/x.go:12", "- https://example.com/issues/3"} {
		if !strings.Contains(fake.created.Body, want) {
			t.Errorf("task body lacks %q: %q", want, fake.created.Body)
		}
	}
	// Once only: a second accept or a dismissal of a resolved one conflicts and makes no second task.
	f.do(t, "POST", "/api/v1/suggestions/"+v.ID+"/accept", `{}`, 409, nil)
	f.do(t, "POST", "/api/v1/suggestions/"+v.ID+"/dismiss", `{"reason":"late"}`, 409, nil)
	if len(fake.list) != 1 {
		t.Fatalf("%d tasks", len(fake.list))
	}
	if lessons, _ := f.h.Store.Lessons(context.Background(), "coder"); len(lessons) != 0 {
		t.Fatalf("accepting taught a lesson: %+v", lessons)
	}
	ev := eventsOfType(t, f, events.SuggestionResolved)
	if len(ev) != 1 || ev[0].Actor != events.Human(f.human.ID) || ev[0].ChannelID != f.team.ID {
		t.Fatalf("resolved events: %+v", ev)
	}
}

func TestAcceptDefaultsToThePersonaAndKeepsOpenWhenTheTaskFails(t *testing.T) {
	f := newThreadFixture(t)
	fake := &fakeTasks{}
	f.h.Tasks = fake
	v := fileSuggestion(t, f, f.team.ID, "Something")
	f.do(t, "POST", "/api/v1/suggestions/"+v.ID+"/accept", ``, 200, nil)
	if fake.created.Assignee != "coder" {
		t.Fatalf("assignee %q", fake.created.Assignee)
	}
	w := fileSuggestion(t, f, f.team.ID, "Other")
	fake.err = domain.UserError{Message: "agent @ghost does not exist"}
	f.do(t, "POST", "/api/v1/suggestions/"+w.ID+"/accept", `{"assignee":"ghost"}`, 400, nil)
	var open []domain.Suggestion
	f.do(t, "GET", "/api/v1/suggestions?state=open", "", 200, &open)
	if len(open) != 1 || open[0].ID != w.ID {
		t.Fatalf("a failed accept must leave it open: %+v", open)
	}
}

func TestDismissSuggestionTeachesALesson(t *testing.T) {
	f := newThreadFixture(t)
	f.h.Tasks = &fakeTasks{}
	v := fileSuggestion(t, f, f.team.ID, "Rename a variable")
	var got domain.Suggestion
	f.do(t, "POST", "/api/v1/suggestions/"+v.ID+"/dismiss", `{"reason":"  style nits   are\nnot worth a task "}`, 200, &got)
	if got.State != domain.SuggestionDismissed || got.Reason != "style nits are not worth a task" || got.ResolvedBy != f.human.ID {
		t.Fatalf("dismissed: %+v", got)
	}
	lessons, err := f.h.Store.Lessons(context.Background(), "coder")
	if err != nil || len(lessons) != 1 {
		t.Fatalf("lessons %+v, %v", lessons, err)
	}
	if lessons[0].Text != "Do not suggest: style nits are not worth a task" || lessons[0].ChannelID != f.team.ID || lessons[0].CreatedBy != f.human.ID {
		t.Fatalf("lesson: %+v", lessons[0])
	}
	if added := eventsOfType(t, f, events.LessonAdded); len(added) != 1 {
		t.Fatalf("lesson.added events: %d", len(added))
	}
	f.do(t, "POST", "/api/v1/suggestions/"+v.ID+"/dismiss", `{"reason":"again"}`, 409, nil)
	if lessons, _ := f.h.Store.Lessons(context.Background(), "coder"); len(lessons) != 1 {
		t.Fatalf("a repeated dismissal added a lesson: %d", len(lessons))
	}
}

func TestDismissWithoutReasonTeachesNothing(t *testing.T) {
	f := newThreadFixture(t)
	f.h.Tasks = &fakeTasks{}
	v := fileSuggestion(t, f, f.team.ID, "Anything")
	f.do(t, "POST", "/api/v1/suggestions/"+v.ID+"/dismiss", `{"reason":"   "}`, 200, nil)
	if lessons, _ := f.h.Store.Lessons(context.Background(), ""); len(lessons) != 0 {
		t.Fatalf("lessons: %+v", lessons)
	}
	w := fileSuggestion(t, f, f.team.ID, "Long reason")
	f.do(t, "POST", "/api/v1/suggestions/"+w.ID+"/dismiss", `{"reason":"`+strings.Repeat("x", 401)+`"}`, 400, nil)
	f.do(t, "POST", "/api/v1/suggestions/"+w.ID+"/dismiss", `{"reason":"`+strings.Repeat("x", 400)+`"}`, 200, nil)
}

func TestSuggestionsInPrivateChannelAreHidden(t *testing.T) {
	f := newThreadFixture(t)
	f.h.Tasks = &fakeTasks{}
	other := domain.Member{ID: store.NewID(), Handle: "other", Kind: domain.MemberHuman}
	private := domain.Channel{ID: store.NewID(), Name: "secret-scout", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPrivate, MemberIDs: []string{other.ID}}
	for _, d := range []events.Draft{
		{Type: events.MemberUpdated, Payload: other},
		{Type: events.ChannelCreated, ChannelID: private.ID, Payload: private},
	} {
		d.Actor = events.System
		if _, err := f.h.Store.Append(context.Background(), d); err != nil {
			t.Fatal(err)
		}
	}
	v := fileSuggestion(t, f, private.ID, "Hidden")
	var list []domain.Suggestion
	f.do(t, "GET", "/api/v1/suggestions", "", 200, &list)
	if len(list) != 0 {
		t.Fatalf("listed a private suggestion: %+v", list)
	}
	f.do(t, "POST", "/api/v1/suggestions/"+v.ID+"/accept", `{}`, 404, nil)
	f.do(t, "POST", "/api/v1/suggestions/"+v.ID+"/dismiss", `{}`, 404, nil)
}

func TestSuggestionsRebuildFromTheLog(t *testing.T) {
	f := newThreadFixture(t)
	f.h.Tasks = &fakeTasks{}
	v := fileSuggestion(t, f, f.team.ID, "Rebuilt")
	f.do(t, "POST", "/api/v1/suggestions/"+v.ID+"/dismiss", `{"reason":"no"}`, 200, nil)
	if err := f.h.Store.Rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, err := f.h.Store.Suggestion(context.Background(), v.ID)
	if err != nil || got.State != domain.SuggestionDismissed || got.Reason != "no" {
		t.Fatalf("after rebuild: %+v, %v", got, err)
	}
}

package api

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestLessonsAPIAuthVisibilityAndEvents(t *testing.T) {
	f := newThreadFixture(t)
	path := "/api/v1/lessons"
	f.do(t, "POST", path, `{"persona":"unknown","text":"thing"}`, 400, nil)
	f.do(t, "POST", path, `{"persona":"coder","text":"  "}`, 400, nil)
	f.do(t, "POST", path, `{"persona":"coder","text":"`+strings.Repeat("x", 501)+`"}`, 400, nil)
	var source domain.Message
	f.do(t, "POST", "/api/v1/channels/"+f.team.ID+"/messages", `{"body":"source"}`, 201, &source)
	var global domain.Lesson
	f.do(t, "POST", path, `{"persona":"coder","text":"  Keep caf\u00e9  ","source_message_id":"`+source.ID+`"}`, 201, &global)
	if global.Text != "Keep café" || global.CreatedBy != f.human.ID || global.ChannelID != "" {
		t.Fatalf("global lesson: %+v", global)
	}
	var scoped domain.Lesson
	f.do(t, "POST", path, `{"persona":"coder","text":"Check tests","channel_id":"`+f.team.ID+`","source_message_id":"`+source.ID+`"}`, 201, &scoped)
	var list []domain.Lesson
	f.do(t, "GET", path+"?persona=coder", "", 200, &list)
	if len(list) != 2 || list[0].ID != scoped.ID {
		t.Fatalf("newest first: %+v", list)
	}
	var changed domain.Lesson
	f.do(t, "PATCH", path+"/"+scoped.ID, `{"text":"  Check vet  ","channel_id":""}`, 200, &changed)
	if changed.Text != "Check vet" || changed.ChannelID != "" || changed.SourceMessageID != "" {
		t.Fatalf("changed: %+v", changed)
	}
	f.do(t, "DELETE", path+"/"+scoped.ID, "", 204, nil)
	f.do(t, "PATCH", path+"/"+scoped.ID, `{"text":"lost"}`, 404, nil)
	f.h.actorForRequest = func(*http.Request) (domain.Member, error) { return f.coder, nil }
	for _, tc := range []struct{ method, url, body string }{
		{"GET", path, ""}, {"POST", path, `{"persona":"coder","text":"x"}`},
		{"PATCH", path + "/" + global.ID, `{"text":"x"}`}, {"DELETE", path + "/" + global.ID, ""},
	} {
		f.do(t, tc.method, tc.url, tc.body, 403, nil)
	}
	f.h.actorForRequest = nil
	evs, err := f.h.Store.EventsAfter(context.Background(), 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[events.Type]bool{}
	for _, e := range evs {
		if e.Type == events.LessonAdded || e.Type == events.LessonUpdated || e.Type == events.LessonRemoved {
			if e.Actor != events.Human(f.human.ID) {
				t.Fatalf("actor: %q", e.Actor)
			}
			seen[e.Type] = true
		}
	}
	if !seen[events.LessonAdded] || !seen[events.LessonUpdated] || !seen[events.LessonRemoved] {
		t.Fatalf("missing events: %+v", seen)
	}
}

func TestLessonsPrivateChannelHidden(t *testing.T) {
	f := newThreadFixture(t)
	other := domain.Member{ID: store.NewID(), Handle: "other", Kind: domain.MemberHuman}
	private := domain.Channel{ID: store.NewID(), Name: "secret-lessons", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPrivate, MemberIDs: []string{other.ID}}
	for _, d := range []events.Draft{
		{Type: events.MemberUpdated, Payload: other},
		{Type: events.ChannelCreated, ChannelID: private.ID, Payload: private},
	} {
		d.Actor = events.System
		if _, err := f.h.Store.Append(context.Background(), d); err != nil {
			t.Fatal(err)
		}
	}
	f.do(t, "POST", "/api/v1/lessons", `{"persona":"coder","text":"secret","channel_id":"`+private.ID+`"}`, 404, nil)
	f.h.actorForRequest = func(*http.Request) (domain.Member, error) { return other, nil }
	var source domain.Message
	f.do(t, "POST", "/api/v1/channels/"+private.ID+"/messages", `{"body":"private source"}`, 201, &source)
	f.do(t, "POST", "/api/v1/lessons", `{"persona":"coder","text":"global","source_message_id":"`+source.ID+`"}`, 400, nil)
	var v domain.Lesson
	f.do(t, "POST", "/api/v1/lessons", `{"persona":"coder","text":"secret","channel_id":"`+private.ID+`","source_message_id":"`+source.ID+`"}`, 201, &v)
	f.h.actorForRequest = nil
	var list []domain.Lesson
	f.do(t, "GET", "/api/v1/lessons", "", 200, &list)
	if len(list) != 0 {
		t.Fatalf("private lesson listed: %+v", list)
	}
	f.do(t, "PATCH", "/api/v1/lessons/"+v.ID, `{"text":"peek"}`, 404, nil)
	f.do(t, "DELETE", "/api/v1/lessons/"+v.ID, "", 404, nil)
	f.h.actorForRequest = func(*http.Request) (domain.Member, error) { return other, nil }
	f.do(t, "GET", "/api/v1/lessons", "", 200, &list)
	if len(list) != 1 || list[0].ID != v.ID {
		t.Fatalf("member lessons: %+v", list)
	}
}

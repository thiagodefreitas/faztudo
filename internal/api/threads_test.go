package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

type threadFixture struct {
	h             *API
	trigger       *countTrigger
	human         domain.Member
	coder, review domain.Member
	team, dm, dm2 domain.Channel
}

func newThreadFixture(t *testing.T) *threadFixture {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	f := &threadFixture{trigger: &countTrigger{}}
	f.human = domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: "user", DisplayName: "User"}
	f.coder = domain.Member{ID: store.NewID(), Kind: domain.MemberAgent, Handle: "coder", DisplayName: "Coder"}
	f.review = domain.Member{ID: store.NewID(), Kind: domain.MemberAgent, Handle: "reviewer", DisplayName: "Reviewer"}
	f.team = domain.Channel{ID: store.NewID(), Name: "general", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic, MemberIDs: []string{f.human.ID, f.coder.ID}}
	f.dm = domain.Channel{ID: store.NewID(), Name: "dm-coder", Kind: domain.ChannelDirect, Visibility: domain.VisibilityDirect, MemberIDs: []string{f.human.ID, f.coder.ID}}
	f.dm2 = domain.Channel{ID: store.NewID(), Name: "dm-both", Kind: domain.ChannelDirect, Visibility: domain.VisibilityDirect, MemberIDs: []string{f.human.ID, f.coder.ID, f.review.ID}}
	for _, m := range []domain.Member{f.human, f.coder, f.review} {
		if _, err = s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: m}); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []domain.Channel{f.team, f.dm, f.dm2} {
		if _, err = s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: c.ID, Payload: c}); err != nil {
			t.Fatal(err)
		}
	}
	f.h = New(s, f.human.ID, "test")
	f.h.Trigger = f.trigger
	return f
}

func (f *threadFixture) do(t *testing.T, method, path, body string, want int, out any) {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.RemoteAddr = "127.0.0.1:1234"
	req.Host = "127.0.0.1"
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)
	if rec.Code != want {
		t.Fatalf("%s %s: status %d, want %d: %s", method, path, rec.Code, want, rec.Body.String())
	}
	if out != nil {
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			t.Fatal(err)
		}
	}
}

func TestThreadRepliesStayOutOfChannelList(t *testing.T) {
	f := newThreadFixture(t)
	base := "/api/v1/channels/" + f.team.ID + "/messages"
	var root, reply, nested domain.Message
	f.do(t, "POST", base, `{"body":"root"}`, 201, &root)
	f.do(t, "POST", base, `{"body":"reply","thread_id":"`+root.ID+`"}`, 201, &reply)
	f.do(t, "POST", base, `{"body":"nested","thread_id":"`+reply.ID+`"}`, 201, &nested)
	if nested.ThreadID != root.ID {
		t.Fatalf("nested reply attached to %q, want root %q", nested.ThreadID, root.ID)
	}
	var list []domain.Message
	f.do(t, "GET", base, "", 200, &list)
	if len(list) != 1 || list[0].ID != root.ID || list[0].ReplyCount != 2 {
		t.Fatalf("channel list %+v", list)
	}
	var thread []domain.Message
	f.do(t, "GET", "/api/v1/messages/"+root.ID+"/thread", "", 200, &thread)
	if len(thread) != 3 {
		t.Fatalf("thread %+v", thread)
	}
}

func TestDirectChannelSoleAgentIsTriggered(t *testing.T) {
	f := newThreadFixture(t)
	post := func(ch domain.Channel, body string) {
		f.do(t, "POST", "/api/v1/channels/"+ch.ID+"/messages", `{"body":"`+body+`"}`, 201, nil)
	}
	post(f.dm, "no mention here")
	if f.trigger.count != 1 {
		t.Fatalf("sole-agent DM trigger count %d", f.trigger.count)
	}
	post(f.team, "no mention in a team channel")
	if f.trigger.count != 1 {
		t.Fatalf("team channel without mention triggered: %d", f.trigger.count)
	}
	post(f.dm2, "two agents, no mention")
	if f.trigger.count != 1 {
		t.Fatalf("ambiguous DM triggered: %d", f.trigger.count)
	}
	post(f.dm2, "@reviewer look")
	if f.trigger.count != 2 {
		t.Fatalf("explicit mention in DM: %d", f.trigger.count)
	}
}

func TestStatusCommandAnswersWithoutAnAgent(t *testing.T) {
	f := newThreadFixture(t)
	lane := domain.Lane{ID: "codex/default", CLI: "codex", Capacity: 2, Health: domain.LaneConserve}
	if _, err := f.h.Store.Append(context.Background(), events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: lane}); err != nil {
		t.Fatal(err)
	}
	f.do(t, "POST", "/api/v1/channels/"+f.team.ID+"/messages", `{"body":"/status"}`, 201, nil)
	if f.trigger.count != 0 {
		t.Fatalf("/status started %d agent run(s)", f.trigger.count)
	}
	evs, err := f.h.Store.EventsAfter(context.Background(), 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range evs {
		if e.Type == events.Notice && e.ChannelID == f.team.ID {
			var p events.NoticePayload
			if err := json.Unmarshal(e.Payload, &p); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(p.Text, "0 active run(s)") || !strings.Contains(p.Text, "codex/default: conserve, 0/2 running") {
				t.Fatalf("status text:\n%s", p.Text)
			}
			return
		}
	}
	t.Fatal("no status notice posted")
}

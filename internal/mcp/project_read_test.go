package mcp

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/org"
)

func (f *delegateFixture) add(t *testing.T, typ events.Type, channel string, payload any) {
	t.Helper()
	if _, err := f.s.Append(context.Background(), events.Draft{Type: typ, Actor: events.System, ChannelID: channel, Payload: payload}); err != nil {
		t.Fatal(err)
	}
}

// post puts a message in a channel, a little later than the one before.
func (f *delegateFixture) post(t *testing.T, id, channel, thread, author, body string, age time.Duration) domain.Message {
	t.Helper()
	m := domain.Message{ID: id, ChannelID: channel, ThreadID: thread, AuthorID: author, Body: body, Mentions: []string{}, CreatedAt: time.Now().UTC().Add(-age)}
	f.add(t, events.MessagePosted, channel, m)
	return m
}

// projectWorld has project "alpha" with #room and #alpha-dev, a private
// #alpha-priv that the agents are not in, project "beta" with #beta-dev, and a
// direct channel between ada and someone else.
func projectWorld(t *testing.T) *delegateFixture {
	t.Helper()
	f := newDelegateFixture(t, org.Limits{MaxRuns: 5, MaxPremium: 2})
	f.add(t, events.ChannelCreated, "alpha-dev", domain.Channel{ID: "alpha-dev", Name: "alpha-dev", Kind: domain.ChannelProject, Visibility: domain.VisibilityPublic, MemberIDs: []string{"ada"}})
	f.add(t, events.ChannelCreated, "alpha-priv", domain.Channel{ID: "alpha-priv", Name: "alpha-priv", Kind: domain.ChannelProject, Visibility: domain.VisibilityPrivate, MemberIDs: []string{"ada"}})
	f.add(t, events.ChannelCreated, "beta-dev", domain.Channel{ID: "beta-dev", Name: "beta-dev", Kind: domain.ChannelProject, Visibility: domain.VisibilityPublic, MemberIDs: []string{"ada"}})
	f.add(t, events.ChannelCreated, "dm", domain.Channel{ID: "dm", Name: "dm-ada-bob", Kind: domain.ChannelDirect, Visibility: domain.VisibilityDirect, MemberIDs: []string{"ada", "bob"}})
	f.add(t, events.ProjectUpdated, "", domain.Project{Handle: "alpha", Name: "Alpha", Channels: []string{"room", "alpha-dev", "alpha-priv"}, Departments: []string{}, Specialists: []string{"coder", "writer", "chief"}})
	f.add(t, events.ProjectUpdated, "", domain.Project{Handle: "beta", Name: "Beta", Channels: []string{"beta-dev"}, Departments: []string{}, Specialists: []string{}})
	f.post(t, "a-dev", "alpha-dev", "", "ada", "the parser decision is to use pratt parsing", time.Hour)
	f.post(t, "a-priv", "alpha-priv", "", "ada", "parser secret in a private channel", time.Hour)
	f.post(t, "b-dev", "beta-dev", "", "ada", "parser notes for the other project", time.Hour)
	f.post(t, "dm-1", "dm", "", "ada", "parser words in a direct message", time.Hour)
	return f
}

func callTool[T any](t *testing.T, s *sdkmcp.ClientSession, name string, args map[string]any) (T, string, bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := s.CallTool(ctx, &sdkmcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatal(err)
	}
	if res.IsError {
		var zero T
		return zero, toolText(res), true
	}
	return decode[T](t, res), "", false
}

func TestReadableChannelsRule(t *testing.T) {
	f := projectWorld(t)
	grant := Grant{RunID: "r", AgentID: "coder", ChannelID: "room"}
	got, err := f.h.readableChannels(context.Background(), grant, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got["room"].ID == "" || got["alpha-dev"].ID == "" {
		t.Fatalf("want room and alpha-dev only, got %v", got)
	}
	// An archived project: own channel for reading, nothing for search.
	f.add(t, events.ProjectUpdated, "", domain.Project{Handle: "alpha", Name: "Alpha", Channels: []string{"room", "alpha-dev", "alpha-priv"}, Departments: []string{}, Specialists: []string{}, Archived: true})
	got, _ = f.h.readableChannels(context.Background(), grant, false)
	if len(got) != 1 || got["room"].ID == "" {
		t.Fatalf("archived project, read: %v", got)
	}
	got, _ = f.h.readableChannels(context.Background(), grant, true)
	if len(got) != 0 {
		t.Fatalf("archived project, search: %v", got)
	}
}

func TestSearchStaysInsideTheProject(t *testing.T) {
	f := projectWorld(t)
	s := f.session(t, "run-coder", "coder", f.root.ID)
	out, _, isErr := callTool[searchOut](t, s, "search_messages", map[string]any{"query": "parser"})
	if isErr {
		t.Fatal("search failed")
	}
	if len(out.Hits) != 1 || out.Hits[0].ID != "a-dev" || out.Hits[0].Channel != "alpha-dev" || out.Hits[0].Author != "ada" {
		t.Fatalf("hits %+v", out.Hits)
	}
}

func TestSearchNewestFirstLimitedAndClipped(t *testing.T) {
	f := projectWorld(t)
	for i := 0; i < 5; i++ {
		f.post(t, fmt.Sprintf("n%d", i), "room", "", "ada", fmt.Sprintf("needle %d %s", i, strings.Repeat("x", 2000)), time.Duration(5-i)*time.Minute)
	}
	s := f.session(t, "run-coder", "coder", f.root.ID)
	out, _, _ := callTool[searchOut](t, s, "search_messages", map[string]any{"query": "needle", "limit": 3})
	if len(out.Hits) != 3 || out.Hits[0].ID != "n4" || out.Hits[2].ID != "n2" {
		t.Fatalf("hits %+v", out.Hits)
	}
	if n := len([]rune(out.Hits[0].Body)); n > maxSearchBodyRune+3 {
		t.Fatalf("body not clipped: %d runes", n)
	}
	if _, msg, isErr := callTool[searchOut](t, s, "search_messages", map[string]any{"query": "needle", "limit": 31}); !isErr || !strings.Contains(msg, "limit") {
		t.Fatalf("limit 31 accepted: %q", msg)
	}
}

func TestReadThreadOrderLimitAndScope(t *testing.T) {
	f := projectWorld(t)
	f.post(t, "t1", "alpha-dev", "a-dev", "ada", "second", 50*time.Minute)
	f.post(t, "t2", "alpha-dev", "a-dev", "ada", "third", 40*time.Minute)
	s := f.session(t, "run-coder", "coder", f.root.ID)

	out, _, isErr := callTool[threadOut](t, s, "read_thread", map[string]any{"thread_id": "t2"})
	if isErr || len(out.Messages) != 3 || out.Messages[0].ID != "a-dev" || out.Messages[2].ID != "t2" {
		t.Fatalf("thread %+v err=%v", out, isErr)
	}
	out, _, _ = callTool[threadOut](t, s, "read_thread", map[string]any{"thread_id": "a-dev", "limit": 2})
	if len(out.Messages) != 2 || !out.Truncated {
		t.Fatalf("limit not applied: %+v", out)
	}
	for _, id := range []string{"b-dev", "a-priv", "dm-1", "missing"} {
		if _, msg, isErr := callTool[threadOut](t, s, "read_thread", map[string]any{"thread_id": id}); !isErr || msg != "thread not found" {
			t.Fatalf("%s: err=%v %q", id, isErr, msg)
		}
	}
}

func TestReadThreadOutputIsCapped(t *testing.T) {
	f := projectWorld(t)
	f.post(t, "a-dev-room", "room", "", "ada", "root", time.Hour)
	for i := 0; i < 30; i++ {
		f.post(t, fmt.Sprintf("big%02d", i), "room", "a-dev-room", "ada", strings.Repeat("y", 6000), time.Duration(30-i)*time.Second)
	}
	s := f.session(t, "run-coder", "coder", f.root.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := s.CallTool(ctx, &sdkmcp.CallToolParams{Name: "read_thread", Arguments: map[string]any{"thread_id": "a-dev-room"}})
	if err != nil || res.IsError {
		t.Fatalf("%v %s", err, toolText(res))
	}
	out := decode[threadOut](t, res)
	if !out.Truncated || len(toolText(res)) > 40<<10 {
		t.Fatalf("truncated=%v size=%d", out.Truncated, len(toolText(res)))
	}
}

func TestListHandoffsShowsOnlyThisRequest(t *testing.T) {
	f := projectWorld(t)
	own := domain.Handoff{RequestID: f.root.ID, From: "chief", To: "coder", Depth: 1}
	m1 := f.handoffMessage(t, "h1", own)
	f.handoffMessage(t, "h-other", domain.Handoff{RequestID: "another-request", From: "chief", To: "writer", Depth: 1})
	done := domain.Run{ID: "run-done", ChannelID: f.room.ID, TriggerMessageID: m1.ID, AgentID: "coder", LaneID: "std", Mode: domain.RunRead, State: domain.RunDone}
	f.add(t, events.RunCreated, f.room.ID, done)
	reply := domain.Message{ID: "ans2", ChannelID: f.room.ID, ThreadID: f.root.ID, AuthorID: "coder", Body: "the bug is fixed", Mentions: []string{}, RunID: done.ID, CreatedAt: time.Now().UTC()}
	f.add(t, events.MessagePosted, f.room.ID, reply)

	// The lead's run sees its own request's handoff and its finished run.
	s := f.session(t, "run-lead", "chief", f.root.ID)
	out, _, isErr := callTool[handoffsOut](t, s, "list_handoffs", nil)
	if isErr || len(out.Handoffs) != 1 {
		t.Fatalf("lead: %+v", out)
	}
	h := out.Handoffs[0]
	if h.To != "coder" || h.Task != "do it" || h.RunID != "run-done" || h.RunState != "done" || h.Answer != "the bug is fixed" {
		t.Fatalf("handoff %+v", h)
	}
	// A run started by that handoff sees the same request, not the other one.
	s = f.session(t, "run-piece", "coder", m1.ID)
	out, _, isErr = callTool[handoffsOut](t, s, "list_handoffs", nil)
	if isErr || len(out.Handoffs) != 1 || out.Handoffs[0].To != "coder" {
		t.Fatalf("piece: %+v", out)
	}
}

func TestDelegateDoneWhenIsInThePostedTask(t *testing.T) {
	f := projectWorld(t)
	chief := f.session(t, "run-chief", "chief", f.root.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := chief.CallTool(ctx, &sdkmcp.CallToolParams{Name: "delegate", Arguments: map[string]any{"to": "coder", "task": "fix the bug", "done_when": "tests\npass @reviewer"}})
	if err != nil || res.IsError {
		t.Fatalf("%v %s", err, toolText(res))
	}
	out := decode[delegateOut](t, res)
	msg, err := f.s.Message(ctx, out.MessageID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(msg.Body, "fix the bug\n\nDone when: tests pass reviewer") {
		t.Fatalf("body %q", msg.Body)
	}
	res, err = chief.CallTool(ctx, &sdkmcp.CallToolParams{Name: "delegate", Arguments: map[string]any{"to": "coder", "task": "again", "done_when": strings.Repeat("z", 501)}})
	if err != nil || !res.IsError || !strings.Contains(toolText(res), "done_when") {
		t.Fatalf("long done_when accepted: %v %s", err, toolText(res))
	}
}

func TestNewToolsAreListedWithReadOnlyHints(t *testing.T) {
	f := projectWorld(t)
	s := f.session(t, "run-coder", "coder", f.root.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	list, err := s.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, tool := range list.Tools {
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
			continue
		}
		seen[tool.Name] = true
	}
	for _, name := range []string{"read_thread", "search_messages", "list_handoffs"} {
		if !seen[name] {
			t.Errorf("%s missing or without hints", name)
		}
	}
}

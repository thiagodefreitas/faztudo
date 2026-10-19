package mcp

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/org"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

type delegateFixture struct {
	s    *store.Store
	h    *Handler
	trig *recordTrigger
	srv  *httptest.Server
	room domain.Channel
	root domain.Message
	ada  domain.Member
	// agents by handle
	who map[string]domain.Member
}

// newDelegateFixture has a Chief of Staff, an Engineering department led by the
// architect (members architect and coder), a writer on a premium lane, and one
// human request in #room.
func newDelegateFixture(t *testing.T, limits org.Limits) *delegateFixture {
	t.Helper()
	ctx := context.Background()
	s := openStore(t)
	f := &delegateFixture{s: s, trig: &recordTrigger{}, who: map[string]domain.Member{}}
	f.ada = domain.Member{ID: "ada", Kind: domain.MemberHuman, Handle: "ada", DisplayName: "Ada", Presence: domain.PresenceOnline}
	f.room = domain.Channel{ID: "room", Name: "room", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic, MemberIDs: []string{"ada"}}
	f.root = domain.Message{ID: "root", ChannelID: f.room.ID, AuthorID: f.ada.ID, Body: "ship the release notes and fix the bug", Mentions: []string{}, CreatedAt: time.Now().UTC()}
	drafts := []events.Draft{
		{Type: events.MemberUpdated, Payload: f.ada},
		{Type: events.LaneUpdated, Payload: domain.Lane{ID: "std", CLI: "codex", CostClass: domain.CostStandard, Capacity: 1, Windows: []domain.LaneWindow{}}},
		{Type: events.LaneUpdated, Payload: domain.Lane{ID: "prem", CLI: "claude", CostClass: domain.CostPremium, Capacity: 1, Windows: []domain.LaneWindow{}}},
		{Type: events.ChannelCreated, ChannelID: f.room.ID, Payload: f.room},
		{Type: events.MessagePosted, ChannelID: f.room.ID, Payload: f.root},
		{Type: events.DepartmentUpdated, Payload: domain.Department{Handle: "engineering", DisplayName: "Engineering", Lead: "architect", Members: []string{"architect", "coder"}}},
	}
	for handle, lane := range map[string]string{"chief": "std", "architect": "std", "coder": "std", "writer": "prem"} {
		m := domain.Member{ID: handle, Kind: domain.MemberAgent, Handle: handle, DisplayName: handle, Presence: domain.PresenceOnline, Agent: &domain.AgentInfo{Lanes: []string{lane}}}
		f.who[handle] = m
		drafts = append(drafts, events.Draft{Type: events.MemberUpdated, Payload: m})
	}
	for _, d := range drafts {
		d.Actor = events.System
		if _, err := s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	f.h = New(s, f.trig)
	f.h.Policy = Policy{ChiefOfStaff: "chief", Limits: limits}
	f.srv = httptest.NewServer(f.h)
	t.Cleanup(f.srv.Close)
	return f
}

// session starts a run of the agent, triggered by the message, and connects to
// the MCP server with that run's token.
func (f *delegateFixture) session(t *testing.T, runID, handle, trigger string) *sdkmcp.ClientSession {
	t.Helper()
	agent := f.who[handle]
	run := domain.Run{ID: runID, ChannelID: f.room.ID, TriggerMessageID: trigger, AgentID: agent.ID, LaneID: "std", Mode: domain.RunRead, State: domain.RunRunning}
	if _, err := f.s.Append(context.Background(), events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: f.room.ID, Payload: run}); err != nil {
		t.Fatal(err)
	}
	token, err := f.h.Issue(runID, agent.ID, f.room.ID)
	if err != nil {
		t.Fatal(err)
	}
	return connectMCP(t, f.srv.URL+"/mcp", token)
}

func (f *delegateFixture) handoffMessage(t *testing.T, id string, h domain.Handoff) domain.Message {
	t.Helper()
	m := domain.Message{ID: id, ChannelID: f.room.ID, ThreadID: f.root.ID, AuthorID: f.who[h.From].ID, Body: "@" + h.To + " do it", Mentions: []string{f.who[h.To].ID}, Handoff: &h, CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(context.Background(), events.Draft{Type: events.MessagePosted, Actor: events.Agent(m.AuthorID), ChannelID: f.room.ID, Payload: m}); err != nil {
		t.Fatal(err)
	}
	return m
}

func delegateCall(t *testing.T, session *sdkmcp.ClientSession, to, task string) (res *sdkmcp.CallToolResult, text string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := session.CallTool(ctx, &sdkmcp.CallToolParams{Name: "delegate", Arguments: map[string]any{"to": to, "task": task}})
	if err != nil {
		t.Fatal(err)
	}
	return res, toolText(res)
}

func (f *delegateFixture) mustDelegate(t *testing.T, session *sdkmcp.ClientSession, to, task string) delegateOut {
	t.Helper()
	res, text := delegateCall(t, session, to, task)
	if res.IsError {
		t.Fatalf("delegate to %s: %s", to, text)
	}
	return decode[delegateOut](t, res)
}

func TestChiefOfStaffHandsWorkToTheOwnerInAThread(t *testing.T) {
	f := newDelegateFixture(t, org.Limits{MaxRuns: 5, MaxPremium: 2})
	chief := f.session(t, "run-chief", "chief", f.root.ID)
	out := f.mustDelegate(t, chief, "@coder", "fix the bug in the parser")
	if out.To != "coder" || out.Depth != 1 {
		t.Fatalf("result %+v", out)
	}
	if got := f.trig.last(); len(got) != 1 || got[0] != "coder" {
		t.Fatalf("the owner was not started: %v", f.trig.calls)
	}
	msg, err := f.s.Message(context.Background(), out.MessageID)
	if err != nil {
		t.Fatal(err)
	}
	if msg.ThreadID != f.root.ID || msg.AuthorID != "chief" || !strings.HasPrefix(msg.Body, "@coder fix the bug") {
		t.Fatalf("handoff message %+v", msg)
	}
	want := domain.Handoff{RequestID: f.root.ID, From: "chief", To: "coder", Depth: 1}
	if msg.Handoff == nil || *msg.Handoff != want {
		t.Fatalf("handoff %+v, want %+v", msg.Handoff, want)
	}
	evs, err := f.s.EventsAfter(context.Background(), 0, 500)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range evs {
		if e.Type != events.HandoffCreated {
			continue
		}
		var p handoffEvent
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			t.Fatal(err)
		}
		found = p.MessageID == out.MessageID && p.To == "coder" && p.From == "chief" && p.Depth == 1 && e.Actor == events.Agent("chief")
	}
	if !found {
		t.Fatal("no handoff.created event for the handoff")
	}
}

func TestOnlyLeadsAndTheChiefDelegateAndOnlyInsideTheirScope(t *testing.T) {
	f := newDelegateFixture(t, org.Limits{MaxRuns: 9, MaxPremium: 9})
	coder := f.session(t, "run-coder", "coder", f.root.ID)
	if res, text := delegateCall(t, coder, "architect", "x"); !res.IsError || !strings.Contains(text, "only the Chief of Staff and department leads") {
		t.Fatalf("a specialist delegated: %v %q", res.IsError, text)
	}
	lead := f.session(t, "run-lead", "architect", f.root.ID)
	if res, text := delegateCall(t, lead, "writer", "x"); !res.IsError || !strings.Contains(text, "not in a department") {
		t.Fatalf("a lead went outside its department: %v %q", res.IsError, text)
	}
	f.mustDelegate(t, lead, "coder", "implement the plan")
	chief := f.session(t, "run-chief", "chief", f.root.ID)
	if res, _ := delegateCall(t, chief, "chief", "x"); !res.IsError {
		t.Fatal("the chief handed work to itself")
	}
	if res, _ := delegateCall(t, chief, "ada", "x"); !res.IsError {
		t.Fatal("work was handed to a human")
	}
	if res, _ := delegateCall(t, chief, "nobody", "x"); !res.IsError {
		t.Fatal("work was handed to an unknown agent")
	}
	if res, _ := delegateCall(t, chief, "coder", "  "); !res.IsError {
		t.Fatal("an empty task was accepted")
	}
	if n := f.trig.len(); n != 1 {
		t.Fatalf("%d agents were started, want only the lead's coder", n)
	}
}

func TestDelegationDepthIsEnforcedOnTheServer(t *testing.T) {
	f := newDelegateFixture(t, org.Limits{MaxRuns: 9, MaxPremium: 9})
	// The architect was handed this work by the chief, so it is at depth 1 and
	// may split it once more, to depth 2.
	first := f.handoffMessage(t, "h1", domain.Handoff{RequestID: f.root.ID, From: "chief", To: "architect", Depth: 1})
	lead := f.session(t, "run-lead", "architect", first.ID)
	out := f.mustDelegate(t, lead, "coder", "write the tests")
	if out.Depth != 2 {
		t.Fatalf("depth %d, want 2", out.Depth)
	}
	// At depth 2 nobody hands work on, whatever their role: the agent cannot
	// raise the limit by naming a different message or run.
	second := f.handoffMessage(t, "h2", domain.Handoff{RequestID: f.root.ID, From: "chief", To: "architect", Depth: org.MaxDepth})
	deep := f.session(t, "run-deep", "architect", second.ID)
	if res, text := delegateCall(t, deep, "coder", "again"); !res.IsError || !strings.Contains(text, "delegation stops here") {
		t.Fatalf("delegation went past the depth limit: %v %q", res.IsError, text)
	}
	chiefDeep := f.session(t, "run-chief-deep", "chief", second.ID)
	if res, _ := delegateCall(t, chiefDeep, "coder", "again"); !res.IsError {
		t.Fatal("the chief delegated past the depth limit")
	}
	if n := f.trig.len(); n != 1 {
		t.Fatalf("%d agents were started, want 1", n)
	}
}

func TestCollectRunCannotDelegate(t *testing.T) {
	f := newDelegateFixture(t, org.Limits{MaxRuns: 9, MaxPremium: 9})
	msg := domain.Message{ID: "collect", ChannelID: f.room.ID, ThreadID: f.root.ID, AuthorID: f.who["chief"].ID, Body: "Combine the answers", CollectForRunID: "parent", CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(context.Background(), events.Draft{Type: events.MessagePosted, Actor: events.Agent(msg.AuthorID), ChannelID: f.room.ID, Payload: msg}); err != nil {
		t.Fatal(err)
	}
	session := f.session(t, "collect-run", "chief", msg.ID)
	if res, text := delegateCall(t, session, "coder", "Again"); !res.IsError || !strings.Contains(text, "collect run cannot delegate") {
		t.Fatalf("collect delegated: %v %q", res.IsError, text)
	}
	if f.trig.len() != 0 {
		t.Fatal("collect started a handoff")
	}
}

func (f *delegateFixture) cards(t *testing.T) []domain.Message {
	t.Helper()
	msgs, err := f.s.Messages(context.Background(), f.room.ID, "", 100)
	if err != nil {
		t.Fatal(err)
	}
	var out []domain.Message
	for _, m := range msgs {
		if len(m.Options) > 0 {
			out = append(out, m)
		}
	}
	return out
}

func (f *delegateFixture) answer(t *testing.T, card domain.Message, body string) {
	t.Helper()
	reply := domain.Message{ID: store.NewID(), ChannelID: f.room.ID, ThreadID: card.ID, AuthorID: f.ada.ID, Body: body, Mentions: []string{}, CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(context.Background(), events.Draft{Type: events.MessagePosted, Actor: events.Human(f.ada.ID), ChannelID: f.room.ID, Payload: reply}); err != nil {
		t.Fatal(err)
	}
}

func TestRunBudgetAsksTheDirectorWithAChoiceCard(t *testing.T) {
	f := newDelegateFixture(t, org.Limits{MaxRuns: 2, MaxPremium: 1})
	chief := f.session(t, "run-chief", "chief", f.root.ID)
	f.mustDelegate(t, chief, "coder", "one")
	f.mustDelegate(t, chief, "architect", "two")
	res, text := delegateCall(t, chief, "coder", "three")
	if !res.IsError || !strings.Contains(text, "over its budget") {
		t.Fatalf("the third run passed a budget of two: %v %q", res.IsError, text)
	}
	if n := f.trig.len(); n != 2 {
		t.Fatalf("%d agents started, want 2", n)
	}
	cards := f.cards(t)
	if len(cards) != 1 || len(cards[0].Options) != 2 || !strings.Contains(cards[0].Body, "@ada") {
		t.Fatalf("choice cards %+v", cards)
	}
	// Asking again must not post a second card while the first is open.
	if res, text := delegateCall(t, chief, "coder", "three"); !res.IsError || !strings.Contains(text, "has not answered") {
		t.Fatalf("second try: %v %q", res.IsError, text)
	}
	if len(f.cards(t)) != 1 {
		t.Fatal("a second card was posted")
	}
	// The Director taps A: two more runs.
	f.answer(t, cards[0], "A: "+cards[0].Options[0])
	f.mustDelegate(t, chief, "coder", "three")
	f.mustDelegate(t, chief, "architect", "four")
	if res, _ := delegateCall(t, chief, "coder", "five"); !res.IsError {
		t.Fatal("the extra round was not limited")
	}
	if len(f.cards(t)) != 2 {
		t.Fatalf("want a new card after the extra round, have %d", len(f.cards(t)))
	}
}

func TestDirectorCanStopTheRequest(t *testing.T) {
	f := newDelegateFixture(t, org.Limits{MaxRuns: 1, MaxPremium: 1})
	chief := f.session(t, "run-chief", "chief", f.root.ID)
	f.mustDelegate(t, chief, "coder", "one")
	if res, _ := delegateCall(t, chief, "coder", "two"); !res.IsError {
		t.Fatal("budget not enforced")
	}
	f.answer(t, f.cards(t)[0], "B: Stop here")
	if res, text := delegateCall(t, chief, "coder", "two"); !res.IsError || !strings.Contains(text, "said to stop") {
		t.Fatalf("after Stop: %v %q", res.IsError, text)
	}
}

func TestPremiumRunsHaveTheirOwnBudget(t *testing.T) {
	f := newDelegateFixture(t, org.Limits{MaxRuns: 5, MaxPremium: 0})
	chief := f.session(t, "run-chief", "chief", f.root.ID)
	// The writer's first lane is premium and none are allowed.
	if res, text := delegateCall(t, chief, "writer", "draft the notes"); !res.IsError || !strings.Contains(text, "over its budget") {
		t.Fatalf("premium run passed: %v %q", res.IsError, text)
	}
	if f.trig.len() != 0 {
		t.Fatal("a premium agent was started over its budget")
	}
	// A standard run is still fine.
	f.mustDelegate(t, chief, "coder", "fix it")
}

func TestBudgetIsPerRequest(t *testing.T) {
	f := newDelegateFixture(t, org.Limits{MaxRuns: 1, MaxPremium: 1})
	other := domain.Message{ID: "root2", ChannelID: f.room.ID, AuthorID: f.ada.ID, Body: "another request", Mentions: []string{}, CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(context.Background(), events.Draft{Type: events.MessagePosted, Actor: events.Human(f.ada.ID), ChannelID: f.room.ID, Payload: other}); err != nil {
		t.Fatal(err)
	}
	a := f.session(t, "run-a", "chief", f.root.ID)
	b := f.session(t, "run-b", "chief", other.ID)
	f.mustDelegate(t, a, "coder", "first request")
	f.mustDelegate(t, b, "coder", "second request")
}

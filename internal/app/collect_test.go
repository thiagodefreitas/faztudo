package app

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/org"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

type collectFixture struct {
	db   string
	s    *store.Store
	a    *App
	root domain.Message
}

func newCollectFixture(t *testing.T) *collectFixture {
	t.Helper()
	f := &collectFixture{db: filepath.Join(t.TempDir(), "db")}
	var err error
	f.s, err = store.Open(f.db)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.s.Close() })
	ctx := context.Background()
	f.root = domain.Message{ID: "root", ChannelID: "room", AuthorID: "human", Body: "Ship the feature", CreatedAt: time.Now().UTC(), Mentions: []string{}}
	for _, d := range []events.Draft{
		{Type: events.MemberUpdated, Payload: domain.Member{ID: "human", Handle: "human", Kind: domain.MemberHuman}},
		{Type: events.MemberUpdated, Payload: domain.Member{ID: "lead", Handle: "lead", Kind: domain.MemberAgent, Agent: &domain.AgentInfo{Lanes: []string{"lane"}, Mode: domain.RunWrite}}},
		{Type: events.MemberUpdated, Payload: domain.Member{ID: "one", Handle: "one", Kind: domain.MemberAgent, Agent: &domain.AgentInfo{Lanes: []string{"lane"}}}},
		{Type: events.MemberUpdated, Payload: domain.Member{ID: "two", Handle: "two", Kind: domain.MemberAgent, Agent: &domain.AgentInfo{Lanes: []string{"lane"}}}},
		{Type: events.ChannelCreated, ChannelID: "room", Payload: domain.Channel{ID: "room", Name: "room", MemberIDs: []string{"human", "lead", "one", "two"}}},
		{Type: events.LaneUpdated, Payload: domain.Lane{ID: "lane", CLI: "codex", Capacity: 1}},
		{Type: events.MessagePosted, ChannelID: "room", Payload: f.root},
	} {
		d.Actor = events.System
		if _, err := f.s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	f.newApp(t, nil)
	return f
}

func (f *collectFixture) newApp(t *testing.T, enabled *bool) {
	t.Helper()
	c := config.Defaults()
	c.Runs.CollectDelegations = enabled
	c.Runs.RequestMaxRuns = 3
	a, err := New(context.Background(), f.s, c, config.Paths{RunsDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	a.queuedDispatch = func(context.Context, domain.Message, domain.Member, string) {}
	f.a = a
}

func (f *collectFixture) addRun(t *testing.T, id, agent, trigger string, state domain.RunState, answer string) {
	t.Helper()
	started := time.Now().UTC()
	r := domain.Run{ID: id, ChannelID: "room", TriggerMessageID: trigger, AgentID: agent, LaneID: "lane", Mode: domain.RunRead, State: state, StartedAt: &started, EndedAt: &started}
	if _, err := f.s.Append(context.Background(), events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: "room", Payload: r}); err != nil {
		t.Fatal(err)
	}
	if answer != "" {
		m := domain.Message{ID: id + "-answer", ChannelID: "room", ThreadID: f.root.ID, AuthorID: agent, Body: answer, RunID: id, CreatedAt: time.Now().UTC()}
		if _, err := f.s.Append(context.Background(), events.Draft{Type: events.MessagePosted, Actor: events.Agent(agent), ChannelID: "room", IdempotencyKey: "run-answer:" + id, Payload: m}); err != nil {
			t.Fatal(err)
		}
	}
}

func (f *collectFixture) handoff(t *testing.T, id, target, task string) {
	t.Helper()
	m := domain.Message{ID: id, ChannelID: "room", ThreadID: f.root.ID, AuthorID: "lead", Body: "@" + target + " " + task, Handoff: &domain.Handoff{RequestID: f.root.ID, From: "lead", To: target, Depth: 1}, CreatedAt: time.Now().UTC()}
	ctx := context.Background()
	if _, err := f.s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Agent("lead"), ChannelID: "room", Payload: m}); err != nil {
		t.Fatal(err)
	}
	p := events.HandoffPayload{Handoff: *m.Handoff, MessageID: id, ParentRunID: "parent", Task: task}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.HandoffCreated, Actor: events.Agent("lead"), ChannelID: "room", Payload: p}); err != nil {
		t.Fatal(err)
	}
}

func TestCollectTwoResultsOnce(t *testing.T) {
	f := newCollectFixture(t)
	f.addRun(t, "parent", "lead", "root", domain.RunDone, "I delegated the pieces.")
	f.handoff(t, "h1", "one", "First piece\nDetails")
	f.handoff(t, "h2", "two", "Second piece")
	f.addRun(t, "r1", "one", "h1", domain.RunDone, "First answer")
	f.addRun(t, "r2", "two", "h2", domain.RunDone, "Second answer")
	for i := 0; i < 2; i++ {
		if err := f.a.collectReady(context.Background(), "room"); err != nil {
			t.Fatal(err)
		}
	}
	runs, err := f.s.Runs(context.Background(), "room", "")
	if err != nil {
		t.Fatal(err)
	}
	var collect domain.Run
	for _, r := range runs {
		if r.TriggerMessageID != "root" && r.TriggerMessageID != "h1" && r.TriggerMessageID != "h2" {
			collect = r
		}
	}
	if collect.ID == "" || collect.Mode != domain.RunRead || collect.State != domain.RunQueued {
		t.Fatalf("collect run: %+v", collect)
	}
	msg, err := f.s.Message(context.Background(), collect.TriggerMessageID)
	if err != nil {
		t.Fatal(err)
	}
	if msg.ThreadID != "root" || msg.CollectForRunID != "parent" || !strings.Contains(msg.Body, "First answer") || !strings.Contains(msg.Body, "Second answer") || !strings.Contains(msg.Body, "First piece [done]") {
		t.Fatalf("collect prompt: %+v", msg)
	}
	log, err := f.s.EventsOfTypes(context.Background(), "room", events.HandoffCollected)
	if err != nil || len(log) != 1 {
		t.Fatalf("collected events: %d, %v", len(log), err)
	}
}

func TestCollectIncludesFailureAndSurvivesReopen(t *testing.T) {
	f := newCollectFixture(t)
	f.addRun(t, "parent", "lead", "root", domain.RunDone, "Delegated.")
	f.handoff(t, "h1", "one", "Working piece")
	f.handoff(t, "h2", "two", "Broken piece")
	f.addRun(t, "r1", "one", "h1", domain.RunDone, "Working answer")
	f.addRun(t, "r2", "two", "h2", domain.RunFailed, "Run failed: quota")
	if err := f.s.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.s, err = store.Open(f.db)
	if err != nil {
		t.Fatal(err)
	}
	f.newApp(t, nil)
	if err := f.a.collectReady(context.Background(), "room"); err != nil {
		t.Fatal(err)
	}
	log, _ := f.s.EventsOfTypes(context.Background(), "room", events.HandoffCollected)
	if len(log) != 1 {
		t.Fatalf("collected: %d", len(log))
	}
	var p events.HandoffCollectedPayload
	if err := json.Unmarshal(log[0].Payload, &p); err != nil {
		t.Fatal(err)
	}
	msg, err := f.s.Message(context.Background(), p.MessageID)
	if err != nil || !strings.Contains(msg.Body, "[failed]") || !strings.Contains(msg.Body, "quota") {
		t.Fatalf("failure digest: %+v %v", msg, err)
	}
	if err := f.s.Close(); err != nil {
		t.Fatal(err)
	}
	f.s, err = store.Open(f.db)
	if err != nil {
		t.Fatal(err)
	}
	f.newApp(t, nil)
	if err := f.a.collectReady(context.Background(), "room"); err != nil {
		t.Fatal(err)
	}
	runs, _ := f.s.Runs(context.Background(), "room", "")
	count := 0
	for _, r := range runs {
		if r.TriggerMessageID == p.MessageID {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("collect runs after reopen: %d", count)
	}
}

func TestCollectSwitchOff(t *testing.T) {
	f := newCollectFixture(t)
	f.addRun(t, "parent", "lead", "root", domain.RunDone, "Delegated.")
	f.handoff(t, "h1", "one", "Piece")
	f.addRun(t, "r1", "one", "h1", domain.RunDone, "Answer")
	off := false
	f.newApp(t, &off)
	if err := f.a.collectReady(context.Background(), "room"); err != nil {
		t.Fatal(err)
	}
	log, _ := f.s.EventsOfTypes(context.Background(), "room", events.HandoffCollected)
	if len(log) != 0 {
		t.Fatalf("collected with switch off: %d", len(log))
	}
}

func TestCollectWaitsForEveryRunOfAHandoff(t *testing.T) {
	f := newCollectFixture(t)
	f.addRun(t, "parent", "lead", "root", domain.RunDone, "Delegated.")
	f.handoff(t, "h1", "one", "Piece")
	f.addRun(t, "r1", "one", "h1", domain.RunRunning, "")
	f.addRun(t, "r2", "one", "h1", domain.RunDone, "Latest answer")
	if err := f.a.collectReady(context.Background(), "room"); err != nil {
		t.Fatal(err)
	}
	log, err := f.s.EventsOfTypes(context.Background(), "room", events.HandoffCollected)
	if err != nil || len(log) != 0 {
		t.Fatalf("collected before all runs finished: %d %v", len(log), err)
	}
}

func TestCollectRefusedHandoff(t *testing.T) {
	f := newCollectFixture(t)
	f.addRun(t, "parent", "lead", "root", domain.RunDone, "Delegated.")
	p := events.HandoffPayload{Handoff: domain.Handoff{RequestID: "root", From: "lead", To: "one", Depth: 1}, ParentRunID: "parent", Task: "Review the release", Refusal: "project archived"}
	if _, err := f.s.Append(context.Background(), events.Draft{Type: events.HandoffCreated, Actor: events.Agent("lead"), ChannelID: "room", Payload: p}); err != nil {
		t.Fatal(err)
	}
	if err := f.a.collectReady(context.Background(), "room"); err != nil {
		t.Fatal(err)
	}
	log, err := f.s.EventsOfTypes(context.Background(), "room", events.HandoffCollected)
	if err != nil || len(log) != 1 {
		t.Fatalf("collected: %d %v", len(log), err)
	}
	var collect events.HandoffCollectedPayload
	if err := json.Unmarshal(log[0].Payload, &collect); err != nil {
		t.Fatal(err)
	}
	m, err := f.s.Message(context.Background(), collect.MessageID)
	if err != nil || !strings.Contains(m.Body, "project archived") || !strings.Contains(m.Body, "[refused]") {
		t.Fatalf("digest: %+v %v", m, err)
	}
}

func TestBudgetCountSurvivesStoreReopen(t *testing.T) {
	f := newCollectFixture(t)
	f.handoff(t, "h1", "one", "Piece")
	if err := f.s.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.s, err = store.Open(f.db)
	if err != nil {
		t.Fatal(err)
	}
	f.newApp(t, nil)
	f.a.MCP.Policy.Limits = org.Limits{MaxRuns: 1, MaxPremium: 1}
	parent := domain.Run{ID: "parent", ChannelID: "room", AgentID: "lead"}
	if err := f.a.MCP.ReserveCollect(context.Background(), parent, "root", false); err == nil {
		t.Fatal("budget reset after reopen")
	}
}

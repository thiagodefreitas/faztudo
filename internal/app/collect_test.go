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
	f.handoffOf(t, "parent", id, target, task)
}

// handoffOf posts a handoff reply and its event naming parent as the run
// that handed the work over; an empty parent writes the pre-collect event
// shape, which carried no parent run.
func (f *collectFixture) handoffOf(t *testing.T, parent, id, target, task string) {
	t.Helper()
	m := domain.Message{ID: id, ChannelID: "room", ThreadID: f.root.ID, AuthorID: "lead", Body: "@" + target + " " + task, RunID: "parent", Handoff: &domain.Handoff{RequestID: f.root.ID, From: "lead", To: target, Depth: 1}, CreatedAt: time.Now().UTC()}
	ctx := context.Background()
	if _, err := f.s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Agent("lead"), ChannelID: "room", Payload: m}); err != nil {
		t.Fatal(err)
	}
	p := events.HandoffPayload{Handoff: *m.Handoff, MessageID: id, ParentRunID: parent, Task: task}
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
	if msg.ThreadID != "root" || msg.CollectForRunID != "parent" || !strings.Contains(msg.Body, "  > First answer") || !strings.Contains(msg.Body, "Second answer") || !strings.Contains(msg.Body, "First piece [done]") {
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

func (f *collectFixture) refusal(t *testing.T, target, task, reason string) {
	t.Helper()
	p := events.HandoffPayload{Handoff: domain.Handoff{RequestID: "root", From: "lead", To: target, Depth: 1}, ParentRunID: "parent", Task: task, Refusal: reason}
	if _, err := f.s.Append(context.Background(), events.Draft{Type: events.HandoffCreated, Actor: events.Agent("lead"), ChannelID: "room", Payload: p}); err != nil {
		t.Fatal(err)
	}
}

func (f *collectFixture) collectedCount(t *testing.T) int {
	t.Helper()
	log, err := f.s.EventsOfTypes(context.Background(), "room", events.HandoffCollected)
	if err != nil {
		t.Fatal(err)
	}
	return len(log)
}

// The parent got every refusal as the tool's error while it ran and
// answered with that in hand, so a request with nothing accepted has no
// follow-up.
func TestCollectSkipsAGroupWithOnlyRefusals(t *testing.T) {
	f := newCollectFixture(t)
	f.addRun(t, "parent", "lead", "root", domain.RunDone, "Nobody was assigned, so I did it myself.")
	f.refusal(t, "one", "Review the release", "project archived")
	f.refusal(t, "two", "Draft the notes", "not assigned")
	if err := f.a.collectReady(context.Background(), "room"); err != nil {
		t.Fatal(err)
	}
	if n := f.collectedCount(t); n != 0 {
		t.Fatalf("collected a request nobody accepted: %d", n)
	}
	if !f.a.collectSettled["parent"] {
		t.Error("a refused-only group is read again on every event")
	}
}

func TestCollectRefusedHandoff(t *testing.T) {
	f := newCollectFixture(t)
	f.addRun(t, "parent", "lead", "root", domain.RunDone, "Delegated.")
	f.refusal(t, "one", "Review the release", "project archived")
	f.handoff(t, "h2", "two", "Draft the notes")
	f.addRun(t, "r2", "two", "h2", domain.RunDone, "Notes drafted")
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

// A handoff event from before collecting existed names no parent run. Its
// request was answered long ago, so an upgrade must not start a follow-up.
func TestCollectIgnoresHandoffsWithoutAParentRun(t *testing.T) {
	f := newCollectFixture(t)
	f.addRun(t, "parent", "lead", "root", domain.RunDone, "Delegated.")
	f.handoffOf(t, "", "h1", "one", "Old piece")
	f.addRun(t, "r1", "one", "h1", domain.RunDone, "Old answer")
	if err := f.a.collectReady(context.Background(), "room"); err != nil {
		t.Fatal(err)
	}
	if n := f.collectedCount(t); n != 0 {
		t.Fatalf("collected a pre-upgrade request: %d", n)
	}
}

// A piece without a run by the time the parent finished never started; the
// digest says so instead of waiting for a run that will not come.
func TestCollectHandoffWithoutARunIsNotStarted(t *testing.T) {
	f := newCollectFixture(t)
	f.addRun(t, "parent", "lead", "root", domain.RunDone, "Delegated.")
	f.handoff(t, "h1", "one", "Piece that ran")
	f.handoff(t, "h2", "two", "Piece that never ran")
	f.addRun(t, "r1", "one", "h1", domain.RunDone, "Ran fine")
	if err := f.a.collectReady(context.Background(), "room"); err != nil {
		t.Fatal(err)
	}
	log, err := f.s.EventsOfTypes(context.Background(), "room", events.HandoffCollected)
	if err != nil || len(log) != 1 {
		t.Fatalf("collected: %d %v", len(log), err)
	}
	var p events.HandoffCollectedPayload
	if err := json.Unmarshal(log[0].Payload, &p); err != nil {
		t.Fatal(err)
	}
	m, err := f.s.Message(context.Background(), p.MessageID)
	if err != nil || !strings.Contains(m.Body, "Piece that never ran [not started]") || !strings.Contains(m.Body, "Ran fine") {
		t.Fatalf("digest: %+v %v", m, err)
	}
}

// A failed parent that another lane retried is answered by the retry, which
// hands its work out again; the failed attempt must not collect as well.
func TestCollectSkipsAFailedParentThatWasRetried(t *testing.T) {
	f := newCollectFixture(t)
	f.addRun(t, "parent", "lead", "root", domain.RunFailed, "")
	f.handoff(t, "h1", "one", "Piece")
	f.addRun(t, "r1", "one", "h1", domain.RunDone, "Answer")
	started := time.Now().UTC()
	retry := domain.Run{ID: "retry", ChannelID: "room", TriggerMessageID: "root", AgentID: "lead", LaneID: "lane", Mode: domain.RunRead, State: domain.RunRunning, RetryOf: "parent", StartedAt: &started}
	if _, err := f.s.Append(context.Background(), events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: "room", Payload: retry}); err != nil {
		t.Fatal(err)
	}
	if err := f.a.collectReady(context.Background(), "room"); err != nil {
		t.Fatal(err)
	}
	if n := f.collectedCount(t); n != 0 {
		t.Fatalf("collected the failed attempt: %d", n)
	}
	if !f.a.collectSettled["parent"] {
		t.Error("the retried parent is read again on every event")
	}
}

// A parent whose request message is gone is skipped, and the channel's
// other groups still collect.
func TestCollectSkipsALostRequestAndCollectsTheRest(t *testing.T) {
	f := newCollectFixture(t)
	f.addRun(t, "lost", "lead", "gone", domain.RunDone, "")
	f.handoffOf(t, "lost", "h0", "one", "Orphan piece")
	f.addRun(t, "r0", "one", "h0", domain.RunDone, "Orphan answer")
	f.addRun(t, "parent", "lead", "root", domain.RunDone, "Delegated.")
	f.handoff(t, "h1", "two", "Piece")
	f.addRun(t, "r1", "two", "h1", domain.RunDone, "Answer")
	// "lost" is done, so its missing answer must not be the reason it is skipped.
	m := domain.Message{ID: "lost-answer", ChannelID: "room", AuthorID: "lead", Body: "Done.", RunID: "lost", CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(context.Background(), events.Draft{Type: events.MessagePosted, Actor: events.Agent("lead"), ChannelID: "room", IdempotencyKey: "run-answer:lost", Payload: m}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := f.a.collectReady(context.Background(), "room"); err != nil {
			t.Fatal(err)
		}
	}
	log, err := f.s.EventsOfTypes(context.Background(), "room", events.HandoffCollected)
	if err != nil || len(log) != 1 {
		t.Fatalf("collected: %d %v", len(log), err)
	}
	var p events.HandoffCollectedPayload
	if err := json.Unmarshal(log[0].Payload, &p); err != nil || p.ParentRunID != "parent" {
		t.Fatalf("collected the wrong group: %+v %v", p, err)
	}
}

// Once the collect run is queued the parent is settled in memory: later
// events in the channel skip it without reading its runs and messages.
func TestCollectSettlesACollectedParent(t *testing.T) {
	f := newCollectFixture(t)
	f.addRun(t, "parent", "lead", "root", domain.RunDone, "Delegated.")
	f.handoff(t, "h1", "one", "Piece")
	f.addRun(t, "r1", "one", "h1", domain.RunDone, "Answer")
	if err := f.a.collectReady(context.Background(), "room"); err != nil {
		t.Fatal(err)
	}
	if !f.a.collectSettled["parent"] {
		t.Fatal("collected parent not settled")
	}
	// The cache is only a shortcut: a new App rebuilds the decision from the log.
	f.newApp(t, nil)
	if err := f.a.collectReady(context.Background(), "room"); err != nil {
		t.Fatal(err)
	}
	if n := f.collectedCount(t); n != 1 {
		t.Fatalf("collected events: %d", n)
	}
	if !f.a.collectSettled["parent"] {
		t.Error("a settled parent found in the log was not cached")
	}
}

// The digest is a prompt, not a conversation: later runs in the channel
// must not get it replayed as context.
func TestPromptSkipsCollectDigests(t *testing.T) {
	f := newCollectFixture(t)
	digest := domain.Message{ID: "digest", ChannelID: "room", ThreadID: "root", AuthorID: "lead", Body: "Write one combined answer for the original request.", CollectForRunID: "parent", CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(context.Background(), events.Draft{Type: events.MessagePosted, Actor: events.Agent("lead"), ChannelID: "room", Payload: digest}); err != nil {
		t.Fatal(err)
	}
	text, err := f.a.prompt(context.Background(), domain.Message{ID: "next", ChannelID: "room", Body: "What is left?"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "Write one combined answer") {
		t.Fatalf("the digest was replayed:\n%s", text)
	}
	if !strings.Contains(text, "Ship the feature") {
		t.Fatalf("other messages dropped:\n%s", text)
	}
}

// A run records the thread and handoff of its trigger, so a client can
// find the pieces of a delegation from the runs alone.
func TestQueuedRunRecordsThreadAndHandoff(t *testing.T) {
	f := newCollectFixture(t)
	f.handoff(t, "h1", "one", "Piece")
	ctx := context.Background()
	h1, err := f.s.Message(ctx, "h1")
	if err != nil {
		t.Fatal(err)
	}
	one, err := f.s.Member(ctx, "one")
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.a.queueRun(ctx, h1, one, domain.RunRead, "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := f.s.Run(ctx, run.ID)
	if err != nil || stored.ThreadID != "root" || !stored.Handoff {
		t.Fatalf("piece run: %+v %v", stored, err)
	}
	root, err := f.a.queueRun(ctx, f.root, one, domain.RunRead, "", "", false)
	if err != nil || root.ThreadID != "" || root.Handoff {
		t.Fatalf("root run: %+v %v", root, err)
	}
}

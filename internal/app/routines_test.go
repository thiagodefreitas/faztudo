package app

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

type routineFixture struct {
	app     *App
	s       *store.Store
	e       *routineEngine
	human   domain.Member
	coder   domain.Member
	general domain.Channel

	mu      sync.Mutex
	ran     []domain.Message
	release chan struct{} // when set, the fake agent waits for it
}

func newRoutineFixture(t *testing.T, cfg config.Config, laneHealth domain.LaneHealth, reason string) *routineFixture {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	f := &routineFixture{s: s}
	f.human = domain.Member{ID: "ada", Kind: domain.MemberHuman, Handle: "ada", DisplayName: "Ada", Presence: domain.PresenceOnline}
	f.coder = domain.Member{ID: "coder", Kind: domain.MemberAgent, Handle: "coder", DisplayName: "Coder", Presence: domain.PresenceOnline, Agent: &domain.AgentInfo{Lanes: []string{"a"}, Mode: domain.RunRead}}
	f.general = domain.Channel{ID: "general", Name: "general", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic, MemberIDs: []string{"ada", "coder"}}
	lane := domain.Lane{ID: "a", CLI: "codex", Capacity: 1, Health: laneHealth, HealthReason: reason, Windows: []domain.LaneWindow{}}
	for _, d := range []events.Draft{
		{Type: events.MemberUpdated, Payload: f.human},
		{Type: events.MemberUpdated, Payload: f.coder},
		{Type: events.LaneUpdated, Payload: lane},
		{Type: events.ChannelCreated, ChannelID: f.general.ID, Payload: f.general},
	} {
		d.Actor = events.System
		if _, err := s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	f.app, err = New(ctx, s, cfg, config.Paths{})
	if err != nil {
		t.Fatal(err)
	}
	f.e = f.app.routines
	f.e.execute = f.fakeAgent
	return f
}

// fakeAgent stands in for the run: it records the message and leaves a finished
// run and a reply behind, as a real run would.
func (f *routineFixture) fakeAgent(ctx context.Context, m domain.Message, agent domain.Member) error {
	f.mu.Lock()
	f.ran = append(f.ran, m)
	wait := f.release
	f.mu.Unlock()
	if wait != nil {
		<-wait
	}
	run := domain.Run{ID: store.NewID(), ChannelID: m.ChannelID, TriggerMessageID: m.ID, AgentID: agent.ID, LaneID: "a", Mode: domain.RunRead, State: domain.RunDone}
	reply := domain.Message{ID: store.NewID(), ChannelID: m.ChannelID, AuthorID: agent.ID, Body: "All good\nsecond line", Mentions: []string{}, RunID: run.ID, CreatedAt: time.Now().UTC()}
	for _, d := range []events.Draft{
		{Type: events.RunCreated, Actor: events.System, ChannelID: m.ChannelID, Payload: run},
		{Type: events.MessagePosted, Actor: events.Agent(agent.ID), ChannelID: m.ChannelID, Payload: reply},
	} {
		if _, err := f.s.Append(ctx, d); err != nil {
			return err
		}
	}
	return nil
}

func (f *routineFixture) save(t *testing.T, r domain.Routine) {
	t.Helper()
	if _, err := f.s.Append(context.Background(), events.Draft{Type: events.RoutineUpdated, Actor: events.System, Payload: r}); err != nil {
		t.Fatal(err)
	}
}

func (f *routineFixture) post(t *testing.T, m domain.Message) events.Event {
	t.Helper()
	if m.Mentions == nil {
		m.Mentions = []string{}
	}
	m.CreatedAt = time.Now().UTC()
	author := events.Human(m.AuthorID)
	if m.AuthorID == f.coder.ID {
		author = events.Agent(m.AuthorID)
	}
	e, err := f.s.Append(context.Background(), events.Draft{Type: events.MessagePosted, Actor: author, ChannelID: m.ChannelID, Payload: m})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// waitRan waits until the fake agent has been asked n times and the routine
// goroutine has finished, so the result is recorded.
func (f *routineFixture) waitRan(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		f.mu.Lock()
		got := len(f.ran)
		f.mu.Unlock()
		f.e.mu.Lock()
		busy := len(f.e.running)
		f.e.mu.Unlock()
		if got >= n && busy == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("agent asked %d times, want %d (busy %d)", got, n, busy)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (f *routineFixture) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.ran)
}

func (f *routineFixture) last(t *testing.T, handle string) domain.Routine {
	t.Helper()
	r, err := f.s.Routine(context.Background(), handle)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestTriggerRoutineFiresOncePerMessage(t *testing.T) {
	f := newRoutineFixture(t, config.Config{}, domain.LaneUnknown, "")
	ctx := context.Background()
	f.save(t, domain.Routine{Handle: "welcome", Name: "Welcome", Persona: "coder", Channel: "general", Trigger: "message", Prompt: "Say hello to the newcomer.", Enabled: true})
	f.save(t, domain.Routine{Handle: "off", Name: "Off", Persona: "coder", Channel: "general", Trigger: "message", Prompt: "never", Enabled: false})
	f.save(t, domain.Routine{Handle: "elsewhere", Name: "Elsewhere", Persona: "coder", Channel: "random", Trigger: "message", Prompt: "never", Enabled: true})

	first := f.post(t, domain.Message{ID: "m1", ChannelID: "general", AuthorID: "ada", Body: "hello team"})
	f.e.onEvent(ctx, first)
	f.e.onEvent(ctx, first) // the same event delivered again
	f.waitRan(t, 1)
	time.Sleep(50 * time.Millisecond)
	if f.count() != 1 {
		t.Fatalf("the routine ran %d times for one message", f.count())
	}
	if got := f.ran[0]; got.Routine != "welcome" || !strings.HasPrefix(got.Body, "@coder Say hello") || got.AuthorID != "ada" {
		t.Fatalf("routine message %+v", got)
	}
	res := f.last(t, "welcome").Last
	if res == nil || res.Status != "ok" || res.Detail != "All good" || res.RunID == "" {
		t.Fatalf("last result %+v", res)
	}

	// None of these start anything.
	for _, m := range []domain.Message{
		{ID: "agent", ChannelID: "general", AuthorID: "coder", Body: "I did a thing"},
		{ID: "reply", ChannelID: "general", ThreadID: "m1", AuthorID: "ada", Body: "thanks"},
		{ID: "from-routine", ChannelID: "general", AuthorID: "ada", Body: "@coder x", Routine: "welcome"},
		{ID: "handoff", ChannelID: "general", AuthorID: "ada", Body: "@coder x", Handoff: &domain.Handoff{RequestID: "m1", From: "chief", To: "coder", Depth: 1}},
	} {
		f.e.onEvent(ctx, f.post(t, m))
	}
	// Another human message in the channel starts it again.
	f.e.onEvent(ctx, f.post(t, domain.Message{ID: "m2", ChannelID: "general", AuthorID: "ada", Body: "one more"}))
	f.waitRan(t, 2)
	time.Sleep(50 * time.Millisecond)
	if f.count() != 2 {
		t.Fatalf("%d runs, want 2", f.count())
	}
}

func TestScheduledRoutineRunsWhenDueInTheUsersZone(t *testing.T) {
	f := newRoutineFixture(t, config.Config{}, domain.LaneUnknown, "")
	ctx := context.Background()
	f.e.loc = time.FixedZone("UTC+2", 2*3600)
	f.save(t, domain.Routine{Handle: "debrief", Name: "Debrief", Persona: "coder", Channel: "general", Schedule: "0 18 * * *", Prompt: "Summarize.", Enabled: true})
	at := func(day, hour, min, sec int) time.Time {
		return time.Date(2026, time.October, day, hour, min, sec, 0, f.e.loc)
	}

	f.e.tick(ctx, at(18, 17, 59, 0)) // works out the next time, runs nothing
	f.e.tick(ctx, at(18, 17, 59, 40))
	if f.count() != 0 {
		t.Fatal("ran before it was due")
	}
	f.e.tick(ctx, at(18, 18, 0, 30))
	f.waitRan(t, 1)
	f.e.tick(ctx, at(18, 18, 0, 50)) // the same minute, already done
	f.e.tick(ctx, at(18, 19, 0, 0))
	time.Sleep(50 * time.Millisecond)
	if f.count() != 1 {
		t.Fatalf("%d runs in one day", f.count())
	}
	f.e.tick(ctx, at(19, 18, 0, 10))
	f.waitRan(t, 2)

	f.e.now = func() time.Time { return at(19, 18, 5, 0) }
	list, err := f.e.List(ctx)
	if err != nil || len(list) != 1 || list[0].NextRun == nil {
		t.Fatalf("list %+v, %v", list, err)
	}
	if want := time.Date(2026, time.October, 20, 16, 0, 0, 0, time.UTC); !list[0].NextRun.Equal(want) {
		t.Fatalf("next run %s, want %s (18:00 UTC+2)", list[0].NextRun, want)
	}
}

func TestCreateRoutineChecksTheInputAndNamesItFromTheName(t *testing.T) {
	f := newRoutineFixture(t, config.Config{}, domain.LaneUnknown, "")
	ctx := context.Background()
	good := domain.RoutineInput{Name: "  Check the build!  ", Prompt: " Check the build. ", Persona: "@coder", Channel: "#General", Schedule: " 0  9 * * 1-5 "}
	r, err := f.e.Create(ctx, good, f.human.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r.Handle != "check-the-build" || r.Name != "Check the build!" || r.Prompt != "Check the build." || r.Persona != "coder" || r.Channel != "general" || r.Schedule != "0 9 * * 1-5" {
		t.Fatalf("routine %+v", r)
	}
	if !r.Enabled || r.Source != "app" || r.CreatedBy != f.human.ID || r.CreatedAt == nil || r.NextRun == nil {
		t.Fatalf("routine state %+v", r)
	}
	if got := f.last(t, r.Handle); got.Source != "app" || got.Schedule != "0 9 * * 1-5" {
		t.Fatalf("stored %+v", got)
	}

	// A second routine with the same name gets a number.
	again, err := f.e.Create(ctx, good, f.human.ID)
	if err != nil || again.Handle != "check-the-build-2" {
		t.Fatalf("second routine %+v, %v", again, err)
	}

	for name, in := range map[string]domain.RoutineInput{
		"no name":         {Prompt: "p", Persona: "coder", Channel: "general", Schedule: "0 9 * * *"},
		"no prompt":       {Name: "n", Persona: "coder", Channel: "general", Schedule: "0 9 * * *"},
		"no schedule":     {Name: "n", Prompt: "p", Persona: "coder", Channel: "general"},
		"bad schedule":    {Name: "n", Prompt: "p", Persona: "coder", Channel: "general", Schedule: "99 9 * * *"},
		"unknown persona": {Name: "n", Prompt: "p", Persona: "nobody", Channel: "general", Schedule: "0 9 * * *"},
		"a human persona": {Name: "n", Prompt: "p", Persona: "ada", Channel: "general", Schedule: "0 9 * * *"},
		"unknown channel": {Name: "n", Prompt: "p", Persona: "coder", Channel: "nowhere", Schedule: "0 9 * * *"},
	} {
		var user domain.UserError
		if _, err := f.e.Create(ctx, in, f.human.ID); !errors.As(err, &user) {
			t.Errorf("%s: want a user error, got %v", name, err)
		}
	}
	if list, _ := f.e.List(ctx); len(list) != 2 {
		t.Fatalf("%d routines after the refusals", len(list))
	}
}

func TestCreateRoutineRefusesAHandleFromLanesToml(t *testing.T) {
	f := newRoutineFixture(t, config.Config{}, domain.LaneUnknown, "")
	ctx := context.Background()
	f.save(t, domain.Routine{Handle: "daily-debrief", Name: "Daily debrief", Persona: "coder", Channel: "general", Schedule: "0 18 * * *", Enabled: true, Source: "config"})
	// A routine recorded before sources existed counts as a lanes.toml one.
	f.save(t, domain.Routine{Handle: "old", Name: "Old", Persona: "coder", Channel: "general", Schedule: "0 1 * * *", Enabled: true})
	for _, name := range []string{"Daily debrief", "daily-DEBRIEF", "Old"} {
		_, err := f.e.Create(ctx, domain.RoutineInput{Name: name, Prompt: "p", Persona: "coder", Channel: "general", Schedule: "0 9 * * *"}, f.human.ID)
		if !errors.Is(err, store.ErrConflict) || !strings.Contains(err.Error(), "lanes.toml") {
			t.Errorf("%q: want a lanes.toml conflict, got %v", name, err)
		}
	}
	if list, _ := f.e.List(ctx); len(list) != 2 {
		t.Fatalf("%d routines after the clashes", len(list))
	}
	if list, _ := f.e.List(ctx); list[0].Source != "config" || list[1].Source != "config" {
		t.Fatalf("sources %+v", list)
	}
}

func TestDeleteRoutineOnlyRemovesAppRoutines(t *testing.T) {
	f := newRoutineFixture(t, config.Config{}, domain.LaneUnknown, "")
	ctx := context.Background()
	f.save(t, domain.Routine{Handle: "daily-debrief", Name: "Daily debrief", Persona: "coder", Channel: "general", Schedule: "0 18 * * *", Enabled: true, Source: "config"})
	r, err := f.e.Create(ctx, domain.RoutineInput{Name: "Mine", Prompt: "p", Persona: "coder", Channel: "general", Schedule: "0 9 * * *"}, f.human.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.e.Delete(ctx, "daily-debrief", f.human.ID); !errors.Is(err, store.ErrConflict) || !strings.Contains(err.Error(), "lanes.toml") {
		t.Fatalf("deleting a lanes.toml routine: %v", err)
	}
	if err := f.e.Delete(ctx, "missing", f.human.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleting a missing routine: %v", err)
	}
	if err := f.e.Delete(ctx, r.Handle, f.human.ID); err != nil {
		t.Fatal(err)
	}
	list, err := f.e.List(ctx)
	if err != nil || len(list) != 1 || list[0].Handle != "daily-debrief" {
		t.Fatalf("list %+v, %v", list, err)
	}
	if err := f.e.Delete(ctx, r.Handle, f.human.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleting twice: %v", err)
	}
}

func TestEngineRunsAnAppRoutineOnItsSchedule(t *testing.T) {
	f := newRoutineFixture(t, config.Config{}, domain.LaneUnknown, "")
	ctx := context.Background()
	f.e.loc = time.UTC
	r, err := f.e.Create(ctx, domain.RoutineInput{Name: "Evening check", Prompt: "Check the build.", Persona: "coder", Channel: "general", Schedule: "0 18 * * *"}, f.human.ID)
	if err != nil {
		t.Fatal(err)
	}
	at := func(hour, min, sec int) time.Time {
		return time.Date(2026, time.October, 22, hour, min, sec, 0, time.UTC)
	}
	f.e.tick(ctx, at(17, 59, 0))
	if f.count() != 0 {
		t.Fatal("ran before it was due")
	}
	f.e.tick(ctx, at(18, 0, 30))
	f.waitRan(t, 1)
	if got := f.ran[0]; got.Routine != r.Handle || got.Body != "@coder Check the build." {
		t.Fatalf("message %+v", got)
	}
	if got := f.last(t, r.Handle); got.Source != "app" || got.Last == nil || got.Last.Status != "ok" {
		t.Fatalf("after the run %+v", got)
	}

	// Switched off, it stays quiet; deleted, it is gone for good.
	if _, err := f.e.SetEnabled(ctx, r.Handle, false, f.human.ID); err != nil {
		t.Fatal(err)
	}
	f.e.tick(ctx, at(18, 5, 0))
	if err := f.e.Delete(ctx, r.Handle, f.human.ID); err != nil {
		t.Fatal(err)
	}
	f.e.tick(ctx, time.Date(2026, time.October, 23, 18, 0, 30, 0, time.UTC))
	time.Sleep(50 * time.Millisecond)
	if f.count() != 1 {
		t.Fatalf("%d runs", f.count())
	}
}

func TestSlugHandle(t *testing.T) {
	for _, c := range [][2]string{
		{"Check the build!", "check-the-build"},
		{"  --Weekly  report--  ", "weekly-report"},
		{"!!!", "routine"},
		{"Resumo da semana", "resumo-da-semana"},
		{strings.Repeat("a", 60), strings.Repeat("a", 40)},
		{strings.Repeat("ab ", 20), strings.Repeat("ab-", 13) + "a"},
	} {
		if got := slugHandle(c[0]); got != c[1] {
			t.Errorf("slugHandle(%q) = %q, want %q", c[0], got, c[1])
		}
	}
}

func TestSwitchedOffRoutineDoesNotRunAndSwitchingOnWaitsForTheNextTime(t *testing.T) {
	f := newRoutineFixture(t, config.Config{}, domain.LaneUnknown, "")
	ctx := context.Background()
	f.e.loc = time.UTC
	f.save(t, domain.Routine{Handle: "nightly", Name: "Nightly", Persona: "coder", Channel: "general", Schedule: "0 3 * * *", Prompt: "Check.", Enabled: false})
	day := func(d, h, m int) time.Time { return time.Date(2026, time.October, d, h, m, 0, 0, time.UTC) }
	f.e.tick(ctx, day(18, 2, 59))
	f.e.tick(ctx, day(18, 3, 1))
	if f.count() != 0 {
		t.Fatal("a switched-off routine ran")
	}
	f.e.now = func() time.Time { return day(18, 3, 2) }
	got, err := f.e.SetEnabled(ctx, "nightly", true, f.human.ID)
	if err != nil || !got.Enabled || got.NextRun == nil {
		t.Fatalf("SetEnabled %+v, %v", got, err)
	}
	f.e.tick(ctx, day(18, 3, 3)) // first tick after switching on: no catch-up
	if f.count() != 0 {
		t.Fatal("a routine switched on late ran for a time it missed")
	}
	f.e.tick(ctx, day(19, 3, 0))
	f.waitRan(t, 1)
	evs, _ := f.s.EventsAfter(ctx, 0, 1000)
	humanChange := false
	for _, e := range evs {
		if e.Type == events.RoutineUpdated && e.Actor == events.Human(f.human.ID) {
			humanChange = true
		}
	}
	if !humanChange {
		t.Fatal("the Director's switch was not recorded as theirs")
	}
	if _, err := f.e.SetEnabled(ctx, "missing", true, f.human.ID); err == nil {
		t.Fatal("unknown routine accepted")
	}
}

func TestRoutinesRespectLaneHealth(t *testing.T) {
	for _, tc := range []struct {
		name   string
		health domain.LaneHealth
		reason string
		want   string
	}{
		{"exhausted", domain.LaneExhausted, "monthly limit", "no lane is usable"},
		{"unavailable", domain.LaneUnavailable, "403 subscription", "no lane is usable"},
		{"conserve", domain.LaneConserve, "82% used", "in conserve"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRoutineFixture(t, config.Config{}, tc.health, tc.reason)
			f.save(t, domain.Routine{Handle: "daily", Name: "Daily", Persona: "coder", Channel: "general", Schedule: "@daily", Prompt: "Go.", Enabled: true})
			err := f.e.RunNow(context.Background(), "daily")
			var user domain.UserError
			if err == nil || !asUserError(err, &user) || !strings.Contains(user.Message, tc.want) {
				t.Fatalf("RunNow error %v, want a refusal containing %q", err, tc.want)
			}
			time.Sleep(30 * time.Millisecond)
			if f.count() != 0 {
				t.Fatal("the routine ran on an unhealthy lane")
			}
			if last := f.last(t, "daily").Last; last == nil || last.Status != "skipped" || !strings.Contains(last.Detail, tc.want) {
				t.Fatalf("last result %+v", last)
			}
		})
	}
}

func asUserError(err error, target *domain.UserError) bool {
	u, ok := err.(domain.UserError)
	if ok {
		*target = u
	}
	return ok
}

func TestRoutinesHaveADailyCapAndOneRunAtATime(t *testing.T) {
	cfg := config.Config{Routines: config.Routines{MaxPerDay: 2}}
	f := newRoutineFixture(t, cfg, domain.LaneUnknown, "")
	ctx := context.Background()
	f.save(t, domain.Routine{Handle: "daily", Name: "Daily", Persona: "coder", Channel: "general", Schedule: "@daily", Prompt: "Go.", Enabled: true})

	f.release = make(chan struct{})
	if err := f.e.RunNow(ctx, "daily"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for f.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if err := f.e.RunNow(ctx, "daily"); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("second run while one is in flight: %v", err)
	}
	close(f.release)
	f.waitRan(t, 1)

	f.release = nil
	if err := f.e.RunNow(ctx, "daily"); err != nil {
		t.Fatal(err)
	}
	f.waitRan(t, 2)
	if err := f.e.RunNow(ctx, "daily"); err == nil || !strings.Contains(err.Error(), "daily limit of 2") {
		t.Fatalf("third run today: %v", err)
	}
	// A new day starts the count again.
	f.e.now = func() time.Time { return time.Now().Add(26 * time.Hour) }
	if err := f.e.RunNow(ctx, "daily"); err != nil {
		t.Fatalf("next day: %v", err)
	}
	f.waitRan(t, 3)
}

func TestRoutineDoesNotRunWhereTheAgentIsNotAssigned(t *testing.T) {
	f := newRoutineFixture(t, config.Config{}, domain.LaneUnknown, "")
	ctx := context.Background()
	project := domain.Project{Handle: "faztudo", Name: "Faztudo", Channels: []string{"general"}, Departments: []string{}, Specialists: []string{}}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.ProjectUpdated, Actor: events.System, Payload: project}); err != nil {
		t.Fatal(err)
	}
	f.save(t, domain.Routine{Handle: "daily", Name: "Daily", Persona: "coder", Channel: "general", Schedule: "@daily", Prompt: "Go.", Enabled: true})
	err := f.e.RunNow(ctx, "daily")
	if err == nil || !strings.Contains(err.Error(), "not assigned") {
		t.Fatalf("RunNow: %v", err)
	}
	f.save(t, domain.Routine{Handle: "ghost", Name: "Ghost", Persona: "coder", Channel: "nowhere", Schedule: "@daily", Prompt: "Go.", Enabled: true})
	if err := f.e.RunNow(ctx, "ghost"); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("missing channel: %v", err)
	}
	if err := f.e.RunNow(ctx, "nope"); err == nil {
		t.Fatal("unknown routine accepted")
	}
}

func TestDebriefRoutineGetsFactsInItsPromptButNotInTheChannel(t *testing.T) {
	f := newRoutineFixture(t, config.Config{}, domain.LaneUnknown, "")
	ctx := context.Background()
	f.save(t, domain.Routine{Handle: "daily-debrief", Name: "Daily debrief", Persona: "coder", Channel: "general", Schedule: "0 18 * * 1-5", Template: "debrief", Enabled: true})
	var facts string
	inner := f.e.execute
	f.e.execute = func(ctx context.Context, m domain.Message, agent domain.Member) error {
		facts = f.app.extraContext(m.ID)
		return inner(ctx, m, agent)
	}
	if err := f.e.RunNow(ctx, "daily-debrief"); err != nil {
		t.Fatal(err)
	}
	f.waitRan(t, 1)
	if !strings.Contains(facts, "Write the daily debrief") || !strings.Contains(facts, "Facts for the last 24 hours") || !strings.Contains(facts, "- a: unknown") {
		t.Fatalf("facts in the prompt:\n%s", facts)
	}
	if got := f.app.extraContext(f.ran[0].ID); got != "" {
		t.Fatal("the facts were kept after the run")
	}
	if strings.Contains(f.ran[0].Body, "Facts") {
		t.Fatalf("the channel message carries the facts: %q", f.ran[0].Body)
	}
}

func TestDebriefStatesWhatHappened(t *testing.T) {
	now := time.Date(2026, time.October, 18, 18, 0, 0, 0, time.UTC)
	ended := func(h int) *time.Time { t := now.Add(-time.Duration(h) * time.Hour); return &t }
	members := []domain.Member{{ID: "u1", Handle: "coder"}, {ID: "u2", Handle: "reviewer"}}
	runs := []domain.Run{
		{ID: "r1", AgentID: "u1", LaneID: "codex/default", State: domain.RunDone, EndedAt: ended(2)},
		{ID: "r2", AgentID: "u1", LaneID: "codex/default", State: domain.RunFailed, FailureReason: "exit status 1", EndedAt: ended(3)},
		{ID: "r3", AgentID: "u2", LaneID: "claude/opus", State: domain.RunDone, EndedAt: ended(5)},
		{ID: "old", AgentID: "u2", LaneID: "claude/opus", State: domain.RunDone, EndedAt: ended(40)},
		{ID: "live", AgentID: "u2", LaneID: "claude/opus", State: domain.RunRunning},
		{ID: "wait", AgentID: "u1", LaneID: "codex/default", State: domain.RunWaitingApproval},
	}
	approvals := []domain.Approval{
		{ID: "p1", State: domain.ApprovalPending, Title: "Choose what to do with branch fz/r9"},
		{ID: "d1", State: domain.ApprovalResolved, Resolution: &domain.ApprovalResolution{Option: "merge", At: now.Add(-time.Hour)}},
		{ID: "d2", State: domain.ApprovalResolved, Resolution: &domain.ApprovalResolution{Option: "discard", At: now.Add(-time.Hour)}},
		{ID: "d3", State: domain.ApprovalResolved, Resolution: &domain.ApprovalResolution{Option: "merge", At: now.Add(-48 * time.Hour)}},
	}
	used := 62.0
	lanes := []domain.Lane{
		{ID: "claude/opus", Health: domain.LaneAvailable, Windows: []domain.LaneWindow{{Name: "5h", UsedPct: &used}}},
		{ID: "codex/default", Health: domain.LaneExhausted, HealthReason: "weekly limit"},
	}
	got := debrief(now, 24*time.Hour, runs, approvals, lanes, members)
	for _, want := range []string{
		"Runs: 3 finished (2 done, 1 failed, 0 cancelled), 1 still running.",
		"- @coder: 2 (1 done, 1 failed, 0 cancelled)",
		"- @reviewer: 1 (1 done, 0 failed, 0 cancelled)",
		"Merged changes: 1.",
		"- @coder on codex/default: exit status 1",
		"Approvals waiting: 1.",
		"- Choose what to do with branch fz/r9",
		"- claude/opus: available, 5h 62%",
		"- codex/default: exhausted (weekly limit)",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("debrief is missing %q:\n%s", want, got)
		}
	}
	if none := debrief(now, 24*time.Hour, nil, nil, nil, nil); !strings.Contains(none, "Failed runs: none.") || !strings.Contains(none, "Approvals waiting: none.") {
		t.Errorf("empty debrief:\n%s", none)
	}
}

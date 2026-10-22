package app

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/cron"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/lanes"
	"github.com/thiagodefreitas/faztudo/internal/org"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

const (
	// firedKeep is how many trigger messages the engine remembers.
	firedKeep = 500
	// defaultRoutinesPerDay applies when the configuration leaves the cap unset.
	defaultRoutinesPerDay = 20
	debriefWindow         = 24 * time.Hour
	debriefIntro          = "Write the daily debrief for the Director. Use only the facts below and invent nothing. Keep it short: what ran, what merged, what failed, which approvals are waiting, and how the lanes are doing."
)

// routineEngine runs the routines: on a schedule, and when a human posts in a
// channel that a routine watches. The routines themselves live in the store;
// the engine only keeps when each one runs next.
type routineEngine struct {
	app *App
	loc *time.Location
	now func() time.Time
	// execute runs the agent on a message. A test replaces it.
	execute func(ctx context.Context, m domain.Message, agent domain.Member) error

	mu      sync.Mutex
	next    map[string]time.Time // routine handle to its next scheduled time
	running map[string]bool      // routines with a run in flight
	fired   map[string]bool      // trigger messages already handled
	order   []string             // the fired keys, oldest first
	day     string               // local date that started counts
	started int                  // runs routines started on that date
}

func newRoutineEngine(a *App) *routineEngine {
	loc := time.Local
	if name := a.Config.Routines.Timezone; name != "" {
		if l, err := time.LoadLocation(name); err == nil {
			loc = l
		}
	}
	e := &routineEngine{app: a, loc: loc, now: time.Now, next: map[string]time.Time{}, running: map[string]bool{}, fired: map[string]bool{}}
	e.execute = func(ctx context.Context, m domain.Message, agent domain.Member) error {
		return a.execute(ctx, m, agent, "")
	}
	return e
}

// loop watches the event log for trigger messages and checks the schedules
// every few seconds. It returns when ctx ends.
func (e *routineEngine) loop(ctx context.Context) {
	var feed <-chan events.Event
	var seq int64
	subscribe := func() {
		if feed != nil {
			return
		}
		if seq == 0 {
			last, err := e.app.Store.LastSeq(ctx)
			if err != nil {
				return
			}
			seq = last
		}
		feed, _ = e.app.Store.Subscribe(ctx, seq)
	}
	subscribe()
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-feed:
			if !ok {
				// Subscribe retries read errors itself; a closed feed means the
				// store went away. A nil channel blocks, and the next tick tries
				// again from the last seq seen.
				feed = nil
				continue
			}
			seq = ev.Seq
			e.onEvent(ctx, ev)
		case <-ticker.C:
			subscribe()
			e.tick(ctx, e.now())
		}
	}
}

// tick starts the scheduled routines that are due. The first tick after a
// start, or after a routine is switched on, only works out the next time: a
// run missed while faztudo was off is not made up.
func (e *routineEngine) tick(ctx context.Context, now time.Time) {
	list, err := e.app.Store.Routines(ctx)
	if err != nil {
		return
	}
	for _, r := range list {
		if !r.Enabled || r.Schedule == "" {
			e.mu.Lock()
			delete(e.next, r.Handle)
			e.mu.Unlock()
			continue
		}
		sched, err := cron.Parse(r.Schedule)
		if err != nil {
			continue
		}
		e.mu.Lock()
		due, known := e.next[r.Handle]
		fire := known && !now.Before(due)
		if !known || fire {
			if next, ok := sched.Next(now.In(e.loc)); ok {
				e.next[r.Handle] = next
			} else {
				delete(e.next, r.Handle)
			}
		}
		e.mu.Unlock()
		if fire {
			_ = e.start(ctx, r)
		}
	}
}

// onEvent starts the routines that watch the channel of a new message. A
// message counts once per routine, however often the event is delivered.
// Messages from agents, from routines, handoffs and thread replies never
// trigger anything, so a routine cannot set off itself or another.
func (e *routineEngine) onEvent(ctx context.Context, ev events.Event) {
	if ev.Type != events.MessagePosted {
		return
	}
	var m domain.Message
	if json.Unmarshal(ev.Payload, &m) != nil || m.ID == "" || m.Routine != "" || m.Handoff != nil || m.ThreadID != "" || m.RunID != "" {
		return
	}
	list, err := e.app.Store.Routines(ctx)
	if err != nil {
		return
	}
	var watching []domain.Routine
	for _, r := range list {
		if r.Enabled && r.Trigger == "message" {
			watching = append(watching, r)
		}
	}
	if len(watching) == 0 {
		return
	}
	author, err := e.app.Store.Member(ctx, m.AuthorID)
	if err != nil || author.Kind != domain.MemberHuman {
		return
	}
	channel, err := e.app.Store.Channel(ctx, m.ChannelID)
	if err != nil {
		return
	}
	for _, r := range watching {
		if strings.EqualFold(r.Channel, channel.Name) && !e.seen(m.ID+"/"+r.Handle) {
			_ = e.start(ctx, r)
		}
	}
}

// seen remembers a key and reports whether it was already remembered.
func (e *routineEngine) seen(key string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.fired[key] {
		return true
	}
	e.fired[key] = true
	e.order = append(e.order, key)
	if len(e.order) > firedKeep {
		delete(e.fired, e.order[0])
		e.order = e.order[1:]
	}
	return false
}

func (e *routineEngine) claim(handle string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.running[handle] {
		return false
	}
	e.running[handle] = true
	return true
}

func (e *routineEngine) release(handle string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.running, handle)
}

// takeSlot counts one more routine run today and reports whether the daily cap
// allows it.
func (e *routineEngine) takeSlot(now time.Time) (ok bool, limit int) {
	limit = e.app.Config.Routines.MaxPerDay
	if limit < 1 {
		limit = defaultRoutinesPerDay
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	day := now.In(e.loc).Format("2006-01-02")
	if e.day != day {
		e.day, e.started = day, 0
	}
	if e.started >= limit {
		return false, limit
	}
	e.started++
	return true, limit
}

type routinePlan struct {
	channel domain.Channel
	agent   domain.Member
	human   domain.Member
}

// plan checks that the routine can run now: its channel and agent exist, the
// agent may act in the channel's project, its lane is healthy and not in
// conserve, and the daily cap allows another run. The second result says why
// not, empty when the routine can run.
func (e *routineEngine) plan(ctx context.Context, r domain.Routine) (routinePlan, string) {
	a := e.app
	var p routinePlan
	channels, err := a.Store.Channels(ctx)
	if err != nil {
		return p, "could not read the channels"
	}
	found := false
	for _, c := range channels {
		if strings.EqualFold(c.Name, r.Channel) {
			p.channel, found = c, true
			break
		}
	}
	if !found {
		return p, "channel #" + r.Channel + " does not exist"
	}
	agent, err := a.Store.MemberByHandle(ctx, r.Persona)
	if err != nil || agent.Kind != domain.MemberAgent || agent.Agent == nil {
		return p, "agent @" + r.Persona + " does not exist"
	}
	p.agent = agent
	members, err := a.Store.Members(ctx)
	if err != nil {
		return p, "could not read the members"
	}
	for _, m := range members {
		if m.Kind == domain.MemberHuman {
			p.human = m
			break
		}
	}
	if p.human.ID == "" {
		return p, "there is no human member to post as"
	}
	projects, err := a.Store.Projects(ctx)
	if err != nil {
		return p, "could not read the projects"
	}
	departments, err := a.Store.Departments(ctx)
	if err != nil {
		return p, "could not read the departments"
	}
	if allowed, _ := org.Gate(projects, departments, p.channel.Name, []domain.Member{agent}); len(allowed) == 0 {
		return p, "@" + agent.Handle + " is not assigned to the project that owns #" + p.channel.Name
	}
	mode := domain.RunRead
	if agent.Agent != nil && agent.Agent.Mode != "" {
		mode = agent.Agent.Mode
	}
	lane, left, err := a.Registry.PickFit(agent.Handle, "", a.laneUnfit(mode))
	switch {
	case err != nil && !lanes.Busy(left):
		return p, "no lane is usable for @" + agent.Handle + " right now"
	case err == nil && lane.Health == domain.LaneConserve:
		return p, "lane " + lane.ID + " is in conserve, so the routine waits"
	}
	if ok, limit := e.takeSlot(e.now()); !ok {
		return p, fmt.Sprintf("the daily limit of %d routine runs is reached", limit)
	}
	return p, ""
}

// start checks the routine and runs it in the background. A refusal is kept as
// the routine's last result and returned as a domain.UserError.
func (e *routineEngine) start(ctx context.Context, r domain.Routine) error {
	if !e.claim(r.Handle) {
		return domain.UserError{Message: "routine " + r.Handle + " is already running"}
	}
	p, reason := e.plan(ctx, r)
	if reason != "" {
		e.release(r.Handle)
		e.record(ctx, r.Handle, domain.RoutineResult{At: e.now().UTC(), Status: "skipped", Detail: reason})
		return domain.UserError{Message: reason}
	}
	go func() {
		defer e.release(r.Handle)
		e.run(context.Background(), r, p)
	}()
	return nil
}

// run posts the routine's prompt in its channel as the Director, with the
// routine's handle on the message, and waits for the agent to finish.
func (e *routineEngine) run(ctx context.Context, r domain.Routine, p routinePlan) {
	body := strings.TrimSpace(r.Prompt)
	if body == "" {
		body = "Write the daily debrief."
	}
	msg := domain.Message{ID: store.NewID(), ChannelID: p.channel.ID, AuthorID: p.human.ID, Body: "@" + p.agent.Handle + " " + body, Mentions: []string{p.agent.ID}, Routine: r.Handle, CreatedAt: time.Now().UTC()}
	if r.Template == "debrief" {
		facts, err := e.app.debriefFacts(ctx, e.now())
		if err != nil {
			e.record(ctx, r.Handle, domain.RoutineResult{At: e.now().UTC(), Status: "failed", Detail: "could not collect the facts: " + err.Error()})
			return
		}
		e.app.setExtra(msg.ID, debriefIntro+"\n\n"+facts)
		defer e.app.clearExtra(msg.ID)
	}
	if _, err := e.app.Store.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.System, ChannelID: p.channel.ID, Payload: msg}); err != nil {
		e.record(ctx, r.Handle, domain.RoutineResult{At: e.now().UTC(), Status: "failed", Detail: "could not post: " + err.Error()})
		return
	}
	runErr := e.execute(ctx, msg, p.agent)
	e.record(ctx, r.Handle, e.result(ctx, p.channel.ID, msg.ID, runErr))
}

// result says how the run for a routine message ended.
func (e *routineEngine) result(ctx context.Context, channelID, messageID string, runErr error) domain.RoutineResult {
	res := domain.RoutineResult{At: e.now().UTC(), Status: "ok"}
	runs, _ := e.app.Store.Runs(ctx, channelID, "")
	var last *domain.Run
	for i := range runs {
		if runs[i].TriggerMessageID == messageID {
			last = &runs[i] // runs are ordered by id, so the last is the newest
		}
	}
	if last != nil {
		res.RunID = last.ID
	}
	switch {
	case runErr != nil:
		res.Status, res.Detail = "failed", clipText(runErr.Error(), 200)
	case last == nil:
		res.Status, res.Detail = "failed", "no run was started"
	case last.State == domain.RunFailed || last.State == domain.RunCancelled:
		res.Status, res.Detail = "failed", clipText(string(last.State)+": "+last.FailureReason, 200)
	default:
		res.Detail = string(last.State)
		if msgs, err := e.app.Store.Messages(ctx, channelID, "", 30); err == nil {
			for _, m := range msgs {
				if m.RunID == last.ID {
					res.Detail = clipText(firstLine(m.Body), 160)
				}
			}
		}
	}
	return res
}

// record stores the result of a run on the routine, keeping whether the
// Director has it switched on.
func (e *routineEngine) record(ctx context.Context, handle string, res domain.RoutineResult) {
	r, err := e.app.Store.Routine(ctx, handle)
	if err != nil {
		return
	}
	r.Last, r.NextRun = &res, nil
	_, _ = e.app.Store.Append(ctx, events.Draft{Type: events.RoutineUpdated, Actor: events.System, Payload: r})
}

// nextRun is when a scheduled routine runs next, nil for one that is off or
// has no schedule.
func (e *routineEngine) nextRun(r domain.Routine) *time.Time {
	if !r.Enabled || r.Schedule == "" {
		return nil
	}
	e.mu.Lock()
	next, ok := e.next[r.Handle]
	e.mu.Unlock()
	if !ok {
		sched, err := cron.Parse(r.Schedule)
		if err != nil {
			return nil
		}
		if next, ok = sched.Next(e.now().In(e.loc)); !ok {
			return nil
		}
	}
	next = next.UTC()
	return &next
}

// List returns the routines with the time of their next run.
func (e *routineEngine) List(ctx context.Context) ([]domain.Routine, error) {
	list, err := e.app.Store.Routines(ctx)
	if err != nil {
		return nil, err
	}
	if list == nil {
		list = []domain.Routine{}
	}
	for i := range list {
		list[i].NextRun = e.nextRun(list[i])
	}
	return list, nil
}

// SetEnabled switches a routine on or off.
func (e *routineEngine) SetEnabled(ctx context.Context, handle string, enabled bool, by string) (domain.Routine, error) {
	r, err := e.app.Store.Routine(ctx, handle)
	if err != nil {
		return domain.Routine{}, err
	}
	r.Enabled, r.NextRun = enabled, nil
	if _, err := e.app.Store.Append(ctx, events.Draft{Type: events.RoutineUpdated, Actor: events.Human(by), Payload: r}); err != nil {
		return domain.Routine{}, err
	}
	e.mu.Lock()
	delete(e.next, handle) // a routine switched on again counts from now
	e.mu.Unlock()
	r.NextRun = e.nextRun(r)
	return r, nil
}

// RunNow starts a routine at once, whether or not it is switched on.
func (e *routineEngine) RunNow(ctx context.Context, handle string) error {
	r, err := e.app.Store.Routine(ctx, handle)
	if err != nil {
		return err
	}
	return e.start(ctx, r)
}

// setExtra, extraContext and clearExtra hold facts that go into the prompt of
// one message without showing up in the channel.
func (a *App) setExtra(messageID, text string) {
	a.extraMu.Lock()
	defer a.extraMu.Unlock()
	if a.extra == nil {
		a.extra = map[string]string{}
	}
	a.extra[messageID] = text
}

func (a *App) extraContext(messageID string) string {
	a.extraMu.Lock()
	defer a.extraMu.Unlock()
	return a.extra[messageID]
}

func (a *App) clearExtra(messageID string) {
	a.extraMu.Lock()
	defer a.extraMu.Unlock()
	delete(a.extra, messageID)
}

// debriefFacts collects what happened in the last day for the debrief routine.
func (a *App) debriefFacts(ctx context.Context, now time.Time) (string, error) {
	runs, err := a.Store.Runs(ctx, "", "")
	if err != nil {
		return "", err
	}
	approvals, err := a.Store.Approvals(ctx, "")
	if err != nil {
		return "", err
	}
	laneList, err := a.Store.Lanes(ctx)
	if err != nil {
		return "", err
	}
	members, err := a.Store.Members(ctx)
	if err != nil {
		return "", err
	}
	return debrief(now, debriefWindow, runs, approvals, laneList, members), nil
}

// debrief states what happened in the window before now, as plain lines.
func debrief(now time.Time, window time.Duration, runs []domain.Run, approvals []domain.Approval, laneList []domain.Lane, members []domain.Member) string {
	since := now.Add(-window)
	handles := map[string]string{}
	for _, m := range members {
		handles[m.ID] = m.Handle
	}
	type tally struct{ done, failed, cancelled int }
	perAgent := map[string]*tally{}
	var total tally
	var failures []string
	running := 0
	for _, r := range runs {
		if !r.State.Terminal() {
			if r.State != domain.RunWaitingApproval {
				running++
			}
			continue
		}
		when := r.EndedAt
		if when == nil {
			when = r.StartedAt
		}
		if when == nil || !when.After(since) {
			continue
		}
		handle := handles[r.AgentID]
		t := perAgent[handle]
		if t == nil {
			t = &tally{}
			perAgent[handle] = t
		}
		switch r.State {
		case domain.RunDone:
			t.done++
			total.done++
		case domain.RunFailed:
			t.failed++
			total.failed++
			failures = append(failures, fmt.Sprintf("@%s on %s: %s", handle, r.LaneID, clipText(r.FailureReason, 100)))
		default:
			t.cancelled++
			total.cancelled++
		}
	}
	merged := 0
	var waiting []string
	for _, ap := range approvals {
		switch {
		case ap.State == domain.ApprovalPending:
			waiting = append(waiting, clipText(ap.Title, 100))
		case ap.State == domain.ApprovalResolved && ap.Resolution != nil && ap.Resolution.Option == "merge" && ap.Resolution.At.After(since):
			merged++
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Facts for the last %d hours, up to %s.\n", int(window.Hours()), now.UTC().Format("2006-01-02 15:04 MST"))
	finished := total.done + total.failed + total.cancelled
	fmt.Fprintf(&b, "Runs: %d finished (%d done, %d failed, %d cancelled), %d still running.\n", finished, total.done, total.failed, total.cancelled, running)
	var names []string
	for handle := range perAgent {
		names = append(names, handle)
	}
	sort.Strings(names)
	for _, handle := range names {
		t := perAgent[handle]
		fmt.Fprintf(&b, "- @%s: %d (%d done, %d failed, %d cancelled)\n", handle, t.done+t.failed+t.cancelled, t.done, t.failed, t.cancelled)
	}
	fmt.Fprintf(&b, "Merged changes: %d.\n", merged)
	if len(failures) == 0 {
		b.WriteString("Failed runs: none.\n")
	} else {
		b.WriteString("Failed runs:\n")
		for i, f := range failures {
			if i == 5 {
				fmt.Fprintf(&b, "- and %d more\n", len(failures)-5)
				break
			}
			b.WriteString("- " + f + "\n")
		}
	}
	if len(waiting) == 0 {
		b.WriteString("Approvals waiting: none.\n")
	} else {
		fmt.Fprintf(&b, "Approvals waiting: %d.\n", len(waiting))
		for _, w := range waiting {
			b.WriteString("- " + w + "\n")
		}
	}
	b.WriteString("Lanes:\n")
	for _, l := range laneList {
		fmt.Fprintf(&b, "- %s: %s", l.ID, l.Health)
		if l.HealthReason != "" {
			fmt.Fprintf(&b, " (%s)", clipText(l.HealthReason, 80))
		}
		for _, w := range l.Windows {
			if w.UsedPct != nil {
				fmt.Fprintf(&b, ", %s %.0f%%", w.Name, *w.UsedPct)
			}
		}
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(line)
}

func clipText(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return strings.TrimSpace(string(runes[:n])) + "..."
}

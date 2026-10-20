package lanes

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

type LaneConfig struct {
	ID, CLI, Model string
	CostClass      domain.CostClass
	Capacity       int
	ConserveAt     int
}
type PersonaConfig struct {
	Handle, DisplayName, Role string
	Lanes                     []string
	Mode                      domain.RunMode
}
type Skipped struct{ ID, Reason string }
type Registry struct {
	mu       sync.Mutex
	lanes    map[string]*domain.Lane
	personas map[string]PersonaConfig
	app      events.Appender
	until    map[string]time.Time
	// cleanAt is when a run on the lane last finished cleanly.
	cleanAt       map[string]time.Time
	thresholds    map[string]int
	alerted       map[string]bool
	alertChannels func(context.Context, string) ([]string, error)
	changed       chan struct{}
	// now is the clock; tests replace it.
	now func() time.Time
}

func New(lanes []LaneConfig, personas []PersonaConfig, app events.Appender) (*Registry, error) {
	r := &Registry{lanes: map[string]*domain.Lane{}, personas: map[string]PersonaConfig{}, app: app, until: map[string]time.Time{}, cleanAt: map[string]time.Time{}, thresholds: map[string]int{}, alerted: map[string]bool{}, changed: make(chan struct{}), now: time.Now}
	for _, c := range lanes {
		if c.ID == "" || c.Capacity < 1 || c.ConserveAt < 0 || c.ConserveAt > 100 || r.lanes[c.ID] != nil {
			return nil, fmt.Errorf("invalid or duplicate lane %q", c.ID)
		}
		threshold := c.ConserveAt
		if threshold == 0 {
			threshold = 80
		}
		r.thresholds[c.ID] = threshold
		r.lanes[c.ID] = &domain.Lane{ID: c.ID, CLI: c.CLI, Model: c.Model, CostClass: c.CostClass, Capacity: c.Capacity, Health: domain.LaneUnknown, HealthReason: "no measurement", Windows: []domain.LaneWindow{}}
	}
	for _, p := range personas {
		if p.Handle == "" || len(p.Lanes) == 0 {
			return nil, errors.New("invalid persona")
		}
		for _, id := range p.Lanes {
			if r.lanes[id] == nil {
				return nil, fmt.Errorf("persona %s references missing lane %s", p.Handle, id)
			}
		}
		r.personas[p.Handle] = p
	}
	return r, nil
}
func (r *Registry) Pick(persona, override string) (domain.Lane, []Skipped, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.personas[persona]
	if !ok {
		return domain.Lane{}, nil, fmt.Errorf("unknown persona %s", persona)
	}
	chain := p.Lanes
	if override != "" {
		found := false
		for _, id := range chain {
			if id == override {
				found = true
				break
			}
		}
		if !found {
			return domain.Lane{}, nil, fmt.Errorf("lane %s is not in persona %s", override, persona)
		}
		chain = []string{override}
	}
	// Lanes that are available or unknown win over conserve lanes. A
	// conserve lane is used only when no other lane in the chain is usable,
	// busy lanes included: those are worth waiting for.
	var skipped []Skipped
	conserveID, conserveAt := "", 0
	busyOther := false
	for _, id := range chain {
		l := r.lanes[id]
		r.expireLocked(id, l, time.Now())
		reason := ""
		if l.Health == domain.LaneExhausted || l.Health == domain.LaneUnavailable {
			reason = l.HealthReason
			if reason == "" {
				reason = string(l.Health)
			}
		}
		if reason == "" && l.Running >= l.Capacity {
			reason = "at capacity"
			if l.Health != domain.LaneConserve {
				busyOther = true
			}
		}
		if reason == "" && l.Health == domain.LaneConserve {
			if conserveID == "" {
				conserveID, conserveAt = id, len(skipped)
			}
			skipped = append(skipped, Skipped{ID: id, Reason: "conserve: " + l.HealthReason})
			continue
		}
		if reason == "" {
			return *l, skipped, nil
		}
		skipped = append(skipped, Skipped{ID: id, Reason: reason})
	}
	if conserveID != "" && !busyOther {
		return *r.lanes[conserveID], skipped[:conserveAt], nil
	}
	return domain.Lane{}, skipped, errors.New("no healthy lane with free capacity")
}

// ErrBusy means every usable lane in the chain is at capacity: the work
// should wait, not fail.
var ErrBusy = errors.New("every usable lane is busy")

// WaitPick is Pick that waits while the only obstacle is capacity. It
// calls onWait once, the first time it has to wait, so the caller can tell
// the channel the request is queued. Exhausted or unavailable lanes still
// fail at once.
func (r *Registry) WaitPick(ctx context.Context, persona, override string, onWait func([]Skipped)) (domain.Lane, []Skipped, error) {
	waited := false
	for {
		r.mu.Lock()
		changed := r.changed
		r.mu.Unlock()
		lane, skipped, err := r.Pick(persona, override)
		if err == nil || !onlyBusy(skipped) {
			return lane, skipped, err
		}
		if !waited && onWait != nil {
			onWait(skipped)
		}
		waited = true
		select {
		case <-changed:
		case <-ctx.Done():
			return domain.Lane{}, skipped, ctx.Err()
		}
	}
}

func onlyBusy(skipped []Skipped) bool {
	busy := false
	for _, s := range skipped {
		if s.Reason != "at capacity" {
			continue
		}
		busy = true
	}
	return busy
}

func (r *Registry) Acquire(id string) error {
	r.mu.Lock()
	l := r.lanes[id]
	if l == nil {
		r.mu.Unlock()
		return fmt.Errorf("unknown lane %s", id)
	}
	if l.Running >= l.Capacity || l.Health == domain.LaneExhausted || l.Health == domain.LaneUnavailable {
		r.mu.Unlock()
		return fmt.Errorf("lane %s unavailable", id)
	}
	l.Running++
	copyLane := *l
	r.mu.Unlock()
	r.emit(copyLane)
	return nil
}
func (r *Registry) WaitAcquire(ctx context.Context, id string) error {
	for {
		r.mu.Lock()
		l := r.lanes[id]
		if l == nil {
			r.mu.Unlock()
			return fmt.Errorf("unknown lane %s", id)
		}
		if l.Health == domain.LaneExhausted || l.Health == domain.LaneUnavailable {
			r.mu.Unlock()
			return fmt.Errorf("lane %s unavailable", id)
		}
		if l.Running < l.Capacity {
			l.Running++
			copyLane := *l
			r.mu.Unlock()
			r.emit(copyLane)
			return nil
		}
		changed := r.changed
		r.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
func (r *Registry) Release(id string) {
	r.mu.Lock()
	if l := r.lanes[id]; l != nil && l.Running > 0 {
		l.Running--
		copyLane := *l
		close(r.changed)
		r.changed = make(chan struct{})
		r.mu.Unlock()
		r.emit(copyLane)
		return
	}
	r.mu.Unlock()
}
func (r *Registry) emit(l domain.Lane) {
	if r.app != nil {
		_, _ = r.app.Append(context.Background(), events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: l})
	}
}
func (r *Registry) Snapshot(id string) (domain.Lane, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	l := r.lanes[id]
	if l == nil {
		return domain.Lane{}, false
	}
	return *l, true
}

// RecordRun counts a run started on the lane for the local day and
// publishes the lane.
func (r *Registry) RecordRun(id string) {
	r.mu.Lock()
	l := r.lanes[id]
	if l == nil {
		r.mu.Unlock()
		return
	}
	r.rollDay(l)
	l.RunsToday++
	copyLane := *l
	r.mu.Unlock()
	r.emit(copyLane)
}

// rollDay resets the run counter when the local day changed.
func (r *Registry) rollDay(l *domain.Lane) {
	today := r.now().Format("2006-01-02")
	if l.RunsDate != today {
		l.RunsDate, l.RunsToday = today, 0
	}
}

// SetTokensLastHour records the token total of the last hour, or clears it
// when the reader has none.
func (r *Registry) SetTokensLastHour(ctx context.Context, id string, tokens *int64) error {
	r.mu.Lock()
	l := r.lanes[id]
	if l == nil {
		r.mu.Unlock()
		return fmt.Errorf("unknown lane %s", id)
	}
	l.TokensLastHour = tokens
	r.rollDay(l)
	copyLane := *l
	r.mu.Unlock()
	if r.app == nil {
		return nil
	}
	_, err := r.app.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: copyLane})
	return err
}

// expireLocked turns an exhausted lane whose reset time passed back to
// unknown. It reports whether the lane changed. r.mu must be held.
func (r *Registry) expireLocked(id string, l *domain.Lane, now time.Time) bool {
	if l.Health != domain.LaneExhausted || r.until[id].IsZero() || !now.After(r.until[id]) {
		return false
	}
	l.Health = domain.LaneUnknown
	l.HealthReason = "reset time passed"
	delete(r.alerted, id)
	l.Alerted = false
	return true
}

// cleanRunFresh is how long a clean run counts as evidence that a lane works
// when no usage reading says otherwise.
const cleanRunFresh = time.Hour

// healthLocked is the usage health, or available when the readings say
// nothing and a run finished cleanly within cleanRunFresh. r.mu must be held.
func (r *Registry) healthLocked(id string, l *domain.Lane, now time.Time) (domain.LaneHealth, string) {
	health, reason := usageHealth(l.CLI, l.Windows, r.thresholds[id], now)
	if at := r.cleanAt[id]; health == domain.LaneUnknown && !at.IsZero() && now.Sub(at) < cleanRunFresh {
		return domain.LaneAvailable, fmt.Sprintf("last run finished cleanly %s ago", now.Sub(at).Round(time.Minute))
	}
	return health, reason
}

// RecordClean notes a run that finished without a lane signal. A lane with
// no usage reading shows as available for the next hour instead of unknown.
func (r *Registry) RecordClean(id string, now time.Time) {
	r.mu.Lock()
	l := r.lanes[id]
	if l == nil || l.Health == domain.LaneExhausted || l.Health == domain.LaneUnavailable {
		r.mu.Unlock()
		return
	}
	r.cleanAt[id] = now
	health, reason := r.healthLocked(id, l, now)
	if health == l.Health && reason == l.HealthReason {
		r.mu.Unlock()
		return
	}
	l.Health, l.HealthReason = health, reason
	copyLane := *l
	r.mu.Unlock()
	r.emit(copyLane)
}

// ExpireResets publishes lanes whose reset time passed, and lanes whose
// last clean run is too old to count. Without it a lane nobody tries stays
// exhausted on every screen, and so nobody tries it.
func (r *Registry) ExpireResets(now time.Time) {
	r.mu.Lock()
	var changed []domain.Lane
	for id, l := range r.lanes {
		if r.expireLocked(id, l, now) {
			changed = append(changed, *l)
			continue
		}
		// A clean run stops counting after cleanRunFresh.
		if l.Health == domain.LaneAvailable && !r.cleanAt[id].IsZero() && now.Sub(r.cleanAt[id]) >= cleanRunFresh {
			delete(r.cleanAt, id)
			if health, reason := r.healthLocked(id, l, now); health != l.Health {
				l.Health, l.HealthReason = health, reason
				changed = append(changed, *l)
			}
		}
	}
	r.mu.Unlock()
	for _, l := range changed {
		r.emit(l)
	}
}

// Restore keeps persisted health when the daemon starts again.
func (r *Registry) Restore(lane domain.Lane) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if current := r.lanes[lane.ID]; current != nil {
		r.alerted[lane.ID] = lane.Alerted || isAlert(lane.Health)
		current.Alerted = r.alerted[lane.ID]
		current.RunsToday, current.RunsDate = lane.RunsToday, lane.RunsDate
		current.TokensLastHour = lane.TokensLastHour
		current.CostTodayUSD = lane.CostTodayUSD
		r.rollDay(current)
		current.Health = lane.Health
		current.HealthReason = lane.HealthReason
		current.Windows = lane.Windows
		current.LastError = lane.LastError
		if lane.Health == domain.LaneExhausted && lane.LastError != nil && lane.LastError.ResetAt != nil {
			r.until[lane.ID] = *lane.LastError.ResetAt
		} else if lane.Health == domain.LaneExhausted && lane.LastError != nil && lane.LastError.Class == string(adapters.SignalExhausted) {
			r.until[lane.ID] = lane.LastError.At.Add(unknownResetRetry)
		}
	}
}

// ResetAt is the reset learned from a failed run, if any.
func (r *Registry) ResetAt(id string) time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.until[id]
}

// ApplyManualHealth replaces a stored failure signal after a human override.
// In particular, an old reset must not re-exhaust the lane later.
func (r *Registry) ApplyManualHealth(ctx context.Context, id string, health domain.LaneHealth) error {
	r.mu.Lock()
	l := r.lanes[id]
	if l == nil {
		r.mu.Unlock()
		return fmt.Errorf("unknown lane %s", id)
	}
	l.Health, l.HealthReason, l.LastError = health, "manual override", nil
	delete(r.until, id)
	delete(r.alerted, id)
	l.Alerted = false
	close(r.changed)
	r.changed = make(chan struct{})
	copyLane := *l
	r.mu.Unlock()
	if r.app == nil {
		return nil
	}
	_, err := r.app.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: copyLane})
	return err
}

func (r *Registry) SetCostToday(ctx context.Context, id string, estimate *float64) error {
	r.mu.Lock()
	l := r.lanes[id]
	if l == nil {
		r.mu.Unlock()
		return fmt.Errorf("unknown lane %s", id)
	}
	l.CostTodayUSD = estimate
	copyLane := *l
	r.mu.Unlock()
	if r.app == nil {
		return nil
	}
	_, err := r.app.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: copyLane})
	return err
}

func isAlert(h domain.LaneHealth) bool {
	return h == domain.LaneConserve || h == domain.LaneExhausted || h == domain.LaneUnavailable
}

func (r *Registry) SetAlertChannels(fn func(context.Context, string) ([]string, error)) {
	r.mu.Lock()
	r.alertChannels = fn
	r.mu.Unlock()
}

func (r *Registry) alertTransition(id string, h domain.LaneHealth) bool {
	if !isAlert(h) {
		if h == domain.LaneAvailable {
			delete(r.alerted, id)
			r.lanes[id].Alerted = false
		}
		return false
	}
	if r.alerted[id] {
		return false
	}
	r.alerted[id] = true
	r.lanes[id].Alerted = true
	return true
}

func (r *Registry) emitAlert(ctx context.Context, l domain.Lane, skipChannel string) error {
	if r.app == nil {
		return nil
	}
	if _, err := r.app.Append(ctx, events.Draft{Type: events.LaneAlert, Actor: events.System, Payload: struct {
		LaneID string            `json:"lane_id"`
		Health domain.LaneHealth `json:"health"`
		Reason string            `json:"reason"`
	}{l.ID, l.Health, l.HealthReason}}); err != nil {
		return err
	}
	if r.alertChannels == nil {
		return nil
	}
	channels, err := r.alertChannels(ctx, l.ID)
	if err != nil {
		return err
	}
	for _, channel := range channels {
		if channel == skipChannel {
			continue
		}
		if _, err := r.app.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, ChannelID: channel, Payload: events.NoticePayload{Level: "warn", Text: fmt.Sprintf("Lane %s is %s: %s", l.ID, l.Health, l.HealthReason)}}); err != nil {
			return err
		}
	}
	return nil
}

// UpdateUsage refreshes readings without clearing a hard failure signal.
func (r *Registry) UpdateUsage(ctx context.Context, id string, windows []domain.LaneWindow) error {
	return r.UpdateUsageAsked(ctx, id, windows, false)
}

// UpdateUsageAsked is UpdateUsage for a reading the human asked for. A failed
// run marks a lane exhausted until a reset time it guessed; if the human
// probes and the fresh reading shows every window below the conserve
// threshold, that mark was stale and the probe clears it. The background
// ticker passes asked=false and never does, so a wrong reading cannot undo a
// real failure on its own.
func (r *Registry) UpdateUsageAsked(ctx context.Context, id string, windows []domain.LaneWindow, asked bool) error {
	r.mu.Lock()
	l := r.lanes[id]
	if l == nil {
		r.mu.Unlock()
		return fmt.Errorf("unknown lane %s", id)
	}
	l.Windows = windows
	now := time.Now()
	cleared := false
	if asked && l.Health == domain.LaneExhausted {
		if health, _ := usageHealth(l.CLI, windows, r.thresholds[id], now); health == domain.LaneAvailable {
			l.LastError = nil
			delete(r.until, id)
			l.Health, l.HealthReason = domain.LaneAvailable, "cleared by probe"
			cleared = true
			close(r.changed)
			r.changed = make(chan struct{})
		}
	}
	if !cleared && r.canUpdateFromUsage(id, l, now) {
		l.Health, l.HealthReason = r.healthLocked(id, l, now)
	}
	alert := r.alertTransition(id, l.Health)
	copyLane := *l
	r.mu.Unlock()
	if r.app == nil {
		return nil
	}
	_, err := r.app.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: copyLane})
	if err == nil {
		for _, window := range windows {
			_, err = r.app.Append(ctx, events.Draft{Type: events.LaneUsageRead, Actor: events.System, Payload: struct {
				LaneID string            `json:"lane_id"`
				Window domain.LaneWindow `json:"window"`
				ReadAt time.Time         `json:"read_at"`
			}{id, window, now.UTC()}})
			if err != nil {
				return err
			}
		}
		if alert {
			err = r.emitAlert(ctx, copyLane, "")
		}
		r.scheduleExpiry(id, windows, now)
	}
	return err
}

func (r *Registry) canUpdateFromUsage(id string, l *domain.Lane, now time.Time) bool {
	return l.Health != domain.LaneUnavailable &&
		(l.LastError == nil || l.LastError.Class != string(adapters.SignalExhausted) ||
			!r.until[id].IsZero() && now.After(r.until[id]))
}

// scheduleExpiry emits a new lane state when the first fresh reading expires.
func (r *Registry) scheduleExpiry(id string, windows []domain.LaneWindow, now time.Time) {
	if r.app == nil {
		return
	}
	var next time.Time
	for _, w := range windows {
		if w.MeasuredAt == nil || w.UsedPct == nil {
			continue
		}
		expires := w.MeasuredAt.Add(15 * time.Minute)
		if expires.After(now) && (next.IsZero() || expires.Before(next)) {
			next = expires
		}
	}
	if next.IsZero() {
		return
	}
	time.AfterFunc(time.Until(next), func() {
		r.expireUsage(id, time.Now())
	})
}

func (r *Registry) expireUsage(id string, now time.Time) {
	r.mu.Lock()
	l := r.lanes[id]
	if l == nil || !r.canUpdateFromUsage(id, l, now) {
		r.mu.Unlock()
		return
	}
	health, reason := usageHealth(l.CLI, l.Windows, r.thresholds[id], now)
	if health == l.Health && reason == l.HealthReason {
		r.mu.Unlock()
		return
	}
	l.Health, l.HealthReason = health, reason
	r.alertTransition(id, l.Health)
	copyLane := *l
	r.mu.Unlock()
	r.emit(copyLane)
}

func usageHealth(cli string, windows []domain.LaneWindow, threshold int, now time.Time) (domain.LaneHealth, string) {
	if len(windows) == 0 {
		return domain.LaneUnknown, "no measurement"
	}
	var missing, stale string
	var conserve bool
	var sources []string
	for _, w := range windows {
		if w.UsedPct == nil || w.MeasuredAt == nil || w.UsedPct != nil && *w.UsedPct < 0 || w.Source != domain.SourceCLILog && w.Source != domain.SourceProbe {
			if cli == "claude" && w.UsedPct == nil && w.Source == domain.SourceCLILog {
				missing = "manual plan limit needed for quota percentage"
			} else if missing == "" {
				missing = "no measurement"
			}
			continue
		}
		age := now.Sub(*w.MeasuredAt)
		if age < 0 || age >= 15*time.Minute {
			if stale == "" {
				stale = fmt.Sprintf("measurement %.0fm old", age.Minutes())
			}
			continue
		}
		if *w.UsedPct >= 100 {
			return domain.LaneExhausted, fmt.Sprintf("%s at 100%% (%s, %s old)", w.Name, w.Source, age.Round(time.Minute))
		}
		if *w.UsedPct >= float64(threshold) {
			conserve = true
		}
		sources = append(sources, fmt.Sprintf("%s %s %.0fm old", w.Name, w.Source, age.Minutes()))
	}
	if missing != "" {
		return domain.LaneUnknown, missing
	}
	if stale != "" {
		return domain.LaneUnknown, stale
	}
	if conserve {
		return domain.LaneConserve, fmt.Sprintf("usage at or above %d%%; %s", threshold, strings.Join(sources, ", "))
	}
	return domain.LaneAvailable, strings.Join(sources, ", ")
}

// unknownResetRetry is when an exhausted lane whose error named no reset
// time is tried again.
const unknownResetRetry = time.Hour

func (r *Registry) ApplySignal(ctx context.Context, runID, persona, laneID string, signal adapters.LaneSignal, reason string) error {
	return r.ApplySignalForChannel(ctx, runID, "", persona, laneID, signal, reason)
}
func (r *Registry) ApplySignalForChannel(ctx context.Context, runID, channelID, persona, laneID string, signal adapters.LaneSignal, reason string) error {
	if signal.Kind == adapters.SignalNone {
		return nil
	}
	r.mu.Lock()
	l := r.lanes[laneID]
	if l == nil {
		r.mu.Unlock()
		return fmt.Errorf("unknown lane %s", laneID)
	}
	// A clean run from before this failure says nothing about the lane now.
	delete(r.cleanAt, laneID)
	if signal.Kind == adapters.SignalExhausted {
		if signal.Until.IsZero() {
			// No reset in the error. Try the lane again later rather than
			// leaving it exhausted until someone resets it by hand.
			signal.Until = time.Now().Add(unknownResetRetry)
		}
		l.Health = domain.LaneExhausted
		r.until[laneID] = signal.Until
	} else {
		l.Health = domain.LaneUnavailable
	}
	l.HealthReason = reason
	l.LastError = &domain.LaneError{Class: string(signal.Kind), Message: reason, At: time.Now().UTC()}
	if signal.Kind == adapters.SignalExhausted && !signal.Until.IsZero() {
		until := signal.Until.UTC()
		l.LastError.ResetAt = &until
	}
	alert := r.alertTransition(laneID, l.Health)
	close(r.changed)
	r.changed = make(chan struct{})
	copyLane := *l
	r.mu.Unlock()
	if r.app == nil {
		return nil
	}
	if _, err := r.app.Append(ctx, events.Draft{Type: events.LaneUpdated, Version: 1, Actor: events.System, Payload: copyLane}); err != nil {
		return err
	}
	next, _, err := r.Pick(persona, "")
	if err != nil {
		if alert {
			return r.emitAlert(ctx, copyLane, "")
		}
		return nil
	}
	if next.ID == laneID {
		if alert {
			return r.emitAlert(ctx, copyLane, "")
		}
		return nil
	}
	if alert {
		if err := r.emitAlert(ctx, copyLane, channelID); err != nil {
			return err
		}
	}
	if _, err = r.app.Append(ctx, events.Draft{Type: events.LaneSwitched, Version: 1, Actor: events.System, ChannelID: channelID, Payload: events.LaneSwitchedPayload{RunID: runID, From: laneID, To: next.ID, Reason: reason}}); err != nil {
		return err
	}
	if alert {
		_, err = r.app.Append(ctx, events.Draft{Type: events.Notice, Version: 1, Actor: events.System, ChannelID: channelID, Payload: events.NoticePayload{Level: "warn", Text: fmt.Sprintf("Lane %s is %s (%s); next run uses %s", laneID, copyLane.Health, reason, next.ID)}})
	}
	return err
}

// Busy reports whether any lane in skipped was skipped only for lack of
// free capacity, so waiting could still produce a lane.
func Busy(skipped []Skipped) bool { return onlyBusy(skipped) }

// Recover clears a failure signal after a probe or a run succeeded on the
// lane: an unavailable or exhausted lane goes back to unknown until the next
// reading, and the last error is dropped. It does nothing for a lane without
// a recorded error.
func (r *Registry) Recover(ctx context.Context, id, reason string) error {
	return r.RecoverSince(ctx, id, reason, time.Time{})
}

// RecoverSince is Recover for a run that started at since: a failure
// recorded after that moment is newer than the run's success and stays.
func (r *Registry) RecoverSince(ctx context.Context, id, reason string, since time.Time) error {
	r.mu.Lock()
	l := r.lanes[id]
	if l == nil || l.LastError == nil || l.LastError.At.After(since) && !since.IsZero() {
		r.mu.Unlock()
		return nil
	}
	l.LastError = nil
	if l.Health == domain.LaneUnavailable || l.Health == domain.LaneExhausted {
		l.Health, l.HealthReason = domain.LaneUnknown, reason
	}
	delete(r.alerted, id)
	l.Alerted = false
	delete(r.until, id)
	close(r.changed)
	r.changed = make(chan struct{})
	copyLane := *l
	r.mu.Unlock()
	if r.app == nil {
		return nil
	}
	_, err := r.app.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: copyLane})
	return err
}

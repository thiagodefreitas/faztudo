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
	mu         sync.Mutex
	lanes      map[string]*domain.Lane
	personas   map[string]PersonaConfig
	app        events.Appender
	until      map[string]time.Time
	thresholds map[string]int
	changed    chan struct{}
}

func New(lanes []LaneConfig, personas []PersonaConfig, app events.Appender) (*Registry, error) {
	r := &Registry{lanes: map[string]*domain.Lane{}, personas: map[string]PersonaConfig{}, app: app, until: map[string]time.Time{}, thresholds: map[string]int{}, changed: make(chan struct{})}
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
	var skipped []Skipped
	for _, id := range chain {
		l := r.lanes[id]
		if l.Health == domain.LaneExhausted && !r.until[id].IsZero() && time.Now().After(r.until[id]) {
			l.Health = domain.LaneUnknown
			l.HealthReason = "reset time passed"
		}
		reason := ""
		if l.Health == domain.LaneExhausted || l.Health == domain.LaneUnavailable {
			reason = l.HealthReason
			if reason == "" {
				reason = string(l.Health)
			}
		}
		if reason == "" && l.Running >= l.Capacity {
			reason = "at capacity"
		}
		if reason == "" {
			return *l, skipped, nil
		}
		skipped = append(skipped, Skipped{ID: id, Reason: reason})
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

// Restore keeps persisted health when the daemon starts again.
func (r *Registry) Restore(lane domain.Lane) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if current := r.lanes[lane.ID]; current != nil {
		current.Health = lane.Health
		current.HealthReason = lane.HealthReason
		current.Windows = lane.Windows
		current.LastError = lane.LastError
	}
}

// UpdateUsage refreshes readings without clearing a hard failure signal.
func (r *Registry) UpdateUsage(ctx context.Context, id string, windows []domain.LaneWindow) error {
	r.mu.Lock()
	l := r.lanes[id]
	if l == nil {
		r.mu.Unlock()
		return fmt.Errorf("unknown lane %s", id)
	}
	l.Windows = windows
	now := time.Now()
	if r.canUpdateFromUsage(id, l, now) {
		l.Health, l.HealthReason = usageHealth(l.CLI, windows, r.thresholds[id], now)
	}
	copyLane := *l
	r.mu.Unlock()
	if r.app == nil {
		return nil
	}
	_, err := r.app.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: copyLane})
	if err == nil {
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
	if signal.Kind == adapters.SignalExhausted {
		l.Health = domain.LaneExhausted
		r.until[laneID] = signal.Until
	} else {
		l.Health = domain.LaneUnavailable
	}
	l.HealthReason = reason
	l.LastError = &domain.LaneError{Class: string(signal.Kind), Message: reason, At: time.Now().UTC()}
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
		return nil
	}
	if next.ID == laneID {
		return nil
	}
	if _, err = r.app.Append(ctx, events.Draft{Type: events.LaneSwitched, Version: 1, Actor: events.System, ChannelID: channelID, Payload: events.LaneSwitchedPayload{RunID: runID, From: laneID, To: next.ID, Reason: reason}}); err != nil {
		return err
	}
	_, err = r.app.Append(ctx, events.Draft{Type: events.Notice, Version: 1, Actor: events.System, ChannelID: channelID, Payload: events.NoticePayload{Level: "warn", Text: fmt.Sprintf("Lane %s is %s (%s); next run uses %s", laneID, copyLane.Health, reason, next.ID)}})
	return err
}

package lanes

import (
	"context"
	"errors"
	"fmt"
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
	changed  chan struct{}
}

func New(lanes []LaneConfig, personas []PersonaConfig, app events.Appender) (*Registry, error) {
	r := &Registry{lanes: map[string]*domain.Lane{}, personas: map[string]PersonaConfig{}, app: app, until: map[string]time.Time{}, changed: make(chan struct{})}
	for _, c := range lanes {
		if c.ID == "" || c.Capacity < 1 || r.lanes[c.ID] != nil {
			return nil, fmt.Errorf("invalid or duplicate lane %q", c.ID)
		}
		r.lanes[c.ID] = &domain.Lane{ID: c.ID, CLI: c.CLI, Model: c.Model, CostClass: c.CostClass, Capacity: c.Capacity, Health: domain.LaneAvailable, Windows: []domain.LaneWindow{}}
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
func (r *Registry) Acquire(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	l := r.lanes[id]
	if l == nil {
		return fmt.Errorf("unknown lane %s", id)
	}
	if l.Running >= l.Capacity || l.Health == domain.LaneExhausted || l.Health == domain.LaneUnavailable {
		return fmt.Errorf("lane %s unavailable", id)
	}
	l.Running++
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
			r.mu.Unlock()
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
	defer r.mu.Unlock()
	if l := r.lanes[id]; l != nil && l.Running > 0 {
		l.Running--
		close(r.changed)
		r.changed = make(chan struct{})
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

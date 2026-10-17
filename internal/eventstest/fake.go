package eventstest

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/events"
)

type Appender struct {
	mu     sync.Mutex
	Drafts []events.Draft
}

func (a *Appender) Append(_ context.Context, d events.Draft) (events.Event, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.Drafts = append(a.Drafts, d)
	payload, err := json.Marshal(d.Payload)
	if err != nil {
		return events.Event{}, err
	}
	return events.Event{Seq: int64(len(a.Drafts)), Type: d.Type, Version: d.Version, Actor: d.Actor, ChannelID: d.ChannelID, Payload: payload, TS: time.Now()}, nil
}
func (a *Appender) Snapshot() []events.Draft {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]events.Draft(nil), a.Drafts...)
}

package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

// staleHandoff is how long a handoff that started no run still counts as
// open work.
var staleHandoff = time.Hour

func promptHandle(handles map[string]string, id string) string {
	if h := handles[id]; h != "" {
		return h
	}
	return id
}

func workingRun(state domain.RunState) bool {
	return state == domain.RunQueued || state == domain.RunRunning || state == domain.RunVerifying || state == domain.RunWaitingApproval
}

func (a *App) workingPrompt(ctx context.Context, channelID, currentRun string, mode domain.RunMode, handles map[string]string) (string, error) {
	if channelID == "" {
		// Store.Runs reads every channel for an empty id.
		return "", nil
	}
	runs, err := a.Store.Runs(ctx, channelID, "")
	if err != nil {
		return "", err
	}
	active := make([]domain.Run, 0)
	byTrigger := make(map[string][]domain.Run, len(runs))
	for _, r := range runs {
		byTrigger[r.TriggerMessageID] = append(byTrigger[r.TriggerMessageID], r)
		if r.ID != currentRun && workingRun(r.State) {
			active = append(active, r)
		}
	}
	handoffs, err := a.Store.EventsOfTypes(ctx, channelID, events.HandoffCreated)
	if err != nil {
		return "", err
	}
	// Run ids are ULIDs, so they sort by creation time.
	sort.Slice(active, func(i, j int) bool { return active[i].ID > active[j].ID })
	now := time.Now().UTC()
	open := make([]events.HandoffPayload, 0)
	for i := len(handoffs) - 1; i >= 0; i-- {
		var h events.HandoffPayload
		if err := json.Unmarshal(handoffs[i].Payload, &h); err != nil {
			return "", err
		}
		if h.Refusal != "" || h.MessageID == "" {
			continue
		}
		started := byTrigger[h.MessageID]
		if len(started) == 0 && now.Sub(handoffs[i].TS) > staleHandoff {
			// Never picked up (lane gone, budget spent): an old one would
			// otherwise read as open forever.
			continue
		}
		finished := len(started) > 0
		for _, r := range started {
			if !r.State.Terminal() {
				finished = false
				break
			}
		}
		if !finished {
			open = append(open, h)
		}
	}
	if len(active) == 0 && len(open) == 0 {
		return "", nil
	}
	var b strings.Builder
	b.WriteString("Working now:\n")
	for i, r := range active {
		if i == 10 {
			fmt.Fprintf(&b, "- and %d more runs\n", len(active)-i)
			break
		}
		started := now
		if r.StartedAt != nil {
			started = *r.StartedAt
		}
		task := ""
		if m, err := a.Store.Message(ctx, r.TriggerMessageID); err == nil {
			task = clipText(firstLine(m.Body), 120)
			if r.StartedAt == nil && !m.CreatedAt.IsZero() {
				started = m.CreatedAt
			}
		} else if !errors.Is(err, store.ErrNotFound) {
			return "", err
		}
		if started.After(now) {
			started = now
		}
		fmt.Fprintf(&b, "- run %s: @%s, lane %s, %s, %s, %s: %s\n", r.ID, promptHandle(handles, r.AgentID), r.LaneID, r.Mode, r.State, now.Sub(started).Truncate(time.Second), task)
	}
	for i, h := range open {
		if i == 10 {
			fmt.Fprintf(&b, "- and %d more handoffs\n", len(open)-i)
			break
		}
		fmt.Fprintf(&b, "- handoff @%s -> @%s: %s\n", h.From, h.To, clipText(firstLine(h.Task), 120))
	}
	if mode == domain.RunWrite {
		for _, r := range active {
			if r.Mode == domain.RunWrite {
				b.WriteString("Keep to your own task and say which files you touched in your answer.\n")
				break
			}
		}
	}
	b.WriteByte('\n')
	return b.String(), nil
}

func (a *App) pinnedPrompt(ctx context.Context, channelID string, handles map[string]string) (string, error) {
	pins, err := a.Store.Pins(ctx, channelID)
	if err != nil || len(pins) == 0 {
		return "", err
	}
	var b strings.Builder
	b.WriteString("Pinned in this channel:\n")
	contentBytes := 0
	for i, pin := range pins {
		if i == 8 || contentBytes >= 3900 {
			break
		}
		body := clipText(pin.Message.Body, 600)
		prefix := fmt.Sprintf("- @%s: ", promptHandle(handles, pin.Message.AuthorID))
		left := 3900 - contentBytes - len(prefix) - 1
		if left <= 0 {
			break
		}
		if len(body) > left {
			body = strings.ToValidUTF8(body[:left], "")
		}
		line := prefix + body + "\n"
		b.WriteString(line)
		contentBytes += len(line)
	}
	if contentBytes == 0 {
		return "", nil
	}
	b.WriteByte('\n')
	return b.String(), nil
}

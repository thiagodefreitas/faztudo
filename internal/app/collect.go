package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func collectFinished(s domain.RunState) bool {
	return s.Terminal() || s == domain.RunWaitingApproval
}

// collectStarted reports whether the collect run for message id exists.
func collectStarted(runs []domain.Run, id string) bool {
	for _, r := range runs {
		if r.TriggerMessageID == id {
			return true
		}
	}
	return false
}

func collectClip(s string, limit int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= limit {
		return string(r)
	}
	return string(r[:limit]) + "..."
}

func (a *App) startCollecting(ctx context.Context) error {
	if a.Config.Runs.CollectDelegations != nil && !*a.Config.Runs.CollectDelegations {
		return nil
	}
	head, err := a.Store.LastSeq(ctx)
	if err != nil {
		return err
	}
	feed, err := a.Store.Subscribe(ctx, head)
	if err != nil {
		return err
	}
	channels, err := a.Store.Channels(ctx)
	if err != nil {
		return err
	}
	for _, ch := range channels {
		if err := a.collectReady(ctx, ch.ID); err != nil {
			return err
		}
	}
	go func() {
		for e := range feed {
			switch e.Type {
			case events.HandoffCreated, events.RunUpdated, events.RunCreated, events.MessagePosted, events.ApprovalResolved:
				_ = a.collectReady(context.Background(), e.ChannelID)
			}
		}
	}()
	return nil
}

// collectReady uses the event log as its decision record. A collected event
// reserves one stable message id before any follow-up run is started.
func (a *App) collectReady(ctx context.Context, channelID string) error {
	if channelID == "" || (a.Config.Runs.CollectDelegations != nil && !*a.Config.Runs.CollectDelegations) {
		return nil
	}
	a.collectMu.Lock()
	defer a.collectMu.Unlock()
	log, err := a.Store.EventsOfTypes(ctx, channelID, events.HandoffCreated, events.HandoffCollected)
	if err != nil {
		return err
	}
	groups := map[string][]events.HandoffPayload{}
	collected := map[string]events.HandoffCollectedPayload{}
	for _, e := range log {
		switch e.Type {
		case events.HandoffCreated:
			var p events.HandoffPayload
			if err := json.Unmarshal(e.Payload, &p); err != nil {
				return err
			}
			if p.ParentRunID == "" && p.MessageID != "" {
				if msg, err := a.Store.Message(ctx, p.MessageID); err == nil {
					p.ParentRunID = msg.RunID
				}
			}
			if p.ParentRunID != "" {
				groups[p.ParentRunID] = append(groups[p.ParentRunID], p)
			}
		case events.HandoffCollected:
			var p events.HandoffCollectedPayload
			if err := json.Unmarshal(e.Payload, &p); err != nil {
				return err
			}
			collected[p.ParentRunID] = p
		}
	}
	if len(groups) == 0 {
		return nil
	}
	runs, err := a.Store.Runs(ctx, channelID, "")
	if err != nil {
		return err
	}
	for parentID, handoffs := range groups {
		if p, ok := collected[parentID]; ok && collectStarted(runs, p.MessageID) {
			continue // settled; skip the reads on every later event
		}
		parent, err := a.Store.Run(ctx, parentID)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if !collectFinished(parent.State) {
			continue
		}
		if parent.State == domain.RunDone || parent.State == domain.RunWaitingApproval {
			if _, err := a.Store.MessageByKey(ctx, channelID, "run-answer:"+parent.ID); errors.Is(err, store.ErrNotFound) {
				continue
			} else if err != nil {
				return err
			}
		}
		trigger, err := a.Store.Message(ctx, parent.TriggerMessageID)
		if err != nil {
			return err
		}
		agent, err := a.Store.Member(ctx, parent.AgentID)
		if err != nil {
			return err
		}
		var digest strings.Builder
		digest.WriteString("Write one combined answer for the original request. Name anything still open.\n\nOriginal request:\n")
		digest.WriteString(collectClip(trigger.Body, 4000))
		digest.WriteString("\n\nDelegated results:\n")
		ready := true
		for _, h := range handoffs {
			state, answer := "refused", h.Refusal
			if h.Refusal == "" {
				var latest *domain.Run
				for i := range runs {
					if runs[i].TriggerMessageID == h.MessageID {
						if !collectFinished(runs[i].State) {
							ready = false
							break
						}
						if latest == nil || runs[i].ID > latest.ID {
							latest = &runs[i]
						}
					}
				}
				if latest == nil || !collectFinished(latest.State) {
					ready = false
					break
				}
				state = string(latest.State)
				if msg, err := a.Store.MessageByKey(ctx, channelID, "run-answer:"+latest.ID); err == nil {
					answer = msg.Body
				} else if !errors.Is(err, store.ErrNotFound) {
					return err
				} else if latest.StartedAt != nil {
					ready = false
					break
				}
				if answer == "" {
					answer = latest.FailureReason
				}
			}
			task := h.Task
			if task == "" && h.MessageID != "" {
				if msg, err := a.Store.Message(ctx, h.MessageID); err == nil {
					task = msg.Body
				}
			}
			if i := strings.IndexByte(task, '\n'); i >= 0 {
				task = task[:i]
			}
			line := fmt.Sprintf("- @%s: %s [%s]\n  %s\n", h.To, collectClip(task, 300), state, collectClip(answer, 4000))
			if digest.Len()+len(line) > 20000 {
				digest.WriteString("- Further results clipped.\n")
				break
			}
			digest.WriteString(line)
		}
		if !ready {
			continue
		}
		p, exists := collected[parentID]
		if !exists {
			request := handoffs[0].RequestID
			premium := false
			if agent.Agent != nil && len(agent.Agent.Lanes) > 0 {
				if lane, err := a.Store.Lane(ctx, agent.Agent.Lanes[0]); err == nil {
					premium = lane.CostClass == domain.CostPremium
				}
			}
			if a.MCP != nil {
				if err := a.MCP.ReserveCollect(ctx, parent, request, premium); err != nil {
					continue
				}
			}
			p = events.HandoffCollectedPayload{ParentRunID: parentID, RequestID: request, MessageID: store.NewID(), Premium: premium}
			e, err := a.Store.Append(ctx, events.Draft{Type: events.HandoffCollected, Actor: events.System, ChannelID: channelID, IdempotencyKey: "collect:" + parentID, Payload: p})
			if err != nil {
				if a.MCP != nil {
					a.MCP.ReleaseCollect(request, premium)
				}
				return err
			}
			if err := json.Unmarshal(e.Payload, &p); err != nil {
				return err
			}
		}
		thread := trigger.ThreadID
		if thread == "" {
			thread = trigger.ID
		}
		msg := domain.Message{ID: p.MessageID, ChannelID: channelID, ThreadID: thread, AuthorID: agent.ID, Body: digest.String(), Mentions: []string{}, CollectForRunID: parentID, CreatedAt: time.Now().UTC()}
		if _, err := a.Store.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Agent(agent.ID), ChannelID: channelID, IdempotencyKey: "collect-message:" + parentID, Payload: msg}); err != nil {
			return err
		}
		already := false
		for _, r := range runs {
			if r.TriggerMessageID == msg.ID && r.AgentID == agent.ID {
				already = true
				break
			}
		}
		if already {
			continue
		}
		if _, err := a.queueRun(ctx, msg, agent, domain.RunRead, "", "", false); err != nil {
			return err
		}
		if a.queuedDispatch != nil {
			go a.queuedDispatch(context.Background(), msg, agent, "")
		} else {
			go a.run(context.Background(), msg, agent, "")
		}
	}
	return nil
}

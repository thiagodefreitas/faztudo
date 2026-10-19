package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/org"
)

const delegateDescription = "Hand work to another agent. Only the Chief of Staff and department leads may call it: the Chief of Staff can hand work to any agent, a lead only to the members of its departments. Delegation is one level deep, and one request can start only a limited number of runs; past that the Director is asked. The task is posted in a thread under the request, so the Director can read it. Returns at once and does not wait for the result, which is posted in that thread. Does not modify the work tree."

const (
	defaultRequestRuns    = 6
	defaultRequestPremium = 2
)

type delegateIn struct {
	To   string `json:"to" jsonschema:"handle of the agent to hand the work to, without the @"`
	Task string `json:"task" jsonschema:"what to do, with the context that agent needs"`
}

type delegateOut struct {
	MessageID string `json:"message_id"`
	To        string `json:"to"`
	Depth     int    `json:"depth"`
}

type handoffEvent = events.HandoffPayload

// RestoreBudget rebuilds committed request counts before another run reserves
// capacity. The event log is the durable record; the ledger is a cache.
func (h *Handler) RestoreBudget(ctx context.Context) error {
	h.budgetMu.Lock()
	defer h.budgetMu.Unlock()
	if h.budgetLoaded {
		return nil
	}
	ledger := org.NewLedger()
	channels, err := h.store.Channels(ctx)
	if err != nil {
		return err
	}
	for _, channel := range channels {
		batch, err := h.store.EventsOfTypes(ctx, channel.ID, events.HandoffCreated, events.HandoffCollected)
		if err != nil {
			return err
		}
		for _, e := range batch {
			switch e.Type {
			case events.HandoffCreated:
				var p events.HandoffPayload
				if err := json.Unmarshal(e.Payload, &p); err != nil {
					return err
				}
				if p.MessageID == "" || p.RequestID == "" {
					continue
				}
				premium := p.Premium
				if !premium && p.ParentRunID == "" {
					if target, err := h.store.MemberByHandle(ctx, p.To); err == nil {
						premium = h.premium(ctx, target)
					}
				}
				ledger.Restore(p.RequestID, premium)
			case events.HandoffCollected:
				var p events.HandoffCollectedPayload
				if err := json.Unmarshal(e.Payload, &p); err != nil {
					return err
				}
				ledger.Restore(p.RequestID, p.Premium)
			}
		}
	}
	h.ledger = ledger
	h.budgetLoaded = true
	return nil
}

// ReserveCollect charges the follow-up run to its original request and uses
// the same Director choice card path as delegate.
func (h *Handler) ReserveCollect(ctx context.Context, run domain.Run, request string, premium bool) error {
	return h.reserve(ctx, Grant{RunID: run.ID, AgentID: run.AgentID, ChannelID: run.ChannelID}, request, premium)
}

func (h *Handler) ReleaseCollect(request string, premium bool) {
	h.ledger.Release(request, premium)
}

func (h *Handler) limits() org.Limits {
	if h.Policy.Limits.MaxRuns < 1 {
		return org.Limits{MaxRuns: defaultRequestRuns, MaxPremium: defaultRequestPremium}
	}
	return h.Policy.Limits
}

// premium reports whether the agent's first lane is a premium one.
func (h *Handler) premium(ctx context.Context, m domain.Member) bool {
	if m.Agent == nil || len(m.Agent.Lanes) == 0 {
		return false
	}
	lane, err := h.store.Lane(ctx, m.Agent.Lanes[0])
	return err == nil && lane.CostClass == domain.CostPremium
}

// delegate hands work to another agent. Every rule is checked here, on the
// server, from the stored run and message: the agent only names who and what.
func (h *Handler) delegate(ctx context.Context, grant Grant, in delegateIn) (delegateOut, error) {
	task := strings.TrimSpace(in.Task)
	if task == "" {
		return delegateOut{}, errors.New("task required")
	}
	handle := strings.TrimPrefix(strings.TrimSpace(in.To), "@")
	if handle == "" {
		return delegateOut{}, errors.New("to required")
	}
	run, err := h.store.Run(ctx, grant.RunID)
	if err != nil {
		return delegateOut{}, errors.New("run unavailable")
	}
	trigger, err := h.store.Message(ctx, run.TriggerMessageID)
	if err != nil {
		return delegateOut{}, errors.New("request unavailable")
	}
	if trigger.CollectForRunID != "" {
		return delegateOut{}, errors.New("a collect run cannot delegate")
	}
	// The depth comes from the message that started this run, which only the
	// server writes. A human request is depth 0.
	depth, request := 0, trigger.ID
	if trigger.Handoff != nil {
		depth, request = trigger.Handoff.Depth, trigger.Handoff.RequestID
	}
	caller, err := h.store.Member(ctx, grant.AgentID)
	if err != nil {
		return delegateOut{}, errors.New("agent unavailable")
	}
	target, err := h.store.MemberByHandle(ctx, handle)
	if err != nil {
		return delegateOut{}, fmt.Errorf("unknown agent @%s", handle)
	}
	departments, err := h.store.Departments(ctx)
	if err != nil {
		return delegateOut{}, err
	}
	if err := org.CheckDelegation(caller, target, h.Policy.ChiefOfStaff, departments, depth); err != nil {
		return delegateOut{}, err
	}
	channel, err := h.store.Channel(ctx, grant.ChannelID)
	if err != nil {
		return delegateOut{}, errors.New("channel unavailable")
	}
	allowed, refusals := h.assignedOnly(ctx, channel.Name, []domain.Member{target})
	if len(allowed) == 0 {
		reason := fmt.Sprintf("@%s is not assigned to this project", target.Handle)
		if len(refusals) > 0 {
			reason = refusals[0].Text
		}
		if _, err := h.store.Append(ctx, events.Draft{Type: events.HandoffCreated, Actor: events.Agent(grant.AgentID), ChannelID: grant.ChannelID, Payload: handoffEvent{Handoff: domain.Handoff{RequestID: request, From: caller.Handle, To: target.Handle, Depth: depth + 1}, ParentRunID: run.ID, Task: task, Refusal: reason}}); err != nil {
			return delegateOut{}, err
		}
		for _, n := range refusals {
			_, _ = h.store.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, ChannelID: grant.ChannelID, Payload: n})
		}
		return delegateOut{}, fmt.Errorf("@%s is not assigned to this project, so it was not asked; the Director was told", target.Handle)
	}
	premium := h.premium(ctx, target)
	if err := h.reserve(ctx, grant, request, premium); err != nil {
		return delegateOut{}, err
	}
	root := trigger.ThreadID
	if root == "" {
		root = trigger.ID
	}
	handoff := &domain.Handoff{RequestID: request, From: caller.Handle, To: target.Handle, Depth: depth + 1}
	msg, err := h.postMessage(ctx, grant, "@"+target.Handle+" "+task, root, nil, false, handoff)
	if err != nil {
		h.ledger.Release(request, premium)
		return delegateOut{}, err
	}
	if _, err := h.store.Append(ctx, events.Draft{
		Type:      events.HandoffCreated,
		Actor:     events.Agent(grant.AgentID),
		ChannelID: grant.ChannelID,
		Payload:   handoffEvent{Handoff: *handoff, MessageID: msg.ID, ParentRunID: run.ID, Task: task, Premium: premium},
	}); err != nil {
		h.ledger.Release(request, premium)
		return delegateOut{}, err
	}
	if h.trigger != nil {
		h.trigger.OnMessage(ctx, msg, []domain.Member{target})
	}
	return delegateOut{MessageID: msg.ID, To: target.Handle, Depth: handoff.Depth}, nil
}

// reserve counts one more delegated run for the request. Over the limits, it
// asks the Director with a choice card, once, and refuses until they answer.
// Their answer "A: ..." (the first option, which allows another round) lifts
// the limits; anything else keeps the refusal.
func (h *Handler) reserve(ctx context.Context, grant Grant, request string, premium bool) error {
	if err := h.RestoreBudget(ctx); err != nil {
		return err
	}
	lim := h.limits()
	if h.ledger.Reserve(request, premium, lim) {
		return nil
	}
	if card := h.ledger.Card(request); card != "" {
		switch h.answer(ctx, card) {
		case answerAllow:
			h.ledger.Allow(request, lim)
			if h.ledger.Reserve(request, premium, lim) {
				return nil
			}
		case answerStop:
			return errors.New("the Director said to stop: do the rest yourself or report what is left")
		default:
			return errors.New("this request is over its budget and the Director has not answered yet: do the rest yourself or wait")
		}
	}
	runs, prem := h.ledger.Used(request)
	question := fmt.Sprintf("This request has used %d of %d allowed runs (%d of %d premium). Allow %d more?", runs, lim.MaxRuns, prem, lim.MaxPremium, lim.MaxRuns)
	card, err := h.ask(ctx, grant, question, []string{fmt.Sprintf("Allow %d more runs", lim.MaxRuns), "Stop here"})
	if err != nil {
		return fmt.Errorf("over budget, and the Director could not be asked: %w", err)
	}
	h.ledger.SetCard(request, card.ID)
	return errors.New("this request is over its budget: the Director was asked for more runs. Do the rest yourself for now")
}

type directorAnswer int

const (
	answerNone directorAnswer = iota
	answerAllow
	answerStop
)

// answer reads the Director's reply to a choice card: a human message in the
// card's thread that starts with "A:" allows, any other human reply stops.
func (h *Handler) answer(ctx context.Context, card string) directorAnswer {
	thread, err := h.store.Thread(ctx, card)
	if err != nil {
		return answerNone
	}
	result := answerNone
	for _, m := range thread {
		if m.ID == card {
			continue
		}
		author, err := h.store.Member(ctx, m.AuthorID)
		if err != nil || author.Kind != domain.MemberHuman {
			continue
		}
		if strings.HasPrefix(strings.TrimSpace(m.Body), "A:") {
			return answerAllow
		}
		result = answerStop
	}
	return result
}

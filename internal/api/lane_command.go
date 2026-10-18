package api

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

// checkLaneOverride says why lane cannot be the preferred lane of handle in
// a channel: the persona must be an agent and the lane must be in its chain.
func checkLaneOverride(members []domain.Member, handle, lane string) error {
	for _, m := range members {
		if m.Kind != domain.MemberAgent || !strings.EqualFold(m.Handle, handle) {
			continue
		}
		if m.Agent != nil && slices.Contains(m.Agent.Lanes, lane) {
			return nil
		}
		var chain []string
		if m.Agent != nil {
			chain = m.Agent.Lanes
		}
		return fmt.Errorf("lane %s is not in @%s's chain (%s)", lane, m.Handle, strings.Join(chain, ", "))
	}
	return fmt.Errorf("no agent @%s", handle)
}

// laneCommand runs "/lane <persona> <lane>" and "/lane <persona> default":
// it sets or clears the persona's preferred lane for the channel and says
// what happened in a notice. It starts no agent.
func (a *API) laneCommand(ctx context.Context, c domain.Channel, members []domain.Member, body string) {
	say := func(level, text string) {
		_, _ = a.Store.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, ChannelID: c.ID, Payload: events.NoticePayload{Level: level, Text: text}})
	}
	f := strings.Fields(body)
	if len(f) != 3 {
		say("warn", "Usage: /lane <persona> <lane>, or /lane <persona> default to clear it.")
		return
	}
	handle, lane := strings.ToLower(strings.TrimPrefix(f[1], "@")), f[2]
	overrides := map[string]string{}
	for k, v := range c.LaneOverrides {
		overrides[k] = v
	}
	if strings.EqualFold(lane, "default") {
		delete(overrides, handle)
	} else {
		if err := checkLaneOverride(members, handle, lane); err != nil {
			say("warn", err.Error()+".")
			return
		}
		overrides[handle] = lane
	}
	c.LaneOverrides = overrides
	if len(overrides) == 0 {
		c.LaneOverrides = nil
	}
	if _, err := a.Store.Append(ctx, events.Draft{Type: events.ChannelUpdated, Actor: events.System, ChannelID: c.ID, Payload: c}); err != nil {
		say("error", "Could not save the lane preference: "+err.Error())
		return
	}
	if strings.EqualFold(lane, "default") {
		say("info", fmt.Sprintf("@%s uses its normal lane order again in this channel.", handle))
		return
	}
	say("info", fmt.Sprintf("@%s prefers lane %s in this channel. If that lane is unavailable or exhausted, the next lane in its chain runs.", handle, lane))
}

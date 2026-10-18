package app

import (
	"context"
	"fmt"
	"strings"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/org"
)

// delegationNote tells the Chief of Staff, or a department lead, how to hand
// work on with the delegate tool, and to whom. It is empty for everyone else
// and for work that was already handed over as deep as it may go. The server
// checks every rule again when the tool is called, so this is only a guide.
func (a *App) delegationNote(ctx context.Context, agent domain.Member, m domain.Message) string {
	if m.Handoff != nil && m.Handoff.Depth >= org.MaxDepth {
		return ""
	}
	members, err := a.Store.Members(ctx)
	if err != nil {
		return ""
	}
	departments, err := a.Store.Departments(ctx)
	if err != nil {
		return ""
	}
	limits := a.requestLimits()
	budget := fmt.Sprintf("One request can start at most %d delegated runs (%d on premium lanes); past that the Director is asked, so hand over only what is needed. The agent you choose posts its result in the thread, so you do not need to wait for it.", limits.MaxRuns, limits.MaxPremium)
	if chief := a.chiefHandle(); chief != "" && strings.EqualFold(agent.Handle, chief) {
		return "You are the Chief of Staff. This request was not addressed to anyone, so it came to you. Decide who should own it by what each agent is for, then hand it over with the delegate tool (to, task). Pick one owner unless the request clearly has separate parts, and put everything the owner needs in the task. Say in one short line who you chose and why. Do the work yourself only if nobody fits. " + budget +
			"\n\nAgents you can hand work to:\n" + org.Roster(members, departments, chief)
	}
	var led []string
	inTeam := map[string]bool{}
	for _, d := range departments {
		if !strings.EqualFold(d.Lead, agent.Handle) {
			continue
		}
		name := d.DisplayName
		if name == "" {
			name = d.Handle
		}
		led = append(led, name)
		for _, h := range d.Members {
			inTeam[strings.ToLower(h)] = true
		}
	}
	if len(led) == 0 {
		return ""
	}
	var team []domain.Member
	for _, mem := range members {
		if inTeam[strings.ToLower(mem.Handle)] {
			team = append(team, mem)
		}
	}
	return "You lead " + strings.Join(led, " and ") + ". When a request is really several separate pieces, you may split it and hand each piece to a member with the delegate tool (to, task); otherwise do the work yourself. Members do not hand work on. " + budget +
		"\n\nMembers you can hand work to:\n" + org.Roster(team, departments, agent.Handle)
}

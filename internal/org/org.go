// Package org holds the assignment rule of projects, shared by every path
// that can start an agent (the API and the MCP post_message tool).
package org

import (
	"fmt"
	"slices"
	"strings"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

// ContainsFold reports whether list has s, ignoring case.
func ContainsFold(list []string, s string) bool {
	return slices.ContainsFunc(list, func(e string) bool { return strings.EqualFold(e, s) })
}

// ProjectOfChannel finds the project that lists the channel by name.
func ProjectOfChannel(projects []domain.Project, channel string) (domain.Project, bool) {
	for _, p := range projects {
		if ContainsFold(p.Channels, channel) {
			return p, true
		}
	}
	return domain.Project{}, false
}

// Assigned reports whether the agent may act in the project: its lead, a
// specialist assigned to it, or the lead or a member of an assigned
// department.
func Assigned(p domain.Project, departments []domain.Department, handle string) bool {
	if strings.EqualFold(p.Lead, handle) || ContainsFold(p.Specialists, handle) {
		return true
	}
	for _, d := range departments {
		if ContainsFold(p.Departments, d.Handle) && (strings.EqualFold(d.Lead, handle) || ContainsFold(d.Members, handle)) {
			return true
		}
	}
	return false
}

// Refusals builds the notices for agents the project does not include, each
// with an action that assigns the agent.
func Refusals(p domain.Project, refused []domain.Member) []events.NoticePayload {
	out := make([]events.NoticePayload, 0, len(refused))
	for _, m := range refused {
		out = append(out, events.NoticePayload{
			Level:  "warn",
			Text:   fmt.Sprintf("@%s is not assigned to project %s, so it did not run.", m.Handle, p.Name),
			Action: &events.NoticeAction{Kind: "assign", Label: fmt.Sprintf("Assign @%s to %s", m.Handle, p.Name), Project: p.Handle, Agent: m.Handle},
		})
	}
	return out
}

// Gate applies the project rule to the agents a message wants to start. In a
// channel no project lists, every agent is allowed. In a project's channel
// only assigned agents are, and the others come back as refusal notices.
func Gate(projects []domain.Project, departments []domain.Department, channel string, agents []domain.Member) (allowed []domain.Member, notices []events.NoticePayload) {
	project, ok := ProjectOfChannel(projects, channel)
	if !ok {
		return agents, nil
	}
	var refused []domain.Member
	for _, ag := range agents {
		if Assigned(project, departments, ag.Handle) {
			allowed = append(allowed, ag)
		} else {
			refused = append(refused, ag)
		}
	}
	return allowed, Refusals(project, refused)
}

package app

import (
	"context"
	"fmt"

	"github.com/thiagodefreitas/faztudo/internal/computers"
	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func (a *App) ListComputers(ctx context.Context) ([]computers.Status, error) {
	members, err := a.Store.Members(ctx)
	if err != nil {
		return nil, err
	}
	status := make([]computers.Status, 0)
	for _, member := range members {
		if member.Kind != domain.MemberAgent {
			continue
		}
		item, err := a.Computers.Status(member.Handle)
		if err != nil {
			return nil, err
		}
		status = append(status, item)
	}
	return status, nil
}

func (a *App) ResetComputer(ctx context.Context, id string) (computers.Status, error) {
	members, err := a.Store.Members(ctx)
	if err != nil {
		return computers.Status{}, err
	}
	var agentID string
	for _, member := range members {
		if member.Kind == domain.MemberAgent && member.Handle == id {
			agentID = member.ID
			break
		}
	}
	if agentID == "" {
		return computers.Status{}, domain.UserError{Message: "unknown computer"}
	}
	for _, state := range []domain.RunState{domain.RunRunning, domain.RunVerifying} {
		runs, err := a.Store.Runs(ctx, "", string(state))
		if err != nil {
			return computers.Status{}, err
		}
		for _, run := range runs {
			if run.AgentID == agentID && run.Mode == domain.RunWrite {
				return computers.Status{}, domain.UserError{Message: fmt.Sprintf("@%s has a live write run", id)}
			}
		}
	}
	return a.Computers.Reset(ctx, id)
}

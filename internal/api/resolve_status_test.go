package api

import (
	"context"
	"errors"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func TestResolveStatusCodes(t *testing.T) {
	f := newOrgFixture(t)
	f.do(t, "POST", "/api/v1/approvals/nope/resolve", `{"option":"yes"}`, 404, nil)
	approval := domain.Approval{ID: "ap2", ChannelID: f.team.ID, RequestedBy: f.coder.ID, RunID: "run", Title: "Go?", State: domain.ApprovalPending,
		Options: []domain.ApprovalOption{{Key: "yes", Label: "Yes"}}}
	if _, err := f.h.Store.Append(context.Background(), events.Draft{Type: events.ApprovalRequested, Actor: events.Agent(f.coder.ID), ChannelID: f.team.ID, Payload: approval}); err != nil {
		t.Fatal(err)
	}
	// A change that cannot be applied is a conflict the person can act on.
	f.h.ResolveApproval = func(context.Context, domain.Approval, string, string) (string, error) {
		return "", errors.New("merge failed")
	}
	f.do(t, "POST", "/api/v1/approvals/ap2/resolve", `{"option":"yes"}`, 409, nil)
	// A store failure is not a conflict: it stays a 500.
	if err := f.h.Store.Close(); err != nil {
		t.Fatal(err)
	}
	f.do(t, "POST", "/api/v1/approvals/ap2/resolve", `{"option":"yes"}`, 500, nil)
}

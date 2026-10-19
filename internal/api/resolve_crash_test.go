package api

import (
	"context"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

// A crash after the merge but before approval.resolved leaves the run done
// with its outcome and the approval pending. A repeated Merge or a late
// Discard must both end with the approval resolved as what really happened.
func TestResolveAfterCrashBetweenChangeAndResolution(t *testing.T) {
	for _, tc := range []struct{ name, option string }{{"merge again", "merge"}, {"late discard", "discard"}} {
		t.Run(tc.name, func(t *testing.T) {
			f := newOrgFixture(t)
			ctx := context.Background()
			run := domain.Run{ID: "run-crash", ChannelID: f.team.ID, State: domain.RunDone, ApprovalOption: "merge", ApprovalOutcome: "Fast-forwarded fz/run-crash into the current branch as abc1234."}
			approval := domain.Approval{ID: "ap-crash", ChannelID: f.team.ID, RequestedBy: f.coder.ID, RunID: run.ID, Title: "Merge?", State: domain.ApprovalPending,
				Options: []domain.ApprovalOption{{Key: "merge", Label: "Merge"}, {Key: "discard", Label: "Discard"}}}
			for _, d := range []events.Draft{
				{Type: events.RunUpdated, Actor: events.System, ChannelID: f.team.ID, Payload: run},
				{Type: events.ApprovalRequested, Actor: events.Agent(f.coder.ID), ChannelID: f.team.ID, Payload: approval},
			} {
				if _, err := f.h.Store.Append(ctx, d); err != nil {
					t.Fatal(err)
				}
			}
			f.h.ResolveApproval = func(_ context.Context, _ domain.Approval, option, _ string) (string, error) {
				if option != "merge" {
					return "", domain.UserError{Message: "This run was already merge."}
				}
				return run.ApprovalOutcome, nil
			}
			f.do(t, "POST", "/api/v1/approvals/ap-crash/resolve", `{"option":"`+tc.option+`"}`, 200, nil)
			got, err := f.h.Store.Approval(ctx, "ap-crash")
			if err != nil {
				t.Fatal(err)
			}
			if got.State != domain.ApprovalResolved || got.Resolution == nil || got.Resolution.Option != "merge" || got.Resolution.Note != run.ApprovalOutcome {
				t.Fatalf("approval = %+v", got)
			}
			// Resolving again is a plain conflict, not a new change.
			f.do(t, "POST", "/api/v1/approvals/ap-crash/resolve", `{"option":"merge"}`, 409, nil)
		})
	}
}

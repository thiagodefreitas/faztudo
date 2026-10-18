package api

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestResolveAsLimitsBridgeToKeepAndDiscard(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	human := domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: "user"}
	agent := domain.Member{ID: store.NewID(), Kind: domain.MemberAgent, Handle: "coder"}
	for _, m := range []domain.Member{human, agent} {
		if _, err := s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: m}); err != nil {
			t.Fatal(err)
		}
	}
	c := domain.Channel{ID: store.NewID(), Name: "general", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic}
	if _, err := s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: c.ID, Payload: c}); err != nil {
		t.Fatal(err)
	}
	approval := domain.Approval{ID: store.NewID(), ChannelID: c.ID, RequestedBy: agent.ID, Title: "Choose", State: domain.ApprovalPending, Options: []domain.ApprovalOption{{Key: "merge"}, {Key: "keep"}, {Key: "discard"}}}
	if _, err := s.Append(ctx, events.Draft{Type: events.ApprovalRequested, Actor: events.Agent(agent.ID), ChannelID: c.ID, Payload: approval}); err != nil {
		t.Fatal(err)
	}
	a := New(s, human.ID, "test")
	if _, err := a.ResolveBridgeAs(ctx, human, approval.ID, "merge"); err == nil {
		t.Fatal("Signal merge accepted")
	}
	if _, err := a.ResolveBridgeAs(ctx, agent, approval.ID, "keep"); err == nil {
		t.Fatal("agent resolved approval")
	}
	got, err := a.ResolveBridgeAs(ctx, human, approval.ID, "keep")
	if err != nil || got.Resolution == nil || got.Resolution.Option != "keep" || got.Resolution.By != human.ID {
		t.Fatalf("resolved: %+v %v", got, err)
	}
	if _, err := a.ResolveBridgeAs(ctx, human, approval.ID, "discard"); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("second resolve: %v", err)
	}
	webApproval := approval
	webApproval.ID = store.NewID()
	if _, err := s.Append(ctx, events.Draft{Type: events.ApprovalRequested, Actor: events.Agent(agent.ID), ChannelID: c.ID, Payload: webApproval}); err != nil {
		t.Fatal(err)
	}
	if got, err := a.ResolveAs(ctx, human, webApproval.ID, "merge", ""); err != nil || got.Resolution == nil || got.Resolution.Option != "merge" {
		t.Fatalf("web merge: %+v %v", got, err)
	}
}

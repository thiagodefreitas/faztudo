package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func TestApprovalRuleRoundTrip(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	rule := domain.ApprovalRule{ID: NewID(), ChannelID: "dev", Persona: "coder", Paths: []string{"src/**", "README.md"}, MaxLines: 100, CreatedBy: "director", CreatedAt: time.Now().UTC()}
	if _, err := s.Append(ctx, events.Draft{Type: events.ApprovalRuleCreated, Actor: events.Human("director"), ChannelID: rule.ChannelID, Payload: rule}); err != nil {
		t.Fatal(err)
	}
	got, err := s.ApprovalRule(ctx, rule.ID)
	if err != nil || got.ID != rule.ID || len(got.Paths) != 2 || got.Paths[0] != "src/**" {
		t.Fatalf("rule %+v %v", got, err)
	}
	if err := s.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApprovalRule(ctx, rule.ID); err != nil {
		t.Fatalf("rebuilt rule: %v", err)
	}
	if _, err := s.Append(ctx, events.Draft{Type: events.ApprovalRuleRemoved, Actor: events.Human("director"), ChannelID: rule.ChannelID, Payload: rule}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApprovalRule(ctx, rule.ID); err != ErrNotFound {
		t.Fatalf("removed rule: %v", err)
	}
}

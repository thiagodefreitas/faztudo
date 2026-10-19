package app

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/org"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func newDelegationApp(t *testing.T) (*App, map[string]domain.Member) {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	lane := domain.Lane{ID: "a", CLI: "codex", Capacity: 1, Windows: []domain.LaneWindow{}}
	if _, err := s.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: lane}); err != nil {
		t.Fatal(err)
	}
	who := map[string]domain.Member{}
	for handle, about := range map[string]string{
		"chief":     "Routes requests.",
		"architect": "Plans the design before code is written.",
		"coder":     "Writes and fixes code.",
		"writer":    "Writes documentation.",
	} {
		m := domain.Member{ID: handle, Kind: domain.MemberAgent, Handle: handle, DisplayName: handle, Agent: &domain.AgentInfo{Lanes: []string{"a"}, Description: about}}
		who[handle] = m
		if _, err := s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: m}); err != nil {
			t.Fatal(err)
		}
	}
	dept := domain.Department{Handle: "engineering", DisplayName: "Engineering", Lead: "architect", Members: []string{"architect", "coder"}}
	if _, err := s.Append(ctx, events.Draft{Type: events.DepartmentUpdated, Actor: events.System, Payload: dept}); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		Runs: config.Runs{RequestMaxRuns: 4, RequestMaxPremium: 1},
		Lanes: config.LaneConfig{Persona: []config.Persona{
			{Handle: "chief", ChiefOfStaff: true, Channels: []string{"General"}},
			{Handle: "coder"},
		}},
	}
	a, err := New(ctx, s, cfg, config.Paths{})
	if err != nil {
		t.Fatal(err)
	}
	return a, who
}

func TestChiefOfStaffIsTheOneThatOptedChannelsName(t *testing.T) {
	a, _ := newDelegationApp(t)
	if a.chiefHandle() != "chief" {
		t.Fatalf("chief handle %q", a.chiefHandle())
	}
	if h, ok := a.chiefFor("general"); !ok || h != "chief" {
		t.Fatalf("chiefFor(general) = %q, %v", h, ok)
	}
	if _, ok := a.chiefFor("random"); ok {
		t.Fatal("a channel that did not opt in has a chief")
	}
	if a.MCP.Policy.ChiefOfStaff != "chief" || a.MCP.Policy.Limits != (org.Limits{MaxRuns: 4, MaxPremium: 1}) {
		t.Fatalf("MCP policy %+v", a.MCP.Policy)
	}
}

func TestDelegationNoteGuidesTheChiefAndLeadsOnly(t *testing.T) {
	a, who := newDelegationApp(t)
	ctx := context.Background()
	request := domain.Message{ID: "m1", ChannelID: "general", Body: "fix the bug"}

	chief := a.delegationNote(ctx, who["chief"], request)
	for _, want := range []string{
		"You are the Chief of Staff",
		"delegate tool",
		"at most 4 delegated runs (1 on premium lanes)",
		"- @architect: Plans the design before code is written. [leads Engineering]",
		"- @writer: Writes documentation.",
	} {
		if !strings.Contains(chief, want) {
			t.Errorf("chief note is missing %q:\n%s", want, chief)
		}
	}
	if strings.Contains(chief, "- @chief") {
		t.Errorf("the chief is listed as someone to hand work to:\n%s", chief)
	}

	lead := a.delegationNote(ctx, who["architect"], request)
	if !strings.Contains(lead, "You lead Engineering") || !strings.Contains(lead, "- @coder: Writes and fixes code.") {
		t.Errorf("lead note:\n%s", lead)
	}
	if strings.Contains(lead, "@writer") || strings.Contains(lead, "- @architect") {
		t.Errorf("the lead was offered someone outside its team, or itself:\n%s", lead)
	}

	if note := a.delegationNote(ctx, who["coder"], request); note != "" {
		t.Errorf("a specialist was told to delegate:\n%s", note)
	}
	// Work that was already handed over as deep as it may go carries no note.
	deep := domain.Message{ID: "m2", ChannelID: "general", Handoff: &domain.Handoff{RequestID: "m1", From: "chief", To: "architect", Depth: org.MaxDepth}}
	if note := a.delegationNote(ctx, who["architect"], deep); note != "" {
		t.Errorf("a note at the depth limit:\n%s", note)
	}
	// One level down a lead may still split the work.
	one := domain.Message{ID: "m3", ChannelID: "general", Handoff: &domain.Handoff{RequestID: "m1", From: "chief", To: "architect", Depth: 1}}
	if note := a.delegationNote(ctx, who["architect"], one); note == "" {
		t.Error("a lead handed work by the chief cannot split it")
	}
	// A collect run combines results; the delegate tool refuses it, so the
	// chief must not be told to hand the digest over.
	collect := domain.Message{ID: "m4", ChannelID: "general", ThreadID: "m1", CollectForRunID: "run1", Body: "Write one combined answer"}
	if note := a.delegationNote(ctx, who["chief"], collect); note != "" {
		t.Errorf("the chief was told to delegate in its collect run:\n%s", note)
	}
}

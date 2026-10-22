package app

import (
	"context"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func TestScoutRoutineUsesItsDefaultPromptAndOnlyReadOnlyAgents(t *testing.T) {
	f := newRoutineFixture(t, config.Config{}, domain.LaneUnknown, "")
	ctx := context.Background()
	f.save(t, domain.Routine{Handle: "scout", Name: "Scout", Persona: "coder", Channel: "general", Schedule: "0 8 * * 1-5", Template: "scout", Enabled: true})
	if err := f.e.RunNow(ctx, "scout"); err != nil {
		t.Fatal(err)
	}
	f.waitRan(t, 1)
	body := f.ran[0].Body
	if f.ran[0].Routine != "scout" || !strings.HasPrefix(body, "@coder ") || !strings.Contains(body, "suggest tool") || !strings.Contains(body, "at most 5") || !strings.Contains(body, "read-only") {
		t.Fatalf("scout message: %+v", f.ran[0])
	}
	// A writing agent is refused, and nothing runs.
	writer := f.coder
	writer.Agent = &domain.AgentInfo{Lanes: []string{"a"}, Mode: domain.RunWrite}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: writer}); err != nil {
		t.Fatal(err)
	}
	err := f.e.RunNow(ctx, "scout")
	if err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("a writing scout should be refused, got %v", err)
	}
	if f.count() != 1 {
		t.Fatalf("the writing scout ran: %d runs", f.count())
	}
	if last := f.last(t, "scout").Last; last == nil || last.Status != "skipped" {
		t.Fatalf("last result: %+v", last)
	}
}

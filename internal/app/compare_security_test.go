package app

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func TestCompareStartsOnlyForHumanAuthors(t *testing.T) {
	a, s, m, agent := compareStartFixture(t, [3]domain.LaneHealth{domain.LaneAvailable, domain.LaneAvailable, domain.LaneAvailable})
	called := make(chan string, 2)
	a.compareDispatch = func(_ context.Context, _ domain.Message, _ domain.Member, lane string) error {
		called <- lane
		return nil
	}
	// An agent posts through MCP post_message or a delegated message: the
	// author is the agent's member id.
	m.AuthorID = agent.ID
	a.OnMessage(context.Background(), m, []domain.Member{agent})
	deadline := time.Now().Add(2 * time.Second)
	for {
		notices, err := s.EventsOfTypes(context.Background(), m.ChannelID, events.Notice)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, n := range notices {
			if strings.Contains(string(n.Payload), "started by people only") {
				found = true
			}
		}
		if found {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no notice for an agent author: %+v", notices)
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case lane := <-called:
		t.Fatalf("agent author started a candidate on %s", lane)
	case <-time.After(100 * time.Millisecond):
	}
	if groups, err := a.CompareList(context.Background(), m.ChannelID); err != nil || len(groups) != 0 {
		t.Fatalf("compare recorded for an agent: %+v %v", groups, err)
	}
}

func TestCompareCombineRetryStartsOneCombiner(t *testing.T) {
	a, s, _, runs := compareDecisionFixture(t)
	members, err := s.Members(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range members {
		if member.ID == "coder" {
			member.Agent.Mode = domain.RunWrite
			if _, err := s.Append(context.Background(), events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: member}); err != nil {
				t.Fatal(err)
			}
		}
	}
	starts := make(chan string, 4)
	var failMu sync.Mutex
	fail := true
	a.compareDispatch = func(ctx context.Context, m domain.Message, _ domain.Member, _ string) error {
		starts <- m.ID
		failMu.Lock()
		failing := fail
		failMu.Unlock()
		if failing {
			// Simulates a crash before the combiner run was created.
			return errors.New("daemon stopped")
		}
		_, err := s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: m.ChannelID, Payload: domain.Run{ID: "combined-run", ChannelID: m.ChannelID, TriggerMessageID: m.ID, AgentID: "coder", LaneID: "a", Mode: domain.RunWrite, State: domain.RunQueued}})
		return err
	}
	channel := runs[0].ChannelID
	if _, err := a.CompareDecide(context.Background(), channel, "comparison", "combine", "ada"); err != nil {
		t.Fatal(err)
	}
	first := waitStart(t, starts)
	groups, err := a.CompareList(context.Background(), channel)
	if err != nil || len(groups) != 1 || groups[0].Decision != "combine" {
		t.Fatalf("decision must be recorded before the run starts: %+v %v", groups, err)
	}
	// Wait for the failed goroutine to clear its extra context.
	for i := 0; i < 200 && a.extraContext(first) != ""; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	failMu.Lock()
	fail = false
	failMu.Unlock()
	if _, err := a.CompareDecide(context.Background(), channel, "comparison", "combine", "ada"); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if second := waitStart(t, starts); second != first {
		t.Fatalf("retry used a new combine message: %s vs %s", second, first)
	}
	for i := 0; i < 200; i++ {
		if all, _ := s.Runs(context.Background(), channel, ""); len(all) == 3 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	// A third click finds the combiner run and starts nothing.
	if _, err := a.CompareDecide(context.Background(), channel, "comparison", "combine", "ada"); err != nil {
		t.Fatalf("third click: %v", err)
	}
	select {
	case id := <-starts:
		t.Fatalf("a second combiner started: %s", id)
	case <-time.After(150 * time.Millisecond):
	}
	if _, err := a.CompareDecide(context.Background(), channel, "comparison", "discard_both", "ada"); err == nil {
		t.Fatal("a different decision was accepted after combine")
	}
}

func waitStart(t *testing.T, starts chan string) string {
	t.Helper()
	select {
	case id := <-starts:
		return id
	case <-time.After(2 * time.Second):
		t.Fatal("combiner did not start")
	}
	return ""
}

package app

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

type refusingCLI struct{}

func (refusingCLI) Name() string { return "codex" }
func (refusingCLI) Command(req adapters.Request) (adapters.Cmd, error) {
	return adapters.Cmd{Path: "/bin/sh", Args: []string{"-c", "printf '%s\\n' 'ERROR: This content was flagged for possible cybersecurity risk. Try rephrasing your request.' >&2; exit 1"}, Dir: req.Workdir}, nil
}
func (refusingCLI) Classify(code int, tail string) (domain.FailureClass, adapters.LaneSignal, string) {
	return (adapters.Codex{}).Classify(code, tail)
}

func TestProviderRefusalFailsOnlyTheRun(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, err := store.Open(filepath.Join(root, "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	agent := domain.Member{ID: "coder", Kind: domain.MemberAgent, Handle: "coder", Agent: &domain.AgentInfo{Lanes: []string{"codex/default"}, Mode: domain.RunRead}}
	lane := domain.Lane{ID: "codex/default", CLI: "codex", Capacity: 1, Health: domain.LaneAvailable, Windows: []domain.LaneWindow{}}
	ch := domain.Channel{ID: "ch", Name: "work", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic}
	msg := domain.Message{ID: "m1", ChannelID: ch.ID, Body: "@coder review this", AuthorID: "human", CreatedAt: time.Now().UTC()}
	for _, d := range []events.Draft{{Type: events.MemberUpdated, Actor: events.System, Payload: agent}, {Type: events.LaneUpdated, Actor: events.System, Payload: lane}, {Type: events.ChannelCreated, Actor: events.System, ChannelID: ch.ID, Payload: ch}, {Type: events.MessagePosted, Actor: events.Human("human"), ChannelID: ch.ID, Payload: msg}} {
		if _, err := s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	a, err := New(ctx, s, config.Defaults(), config.Paths{DataDir: root, RunsDir: filepath.Join(root, "runs")})
	if err != nil {
		t.Fatal(err)
	}
	a.Adapters["codex"] = refusingCLI{}
	if err := a.execute(ctx, msg, agent, ""); err == nil {
		t.Fatal("refused run succeeded")
	}
	runs, err := s.Runs(ctx, ch.ID, "")
	if err != nil || len(runs) != 1 {
		t.Fatalf("runs: %+v %v", runs, err)
	}
	if runs[0].State != domain.RunFailed || !strings.Contains(runs[0].FailureReason, "flagged for possible cybersecurity risk") {
		t.Fatalf("run: %+v", runs[0])
	}
	got, ok := a.Registry.Snapshot(lane.ID)
	if !ok || got.Health == domain.LaneExhausted || got.Health == domain.LaneUnavailable || got.LastError != nil {
		t.Fatalf("refusal changed lane health: %+v", got)
	}
	if !noticeContaining(t, s, ch.ID, "provider refused @coder's request") {
		t.Fatal("provider refusal notice missing")
	}
}

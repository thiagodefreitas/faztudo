package app

import (
	"context"
	"os"
	"os/exec"
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

func TestMCPRunConfig(t *testing.T) {
	bin := buildMCPCheck(t)
	for _, cli := range []string{"claude", "codex"} {
		t.Run(cli, func(t *testing.T) {
			ctx := context.Background()
			root := t.TempDir()
			data := filepath.Join(root, "data")
			runs := filepath.Join(root, "runs")
			if err := os.MkdirAll(data, 0700); err != nil {
				t.Fatal(err)
			}
			s, err := store.Open(filepath.Join(root, "test.db"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { s.Close() })
			human := domain.Member{ID: "ada", Kind: domain.MemberHuman, Handle: "ada", DisplayName: "Ada", Presence: domain.PresenceOnline}
			agent := domain.Member{ID: "coder", Kind: domain.MemberAgent, Handle: "coder", DisplayName: "Coder", Presence: domain.PresenceOnline, Agent: &domain.AgentInfo{Lanes: []string{"lane"}, Mode: domain.RunRead}}
			lane := domain.Lane{ID: "lane", CLI: cli, CostClass: domain.CostStandard, Capacity: 1, Health: domain.LaneUnknown, Windows: []domain.LaneWindow{}}
			channel := domain.Channel{ID: "room", Name: "room", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic, MemberIDs: []string{human.ID, agent.ID}}
			msg := domain.Message{ID: "m1", ChannelID: channel.ID, AuthorID: human.ID, Body: "@coder synthetic", Mentions: []string{agent.ID}, CreatedAt: time.Now().UTC()}
			for _, d := range []events.Draft{
				{Type: events.MemberUpdated, Actor: events.System, Payload: human},
				{Type: events.MemberUpdated, Actor: events.System, Payload: agent},
				{Type: events.LaneUpdated, Actor: events.System, Payload: lane},
				{Type: events.ChannelCreated, Actor: events.System, ChannelID: channel.ID, Payload: channel},
				{Type: events.MessagePosted, Actor: events.Human(human.ID), ChannelID: channel.ID, Payload: msg},
			} {
				if _, err := s.Append(ctx, d); err != nil {
					t.Fatal(err)
				}
			}
			a, err := New(ctx, s, config.Config{Runs: config.Runs{DefaultTimeout: "20s", ContextMessages: 5}}, config.Paths{DataDir: data, RunsDir: runs})
			if err != nil {
				t.Fatal(err)
			}
			a.MCPBase = "http://127.0.0.1:9"
			a.Adapters[cli] = cliPath{inner: a.Adapters[cli], path: bin}
			if err := a.execute(ctx, msg, agent, ""); err != nil {
				t.Fatal(err)
			}
			left, err := filepath.Glob(filepath.Join(runs, "*", "mcp.json"))
			if err != nil {
				t.Fatal(err)
			}
			if len(left) != 0 {
				t.Fatal("mcp config remains after the run")
			}
			if a.MCP.LiveRuns() != 0 {
				t.Fatal("token still accepted after the run")
			}
			messages, err := s.Messages(ctx, channel.ID, "", 20)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, message := range messages {
				if strings.Contains(message.Body, "mcp-ok") {
					found = true
				}
				if strings.Contains(message.Body, "Bearer ") {
					t.Fatal("answer mentioned a bearer token")
				}
			}
			if !found {
				t.Fatal("run did not report mcp-ok")
			}
		})
	}
}

type cliPath struct {
	inner adapters.Adapter
	path  string
}

func (c cliPath) Name() string { return c.inner.Name() }
func (c cliPath) Command(r adapters.Request) (adapters.Cmd, error) {
	cmd, err := c.inner.Command(r)
	if err != nil {
		return cmd, err
	}
	cmd.Path = c.path
	return cmd, nil
}
func (c cliPath) Classify(code int, tail string) (domain.FailureClass, adapters.LaneSignal, string) {
	return c.inner.Classify(code, tail)
}

func buildMCPCheck(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "mcpcheck")
	cmd := exec.Command("go", "build", "-o", bin, "./testdata/mcpcheck")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build mcpcheck: %v %s", err, out)
	}
	return bin
}

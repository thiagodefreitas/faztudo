package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

// stopFixture runs the real API with one running and one finished run.
// Cancelling marks the run cancelled, as the runner does.
func stopFixture(t *testing.T) (listen, tokenPath, token string, s *store.Store) {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	human := domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: "human", DisplayName: "Human"}
	ch := domain.Channel{ID: "chan", Name: "chan", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic}
	running := domain.Run{ID: "live", ChannelID: ch.ID, AgentID: "agent", State: domain.RunRunning}
	done := domain.Run{ID: "old", ChannelID: ch.ID, AgentID: "agent", State: domain.RunDone}
	for _, e := range []events.Draft{
		{Type: events.MemberUpdated, Actor: events.System, Payload: human},
		{Type: events.ChannelCreated, Actor: events.System, ChannelID: ch.ID, Payload: ch},
		{Type: events.RunCreated, Actor: events.System, ChannelID: ch.ID, Payload: running},
		{Type: events.RunCreated, Actor: events.System, ChannelID: ch.ID, Payload: done},
	} {
		if _, err := s.Append(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	h := api.New(s, human.ID, "9.9.9")
	h.CancelRun = func(ctx context.Context, id string) error {
		r, err := s.Run(ctx, id)
		if err != nil {
			return err
		}
		r.State = domain.RunCancelled
		_, err = s.Append(ctx, events.Draft{Type: events.RunUpdated, Actor: events.System, ChannelID: r.ChannelID, Payload: r})
		return err
	}
	tokenPath = auth.LocalTokenPath(t.TempDir())
	h.LocalTokenPath = tokenPath
	token, err = auth.EnsureLocalToken(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return strings.TrimPrefix(srv.URL, "http://"), tokenPath, token, s
}

func TestStopCancelsActiveRunsAndStopsTheUnit(t *testing.T) {
	listen, path, token, s := stopFixture(t)
	var out bytes.Buffer
	unitStopped := false
	err := runStop(listen, path, []string{"--json"}, &out, func(string) (bool, error) { unitStopped = true; return true, nil })
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), token) {
		t.Fatal("output contains the local token")
	}
	var got stopResult
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Cancelled != 1 || got.Daemon != "stopped" || !unitStopped {
		t.Fatalf("got %+v, unit stopped %v", got, unitStopped)
	}
	r, err := s.Run(context.Background(), "live")
	if err != nil || r.State != domain.RunCancelled {
		t.Fatalf("live run: %v %v", r.State, err)
	}
}

func TestStopOutsideTheUnitLeavesTheDaemon(t *testing.T) {
	listen, path, _, _ := stopFixture(t)
	var out bytes.Buffer
	if err := runStop(listen, path, []string{"--json"}, &out, func(string) (bool, error) { return false, nil }); err != nil {
		t.Fatal(err)
	}
	var got stopResult
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Daemon != "left_running" {
		t.Fatalf("got %+v", got)
	}
}

func TestStopWithNothingRunning(t *testing.T) {
	var out bytes.Buffer
	if err := runStop("127.0.0.1:1", filepath.Join(t.TempDir(), "missing"), nil, &out, func(string) (bool, error) { return false, nil }); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "not running") {
		t.Fatalf("output %q", out.String())
	}
}

func TestStopRefusesNonLoopback(t *testing.T) {
	if err := runStop("0.0.0.0:7457", "x", nil, &bytes.Buffer{}, func(string) (bool, error) { return false, nil }); err == nil {
		t.Fatal("non-loopback listen accepted")
	}
}

func TestListensOnMatchesTheProcessSocket(t *testing.T) {
	proc := t.TempDir()
	tcp := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
		"   0: 0100007F:1D1D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0 100 0 0 10 0\n" +
		"   1: 0100007F:1D1E 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 5353 1 0 100 0 0 10 0\n"
	if err := os.MkdirAll(filepath.Join(proc, "net"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proc, "net/tcp"), []byte(tcp), 0o644); err != nil {
		t.Fatal(err)
	}
	fd := filepath.Join(proc, "77", "fd")
	if err := os.MkdirAll(fd, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("socket:[4242]", filepath.Join(fd, "8")); err != nil {
		t.Fatal(err)
	}
	if !listensOn(proc, 77, "7453") {
		t.Fatal("pid 77 listens on 7453 (0x1D1D)")
	}
	if listensOn(proc, 77, "7454") {
		t.Fatal("7454 is an established connection, not a listener")
	}
	if listensOn(proc, 78, "7453") {
		t.Fatal("pid 78 has no such socket")
	}
}

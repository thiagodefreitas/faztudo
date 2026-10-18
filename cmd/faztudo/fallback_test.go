package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

const kimi403 = "provider.auth_error: 403 Your current subscription does not have access to Kimi Code right now."

// fallbackSetup has coder on codex/default then claude/default. The first
// lane's fake CLI fails with the kimi 403 line, the second answers.
func fallbackSetup(t *testing.T) (*store.Store, string, domain.Channel) {
	t.Helper()
	c := config.Defaults()
	c.Lanes.Lane = []config.Lane{{ID: "codex/default", CLI: "codex", Capacity: 1}, {ID: "claude/default", CLI: "claude", Capacity: 1}}
	c.Lanes.Persona = []config.Persona{{Handle: "coder", Lanes: []string{"codex/default", "claude/default"}, Mode: "read"}}
	s, a, srv, p := setupWire(t, c)
	fail := filepath.Join(p.DataDir, "fail-agent")
	ok := filepath.Join(p.DataDir, "ok-agent")
	if err := os.WriteFile(fail, []byte("#!/bin/sh\necho '"+kimi403+"' >&2\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ok, []byte("#!/bin/sh\necho 'synthetic answer'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	a.Adapters["codex"] = fakeCodex{fail}
	a.Adapters["claude"] = fakeCodex{ok}
	var ch domain.Channel
	requestJSON(t, "POST", srv.URL+"/api/v1/channels", `{"name":"work"}`, 201, &ch)
	return s, srv.URL, ch
}

func noticeTexts(t *testing.T, s *store.Store) []string {
	t.Helper()
	all, err := s.EventsAfter(context.Background(), 0, 500)
	if err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, e := range all {
		if e.Type != events.Notice {
			continue
		}
		var n events.NoticePayload
		if err := json.Unmarshal(e.Payload, &n); err != nil {
			t.Fatal(err)
		}
		texts = append(texts, n.Text)
	}
	return texts
}

func hasNotice(texts []string, parts ...string) bool {
	for _, text := range texts {
		found := true
		for _, p := range parts {
			found = found && strings.Contains(text, p)
		}
		if found {
			return true
		}
	}
	return false
}

func TestAuthFailureFallsBackToNextLane(t *testing.T) {
	s, url, ch := fallbackSetup(t)
	requestJSON(t, "POST", url+"/api/v1/channels/"+ch.ID+"/messages", `{"body":"@coder synthetic work"}`, 201, nil)
	retry := waitFor(t, func() (domain.Run, bool) {
		runs, _ := s.Runs(context.Background(), ch.ID, "done")
		if len(runs) == 1 {
			return runs[0], true
		}
		return domain.Run{}, false
	})
	if retry.LaneID != "claude/default" || retry.RetryOf == "" {
		t.Fatalf("retry run %+v", retry)
	}
	failed, err := s.Run(context.Background(), retry.RetryOf)
	if err != nil {
		t.Fatal(err)
	}
	if failed.LaneID != "codex/default" || failed.State != domain.RunFailed || failed.FailureClass != domain.FailureSemantic {
		t.Fatalf("first run %+v", failed)
	}
	lane, err := s.Lane(context.Background(), "codex/default")
	if err != nil {
		t.Fatal(err)
	}
	if lane.Health != domain.LaneUnavailable || lane.LastError == nil || !strings.Contains(lane.HealthReason, "subscription") {
		t.Fatalf("lane %+v", lane)
	}
	if !hasNotice(noticeTexts(t, s), "codex/default", "claude/default", "subscription") {
		t.Fatalf("no notice names both lanes and the reason: %q", noticeTexts(t, s))
	}
	var replies int
	msgs, err := s.Messages(context.Background(), ch.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range msgs {
		if m.RunID == failed.ID {
			t.Fatalf("the failed attempt posted a reply: %+v", m)
		}
		if m.RunID == retry.ID {
			replies++
		}
	}
	if replies != 1 {
		t.Fatalf("replies from the retry: %d", replies)
	}
}

func TestExplicitLaneDoesNotFallBack(t *testing.T) {
	s, url, ch := fallbackSetup(t)
	requestJSON(t, "POST", url+"/api/v1/channels/"+ch.ID+"/messages", `{"body":"@coder /lane codex/default synthetic work"}`, 201, nil)
	waitFor(t, func() (bool, bool) {
		return true, hasNotice(noticeTexts(t, s), "You chose lane codex/default")
	})
	runs, err := s.Runs(context.Background(), ch.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].State != domain.RunFailed || runs[0].LaneID != "codex/default" {
		t.Fatalf("runs %+v", runs)
	}
	// The human's lane is unavailable now, so a second try says why.
	requestJSON(t, "POST", url+"/api/v1/channels/"+ch.ID+"/messages", `{"body":"@coder /lane codex/default again"}`, 201, nil)
	waitFor(t, func() (bool, bool) {
		return true, hasNotice(noticeTexts(t, s), "does not fall back")
	})
}

func TestChannelLaneOverride(t *testing.T) {
	c := config.Defaults()
	c.Lanes.Lane = []config.Lane{{ID: "codex/default", CLI: "codex", Capacity: 1}, {ID: "claude/default", CLI: "claude", Capacity: 1}}
	c.Lanes.Persona = []config.Persona{{Handle: "coder", Lanes: []string{"codex/default", "claude/default"}, Mode: "read"}}
	s, a, srv, p := setupWire(t, c)
	ok := filepath.Join(p.DataDir, "ok-agent")
	if err := os.WriteFile(ok, []byte("#!/bin/sh\necho 'synthetic answer'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	a.Adapters["codex"] = fakeCodex{ok}
	a.Adapters["claude"] = fakeCodex{ok}
	var ch domain.Channel
	requestJSON(t, "POST", srv.URL+"/api/v1/channels", `{"name":"work"}`, 201, &ch)
	post := func(body string) {
		requestJSON(t, "POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", `{"body":"`+body+`"}`, 201, nil)
	}
	overrides := func() map[string]string {
		got, err := s.Channel(context.Background(), ch.ID)
		if err != nil {
			t.Fatal(err)
		}
		return got.LaneOverrides
	}

	post("/lane coder nope/lane")
	waitFor(t, func() (bool, bool) { return true, hasNotice(noticeTexts(t, s), "not in @coder's chain") })
	if len(overrides()) != 0 {
		t.Fatalf("bad lane stored: %v", overrides())
	}

	post("/lane coder claude/default")
	waitFor(t, func() (bool, bool) { return true, overrides()["coder"] == "claude/default" })
	post("@coder synthetic work")
	waitFor(t, func() (bool, bool) {
		runs, _ := s.Runs(context.Background(), ch.ID, "done")
		return true, len(runs) == 1 && runs[0].LaneID == "claude/default"
	})

	post("/lane coder default")
	waitFor(t, func() (bool, bool) { return true, len(overrides()) == 0 })
	post("@coder second")
	waitFor(t, func() (bool, bool) {
		runs, _ := s.Runs(context.Background(), ch.ID, "done")
		for _, r := range runs {
			if r.LaneID == "codex/default" {
				return true, true
			}
		}
		return true, false
	})

	requestJSON(t, "PATCH", srv.URL+"/api/v1/channels/"+ch.ID, `{"lane_overrides":{"coder":"nope/lane"}}`, 400, nil)
	requestJSON(t, "PATCH", srv.URL+"/api/v1/channels/"+ch.ID, `{"lane_overrides":{"coder":"claude/default"}}`, 200, nil)
	if overrides()["coder"] != "claude/default" {
		t.Fatalf("patched override: %v", overrides())
	}
}

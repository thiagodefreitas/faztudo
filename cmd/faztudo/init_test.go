package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func initPaths(t *testing.T) config.Paths {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(dir, "data"))
	return config.PathsFromEnv()
}

func TestInitTemplatesWriteALoadableLanesFile(t *testing.T) {
	for _, name := range []string{"solo", "team"} {
		t.Run(name, func(t *testing.T) {
			p := initPaths(t)
			var out bytes.Buffer
			if err := runInit(p, []string{"--template", name}, &out); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), name+" template") {
				t.Fatalf("output %q", out.String())
			}
			c, err := config.Load(p)
			if err != nil {
				t.Fatalf("the %s template does not load: %v", name, err)
			}
			if len(c.Lanes.Persona) < 3 {
				t.Fatalf("personas %+v", c.Lanes.Persona)
			}
			info, err := os.Stat(p.LanesFile)
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatalf("lanes.toml %v, %v", info, err)
			}
		})
	}
}

func TestInitWithoutATemplateKeepsTheCommentedDefaults(t *testing.T) {
	p := initPaths(t)
	for _, args := range [][]string{nil, {"--template", "empty"}} {
		if err := runInit(p, args, &bytes.Buffer{}); err != nil {
			t.Fatal(err)
		}
		used, err := hasSettings(p.LanesFile)
		if err != nil || used {
			t.Fatalf("args %v: lanes.toml has settings (%v, %v)", args, used, err)
		}
	}
}

func TestInitNeverOverwritesYourSettings(t *testing.T) {
	p := initPaths(t)
	if err := runInit(p, []string{"--template", "solo"}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	mine, err := os.ReadFile(p.LanesFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := runInit(p, []string{"--template", "team"}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "already has settings") {
		t.Fatalf("second template: %v", err)
	}
	after, _ := os.ReadFile(p.LanesFile)
	if !bytes.Equal(mine, after) {
		t.Fatal("init changed a lanes.toml that had settings")
	}
}

func TestInitRejectsUnknownTemplatesAndArguments(t *testing.T) {
	p := initPaths(t)
	if err := runInit(p, []string{"--template", "nope"}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "solo") {
		t.Fatalf("unknown template: %v", err)
	}
	if _, err := os.Stat(p.ConfigDir); err == nil {
		t.Fatal("a bad template still created the config directory")
	}
	if err := runInit(p, []string{"extra"}, &bytes.Buffer{}); err == nil {
		t.Fatal("stray argument accepted")
	}
	if err := runInit(p, []string{"--bogus"}, &bytes.Buffer{}); err == nil {
		t.Fatal("unknown flag accepted")
	}
}

func recordRoutine(ctx context.Context, s *store.Store, r domain.Routine) error {
	_, err := s.Append(ctx, events.Draft{Type: events.RoutineUpdated, Actor: events.Human("director"), Payload: r})
	return err
}

func TestSeedRecordsRoutinesAndKeepsTheDirectorsChoices(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("PATH", dir)
	t.Setenv("USER", "tester")
	s, err := store.Open(filepath.Join(dir, "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	off := false
	c := config.Defaults()
	c.Lanes.Lane = []config.Lane{{ID: "codex/default", CLI: "codex", Capacity: 1}}
	c.Lanes.Persona = []config.Persona{{Handle: "chief", Lanes: []string{"codex/default"}, ChiefOfStaff: true, Channels: []string{"general"}}}
	c.Lanes.Routine = []config.Routine{
		{Handle: "daily-debrief", Persona: "chief", Channel: "general", Schedule: "0 18 * * 1-5", Template: "debrief", Enabled: &off},
		{Handle: "welcome", Name: "Welcome", Persona: "chief", Channel: "general", Trigger: "message", Prompt: "Say hello."},
	}
	ctx := context.Background()
	if _, err := seed(ctx, s, c); err != nil {
		t.Fatal(err)
	}
	debrief, err := s.Routine(ctx, "daily-debrief")
	if err != nil || debrief.Enabled || debrief.Name != "daily-debrief" || debrief.Template != "debrief" {
		t.Fatalf("debrief %+v, %v", debrief, err)
	}
	welcome, err := s.Routine(ctx, "welcome")
	if err != nil || !welcome.Enabled || welcome.Trigger != "message" {
		t.Fatalf("welcome %+v, %v", welcome, err)
	}
	member, err := s.MemberByHandle(ctx, "chief")
	if err != nil || member.Agent == nil || !member.Agent.ChiefOfStaff {
		t.Fatalf("chief member %+v, %v", member, err)
	}

	// The Director switches the debrief on and it runs once; a restart reads the
	// file again and must not undo that.
	debrief.Enabled = true
	debrief.Last = &domain.RoutineResult{Status: "ok", Detail: "posted"}
	if err := recordRoutine(ctx, s, debrief); err != nil {
		t.Fatal(err)
	}
	if _, err := seed(ctx, s, c); err != nil {
		t.Fatal(err)
	}
	again, err := s.Routine(ctx, "daily-debrief")
	if err != nil || !again.Enabled || again.Last == nil || again.Last.Status != "ok" {
		t.Fatalf("after a restart %+v, %v", again, err)
	}
}

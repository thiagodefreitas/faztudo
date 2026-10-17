package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestSeedFirstStart(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("PATH", dir)
	t.Setenv("USER", "tester")
	s, err := store.Open(filepath.Join(dir, "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	id, err := seed(context.Background(), s, config.Defaults())
	if err != nil {
		t.Fatal(err)
	}
	again, err := seed(context.Background(), s, config.Defaults())
	if err != nil || again != id {
		t.Fatalf("second seed: %s %v", again, err)
	}
	members, err := s.Members(context.Background())
	if err != nil || len(members) != 1 || members[0].Handle != "tester" {
		t.Fatalf("members: %+v %v", members, err)
	}
	channels, err := s.Channels(context.Background())
	if err != nil || len(channels) != 1 || channels[0].Name != "general" {
		t.Fatalf("channels: %+v %v", channels, err)
	}
}

func TestSeedDetectedCLIAndPersona(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("PATH", dir)
	t.Setenv("USER", "tester")
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte("synthetic"), 0700); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(filepath.Join(dir, "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c := config.Defaults()
	c.Lanes.Lane = []config.Lane{{ID: "codex/custom", CLI: "codex", Capacity: 2, CostClass: "standard"}}
	c.Lanes.Persona = []config.Persona{{Handle: "coder", DisplayName: "Coder", Lanes: []string{"codex/custom"}, Mode: "write"}}
	if _, err = seed(context.Background(), s, c); err != nil {
		t.Fatal(err)
	}
	for _, handle := range []string{"codex", "coder"} {
		m, err := s.MemberByHandle(context.Background(), handle)
		if err != nil || m.Agent == nil || len(m.Agent.Lanes) != 1 || m.Agent.Lanes[0] != "codex/custom" {
			t.Fatalf("member %s: %+v %v", handle, m, err)
		}
	}
}

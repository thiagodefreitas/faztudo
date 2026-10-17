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

func TestShouldOpenBrowser(t *testing.T) {
	tests := []struct {
		name               string
		configured, noOpen bool
		terminal           bool
		display, wayland   string
		want               bool
	}{
		{name: "X display", configured: true, terminal: true, display: ":0", want: true},
		{name: "Wayland display", configured: true, terminal: true, wayland: "wayland-0", want: true},
		{name: "disabled in config", terminal: true, display: ":0"},
		{name: "flag override", configured: true, noOpen: true, terminal: true, display: ":0"},
		{name: "stdout is not a terminal", configured: true, display: ":0"},
		{name: "no display", configured: true, terminal: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldOpenBrowser(tt.configured, tt.noOpen, tt.terminal, tt.display, tt.wayland); got != tt.want {
				t.Fatalf("shouldOpenBrowser() = %t, want %t", got, tt.want)
			}
		})
	}
}

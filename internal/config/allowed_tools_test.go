package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAllowedToolsAndStaleDefault(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("XDG_DATA_HOME", filepath.Join(dir, "data"))
	p := PathsFromEnv()
	if err := WriteDefaults(p); err != nil {
		t.Fatal(err)
	}
	body := "[[lane]]\nid = \"claude/opus\"\ncli = \"claude\"\ncapacity = 1\nallowed_tools = [\"Bash(make:*)\", \"Read\"]\n[[lane]]\nid = \"claude/sonnet\"\ncli = \"claude\"\ncapacity = 1\n[[lane]]\nid = \"claude/none\"\ncli = \"claude\"\ncapacity = 1\nallowed_tools = []\n"
	if err := os.WriteFile(p.LanesFile, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	l := c.Lanes.Lane
	if len(l[0].AllowedTools) != 2 || l[0].AllowedTools[0] != "Bash(make:*)" {
		t.Fatalf("%+v", l[0])
	}
	if l[1].AllowedTools != nil {
		t.Fatalf("unset must stay nil: %#v", l[1].AllowedTools)
	}
	if l[2].AllowedTools == nil || len(l[2].AllowedTools) != 0 {
		t.Fatalf("empty list must stay non-nil: %#v", l[2].AllowedTools)
	}
	if err := os.WriteFile(p.LanesFile, []byte("[[lane]]\nid = \"a\"\ncli = \"claude\"\ncapacity = 1\nallowed_tools = [\" \"]\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(p); err == nil {
		t.Fatal("blank tool accepted")
	}
	// agy/default is hidden once lanes.toml configures any agy lane.
	c = Config{Lanes: LaneConfig{Lane: []Lane{{ID: "agy/opus", CLI: "agy", Capacity: 1}}}}
	for _, tc := range []struct {
		id, cli string
		want    bool
	}{{"agy/default", "agy", true}, {"agy/opus", "agy", false}, {"codex/default", "codex", false}} {
		if got := c.IsStaleDefaultLane(tc.id, tc.cli); got != tc.want {
			t.Fatalf("%s: %v", tc.id, got)
		}
	}
	c.Lanes.Lane = append(c.Lanes.Lane, Lane{ID: "agy/default", CLI: "agy", Capacity: 1})
	if c.IsStaleDefaultLane("agy/default", "agy") {
		t.Fatal("a configured default is not stale")
	}
}

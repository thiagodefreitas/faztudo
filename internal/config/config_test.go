package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("XDG_DATA_HOME", filepath.Join(dir, "data"))
	p := PathsFromEnv()
	if err := WriteDefaults(p); err != nil {
		t.Fatal(err)
	}
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.Server.Listen != "127.0.0.1:7457" || len(c.Lanes.Lane) != 0 {
		t.Fatalf("unexpected config: %+v", c)
	}
	lanes := "[[lane]]\nid = \"codex/default\"\ncli = \"codex\"\ncost_class = \"standard\"\ncapacity = 2\n[[persona]]\nhandle = \"coder\"\ndisplay_name = \"Coder\"\nlanes = [\"codex/default\"]\nmode = \"write\"\n"
	if err := os.WriteFile(p.LanesFile, []byte(lanes), 0600); err != nil {
		t.Fatal(err)
	}
	c, err = Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Lanes.Lane) != 1 || c.Lanes.Lane[0].CostClass != "standard" || c.Lanes.Persona[0].DisplayName != "Coder" {
		t.Fatalf("lane config: %+v", c.Lanes)
	}
	if err := os.WriteFile(p.ConfigFile, []byte("[runs]\ncontext_messages = -1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = Load(p)
	if err == nil {
		t.Fatal("expected validation error")
	}
}

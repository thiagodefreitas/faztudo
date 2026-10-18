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
	lanes := "[[lane]]\nid = \"codex/default\"\ncli = \"codex\"\ncost_class = \"standard\"\ncapacity = 2\nconserve_at = 65\n[[persona]]\nhandle = \"coder\"\ndisplay_name = \"Coder\"\nlanes = [\"codex/default\"]\nmode = \"write\"\n"
	if err := os.WriteFile(p.LanesFile, []byte(lanes), 0600); err != nil {
		t.Fatal(err)
	}
	c, err = Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Lanes.Lane) != 1 || c.Lanes.Lane[0].CostClass != "standard" || c.Lanes.Lane[0].ConserveAt == nil || *c.Lanes.Lane[0].ConserveAt != 65 || c.Lanes.Persona[0].DisplayName != "Coder" {
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

func TestConserveAt(t *testing.T) {
	for _, tc := range []struct {
		value int
		valid bool
	}{{1, true}, {80, true}, {100, true}, {0, false}, {101, false}, {-1, false}} {
		c := Defaults()
		c.Lanes.Lane = []Lane{{ID: "codex/default", CLI: "codex", Capacity: 1, ConserveAt: &tc.value}}
		if got := c.Validate() == nil; got != tc.valid {
			t.Errorf("conserve_at %d valid=%t, want %t", tc.value, got, tc.valid)
		}
	}
}

func TestLANConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("XDG_DATA_HOME", filepath.Join(dir, "data"))
	p := PathsFromEnv()
	if p.TLSDir != filepath.Join(dir, "data", "faztudo", "tls") {
		t.Fatalf("unexpected TLSDir %s", p.TLSDir)
	}
	if err := WriteDefaults(p); err != nil {
		t.Fatal(err)
	}
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.LAN.Enabled || c.LAN.Listen != "0.0.0.0:7458" {
		t.Fatalf("unexpected LAN defaults: %+v", c.LAN)
	}
	if err := os.WriteFile(p.ConfigFile, []byte("[lan]\nenabled = true\nlisten = \"0.0.0.0:7458\"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	c, err = Load(p)
	if err != nil || !c.LAN.Enabled || c.LAN.Listen != "0.0.0.0:7458" {
		t.Fatalf("LAN enabled load: %+v %v", c.LAN, err)
	}
	if err := os.WriteFile(p.ConfigFile, []byte("[lan]\nenabled = true\nlisten = \"bad-addr\"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(p); err == nil {
		t.Fatal("expected error for invalid lan.listen")
	}
}

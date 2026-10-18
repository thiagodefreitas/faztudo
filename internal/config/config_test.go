package config

import (
	"os"
	"path/filepath"
	"strings"
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
	lanes := "[[lane]]\nid = \"codex/default\"\ncli = \"codex\"\ncost_class = \"standard\"\ncapacity = 2\nconserve_at = 65\nsandbox = \"required\"\nsandbox_network = false\n[[persona]]\nhandle = \"coder\"\ndisplay_name = \"Coder\"\nlanes = [\"codex/default\"]\nmode = \"write\"\n"
	if err := os.WriteFile(p.LanesFile, []byte(lanes), 0600); err != nil {
		t.Fatal(err)
	}
	c, err = Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Lanes.Lane) != 1 || c.Lanes.Lane[0].CostClass != "standard" || c.Lanes.Lane[0].ConserveAt == nil || *c.Lanes.Lane[0].ConserveAt != 65 || c.Lanes.Lane[0].Sandbox != "required" || c.Lanes.Lane[0].SandboxNetwork == nil || *c.Lanes.Lane[0].SandboxNetwork || c.Lanes.Persona[0].DisplayName != "Coder" {
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

func TestSandboxConfig(t *testing.T) {
	c := Defaults()
	if c.Runs.Sandbox != "auto" || c.Runs.SandboxMemoryMax != "4G" || c.Runs.SandboxTasksMax != 512 {
		t.Fatalf("sandbox defaults: %+v", c.Runs)
	}
	c.Runs.SandboxReadOnly = []string{"relative/toolchain"}
	if err := c.Validate(); err == nil {
		t.Fatal("accepted relative sandbox_read_only path")
	}
	c.Runs.SandboxReadOnly = nil
	for _, mode := range []string{"auto", "required", "off"} {
		c.Runs.Sandbox = mode
		if err := c.Validate(); err != nil {
			t.Fatalf("%s: %v", mode, err)
		}
	}
	c.Runs.Sandbox = "invalid"
	if err := c.Validate(); err == nil {
		t.Fatal("accepted invalid sandbox mode")
	}
	c.Runs.Sandbox = "auto"
	c.Runs.SandboxMemoryMax = "no-limit"
	if err := c.Validate(); err == nil {
		t.Fatal("accepted invalid memory limit")
	}
}

func TestLaneSandboxOverride(t *testing.T) {
	c := Defaults()
	c.Lanes.Lane = []Lane{{ID: "codex/default", CLI: "codex", Capacity: 1, Sandbox: "required"}}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.Lanes.Lane[0].Sandbox = "invalid"
	if err := c.Validate(); err == nil {
		t.Fatal("accepted invalid lane sandbox")
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

// Finding 7: the CA helper has a real default listen address.
func TestCAListenDefault(t *testing.T) {
	if got := Defaults().LAN.CAListen; got != "0.0.0.0:7459" {
		t.Fatalf("Defaults ca_listen = %q, want 0.0.0.0:7459", got)
	}
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("XDG_DATA_HOME", filepath.Join(dir, "data"))
	p := PathsFromEnv()
	if err := WriteDefaults(p); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(p.ConfigFile)
	if err != nil || !strings.Contains(string(body), `ca_listen = "0.0.0.0:7459"`) {
		t.Fatalf("written defaults lack ca_listen: %v %s", err, body)
	}
	c, err := Load(p)
	if err != nil || c.LAN.CAListen != "0.0.0.0:7459" {
		t.Fatalf("loaded ca_listen = %q (%v)", c.LAN.CAListen, err)
	}
}

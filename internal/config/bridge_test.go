package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSignalBridgeValidation(t *testing.T) {
	base := Defaults()
	base.Bridges.Signal.Enabled = true
	for _, tc := range []struct {
		name   string
		change func(*SignalBridge)
		want   string
	}{
		{"account", func(s *SignalBridge) {}, "account"},
		{"cli", func(s *SignalBridge) { s.Account = "self" }, "signal_cli"},
		{"allow", func(s *SignalBridge) { s.Account = "self"; s.SignalCLI = "signal-cli" }, "allow"},
		{"bind", func(s *SignalBridge) {
			s.Account = "self"
			s.SignalCLI = "signal-cli"
			s.Allow = []string{"+15551234567"}
		}, "bind"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := base
			tc.change(&c.Bridges.Signal)
			if err := c.Validate(); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v; want %s", err, tc.want)
			}
		})
	}
	c := base
	c.Bridges.Signal = SignalBridge{Enabled: true, Account: "self", SignalCLI: "signal-cli", Allow: []string{"+15551234567"}, Bind: map[string]string{"self": "general"}}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.Bridges.Signal.Bind = map[string]string{"group:": "general"}
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "invalid conversation") {
		t.Fatalf("conversation: %v", err)
	}
	c.Bridges.Signal.Bind = map[string]string{"self": "general"}
	c.Bridges.Signal.Alerts = "group:unknown"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "alerts") {
		t.Fatalf("alerts: %v", err)
	}
}

func TestLoadSignalBridgeConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	body := "[bridges.signal]\nenabled = true\naccount = \"+15551234567\"\nsignal_cli = \"signal-cli\"\nallow = [\"+15551234567\"]\napprovals = false\nalerts = \"self\"\n[bridges.signal.bind]\nself = \"general\"\n"
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(Paths{ConfigFile: path, LanesFile: filepath.Join(dir, "lanes.toml")})
	if err != nil {
		t.Fatal(err)
	}
	if !c.Bridges.Signal.Enabled || c.Bridges.Signal.Bind["self"] != "general" || len(c.Bridges.Signal.Allow) != 1 {
		t.Fatalf("bridge config: %+v", c.Bridges.Signal)
	}
}

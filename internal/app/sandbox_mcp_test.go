package app

import (
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func TestLaneSandboxMode(t *testing.T) {
	lanes := []config.Lane{{ID: "codex/default", Sandbox: "off"}, {ID: "claude/default", Sandbox: "required"}}
	for _, tc := range []struct{ id, want string }{{"codex/default", "off"}, {"claude/default", "required"}, {"other/default", "auto"}} {
		if got := laneSandboxMode("auto", lanes, tc.id); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.id, got, tc.want)
		}
	}
}

func TestNetworklessWriteDoesNotReceiveMCP(t *testing.T) {
	for _, tc := range []struct {
		mode    domain.RunMode
		sandbox string
		network bool
		want    bool
	}{
		{domain.RunRead, "required", false, true},
		{domain.RunWrite, "off", false, true},
		{domain.RunWrite, "auto", false, false},
		{domain.RunWrite, "required", false, false},
		{domain.RunWrite, "required", true, true},
	} {
		if got := mcpReachableForRun(tc.mode, tc.sandbox, tc.network); got != tc.want {
			t.Errorf("mode=%s sandbox=%s network=%t: MCP reachable=%t, want %t", tc.mode, tc.sandbox, tc.network, got, tc.want)
		}
	}
}

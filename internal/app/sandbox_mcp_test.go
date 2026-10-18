package app

import (
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

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

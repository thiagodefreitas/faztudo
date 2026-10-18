package main

import (
	"strings"
	"testing"
)

func TestBridgeSignalDispatch(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	if err := run([]string{"bridge", "signal", "unknown"}); err == nil || !strings.Contains(err.Error(), "usage: faztudo bridge signal [link]") {
		t.Fatalf("invalid subcommand: %v", err)
	}
	if err := run([]string{"bridge", "signal"}); err == nil || !strings.Contains(err.Error(), "signal bridge requires") {
		t.Fatalf("bridge dispatch: %v", err)
	}
}

package runner

import (
	"context"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
)

func TestSandboxFallbackPolicy(t *testing.T) {
	command := adapters.Cmd{Path: "faztudo-missing-cli-for-test"}
	req := adapters.Request{Workdir: t.TempDir()}
	var notices []string
	opts := WriteOptions{SandboxMode: "auto", Network: true, OnFallback: func(s string) { notices = append(notices, s) }}
	got, err := sandboxCommand(context.Background(), command, "codex", req, opts)
	if err != nil || got.Path != command.Path || len(notices) != 1 || !strings.Contains(notices[0], "not sandboxed") {
		t.Fatalf("auto fallback: %+v, %v, %q", got, err, notices)
	}
	opts.SandboxMode = "required"
	if _, err := sandboxCommand(context.Background(), command, "codex", req, opts); err == nil || !strings.Contains(err.Error(), "requires bubblewrap") {
		t.Fatalf("required mode: %v", err)
	}
	if len(notices) != 1 {
		t.Fatalf("required mode sent a fallback notice: %q", notices)
	}
}

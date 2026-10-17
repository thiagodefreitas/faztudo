package adapters

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func TestLiveAdditionalAdapters(t *testing.T) {
	if os.Getenv("FAZTUDO_LIVE") != "1" {
		t.Skip("set FAZTUDO_LIVE=1 to run installed CLIs")
	}
	for _, tc := range []struct {
		adapter Adapter
		mode    domain.RunMode
		model   string
	}{
		{Grok{}, domain.RunRead, ""},
		{Kimi{}, domain.RunWrite, ""},
		{Agy{}, domain.RunWrite, "gemini-4-argon-high"},
		{OpenCode{}, domain.RunWrite, ""},
	} {
		t.Run(tc.adapter.Name(), func(t *testing.T) {
			workdir := t.TempDir()
			git := exec.Command("git", "init", "-q", workdir)
			if out, err := git.CombinedOutput(); err != nil {
				t.Fatalf("initialize temporary repo: %v, %s", err, out)
			}
			req := Request{Prompt: "Reply with OK. Do not use tools or edit files.", Mode: tc.mode, Model: tc.model, Workdir: workdir, Timeout: 60 * time.Second}
			c, err := tc.adapter.Command(req)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, c.Path, c.Args...)
			cmd.Dir = c.Dir
			out, err := cmd.CombinedOutput()
			if err != nil {
				code := -1
				if exit, ok := err.(*exec.ExitError); ok {
					code = exit.ExitCode()
				}
				class, signal, _ := tc.adapter.Classify(code, string(out))
				t.Fatalf("live CLI failed: exit %d, class %s, lane signal %s, timeout %t", code, class, signal.Kind, ctx.Err() != nil)
			}
			answered := false
			for _, line := range strings.Split(string(out), "\n") {
				if strings.TrimSpace(line) == "OK" {
					answered = true
					break
				}
			}
			if !answered {
				t.Fatalf("live CLI exited successfully but did not give a standalone OK answer; output bytes %d", len(out))
			}
			t.Logf("exit 0; output bytes %d", len(out))
		})
	}
}

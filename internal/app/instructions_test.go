package app

import (
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/config"
)

func TestStandingInstructionsLeadThePrompt(t *testing.T) {
	a := &App{Config: config.Config{Lanes: config.LaneConfig{Persona: []config.Persona{
		{Handle: "reviewer", Instructions: "  Review for correctness first.\n"},
		{Handle: "coder"},
	}}}}
	if got := a.instructions("Reviewer"); got != "Review for correctness first." {
		t.Fatalf("instructions %q", got)
	}
	if got := a.instructions("coder"); got != "" {
		t.Fatalf("persona without instructions: %q", got)
	}
	if got := a.instructions("claude"); got != "" {
		t.Fatalf("agent without a persona: %q", got)
	}
	if got := withInstructions("", "Request:\nhi"); got != "Request:\nhi" {
		t.Fatalf("no instructions must leave the prompt alone: %q", got)
	}
	got := withInstructions("Be brief.", "Request:\nhi")
	if !strings.HasPrefix(got, "Standing instructions for this role:\nBe brief.\n\n") || !strings.HasSuffix(got, "Request:\nhi") {
		t.Fatalf("prompt %q", got)
	}
}

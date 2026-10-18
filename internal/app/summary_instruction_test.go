package app

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestPromptAsksForALeadingSummary(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a := App{Store: s, Config: config.Defaults()}
	text, err := a.prompt(context.Background(), domain.Message{ID: "m", ChannelID: "ch", Body: "do it"})
	if err != nil {
		t.Fatal(err)
	}
	want := "Start your answer with a summary of one or two plain sentences"
	at := strings.Index(text, want)
	if at < 0 {
		t.Fatalf("prompt lacks the summary instruction: %s", text)
	}
	if strings.Index(text, "Request:\ndo it") > at {
		t.Fatalf("the instruction must follow the request: %s", text)
	}
}

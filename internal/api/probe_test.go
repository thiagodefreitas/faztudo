package api

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestProbeUnsupportedCLIIsBadRequest(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	human := domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: "human"}
	if _, err := s.Append(context.Background(), events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: human}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"agy/flash", "agy/sonnet"} {
		lane := domain.Lane{ID: id, CLI: "agy", Health: domain.LaneAvailable, Capacity: 1}
		if _, err := s.Append(context.Background(), events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: lane}); err != nil {
			t.Fatal(err)
		}
	}
	h := newTestAPI(s, human.ID, "test")
	h.ProbeLane = func(_ context.Context, id string) (domain.Lane, error) {
		if id != "agy/flash" && id != "agy/sonnet" {
			t.Fatalf("wrong lane id: %q", id)
		}
		return domain.Lane{}, domain.UserError{Message: "this CLI has no probe"}
	}
	for _, id := range []string{"flash", "sonnet"} {
		req := httptest.NewRequest("POST", "/api/v1/lanes/agy%2F"+id+"/probe", nil)
		req.RemoteAddr = "127.0.0.1:1234"
		req.Host = "127.0.0.1"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), "this CLI has no probe") {
			t.Fatalf("%s: %d %s", id, rec.Code, rec.Body.String())
		}
	}
}

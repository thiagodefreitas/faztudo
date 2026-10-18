package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/events"
)

func TestBridgeCursorAndOutboundPersist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	ctx := context.Background()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	e, err := s.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, Payload: events.NoticePayload{Level: "info", Text: "old"}})
	if err != nil {
		t.Fatal(err)
	}
	initial, err := s.EnsureBridgeCursor(ctx, "new")
	if err != nil || initial != e.Seq {
		t.Fatalf("initial cursor: %d %v", initial, err)
	}
	if _, err := s.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, Payload: events.NoticePayload{Level: "info", Text: "new"}}); err != nil {
		t.Fatal(err)
	}
	again, err := s.EnsureBridgeCursor(ctx, "new")
	if err != nil || again != initial {
		t.Fatalf("cursor moved on restart: %d %v", again, err)
	}
	if err := s.SetBridgeCursor(ctx, "signal", 12); err != nil {
		t.Fatal(err)
	}
	if err := s.SetBridgeCursor(ctx, "signal", 4); err != nil {
		t.Fatal(err)
	}
	v := BridgeOutbound{ExternalID: "outside", MessageID: "inside"}
	if err := s.PutBridgeOutbound(ctx, "signal", v); err != nil {
		t.Fatal(err)
	}
	if err := s.PutBridgeOutbound(ctx, "signal", v); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate: %v", err)
	}
	_ = s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	seq, err := s.BridgeCursor(ctx, "signal")
	if err != nil || seq != 12 {
		t.Fatalf("cursor: %d %v", seq, err)
	}
	got, err := s.BridgeOutbound(ctx, "signal", "outside")
	if err != nil || got != v {
		t.Fatalf("outbound: %+v %v", got, err)
	}
}

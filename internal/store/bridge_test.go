package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func TestMessageByKeyIsScopedToTheChannel(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, channel := range []string{"one", "two"} {
		c := domain.Channel{ID: channel, Name: channel, Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic}
		if _, err := s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: channel, Payload: c}); err != nil {
			t.Fatal(err)
		}
		m := domain.Message{ID: "msg-" + channel, ChannelID: channel, Body: channel}
		if _, err := s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.System, ChannelID: channel, IdempotencyKey: "signal:a:1", Payload: m}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.MessageByKey(ctx, "two", "signal:a:1")
	if err != nil || got.ID != "msg-two" {
		t.Fatalf("channel two: %+v %v", got, err)
	}
	if _, err := s.MessageByKey(ctx, "three", "signal:a:1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other channel: %v", err)
	}
}

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

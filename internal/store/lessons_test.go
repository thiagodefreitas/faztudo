package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func TestLessonsRoundTripAndRebuild(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now().UTC()
	v := domain.Lesson{ID: NewID(), Persona: "coder", Text: "Keep café accents", SourceMessageID: "source", CreatedBy: "human", CreatedAt: now, UpdatedAt: now}
	appendLesson := func(typ events.Type) {
		t.Helper()
		if _, err := s.Append(ctx, events.Draft{Type: typ, Actor: events.Human("human"), ChannelID: v.ChannelID, Payload: v}); err != nil {
			t.Fatal(err)
		}
	}
	appendLesson(events.LessonAdded)
	got, err := s.Lesson(ctx, v.ID)
	if err != nil || got.Text != v.Text || got.CreatedBy != v.CreatedBy {
		t.Fatalf("added: %+v %v", got, err)
	}
	v.Text = "Keep the accents"
	v.ChannelID = "team"
	v.SourceMessageID = ""
	v.UpdatedAt = now.Add(time.Second)
	appendLesson(events.LessonUpdated)
	if err := s.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	list, err := s.Lessons(ctx, "coder")
	if err != nil || len(list) != 1 || list[0].Text != v.Text || list[0].ChannelID != "team" || list[0].SourceMessageID != "" || !list[0].CreatedAt.Equal(now) {
		t.Fatalf("rebuilt: %+v %v", list, err)
	}
	appendLesson(events.LessonRemoved)
	if _, err := s.Lesson(ctx, v.ID); err != ErrNotFound {
		t.Fatalf("removed: %v", err)
	}
}

func TestLessonScopeMoveNotifiesOldChannel(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now().UTC()
	before := domain.Lesson{ID: NewID(), Persona: "coder", ChannelID: "private", Text: "old", CreatedBy: "human", CreatedAt: now, UpdatedAt: now}
	if _, err := s.Append(ctx, events.Draft{Type: events.LessonAdded, Actor: events.Human("human"), ChannelID: before.ChannelID, Payload: before}); err != nil {
		t.Fatal(err)
	}
	after := before
	after.ChannelID = ""
	after.Text = "new"
	after.UpdatedAt = now.Add(time.Second)
	if err := s.UpdateLesson(ctx, before, after, events.Human("human")); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateLesson(ctx, before, after, events.Human("human")); err != ErrConflict {
		t.Fatalf("stale update: %v", err)
	}
	evs, err := s.EventsAfter(ctx, 0, 10)
	if err != nil || len(evs) != 3 || evs[1].Type != events.LessonUpdated || evs[1].ChannelID != "" || evs[2].Type != events.LessonRemoved || evs[2].ChannelID != "private" {
		t.Fatalf("scope events: %+v %v", evs, err)
	}
	if err := s.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := s.Lesson(ctx, before.ID)
	if err != nil || got.ChannelID != "" || got.Text != "new" {
		t.Fatalf("moved lesson: %+v %v", got, err)
	}
	if err := s.RemoveLesson(ctx, before, events.Human("human")); err != ErrConflict {
		t.Fatalf("stale removal: %v", err)
	}
	if err := s.RemoveLesson(ctx, got, events.Human("human")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Lesson(ctx, before.ID); err != ErrNotFound {
		t.Fatalf("removed lesson: %v", err)
	}
}

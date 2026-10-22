package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func scanLesson(row interface{ Scan(...any) error }) (domain.Lesson, error) {
	var v domain.Lesson
	var created, updated string
	err := row.Scan(&v.ID, &v.Persona, &v.ChannelID, &v.Text, &v.SourceMessageID, &v.CreatedBy, &created, &updated)
	if err != nil {
		return v, err
	}
	v.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	if err != nil {
		return v, err
	}
	v.UpdatedAt, err = time.Parse(time.RFC3339Nano, updated)
	return v, err
}

// UpdateLesson sends a removal to the old channel when its scope changes.
// Both events and their projection commit together.
func (s *Store) UpdateLesson(ctx context.Context, before, after domain.Lesson, actor events.Actor) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var channel, updated string
	if err := tx.QueryRowContext(ctx, "SELECT channel_id,updated_at FROM lessons WHERE id=?", before.ID).Scan(&channel, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if channel != before.ChannelID || updated != before.UpdatedAt.Format(time.RFC3339Nano) {
		return ErrConflict
	}
	if _, err := appendLessonTx(ctx, tx, events.Draft{Type: events.LessonUpdated, Actor: actor, ChannelID: after.ChannelID, Payload: after}); err != nil {
		return err
	}
	if before.ChannelID != after.ChannelID {
		if _, err := appendLessonTx(ctx, tx, events.Draft{Type: events.LessonRemoved, Actor: actor, ChannelID: before.ChannelID, Payload: before}); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.wake()
	return nil
}

func (s *Store) RemoveLesson(ctx context.Context, lesson domain.Lesson, actor events.Actor) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var channel, updated string
	if err := tx.QueryRowContext(ctx, "SELECT channel_id,updated_at FROM lessons WHERE id=?", lesson.ID).Scan(&channel, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if channel != lesson.ChannelID || updated != lesson.UpdatedAt.Format(time.RFC3339Nano) {
		return ErrConflict
	}
	if _, err := appendLessonTx(ctx, tx, events.Draft{Type: events.LessonRemoved, Actor: actor, ChannelID: lesson.ChannelID, Payload: lesson}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.wake()
	return nil
}

func appendLessonTx(ctx context.Context, tx *sql.Tx, d events.Draft) (events.Event, error) {
	payload, err := json.Marshal(d.Payload)
	if err != nil {
		return events.Event{}, err
	}
	return appendTx(ctx, tx, d, payload)
}

func (s *Store) Lesson(ctx context.Context, id string) (domain.Lesson, error) {
	v, err := scanLesson(s.rdb.QueryRowContext(ctx, "SELECT id,persona,channel_id,text,source_message_id,created_by,created_at,updated_at FROM lessons WHERE id=?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return v, ErrNotFound
	}
	return v, err
}

func (s *Store) Lessons(ctx context.Context, persona string) ([]domain.Lesson, error) {
	rows, err := s.rdb.QueryContext(ctx, "SELECT id,persona,channel_id,text,source_message_id,created_by,created_at,updated_at FROM lessons WHERE (?='' OR persona=?) ORDER BY created_at DESC, id DESC", persona, persona)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Lesson{}
	for rows.Next() {
		v, err := scanLesson(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

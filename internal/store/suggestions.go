package store

import (
	"context"
	"database/sql"
	"errors"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

// ErrSuggestionCap is returned by FileSuggestion when the run already filed
// as many suggestions as it may.
var ErrSuggestionCap = errors.New("suggestion limit for this run reached")

// Suggestions lists suggestions newest first. An empty channelID means every
// channel and an empty state means every state.
func (s *Store) Suggestions(ctx context.Context, channelID string, state domain.SuggestionState) ([]domain.Suggestion, error) {
	return queryJSON[domain.Suggestion](ctx, s.rdb, "SELECT data FROM suggestions WHERE (?='' OR channel_id=?) AND (?='' OR state=?) ORDER BY created_at DESC, id DESC", channelID, channelID, string(state), string(state))
}

func (s *Store) Suggestion(ctx context.Context, id string) (domain.Suggestion, error) {
	return oneJSON[domain.Suggestion](ctx, s.rdb, "SELECT data FROM suggestions WHERE id=?", id)
}

// FileSuggestion records a new suggestion unless the run already filed max of
// them. The count and the event commit together.
func (s *Store) FileSuggestion(ctx context.Context, v domain.Suggestion, max int, actor events.Actor) (events.Event, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return events.Event{}, err
	}
	defer tx.Rollback()
	var filed int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM suggestions WHERE run_id=?", v.RunID).Scan(&filed); err != nil {
		return events.Event{}, err
	}
	if v.RunID != "" && filed >= max {
		return events.Event{}, ErrSuggestionCap
	}
	e, err := appendLessonTx(ctx, tx, events.Draft{Type: events.SuggestionCreated, Actor: actor, ChannelID: v.ChannelID, Payload: v})
	if err != nil {
		return events.Event{}, err
	}
	if err := tx.Commit(); err != nil {
		return events.Event{}, err
	}
	s.wake()
	return e, nil
}

// ResolveSuggestion moves an open suggestion to its new state. A suggestion
// that is no longer open is a conflict, so two clicks make one task.
func (s *Store) ResolveSuggestion(ctx context.Context, after domain.Suggestion, actor events.Actor) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var state string
	if err := tx.QueryRowContext(ctx, "SELECT state FROM suggestions WHERE id=?", after.ID).Scan(&state); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if state != string(domain.SuggestionOpen) {
		return ErrConflict
	}
	if _, err := appendLessonTx(ctx, tx, events.Draft{Type: events.SuggestionResolved, Actor: actor, ChannelID: after.ChannelID, Payload: after}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.wake()
	return nil
}

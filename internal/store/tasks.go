package store

import (
	"context"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// Tasks lists the tasks of a channel, or of all channels when channelID is
// empty, by their board order and then by id.
func (s *Store) Tasks(ctx context.Context, channelID string) ([]domain.Task, error) {
	return queryJSON[domain.Task](ctx, s.db, "SELECT data FROM tasks WHERE (?='' OR channel_id=?) ORDER BY json_extract(data,'$.order'), id", channelID, channelID)
}

func (s *Store) Task(ctx context.Context, id string) (domain.Task, error) {
	return oneJSON[domain.Task](ctx, s.db, "SELECT data FROM tasks WHERE id=?", id)
}

// TaskByMessage finds the task whose start posted the message.
func (s *Store) TaskByMessage(ctx context.Context, messageID string) (domain.Task, error) {
	if messageID == "" {
		return domain.Task{}, ErrNotFound
	}
	return oneJSON[domain.Task](ctx, s.db, "SELECT data FROM tasks WHERE message_id=?", messageID)
}

package store

import (
	"context"
	"errors"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

type LaneUsageReading struct {
	LaneID string            `json:"lane_id"`
	Window domain.LaneWindow `json:"window"`
	ReadAt time.Time         `json:"read_at"`
}

func (s *Store) LaneHistory(ctx context.Context, laneID, window string, since time.Time) ([]LaneUsageReading, error) {
	return queryJSON[LaneUsageReading](ctx, s.db, "SELECT data FROM lane_usage_history WHERE lane_id=? AND (?='' OR window_name=?) AND measured_at>=? ORDER BY measured_at,seq", laneID, window, window, since.UTC().Format("2006-01-02T15:04:05.000000000Z"))
}

type ChannelSummary struct {
	ChannelID        string    `json:"channel_id"`
	LaneID           string    `json:"lane_id"`
	Text             string    `json:"text"`
	ThroughMessageID string    `json:"through_message_id"`
	UpdatedAt        time.Time `json:"updated_at"`
}

func (s *Store) ChannelSummary(ctx context.Context, channelID string) (ChannelSummary, error) {
	return oneJSON[ChannelSummary](ctx, s.db, "SELECT data FROM channel_summaries WHERE channel_id=?", channelID)
}

func (s *Store) RootMessagesAfter(ctx context.Context, channelID, afterID string) ([]domain.Message, error) {
	if afterID == "" {
		return queryJSON[domain.Message](ctx, s.db, "SELECT data FROM messages WHERE channel_id=? AND thread_id='' ORDER BY created_at,id LIMIT 80", channelID)
	}
	boundary, err := s.Message(ctx, afterID)
	if err != nil {
		return nil, err
	}
	if boundary.ChannelID != channelID {
		return nil, ErrNotFound
	}
	if boundary.CreatedAt.IsZero() {
		return nil, errors.New("summary boundary has no timestamp")
	}
	return queryJSON[domain.Message](ctx, s.db, "SELECT data FROM messages WHERE channel_id=? AND thread_id='' AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 80", channelID, boundary.CreatedAt.UTC().Format(time.RFC3339Nano), boundary.CreatedAt.UTC().Format(time.RFC3339Nano), afterID)
}

package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

// MessageByKey finds a posted message by the idempotency key it was appended
// with. The lookup is scoped to the channel, like Append's uniqueness, so it
// uses the (channel_id, idempotency_key) index.
func (s *Store) MessageByKey(ctx context.Context, channelID, key string) (domain.Message, error) {
	var typ string
	var raw []byte
	err := s.db.QueryRowContext(ctx, "SELECT type,payload FROM events WHERE channel_id=? AND idempotency_key=?", channelID, key).Scan(&typ, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Message{}, ErrNotFound
	}
	if err != nil {
		return domain.Message{}, err
	}
	if typ != string(events.MessagePosted) {
		return domain.Message{}, ErrConflict
	}
	var m domain.Message
	return m, json.Unmarshal(raw, &m)
}

// BridgeCursor is the last event a bridge acknowledged for outbound delivery.
// EnsureBridgeCursor starts a newly configured bridge at the current log tip,
// so enabling a mirror does not publish old channel history by surprise.
func (s *Store) EnsureBridgeCursor(ctx context.Context, bridge string) (int64, error) {
	_, err := s.db.ExecContext(ctx, "INSERT OR IGNORE INTO bridge_cursor(bridge,seq) SELECT ?,COALESCE(MAX(seq),0) FROM events", bridge)
	if err != nil {
		return 0, err
	}
	return s.BridgeCursor(ctx, bridge)
}

func (s *Store) BridgeCursor(ctx context.Context, bridge string) (int64, error) {
	var seq int64
	err := s.db.QueryRowContext(ctx, "SELECT seq FROM bridge_cursor WHERE bridge=?", bridge).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return seq, err
}

func (s *Store) SetBridgeCursor(ctx context.Context, bridge string, seq int64) error {
	_, err := s.db.ExecContext(ctx, "INSERT INTO bridge_cursor(bridge,seq) VALUES(?,?) ON CONFLICT(bridge) DO UPDATE SET seq=max(seq,excluded.seq)", bridge, seq)
	return err
}

type BridgeOutbound struct {
	ExternalID string
	MessageID  string
	ApprovalID string
}

func (s *Store) PutBridgeOutbound(ctx context.Context, bridge string, v BridgeOutbound) error {
	if v.ExternalID == "" || (v.MessageID == "") == (v.ApprovalID == "") {
		return errors.New("bridge outbound needs an external id and one local reference")
	}
	_, err := s.db.ExecContext(ctx, "INSERT INTO bridge_outbound(bridge,external_id,message_id,approval_id) VALUES(?,?,?,?)", bridge, v.ExternalID, v.MessageID, v.ApprovalID)
	return storeError(err)
}

func (s *Store) BridgeOutbound(ctx context.Context, bridge, externalID string) (BridgeOutbound, error) {
	var v BridgeOutbound
	err := s.db.QueryRowContext(ctx, "SELECT external_id,message_id,approval_id FROM bridge_outbound WHERE bridge=? AND external_id=?", bridge, externalID).Scan(&v.ExternalID, &v.MessageID, &v.ApprovalID)
	if errors.Is(err, sql.ErrNoRows) {
		return v, ErrNotFound
	}
	return v, err
}

// BridgeAgentPolicy returns the stored choice or the safe default for this
// conversation. Only note-to-self has the Director as its sole reader.
func (s *Store) BridgeAgentPolicy(ctx context.Context, bridge, conversation, channelID string) (string, error) {
	var policy string
	err := s.db.QueryRowContext(ctx, "SELECT outbound_agents FROM bridge_binding_policy WHERE bridge=? AND conversation=? AND channel_id=?", bridge, conversation, channelID).Scan(&policy)
	if errors.Is(err, sql.ErrNoRows) {
		if conversation == "self" {
			return "send", nil
		}
		return "draft", nil
	}
	return policy, err
}

func (s *Store) SetBridgeAgentPolicy(ctx context.Context, bridge, conversation, channelID, policy string) error {
	if policy != "send" && policy != "draft" && policy != "off" {
		return ErrInvalidOption
	}
	_, err := s.db.ExecContext(ctx, "INSERT INTO bridge_binding_policy(bridge,conversation,channel_id,outbound_agents) VALUES(?,?,?,?) ON CONFLICT(bridge,conversation,channel_id) DO UPDATE SET outbound_agents=excluded.outbound_agents", bridge, conversation, channelID, policy)
	return err
}

// ClaimBridgeDelivery makes an approved draft an at-most-once send. A crash
// after claiming may leave it undelivered, but cannot publish it twice.
func (s *Store) ClaimBridgeDelivery(ctx context.Context, bridge, key string) (bool, error) {
	result, err := s.db.ExecContext(ctx, "INSERT OR IGNORE INTO bridge_delivery(bridge,delivery_key) VALUES(?,?)", bridge, key)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}

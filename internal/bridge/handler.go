// Package bridge supervises local bridge processes. A bridge is not trusted
// to authorize senders, choose channels, or act as a human on its own.
package bridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/files"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

type Conversation struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

func (c Conversation) Key() string {
	if c.Kind == "self" && c.ID == "" {
		return "self"
	}
	return c.Kind + ":" + c.ID
}

type Sender struct {
	ID     string `json:"id"`
	Number string `json:"number"`
}

type Attachment struct {
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	DataBase64  string `json:"data_b64"`
}

type Quote struct {
	ExternalID string `json:"external_id"`
	AuthorID   string `json:"author_id"`
}

type Inbound struct {
	Conversation Conversation `json:"conversation"`
	Sender       Sender       `json:"sender"`
	SentAtMS     int64        `json:"sent_at_ms"`
	ExternalID   string       `json:"external_id"`
	Body         string       `json:"body"`
	Quote        *Quote       `json:"quote"`
	Attachments  []Attachment `json:"attachments"`
}

type Hello struct {
	Protocol     string   `json:"protocol"`
	Bridge       string   `json:"bridge"`
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
}

type HelloResult struct {
	Bindings map[string]string `json:"bindings"`
	Allowed  []string          `json:"allowed_senders"`
}

type InboundResult struct {
	MessageID string `json:"message_id"`
	Duplicate bool   `json:"duplicate"`
}

type RPCError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e RPCError) Error() string { return e.Message }

type Handler struct {
	Config    config.SignalBridge
	API       *api.API
	Store     *store.Store
	Human     domain.Member
	MaxUpload int64
	FilesDir  string
}

func (h *Handler) bindings(ctx context.Context) (map[string]string, error) {
	out, _, err := h.resolveBindings(ctx)
	return out, err
}

// resolveBindings returns the bindings that resolve to a channel and, as err,
// the first one that does not.
func (h *Handler) resolveBindings(ctx context.Context) (map[string]string, []domain.Channel, error) {
	channels, err := h.Store.Channels(ctx)
	if err != nil {
		return nil, nil, err
	}
	out := make(map[string]string, len(h.Config.Bind))
	var missing error
	for key, configured := range h.Config.Bind {
		found := false
		for _, c := range channels {
			if c.ID == configured || c.Name == configured {
				out[key] = c.ID
				found = true
				break
			}
		}
		if !found && missing == nil {
			missing = fmt.Errorf("bridge binding %q: channel %q not found", key, configured)
		}
	}
	if missing != nil {
		return out, channels, missing
	}
	return out, channels, nil
}

// Notice posts a warning in the alerts conversation's channel, else the first
// bound channel, else the first channel there is. It works even when some
// binding names a channel that does not exist.
func (h *Handler) Notice(ctx context.Context, text string) {
	bound, channels, err := h.resolveBindings(ctx)
	if channels == nil && err != nil {
		return
	}
	channelID := bound[h.Config.Alerts]
	if channelID == "" {
		keys := make([]string, 0, len(bound))
		for k := range bound {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		if len(keys) > 0 {
			channelID = bound[keys[0]]
		} else if len(channels) > 0 {
			channelID = channels[0].ID
		}
	}
	if channelID != "" {
		_, _ = h.Store.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, ChannelID: channelID, Payload: events.NoticePayload{Level: "warn", Text: text}})
	}
}

func (h *Handler) Hello(ctx context.Context, v Hello) (HelloResult, error) {
	if v.Protocol != "1" || v.Bridge != "signal" || v.Version == "" {
		return HelloResult{}, RPCError{"bad_request", "unsupported bridge protocol or bridge"}
	}
	bindings, err := h.bindings(ctx)
	if err != nil {
		return HelloResult{}, err
	}
	return HelloResult{Bindings: bindings, Allowed: append([]string(nil), h.Config.Allow...)}, nil
}

func (h *Handler) Inbound(ctx context.Context, v Inbound) (InboundResult, error) {
	if v.Sender.ID == "" || len(v.Sender.ID) > 256 || strings.Contains(v.Sender.ID, ":") || v.ExternalID == "" || v.SentAtMS <= 0 || len(v.ExternalID) > 256 || len(v.Attachments) > 10 || (strings.TrimSpace(v.Body) == "" && len(v.Attachments) == 0) {
		return InboundResult{}, RPCError{"bad_request", "invalid inbound message"}
	}
	allowed := false
	for _, id := range h.Config.Allow {
		allowed = allowed || id == v.Sender.ID || (v.Sender.Number != "" && id == v.Sender.Number)
	}
	if !allowed {
		return InboundResult{}, RPCError{"not_allowed", "sender is not allowed"}
	}
	if len(v.Body) > api.MaxMessageBytes {
		return InboundResult{}, RPCError{"too_large", "message is too large"}
	}
	bindings, err := h.bindings(ctx)
	if err != nil {
		return InboundResult{}, err
	}
	channelID, ok := bindings[v.Conversation.Key()]
	if !ok {
		return InboundResult{}, RPCError{"unbound", "conversation is not bound"}
	}
	limit := h.MaxUpload
	if limit <= 0 {
		limit = 25 << 20
	}
	data := make([][]byte, 0, len(v.Attachments))
	for _, attachment := range v.Attachments {
		if int64(base64.StdEncoding.DecodedLen(len(attachment.DataBase64))) > limit+3 {
			return InboundResult{}, RPCError{"too_large", "attachment is too large"}
		}
		decoded, err := base64.StdEncoding.DecodeString(attachment.DataBase64)
		if err != nil {
			return InboundResult{}, RPCError{"bad_request", "invalid attachment data"}
		}
		if int64(len(decoded)) > limit {
			return InboundResult{}, RPCError{"too_large", "attachment is too large"}
		}
		data = append(data, decoded)
	}
	// The event append is the idempotency boundary. Check first to avoid
	// rewriting attachments, then let Store.Append arbitrate concurrent posts.
	key := "signal:" + v.Sender.ID + ":" + v.ExternalID
	if old, err := h.Store.MessageByKey(ctx, channelID, key); err == nil {
		return InboundResult{MessageID: old.ID, Duplicate: true}, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return InboundResult{}, err
	}
	attachments := make([]domain.Attachment, 0, len(data))
	if len(data) > 0 && h.FilesDir == "" {
		return InboundResult{}, RPCError{"bad_request", "attachments are unavailable"}
	}
	for i, b := range data {
		id, size, err := (files.Store{Dir: h.FilesDir}).Put(bytes.NewReader(b), limit)
		if err != nil {
			if errors.Is(err, files.ErrTooLarge) {
				return InboundResult{}, RPCError{"too_large", "attachment is too large"}
			}
			return InboundResult{}, err
		}
		typ, _, err := (files.Store{Dir: h.FilesDir}).Info(id)
		if err != nil {
			return InboundResult{}, err
		}
		attachments = append(attachments, domain.Attachment{ID: id, Name: files.CleanName(v.Attachments[i].Name), ContentType: typ, Size: size})
	}
	threadID := ""
	if v.Quote != nil && v.Quote.ExternalID != "" {
		if ref, err := h.Store.BridgeOutbound(ctx, "signal", v.Quote.ExternalID); err == nil {
			threadID = ref.MessageID
		} else if !errors.Is(err, store.ErrNotFound) {
			return InboundResult{}, err
		}
		if threadID == "" && v.Quote.AuthorID != "" {
			if quoted, err := h.Store.MessageByKey(ctx, channelID, "signal:"+v.Quote.AuthorID+":"+v.Quote.ExternalID); err == nil {
				threadID = quoted.ID
			} else if !errors.Is(err, store.ErrNotFound) {
				return InboundResult{}, err
			}
		}
		if threadID != "" {
			quoted, err := h.Store.Message(ctx, threadID)
			if err != nil || quoted.ChannelID != channelID {
				threadID = ""
			}
		}
	}
	message, fresh, err := h.API.PostAs(ctx, events.Bridge("signal"), h.Human, api.PostInput{ChannelID: channelID, Body: v.Body, ThreadID: threadID, IdempotencyKey: key, Attachments: attachments, Fanout: true})
	if err != nil {
		return InboundResult{}, err
	}
	return InboundResult{MessageID: message.ID, Duplicate: !fresh}, nil
}

package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

const (
	maxBodyBytes = 65536
	maxContext   = 50
	maxOptions   = 8
)

var optionKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

type postIn struct {
	Body     string `json:"body" jsonschema:"message text"`
	ThreadID string `json:"thread_id,omitempty" jsonschema:"optional id of a message in this channel"`
}

type askIn struct {
	Question string `json:"question" jsonschema:"question for the human"`
}

type optionIn struct {
	Key   string `json:"key" jsonschema:"option key"`
	Label string `json:"label" jsonschema:"option label"`
	Style string `json:"style,omitempty" jsonschema:"primary or danger or empty"`
}

type approvalIn struct {
	Title   string     `json:"title" jsonschema:"short title"`
	Detail  string     `json:"detail" jsonschema:"why a decision is needed"`
	Options []optionIn `json:"options" jsonschema:"choices the human can pick"`
}

type contextIn struct {
	Limit int `json:"limit,omitempty" jsonschema:"how many recent messages to return. 0 means 50. Maximum 50"`
}

type emptyIn struct{}

type messageOut struct {
	ID        string   `json:"id"`
	ChannelID string   `json:"channel_id"`
	ThreadID  string   `json:"thread_id,omitempty"`
	AuthorID  string   `json:"author_id"`
	Body      string   `json:"body"`
	Mentions  []string `json:"mentions"`
	RunID     string   `json:"run_id,omitempty"`
}

type messagesOut struct {
	Messages []messageOut `json:"messages"`
}

type approvalOut struct {
	ID    string `json:"id"`
	State string `json:"state"`
}

type memberOut struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Handle      string `json:"handle"`
	DisplayName string `json:"display_name"`
	Presence    string `json:"presence"`
}

type membersOut struct {
	Members []memberOut `json:"members"`
}

// channelToolHints tells a plan-mode client that these tools do not modify
// the work tree. They only read or append to this run's channel.
func channelToolHints() *sdkmcp.ToolAnnotations {
	closed := false
	return &sdkmcp.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: &closed, OpenWorldHint: &closed}
}

func (h *Handler) addTools(server *sdkmcp.Server, grant Grant) {
	hints := channelToolHints()
	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "post_message",
		Description: "Post a message in this run's channel as this run's agent. Does not modify the work tree.",
		Annotations: hints,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, in postIn) (*sdkmcp.CallToolResult, messageOut, error) {
		out, err := h.post(ctx, grant, in.Body, in.ThreadID, true)
		return nil, out, err
	})
	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "ask_human",
		Description: "Post a question mentioning the human members. Returns immediately and does not wait. Does not modify the work tree.",
		Annotations: hints,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, in askIn) (*sdkmcp.CallToolResult, messageOut, error) {
		out, err := h.ask(ctx, grant, in.Question)
		return nil, out, err
	})
	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "request_approval",
		Description: "Create a pending approval in this run's channel. Nothing in this server resolves it. Does not modify the work tree.",
		Annotations: hints,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, in approvalIn) (*sdkmcp.CallToolResult, approvalOut, error) {
		out, err := h.requestApproval(ctx, grant, in)
		return nil, out, err
	})
	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "read_context",
		Description: "Read recent messages from this run's channel. Limit must be from 1 to 50.",
		Annotations: hints,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, in contextIn) (*sdkmcp.CallToolResult, messagesOut, error) {
		out, err := h.readContext(ctx, grant, in.Limit)
		return nil, out, err
	})
	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "list_members",
		Description: "List workspace members.",
		Annotations: hints,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, _ emptyIn) (*sdkmcp.CallToolResult, membersOut, error) {
		out, err := h.listMembers(ctx)
		return nil, out, err
	})
}

func (h *Handler) post(ctx context.Context, grant Grant, body, threadID string, fanout bool) (messageOut, error) {
	if strings.TrimSpace(body) == "" {
		return messageOut{}, errors.New("body required")
	}
	if len(body) > maxBodyBytes {
		return messageOut{}, errors.New("body too long")
	}
	if _, err := h.store.Channel(ctx, grant.ChannelID); err != nil {
		return messageOut{}, errors.New("channel unavailable")
	}
	if threadID != "" {
		root, err := h.store.Message(ctx, threadID)
		if err != nil || root.ChannelID != grant.ChannelID {
			return messageOut{}, errors.New("invalid thread_id")
		}
	}
	members, err := h.store.Members(ctx)
	if err != nil {
		return messageOut{}, err
	}
	ids, agents := mentioned(body, members)
	msg := domain.Message{
		ID:        store.NewID(),
		ChannelID: grant.ChannelID,
		ThreadID:  threadID,
		AuthorID:  grant.AgentID,
		Body:      body,
		Mentions:  ids,
		RunID:     grant.RunID,
		CreatedAt: time.Now().UTC(),
	}
	evt, err := h.store.Append(ctx, events.Draft{
		Type:      events.MessagePosted,
		Actor:     events.Agent(grant.AgentID),
		ChannelID: grant.ChannelID,
		Payload:   msg,
	})
	if err != nil {
		return messageOut{}, err
	}
	if err := unmarshalPayload(evt.Payload, &msg); err != nil {
		return messageOut{}, err
	}
	if fanout && h.trigger != nil {
		others := make([]domain.Member, 0, len(agents))
		for _, agent := range agents {
			if agent.ID != grant.AgentID {
				others = append(others, agent)
			}
		}
		if len(others) > 0 {
			h.trigger.OnMessage(ctx, msg, others)
		}
	}
	return messageView(msg), nil
}

func (h *Handler) ask(ctx context.Context, grant Grant, question string) (messageOut, error) {
	if strings.TrimSpace(question) == "" {
		return messageOut{}, errors.New("question required")
	}
	members, err := h.store.Members(ctx)
	if err != nil {
		return messageOut{}, err
	}
	var b strings.Builder
	humans := 0
	for _, member := range members {
		if member.Kind != domain.MemberHuman || member.Handle == "" {
			continue
		}
		if humans > 0 {
			b.WriteByte(' ')
		}
		b.WriteByte('@')
		b.WriteString(member.Handle)
		humans++
	}
	if humans == 0 {
		return messageOut{}, errors.New("no human member")
	}
	b.WriteByte(' ')
	b.WriteString(question)
	return h.post(ctx, grant, b.String(), "", false)
}

func (h *Handler) requestApproval(ctx context.Context, grant Grant, in approvalIn) (approvalOut, error) {
	title := strings.TrimSpace(in.Title)
	if title == "" {
		return approvalOut{}, errors.New("title required")
	}
	if len(in.Title) > maxBodyBytes || len(in.Detail) > maxBodyBytes {
		return approvalOut{}, errors.New("approval text too long")
	}
	if len(in.Options) < 1 {
		return approvalOut{}, errors.New("at least one option")
	}
	if len(in.Options) > maxOptions {
		return approvalOut{}, errors.New("too many options")
	}
	options := make([]domain.ApprovalOption, 0, len(in.Options))
	seen := map[string]bool{}
	for _, opt := range in.Options {
		key := opt.Key
		label := strings.TrimSpace(opt.Label)
		if !optionKeyPattern.MatchString(key) {
			return approvalOut{}, errors.New("option key invalid")
		}
		if label == "" {
			return approvalOut{}, errors.New("option label required")
		}
		switch opt.Style {
		case "", "primary", "danger":
		default:
			return approvalOut{}, errors.New("option style invalid")
		}
		if seen[key] {
			return approvalOut{}, errors.New("duplicate option")
		}
		seen[key] = true
		options = append(options, domain.ApprovalOption{Key: key, Label: label, Style: opt.Style})
	}
	if _, err := h.store.Channel(ctx, grant.ChannelID); err != nil {
		return approvalOut{}, errors.New("channel unavailable")
	}
	approval := domain.Approval{
		ID:          store.NewID(),
		RunID:       grant.RunID,
		ChannelID:   grant.ChannelID,
		RequestedBy: grant.AgentID,
		Title:       title,
		Detail:      in.Detail,
		Options:     options,
		State:       domain.ApprovalPending,
	}
	evt, err := h.store.Append(ctx, events.Draft{
		Type:      events.ApprovalRequested,
		Actor:     events.Agent(grant.AgentID),
		ChannelID: grant.ChannelID,
		Payload:   approval,
	})
	if err != nil {
		return approvalOut{}, err
	}
	if err := unmarshalPayload(evt.Payload, &approval); err != nil {
		return approvalOut{}, err
	}
	if approval.State != domain.ApprovalPending {
		return approvalOut{}, errors.New("approval was not left pending")
	}
	return approvalOut{ID: approval.ID, State: string(approval.State)}, nil
}

func (h *Handler) readContext(ctx context.Context, grant Grant, limit int) (messagesOut, error) {
	if limit == 0 {
		limit = maxContext
	}
	if limit < 1 || limit > maxContext {
		return messagesOut{}, errors.New("limit must be from 1 to 50")
	}
	msgs, err := h.store.Messages(ctx, grant.ChannelID, "", limit)
	if err != nil {
		return messagesOut{}, err
	}
	out := messagesOut{Messages: make([]messageOut, 0, len(msgs))}
	for _, msg := range msgs {
		out.Messages = append(out.Messages, messageView(msg))
	}
	return out, nil
}

func (h *Handler) listMembers(ctx context.Context) (membersOut, error) {
	members, err := h.store.Members(ctx)
	if err != nil {
		return membersOut{}, err
	}
	out := membersOut{Members: make([]memberOut, 0, len(members))}
	for _, member := range members {
		out.Members = append(out.Members, memberOut{
			ID:          member.ID,
			Kind:        string(member.Kind),
			Handle:      member.Handle,
			DisplayName: member.DisplayName,
			Presence:    string(member.Presence),
		})
	}
	return out, nil
}

func messageView(msg domain.Message) messageOut {
	mentions := msg.Mentions
	if mentions == nil {
		mentions = []string{}
	}
	return messageOut{
		ID:        msg.ID,
		ChannelID: msg.ChannelID,
		ThreadID:  msg.ThreadID,
		AuthorID:  msg.AuthorID,
		Body:      msg.Body,
		Mentions:  mentions,
		RunID:     msg.RunID,
	}
}

func unmarshalPayload(raw []byte, dest any) error {
	if len(raw) == 0 {
		return errors.New("empty event payload")
	}
	return json.Unmarshal(raw, dest)
}

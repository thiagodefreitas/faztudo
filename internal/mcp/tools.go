package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/files"
	"github.com/thiagodefreitas/faztudo/internal/org"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

const (
	maxBodyBytes = 65536
	maxContext   = 50
	maxOptions   = 8

	maxAttachmentText = 64 << 10

	minChoices     = 2
	maxChoices     = 5
	maxChoiceBytes = 80
)

var optionKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

type postIn struct {
	Body     string `json:"body" jsonschema:"message text"`
	ThreadID string `json:"thread_id,omitempty" jsonschema:"optional id of a message in this channel"`
}

type askIn struct {
	Question string   `json:"question" jsonschema:"question for the human"`
	Options  []string `json:"options,omitempty" jsonschema:"optional short answers shown as buttons. 2 to 5 entries, each up to 80 bytes"`
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
	Options   []string `json:"options,omitempty"`
	RunID     string   `json:"run_id,omitempty"`
	// Attachments are set only on the message that started this run.
	Attachments []attachmentOut `json:"attachments,omitempty"`
}

// attachmentOut is a file attached to the trigger message. Small plain text
// files come with their content; anything else is described only, because
// the sandbox cannot see the upload directory.
type attachmentOut struct {
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
	Text        string `json:"text,omitempty"`
	Note        string `json:"note,omitempty"`
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
		// A collect run's mentions start nothing: it may not hand out work,
		// and runs started by a mention would bypass the request budget.
		out, err := h.post(ctx, grant, in.Body, in.ThreadID, nil, !h.collectRun(ctx, grant))
		return nil, out, err
	})
	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "ask_human",
		Description: "Post a question mentioning the human members. Optional options (2 to 5 short strings) show as lettered buttons and the answer arrives as a thread reply. Returns immediately and does not wait. Does not modify the work tree.",
		Annotations: hints,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, in askIn) (*sdkmcp.CallToolResult, messageOut, error) {
		out, err := h.ask(ctx, grant, in.Question, in.Options)
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
		Description: "Read recent messages from this run's channel. Limit must be from 1 to 50. The message that started this run lists its attached files, with the text of small plain-text ones.",
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
	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "read_thread",
		Description: "Read a whole thread, oldest first, from this run's channel or another channel of the same project. Limit must be from 1 to 100. Does not modify the work tree.",
		Annotations: hints,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, in threadIn) (*sdkmcp.CallToolResult, threadOut, error) {
		out, err := h.readThread(ctx, grant, in)
		return nil, out, err
	})
	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "search_messages",
		Description: "Search message text in this run's channel and the other channels of its project, newest first. Limit must be from 1 to 30. Does not modify the work tree.",
		Annotations: hints,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, in searchIn) (*sdkmcp.CallToolResult, searchOut, error) {
		out, err := h.searchMessages(ctx, grant, in)
		return nil, out, err
	})
	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "list_handoffs",
		Description: "List the work handed out for this run's request: who got it, the task, and the state and answer of the run it started. Does not modify the work tree.",
		Annotations: hints,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, _ emptyIn) (*sdkmcp.CallToolResult, handoffsOut, error) {
		out, err := h.listHandoffs(ctx, grant)
		return nil, out, err
	})
	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "delegate",
		Description: delegateDescription,
		Annotations: hints,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, in delegateIn) (*sdkmcp.CallToolResult, delegateOut, error) {
		out, err := h.delegate(ctx, grant, in)
		return nil, out, err
	})
}

// collectRun reports whether the grant's run is a collect run. A read error
// other than a missing record counts as one, so mentions fail closed.
func (h *Handler) collectRun(ctx context.Context, grant Grant) bool {
	run, err := h.store.Run(ctx, grant.RunID)
	if errors.Is(err, store.ErrNotFound) {
		return false
	} else if err != nil {
		return true
	}
	trigger, err := h.store.Message(ctx, run.TriggerMessageID)
	if errors.Is(err, store.ErrNotFound) {
		return false
	}
	return err != nil || trigger.CollectForRunID != ""
}

func (h *Handler) post(ctx context.Context, grant Grant, body, threadID string, choices []string, fanout bool) (messageOut, error) {
	msg, err := h.postMessage(ctx, grant, body, threadID, choices, fanout, nil)
	if err != nil {
		return messageOut{}, err
	}
	return messageView(msg), nil
}

// postMessage posts as the run's agent. handoff is set when the message hands
// work to another agent.
func (h *Handler) postMessage(ctx context.Context, grant Grant, body, threadID string, choices []string, fanout bool, handoff *domain.Handoff) (domain.Message, error) {
	if strings.TrimSpace(body) == "" {
		return domain.Message{}, errors.New("body required")
	}
	if len(body) > maxBodyBytes {
		return domain.Message{}, errors.New("body too long")
	}
	if h.PostAs != nil {
		author, err := h.store.Member(ctx, grant.AgentID)
		if err != nil {
			return domain.Message{}, err
		}
		msg, _, err := h.PostAs(ctx, events.Agent(grant.AgentID), author, api.PostInput{ChannelID: grant.ChannelID, Body: body, ThreadID: threadID, Options: choices, RunID: grant.RunID, Handoff: handoff, AgentMessage: true, Fanout: fanout})
		return msg, err
	}
	channel, err := h.store.Channel(ctx, grant.ChannelID)
	if err != nil {
		return domain.Message{}, errors.New("channel unavailable")
	}
	if threadID != "" {
		root, err := h.store.Message(ctx, threadID)
		if err != nil || root.ChannelID != grant.ChannelID {
			return domain.Message{}, errors.New("invalid thread_id")
		}
	}
	members, err := h.store.Members(ctx)
	if err != nil {
		return domain.Message{}, err
	}
	ids, agents := mentioned(body, members)
	msg := domain.Message{
		ID:        store.NewID(),
		ChannelID: grant.ChannelID,
		ThreadID:  threadID,
		AuthorID:  grant.AgentID,
		Body:      body,
		Mentions:  ids,
		Options:   choices,
		RunID:     grant.RunID,
		Handoff:   handoff,
		CreatedAt: time.Now().UTC(),
	}
	evt, err := h.store.Append(ctx, events.Draft{
		Type:      events.MessagePosted,
		Actor:     events.Agent(grant.AgentID),
		ChannelID: grant.ChannelID,
		Payload:   msg,
	})
	if err != nil {
		return domain.Message{}, err
	}
	if err := unmarshalPayload(evt.Payload, &msg); err != nil {
		return domain.Message{}, err
	}
	if fanout && h.trigger != nil {
		others := make([]domain.Member, 0, len(agents))
		for _, agent := range agents {
			if agent.ID != grant.AgentID {
				others = append(others, agent)
			}
		}
		// A project's channel only lets assigned agents act, as in the API.
		others, refusals := h.assignedOnly(ctx, channel.Name, others)
		for _, n := range refusals {
			_, _ = h.store.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, ChannelID: grant.ChannelID, Payload: n})
		}
		if len(others) > 0 {
			h.trigger.OnMessage(ctx, msg, others)
		}
	}
	return msg, nil
}

// assignedOnly filters agents by the project rule. If the org cannot be read
// it lets nobody through, so a store error never widens who may run.
func (h *Handler) assignedOnly(ctx context.Context, channel string, agents []domain.Member) ([]domain.Member, []events.NoticePayload) {
	if len(agents) == 0 {
		return agents, nil
	}
	projects, err := h.store.Projects(ctx)
	if err != nil {
		return nil, nil
	}
	departments, err := h.store.Departments(ctx)
	if err != nil {
		return nil, nil
	}
	return org.Gate(projects, departments, channel, agents)
}

// cleanChoices validates the optional answers of ask_human. No options is
// valid. One option, more than five, or an empty or long one is not.
func cleanChoices(options []string) ([]string, error) {
	if len(options) == 0 {
		return nil, nil
	}
	if len(options) < minChoices || len(options) > maxChoices {
		return nil, errors.New("options must have 2 to 5 entries")
	}
	out := make([]string, 0, len(options))
	for _, option := range options {
		option = strings.TrimSpace(option)
		if option == "" {
			return nil, errors.New("option must not be empty")
		}
		if len(option) > maxChoiceBytes {
			return nil, errors.New("option too long")
		}
		out = append(out, option)
	}
	return out, nil
}

func (h *Handler) ask(ctx context.Context, grant Grant, question string, options []string) (messageOut, error) {
	if strings.TrimSpace(question) == "" {
		return messageOut{}, errors.New("question required")
	}
	choices, err := cleanChoices(options)
	if err != nil {
		return messageOut{}, err
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
	return h.post(ctx, grant, b.String(), "", choices, false)
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
	trigger := ""
	if run, err := h.store.Run(ctx, grant.RunID); err == nil {
		trigger = run.TriggerMessageID
	}
	out := messagesOut{Messages: make([]messageOut, 0, len(msgs))}
	for _, msg := range msgs {
		view := messageView(msg)
		if trigger != "" && msg.ID == trigger {
			view.Attachments = h.attachmentViews(msg.Attachments)
		}
		out.Messages = append(out.Messages, view)
	}
	return out, nil
}

// attachmentViews describes the trigger message's files. It reads only ids
// that the message itself lists, and only as files in the upload directory.
func (h *Handler) attachmentViews(list []domain.Attachment) []attachmentOut {
	var out []attachmentOut
	for _, att := range list {
		view := attachmentOut{Name: att.Name, ContentType: att.ContentType, Size: att.Size}
		switch {
		case h.FilesDir == "":
			view.Note = "uploads are not available"
		case att.Size > maxAttachmentText:
			view.Note = "too large to show here"
		default:
			f, err := files.Store{Dir: h.FilesDir}.Open(att.ID)
			if err != nil {
				view.Note = "file is missing"
				break
			}
			data, err := io.ReadAll(io.LimitReader(f, maxAttachmentText+1))
			f.Close()
			if err == nil && int64(len(data)) <= maxAttachmentText && files.IsText(data) {
				view.Text = string(data)
			} else {
				view.Note = "not plain text, so not shown"
			}
		}
		out = append(out, view)
	}
	return out
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
		Options:   msg.Options,
		RunID:     msg.RunID,
	}
}

func unmarshalPayload(raw []byte, dest any) error {
	if len(raw) == 0 {
		return errors.New("empty event payload")
	}
	return json.Unmarshal(raw, dest)
}

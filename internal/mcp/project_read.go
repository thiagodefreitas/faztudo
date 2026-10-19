package mcp

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/org"
)

const (
	maxThreadLimit    = 100
	maxSearchLimit    = 30
	maxToolBytes      = 30 << 10 // one tool call never returns more than this
	maxThreadBodyRune = 4000
	maxSearchBodyRune = 400
	maxHandoffRunes   = 2000
	maxTaskLineRunes  = 200
	maxDoneWhenRunes  = 500
)

type threadIn struct {
	ThreadID string `json:"thread_id" jsonschema:"id of the thread root, or of any message in the thread"`
	Limit    int    `json:"limit,omitempty" jsonschema:"how many messages to return, oldest first. 0 means 100. Maximum 100"`
}

type threadOut struct {
	Messages  []messageOut `json:"messages"`
	Truncated bool         `json:"truncated,omitempty"`
}

type searchIn struct {
	Query string `json:"query" jsonschema:"words to look for in message text"`
	Limit int    `json:"limit,omitempty" jsonschema:"how many hits to return, newest first. 0 means 30. Maximum 30"`
}

type searchHitOut struct {
	Channel  string `json:"channel"`
	ID       string `json:"id"`
	ThreadID string `json:"thread_id,omitempty"`
	Author   string `json:"author"`
	At       string `json:"at"`
	Body     string `json:"body"`
}

type searchOut struct {
	Hits []searchHitOut `json:"hits"`
}

type handoffOut struct {
	To       string `json:"to"`
	Task     string `json:"task"`
	RunID    string `json:"run_id,omitempty"`
	RunState string `json:"run_state,omitempty"`
	Answer   string `json:"answer,omitempty"`
}

type handoffsOut struct {
	Handoffs  []handoffOut `json:"handoffs"`
	Truncated bool         `json:"truncated,omitempty"`
}

// readableChannels is the one place that decides which channels a run may
// read with the project tools. The run's own channel always counts. When that
// channel belongs to a project, so do the project's other channels, except a
// private or direct channel the agent is not a member of. A channel of any
// other project is never included, and neither is a direct channel the agent
// is not in. For an archived project only the run's own channel is readable,
// and search skips it too.
func (h *Handler) readableChannels(ctx context.Context, grant Grant, forSearch bool) (map[string]domain.Channel, error) {
	own, err := h.store.Channel(ctx, grant.ChannelID)
	if err != nil {
		return nil, errors.New("channel unavailable")
	}
	out := map[string]domain.Channel{}
	projects, err := h.store.Projects(ctx)
	if err != nil {
		return nil, err
	}
	project, inProject := org.ProjectOfChannel(projects, own.Name)
	if inProject && project.Archived && forSearch {
		return out, nil
	}
	out[own.ID] = own
	if !inProject || project.Archived {
		return out, nil
	}
	all, err := h.store.Channels(ctx)
	if err != nil {
		return nil, err
	}
	for _, c := range all {
		if c.ID == own.ID || !org.ContainsFold(project.Channels, c.Name) {
			continue
		}
		if (c.Visibility == domain.VisibilityPublic && c.Kind != domain.ChannelDirect) || memberOf(c, grant.AgentID) {
			out[c.ID] = c
		}
	}
	return out, nil
}

func memberOf(c domain.Channel, id string) bool {
	for _, m := range c.MemberIDs {
		if m == id {
			return true
		}
	}
	return false
}

// clipRunes cuts s to at most n runes and marks the cut.
func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "..."
}

func firstLine(s string, n int) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return clipRunes(strings.TrimSpace(s), n)
}

func (h *Handler) readThread(ctx context.Context, grant Grant, in threadIn) (threadOut, error) {
	limit := in.Limit
	if limit == 0 {
		limit = maxThreadLimit
	}
	if limit < 1 || limit > maxThreadLimit {
		return threadOut{}, errors.New("limit must be from 1 to 100")
	}
	channels, err := h.readableChannels(ctx, grant, false)
	if err != nil {
		return threadOut{}, err
	}
	// One error for a missing message and for one outside the scope, so the
	// answer does not reveal what exists elsewhere.
	errGone := errors.New("thread not found")
	msg, err := h.store.Message(ctx, strings.TrimSpace(in.ThreadID))
	if err != nil {
		return threadOut{}, errGone
	}
	if _, ok := channels[msg.ChannelID]; !ok {
		return threadOut{}, errGone
	}
	root := msg.ID
	if msg.ThreadID != "" {
		root = msg.ThreadID
	}
	thread, err := h.store.Thread(ctx, root)
	if err != nil {
		return threadOut{}, err
	}
	out := threadOut{Messages: []messageOut{}}
	used := 0
	for _, m := range thread {
		if m.ChannelID != msg.ChannelID {
			continue
		}
		if len(out.Messages) == limit {
			out.Truncated = true
			break
		}
		view := messageView(m)
		view.Body = clipRunes(view.Body, maxThreadBodyRune)
		used += len(view.Body) + 200
		if used > maxToolBytes {
			out.Truncated = true
			break
		}
		out.Messages = append(out.Messages, view)
	}
	return out, nil
}

func (h *Handler) searchMessages(ctx context.Context, grant Grant, in searchIn) (searchOut, error) {
	limit := in.Limit
	if limit == 0 {
		limit = maxSearchLimit
	}
	if limit < 1 || limit > maxSearchLimit {
		return searchOut{}, errors.New("limit must be from 1 to 30")
	}
	if strings.TrimSpace(in.Query) == "" {
		return searchOut{}, errors.New("query required")
	}
	if len(in.Query) > 200 {
		return searchOut{}, errors.New("query too long")
	}
	channels, err := h.readableChannels(ctx, grant, true)
	if err != nil {
		return searchOut{}, err
	}
	var hits []domain.Message
	for id := range channels {
		found, err := h.store.Search(ctx, in.Query, id, 100)
		if err != nil {
			return searchOut{}, err
		}
		for _, hit := range found {
			hits = append(hits, hit.Message)
		}
	}
	sort.Slice(hits, func(i, j int) bool {
		if !hits[i].CreatedAt.Equal(hits[j].CreatedAt) {
			return hits[i].CreatedAt.After(hits[j].CreatedAt)
		}
		return hits[i].ID > hits[j].ID
	})
	handles := h.handles(ctx)
	out := searchOut{Hits: []searchHitOut{}}
	used := 0
	for _, m := range hits {
		if len(out.Hits) == limit {
			break
		}
		hit := searchHitOut{
			Channel:  channels[m.ChannelID].Name,
			ID:       m.ID,
			ThreadID: m.ThreadID,
			Author:   handles[m.AuthorID],
			At:       m.CreatedAt.UTC().Format(time.RFC3339),
			Body:     clipRunes(m.Body, maxSearchBodyRune),
		}
		if hit.Author == "" {
			hit.Author = m.AuthorID
		}
		used += len(hit.Body) + 300
		if used > maxToolBytes {
			break
		}
		out.Hits = append(out.Hits, hit)
	}
	return out, nil
}

// handles maps member ids to handles.
func (h *Handler) handles(ctx context.Context) map[string]string {
	out := map[string]string{}
	members, err := h.store.Members(ctx)
	if err != nil {
		return out
	}
	for _, m := range members {
		out[m.ID] = m.Handle
	}
	return out
}

// listHandoffs shows the handoffs of this run's request: every message in the
// request's thread that carries the same request id, with the run each one
// started.
func (h *Handler) listHandoffs(ctx context.Context, grant Grant) (handoffsOut, error) {
	run, err := h.store.Run(ctx, grant.RunID)
	if err != nil {
		return handoffsOut{}, errors.New("run unavailable")
	}
	trigger, err := h.store.Message(ctx, run.TriggerMessageID)
	if err != nil {
		return handoffsOut{}, errors.New("request unavailable")
	}
	request, root := trigger.ID, trigger.ID
	if trigger.ThreadID != "" {
		root = trigger.ThreadID
	}
	if trigger.Handoff != nil {
		request = trigger.Handoff.RequestID
	}
	thread, err := h.store.Thread(ctx, root)
	if err != nil {
		return handoffsOut{}, err
	}
	runs, err := h.store.Runs(ctx, trigger.ChannelID, "")
	if err != nil {
		return handoffsOut{}, err
	}
	runOf := map[string]domain.Run{} // later runs (retries) replace earlier ones
	for _, r := range runs {
		runOf[r.TriggerMessageID] = r
	}
	answers := map[string]string{}
	for _, m := range thread {
		if m.RunID != "" {
			answers[m.RunID] = m.Body
		}
	}
	out := handoffsOut{Handoffs: []handoffOut{}}
	used := 0
	for _, m := range thread {
		if m.Handoff == nil || m.Handoff.RequestID != request || m.ChannelID != trigger.ChannelID {
			continue
		}
		item := handoffOut{To: m.Handoff.To, Task: firstLine(strings.TrimPrefix(m.Body, "@"+m.Handoff.To), maxTaskLineRunes)}
		if r, ok := runOf[m.ID]; ok {
			item.RunID, item.RunState = r.ID, string(r.State)
			if r.State == domain.RunDone {
				item.Answer = clipRunes(answers[r.ID], maxHandoffRunes)
			}
		}
		used += len(item.Answer) + len(item.Task) + 200
		if used > maxToolBytes {
			out.Truncated = true
			break
		}
		out.Handoffs = append(out.Handoffs, item)
	}
	return out, nil
}

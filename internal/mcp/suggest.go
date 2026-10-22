package mcp

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

const (
	// MaxSuggestionsPerRun is how many suggestions one scout run may file.
	MaxSuggestionsPerRun = 5
	maxSuggestionTitle   = 120
	maxSuggestionDetail  = 2000
	maxEvidenceItems     = 10
	maxEvidenceBytes     = 300
)

type suggestIn struct {
	Title    string   `json:"title" jsonschema:"what to do, in up to 120 characters"`
	Detail   string   `json:"detail" jsonschema:"why it matters and what a fix looks like, markdown, up to 2000 characters"`
	Evidence []string `json:"evidence" jsonschema:"links or file:line references that show the problem. 1 to 10 entries, each up to 300 bytes"`
}

type suggestOut struct {
	ID        string `json:"id"`
	Remaining int    `json:"remaining"`
}

// htmlMarkup finds an HTML tag or comment start. A plain "a < b" passes.
var htmlMarkup = regexp.MustCompile(`<(!--|/?[A-Za-z])`)

// scoutRun reports whether the grant's run was started by a routine whose
// template is "scout". It looks at the trigger message of the run on the
// server, so an agent cannot claim it. Any read error counts as no.
func (h *Handler) scoutRun(ctx context.Context, grant Grant) bool {
	run, err := h.store.Run(ctx, grant.RunID)
	if err != nil {
		return false
	}
	trigger, err := h.store.Message(ctx, run.TriggerMessageID)
	if err != nil || trigger.Routine == "" {
		return false
	}
	routine, err := h.store.Routine(ctx, trigger.Routine)
	return err == nil && routine.Template == "scout"
}

// suggest files one suggestion for the Director. It creates no task, message
// or approval.
func (h *Handler) suggest(ctx context.Context, grant Grant, in suggestIn) (suggestOut, error) {
	if !h.scoutRun(ctx, grant) {
		return suggestOut{}, errors.New("suggest is only for runs started by a scout routine")
	}
	title := strings.TrimSpace(in.Title)
	detail := strings.TrimSpace(in.Detail)
	switch {
	case title == "":
		return suggestOut{}, errors.New("title required")
	case utf8.RuneCountInString(title) > maxSuggestionTitle:
		return suggestOut{}, errors.New("title longer than 120 characters")
	case utf8.RuneCountInString(detail) > maxSuggestionDetail:
		return suggestOut{}, errors.New("detail longer than 2000 characters")
	case htmlMarkup.MatchString(title) || htmlMarkup.MatchString(detail):
		// The inbox hides raw HTML, but a task made from the suggestion would
		// pass it to an agent: text the Director never saw.
		return suggestOut{}, errors.New("no HTML tags or comments in a suggestion; write plain markdown")
	}
	evidence := make([]string, 0, len(in.Evidence))
	for _, item := range in.Evidence {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if len(item) > maxEvidenceBytes {
			return suggestOut{}, errors.New("an evidence entry is longer than 300 bytes")
		}
		evidence = append(evidence, item)
	}
	if len(evidence) == 0 {
		return suggestOut{}, errors.New("evidence required: give a link or file:line")
	}
	if len(evidence) > maxEvidenceItems {
		return suggestOut{}, errors.New("too many evidence entries")
	}
	agent, err := h.store.Member(ctx, grant.AgentID)
	if err != nil {
		return suggestOut{}, err
	}
	v := domain.Suggestion{ID: store.NewID(), ChannelID: grant.ChannelID, Persona: agent.Handle, RunID: grant.RunID, Title: title, Detail: detail, Evidence: evidence, State: domain.SuggestionOpen, CreatedAt: time.Now().UTC()}
	if _, err := h.store.FileSuggestion(ctx, v, MaxSuggestionsPerRun, events.Agent(grant.AgentID)); err != nil {
		if errors.Is(err, store.ErrSuggestionCap) {
			return suggestOut{}, errors.New("this run already filed 5 suggestions; no more are accepted")
		}
		return suggestOut{}, err
	}
	filed, err := h.store.Suggestions(ctx, grant.ChannelID, "")
	remaining := MaxSuggestionsPerRun
	if err == nil {
		for _, s := range filed {
			if s.RunID == grant.RunID {
				remaining--
			}
		}
	}
	return suggestOut{ID: v.ID, Remaining: remaining}, nil
}

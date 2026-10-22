package api

import (
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/tasks"
)

// maxDismissReason leaves room for the "Do not suggest: " prefix in a lesson,
// which holds 500 characters.
const maxDismissReason = 400

func (a *API) listSuggestions(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "read suggestions") {
		return
	}
	state := domain.SuggestionState(r.URL.Query().Get("state"))
	switch state {
	case "", domain.SuggestionOpen, domain.SuggestionAccepted, domain.SuggestionDismissed:
	default:
		fail(w, 400, "bad_request", "state must be open, accepted or dismissed")
		return
	}
	channelID := r.URL.Query().Get("channel_id")
	if channelID != "" && !a.canSee(r.Context(), current(r).ID, channelID) {
		fail(w, 404, "not_found", "channel not found")
		return
	}
	list, err := a.Store.Suggestions(r.Context(), channelID, state)
	if err != nil {
		failErr(w, err)
		return
	}
	out := make([]domain.Suggestion, 0, len(list))
	for _, v := range list {
		if a.canSee(r.Context(), current(r).ID, v.ChannelID) {
			out = append(out, v)
		}
	}
	respond(w, 200, out)
}

// openSuggestion loads a suggestion the caller can see and that is still open.
func (a *API) openSuggestion(w http.ResponseWriter, r *http.Request) (domain.Suggestion, bool) {
	v, err := a.Store.Suggestion(r.Context(), r.PathValue("id"))
	if err != nil {
		failErr(w, err)
		return v, false
	}
	if !a.canSee(r.Context(), current(r).ID, v.ChannelID) {
		fail(w, 404, "not_found", "suggestion not found")
		return v, false
	}
	if v.State != domain.SuggestionOpen {
		fail(w, 409, "conflict", "suggestion is already "+string(v.State))
		return v, false
	}
	return v, true
}

// acceptSuggestion makes a task in the suggestion's channel, filled in from
// the suggestion, and marks it accepted. The task waits in Todo; nothing runs.
func (a *API) acceptSuggestion(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "accept suggestions") {
		return
	}
	var req struct {
		Assignee string `json:"assignee"`
	}
	if r.ContentLength != 0 && !decode(w, r, &req) {
		return
	}
	a.suggestionMu.Lock()
	defer a.suggestionMu.Unlock()
	v, ok := a.openSuggestion(w, r)
	if !ok {
		return
	}
	assignee := strings.TrimSpace(req.Assignee)
	if assignee == "" {
		assignee = v.Persona
	}
	body := v.Detail
	if len(v.Evidence) > 0 {
		body += "\n\nEvidence:\n- " + strings.Join(v.Evidence, "\n- ")
	}
	task, err := a.Tasks.CreateTask(r.Context(), current(r), v.ChannelID, tasks.Input{Title: v.Title, Body: strings.TrimSpace(body), Assignee: assignee})
	if err != nil {
		taskFail(w, err, 400, "bad_request")
		return
	}
	now := time.Now().UTC()
	v.State, v.ResolvedBy, v.ResolvedAt, v.TaskID = domain.SuggestionAccepted, current(r).ID, &now, task.ID
	if err := a.Store.ResolveSuggestion(r.Context(), v, events.Human(current(r).ID)); err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, v)
}

// dismissSuggestion closes a suggestion. A reason also becomes a lesson for the
// persona that filed it, scoped to the suggestion's channel, so the scout
// learns what not to suggest.
func (a *API) dismissSuggestion(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "dismiss suggestions") {
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	if r.ContentLength != 0 && !decode(w, r, &req) {
		return
	}
	reason := strings.Join(strings.Fields(req.Reason), " ")
	if utf8.RuneCountInString(reason) > maxDismissReason {
		fail(w, 400, "bad_request", "reason must be at most 400 characters")
		return
	}
	a.suggestionMu.Lock()
	defer a.suggestionMu.Unlock()
	v, ok := a.openSuggestion(w, r)
	if !ok {
		return
	}
	now := time.Now().UTC()
	v.State, v.ResolvedBy, v.ResolvedAt, v.Reason = domain.SuggestionDismissed, current(r).ID, &now, reason
	if err := a.Store.ResolveSuggestion(r.Context(), v, events.Human(current(r).ID)); err != nil {
		failErr(w, err)
		return
	}
	if reason != "" {
		lesson := domain.Lesson{ID: store.NewID(), Persona: v.Persona, ChannelID: v.ChannelID, Text: "Do not suggest: " + reason, CreatedBy: current(r).ID, CreatedAt: now, UpdatedAt: now}
		if _, err := a.Store.Append(r.Context(), events.Draft{Type: events.LessonAdded, Actor: events.Human(current(r).ID), ChannelID: lesson.ChannelID, Payload: lesson}); err != nil {
			failErr(w, err)
			return
		}
	}
	respond(w, 200, v)
}

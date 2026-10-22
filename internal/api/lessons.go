package api

import (
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func lessonText(s string) (string, bool) {
	s = strings.TrimSpace(s)
	return s, utf8.RuneCountInString(s) >= 1 && utf8.RuneCountInString(s) <= 500
}

func (a *API) lessonChannelVisible(w http.ResponseWriter, r *http.Request, id string) bool {
	if id == "" || a.canSee(r.Context(), current(r).ID, id) {
		return true
	}
	fail(w, 404, "not_found", "channel not found")
	return false
}

func (a *API) lessons(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "read lessons") {
		return
	}
	v, err := a.Store.Lessons(r.Context(), r.URL.Query().Get("persona"))
	if err != nil {
		failErr(w, err)
		return
	}
	out := make([]domain.Lesson, 0, len(v))
	for _, lesson := range v {
		if lesson.ChannelID == "" || a.canSee(r.Context(), current(r).ID, lesson.ChannelID) {
			out = append(out, lesson)
		}
	}
	respond(w, 200, out)
}

func (a *API) createLesson(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "create lessons") {
		return
	}
	var req struct {
		Persona         string `json:"persona"`
		Text            string `json:"text"`
		ChannelID       string `json:"channel_id"`
		SourceMessageID string `json:"source_message_id"`
	}
	if !decode(w, r, &req) {
		return
	}
	member, err := a.Store.MemberByHandle(r.Context(), req.Persona)
	if errors.Is(err, store.ErrNotFound) || (err == nil && member.Kind != domain.MemberAgent) {
		fail(w, 400, "bad_request", "unknown persona")
		return
	}
	if err != nil {
		failErr(w, err)
		return
	}
	value, ok := lessonText(req.Text)
	if !ok {
		fail(w, 400, "bad_request", "text must be 1 to 500 characters")
		return
	}
	if !a.lessonChannelVisible(w, r, req.ChannelID) {
		return
	}
	if req.SourceMessageID != "" {
		message, err := a.Store.Message(r.Context(), req.SourceMessageID)
		if err != nil || !a.canSee(r.Context(), current(r).ID, message.ChannelID) || (req.ChannelID != "" && req.ChannelID != message.ChannelID) {
			fail(w, 404, "not_found", "source message not found")
			return
		}
		if req.ChannelID == "" {
			channel, err := a.Store.Channel(r.Context(), message.ChannelID)
			if err != nil || channel.Visibility != domain.VisibilityPublic {
				fail(w, 400, "bad_request", "global lesson needs a public source message")
				return
			}
		}
	}
	now := time.Now().UTC()
	v := domain.Lesson{ID: store.NewID(), Persona: member.Handle, ChannelID: req.ChannelID, Text: value, SourceMessageID: req.SourceMessageID, CreatedBy: current(r).ID, CreatedAt: now, UpdatedAt: now}
	if _, ok := a.append(w, r, events.Human(current(r).ID), events.LessonAdded, v.ChannelID, "", v); !ok {
		return
	}
	respond(w, 201, v)
}

func (a *API) patchLesson(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "edit lessons") {
		return
	}
	v, err := a.Store.Lesson(r.Context(), r.PathValue("id"))
	if err != nil {
		failErr(w, err)
		return
	}
	if !a.lessonChannelVisible(w, r, v.ChannelID) {
		return
	}
	before := v
	var req struct {
		Text      *string `json:"text"`
		ChannelID *string `json:"channel_id"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Text != nil {
		var ok bool
		v.Text, ok = lessonText(*req.Text)
		if !ok {
			fail(w, 400, "bad_request", "text must be 1 to 500 characters")
			return
		}
	}
	if req.ChannelID != nil {
		if !a.lessonChannelVisible(w, r, *req.ChannelID) {
			return
		}
		if v.ChannelID != *req.ChannelID {
			v.SourceMessageID = ""
		}
		v.ChannelID = *req.ChannelID
	}
	if req.Text == nil && req.ChannelID == nil {
		fail(w, 400, "bad_request", "text or channel_id required")
		return
	}
	v.UpdatedAt = time.Now().UTC()
	if err := a.Store.UpdateLesson(r.Context(), before, v, events.Human(current(r).ID)); err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, v)
}

func (a *API) deleteLesson(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "delete lessons") {
		return
	}
	v, err := a.Store.Lesson(r.Context(), r.PathValue("id"))
	if err != nil {
		failErr(w, err)
		return
	}
	if !a.lessonChannelVisible(w, r, v.ChannelID) {
		return
	}
	if err := a.Store.RemoveLesson(r.Context(), v, events.Human(current(r).ID)); err != nil {
		failErr(w, err)
		return
	}
	w.WriteHeader(204)
}

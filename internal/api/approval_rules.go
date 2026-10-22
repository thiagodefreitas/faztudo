package api

import (
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func (a *API) listApprovalRules(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "read approval rules") {
		return
	}
	channelID := r.URL.Query().Get("channel_id")
	if channelID != "" && !a.canSee(r.Context(), current(r).ID, channelID) {
		fail(w, 404, "not_found", "channel not found")
		return
	}
	rules, err := a.Store.ApprovalRules(r.Context(), channelID)
	if err != nil {
		failErr(w, err)
		return
	}
	visible := make([]domain.ApprovalRule, 0, len(rules))
	for _, rule := range rules {
		if a.canSee(r.Context(), current(r).ID, rule.ChannelID) {
			visible = append(visible, rule)
		}
	}
	respond(w, 200, visible)
}

func validApprovalGlob(glob string) bool {
	if glob == "" || strings.HasPrefix(glob, "/") || strings.Contains(glob, "\\") || strings.Contains(glob, "\x00") {
		return false
	}
	for _, segment := range strings.Split(glob, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	pattern := glob
	if strings.HasSuffix(pattern, "/**") {
		pattern = strings.TrimSuffix(pattern, "/**")
	}
	_, err := path.Match(pattern, "example")
	return err == nil
}

func (a *API) createApprovalRule(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "create approval rules") {
		return
	}
	var req struct {
		ChannelID string   `json:"channel_id"`
		Persona   string   `json:"persona"`
		Paths     []string `json:"paths"`
		MaxLines  int      `json:"max_lines"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.ChannelID == "" || !a.canSee(r.Context(), current(r).ID, req.ChannelID) {
		fail(w, 404, "not_found", "channel not found")
		return
	}
	if req.MaxLines < 1 || req.MaxLines > 2000 {
		fail(w, 400, "bad_request", "max_lines must be 1 to 2000")
		return
	}
	for _, glob := range req.Paths {
		if !validApprovalGlob(glob) {
			fail(w, 400, "bad_request", "invalid path glob")
			return
		}
	}
	if req.Persona != "" {
		members, err := a.Store.Members(r.Context())
		if err != nil {
			failErr(w, err)
			return
		}
		found := false
		for _, member := range members {
			if member.Kind == domain.MemberAgent && member.Handle == req.Persona {
				found = true
				break
			}
		}
		if !found {
			fail(w, 400, "bad_request", "unknown persona")
			return
		}
	}
	if req.Paths == nil {
		req.Paths = []string{}
	}
	rule := domain.ApprovalRule{ID: store.NewID(), ChannelID: req.ChannelID, Persona: req.Persona, Paths: req.Paths, MaxLines: req.MaxLines, CreatedBy: current(r).ID, CreatedAt: time.Now().UTC()}
	if _, err := a.Store.Append(r.Context(), events.Draft{Type: events.ApprovalRuleCreated, Actor: events.Human(current(r).ID), ChannelID: rule.ChannelID, Payload: rule}); err != nil {
		failErr(w, err)
		return
	}
	respond(w, 201, rule)
}

func (a *API) deleteApprovalRule(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "remove approval rules") {
		return
	}
	rule, err := a.Store.ApprovalRule(r.Context(), r.PathValue("id"))
	if err != nil {
		failErr(w, err)
		return
	}
	if !a.canSee(r.Context(), current(r).ID, rule.ChannelID) {
		fail(w, 404, "not_found", "rule not found")
		return
	}
	if _, err := a.Store.Append(r.Context(), events.Draft{Type: events.ApprovalRuleRemoved, Actor: events.Human(current(r).ID), ChannelID: rule.ChannelID, Payload: rule}); err != nil {
		failErr(w, err)
		return
	}
	w.WriteHeader(204)
}

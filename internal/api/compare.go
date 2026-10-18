package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

type CompareCandidate struct {
	LaneID     string      `json:"lane_id"`
	Run        *domain.Run `json:"run,omitempty"`
	OutputTail []string    `json:"output_tail,omitempty"`
}

type CompareGroup struct {
	ID         string              `json:"id"`
	ChannelID  string              `json:"channel_id"`
	MessageID  string              `json:"message_id"`
	AgentID    string              `json:"agent_id"`
	Candidates [2]CompareCandidate `json:"candidates"`
	Decision   string              `json:"decision,omitempty"`
	WinnerLane string              `json:"winner_lane,omitempty"`
	// CombineMessageID is the request message of a combine decision.
	CombineMessageID string `json:"combine_message_id,omitempty"`
}

type CompareControl interface {
	CompareList(context.Context, string) ([]CompareGroup, error)
	CompareDecide(context.Context, string, string, string, string) (CompareGroup, error)
}

func (a *API) compares(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !a.canSee(r.Context(), current(r).ID, id) {
		fail(w, 404, "not_found", "channel not found")
		return
	}
	if a.Compare == nil {
		respond(w, 200, []CompareGroup{})
		return
	}
	groups, err := a.Compare.CompareList(r.Context(), id)
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, groups)
}

func (a *API) decideCompare(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "decide a comparison") {
		return
	}
	id := r.PathValue("id")
	if !a.canSee(r.Context(), current(r).ID, id) {
		fail(w, 404, "not_found", "channel not found")
		return
	}
	if a.Compare == nil {
		fail(w, 503, "unavailable", "comparison is unavailable")
		return
	}
	var body struct {
		Decision string `json:"decision"`
	}
	if !decode(w, r, &body) {
		return
	}
	switch body.Decision {
	case "merge_a", "merge_b", "discard_both", "combine":
	default:
		fail(w, 400, "bad_request", "invalid comparison decision")
		return
	}
	group, err := a.Compare.CompareDecide(r.Context(), id, r.PathValue("compare"), body.Decision, current(r).ID)
	if err != nil {
		var user domain.UserError
		if errors.Is(err, store.ErrNotFound) {
			fail(w, 404, "not_found", "comparison not found")
		} else if errors.As(err, &user) {
			fail(w, 409, "conflict", user.Message)
		} else {
			failErr(w, err)
		}
		return
	}
	respond(w, 200, group)
}

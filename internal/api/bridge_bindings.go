package api

import (
	"net/http"
	"sort"

	"github.com/thiagodefreitas/faztudo/internal/store"
)

type bridgeBindingView struct {
	Conversation   string `json:"conversation"`
	Recipients     string `json:"recipients"`
	OutboundAgents string `json:"outbound_agents"`
}

func (a *API) bridgeBindingChannel(r *http.Request, conversation string) string {
	configured := a.SignalBindings[conversation]
	if configured == "" {
		return ""
	}
	channels, err := a.Store.Channels(r.Context())
	if err != nil {
		return ""
	}
	for _, channel := range channels {
		if configured == channel.ID || configured == channel.Name {
			return channel.ID
		}
	}
	return ""
}

func (a *API) bridgeBindings(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "read bridge settings") {
		return
	}
	channelID := r.PathValue("id")
	if !a.canSee(r.Context(), current(r).ID, channelID) {
		fail(w, 404, "not_found", "channel not found")
		return
	}
	out := []bridgeBindingView{}
	for conversation := range a.SignalBindings {
		if a.bridgeBindingChannel(r, conversation) != channelID {
			continue
		}
		policy, err := a.Store.BridgeAgentPolicy(r.Context(), "signal", conversation, channelID)
		if err != nil {
			failErr(w, err)
			return
		}
		out = append(out, bridgeBindingView{conversation, conversation, policy})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Conversation < out[j].Conversation })
	respond(w, 200, out)
}

func (a *API) patchBridgeBinding(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "change bridge settings") {
		return
	}
	conversation := r.PathValue("conversation")
	if !a.canSee(r.Context(), current(r).ID, r.PathValue("id")) || a.bridgeBindingChannel(r, conversation) != r.PathValue("id") {
		fail(w, 404, "not_found", "binding not found")
		return
	}
	var req struct {
		OutboundAgents string `json:"outbound_agents"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.OutboundAgents != "send" && req.OutboundAgents != "draft" && req.OutboundAgents != "off" {
		fail(w, 400, "bad_request", "outbound_agents must be send, draft, or off")
		return
	}
	if err := a.Store.SetBridgeAgentPolicy(r.Context(), "signal", conversation, r.PathValue("id"), req.OutboundAgents); err != nil {
		if err == store.ErrInvalidOption {
			fail(w, 400, "bad_request", "invalid policy")
		} else {
			failErr(w, err)
		}
		return
	}
	respond(w, 200, bridgeBindingView{conversation, conversation, req.OutboundAgents})
}

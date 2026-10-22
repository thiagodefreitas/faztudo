package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestBridgeBindingPolicyAndDraftAPIAuth(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	human := domain.Member{ID: "human", Kind: domain.MemberHuman, Handle: "human"}
	agent := domain.Member{ID: "agent", Kind: domain.MemberAgent, Handle: "agent"}
	outsider := domain.Member{ID: "outsider", Kind: domain.MemberHuman, Handle: "outsider"}
	for _, member := range []domain.Member{human, agent, outsider} {
		if _, err := s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: member}); err != nil {
			t.Fatal(err)
		}
	}
	channel := domain.Channel{ID: "private", Name: "private", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPrivate, MemberIDs: []string{human.ID, agent.ID}}
	if _, err := s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: channel.ID, Payload: channel}); err != nil {
		t.Fatal(err)
	}
	a := newTestAPI(s, human.ID, "test")
	a.SignalBindings = map[string]string{"group:people": channel.ID}
	request := func(method, url, body string, member domain.Member, handler http.HandlerFunc, id string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, url, strings.NewReader(body)).WithContext(context.WithValue(ctx, actorKey{}, member))
		r.Header.Set("Content-Type", "application/json")
		r.SetPathValue("id", id)
		r.SetPathValue("conversation", "group:people")
		w := httptest.NewRecorder()
		handler(w, r)
		return w
	}
	patch := `{"outbound_agents":"send"}`
	for _, member := range []domain.Member{agent, outsider} {
		want := 403
		if member.ID == outsider.ID {
			want = 404
		}
		if got := request("PATCH", "/", patch, member, a.patchBridgeBinding, channel.ID).Code; got != want {
			t.Fatalf("%s patch: %d", member.ID, got)
		}
	}
	if got := request("PATCH", "/", `{"outbound_agents":"invalid"}`, human, a.patchBridgeBinding, channel.ID).Code; got != 400 {
		t.Fatalf("invalid policy: %d", got)
	}
	if got := request("PATCH", "/", patch, human, a.patchBridgeBinding, channel.ID).Code; got != 200 {
		t.Fatalf("human patch: %d", got)
	}
	if got, err := s.BridgeAgentPolicy(ctx, "signal", "group:people", channel.ID); err != nil || got != "send" {
		t.Fatalf("saved policy: %s %v", got, err)
	}
	if got := request("GET", "/", "", agent, a.bridgeBindings, channel.ID).Code; got != 403 {
		t.Fatalf("agent list: %d", got)
	}
	if got := request("GET", "/", "", outsider, a.bridgeBindings, channel.ID).Code; got != 404 {
		t.Fatalf("outsider list: %d", got)
	}

	draft := domain.Approval{ID: store.NewID(), ChannelID: channel.ID, RequestedBy: agent.ID, Title: "Send?", State: domain.ApprovalPending, Options: []domain.ApprovalOption{{Key: "send"}, {Key: "edit_send"}, {Key: "dont_send"}}, SignalDraft: &domain.SignalDraft{Conversation: "group:people", MessageID: "message", Text: "original", Recipients: "group:people"}}
	if _, err := s.Append(ctx, events.Draft{Type: events.ApprovalRequested, Actor: events.System, ChannelID: channel.ID, Payload: draft}); err != nil {
		t.Fatal(err)
	}
	if got := request("POST", "/", `{"option":"edit_send","text":"edited"}`, agent, a.resolve, draft.ID).Code; got != 403 {
		t.Fatalf("agent resolve: %d", got)
	}
	if got := request("POST", "/", `{"option":"send"}`, outsider, a.resolve, draft.ID).Code; got != 403 {
		t.Fatalf("other human resolve: %d", got)
	}
	if got := request("POST", "/", `{"option":"edit_send","text":""}`, human, a.resolve, draft.ID).Code; got != 400 {
		t.Fatalf("empty edit: %d", got)
	}
	if got := request("POST", "/", `{"option":"edit_send","text":"edited"}`, human, a.resolve, draft.ID).Code; got != 200 {
		t.Fatalf("human edit: %d", got)
	}
	got, err := s.Approval(ctx, draft.ID)
	if err != nil || got.Resolution == nil || got.Resolution.Note != "edited" {
		t.Fatalf("recorded edit: %+v %v", got, err)
	}
	if got := request("POST", "/", `{"option":"send"}`, human, a.resolve, draft.ID).Code; got != 409 {
		t.Fatalf("repeat send: %d", got)
	}
}

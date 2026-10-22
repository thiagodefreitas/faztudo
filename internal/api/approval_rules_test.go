package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestApprovalRuleAPIAuthAndVisibility(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	owner := domain.Member{ID: "owner", Kind: domain.MemberHuman, Handle: "owner"}
	outsider := domain.Member{ID: "outsider", Kind: domain.MemberHuman, Handle: "outsider"}
	agent := domain.Member{ID: "agent", Kind: domain.MemberAgent, Handle: "coder"}
	for _, member := range []domain.Member{owner, outsider, agent} {
		if _, err := s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: member}); err != nil {
			t.Fatal(err)
		}
	}
	channel := domain.Channel{ID: "private", Name: "private", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPrivate, MemberIDs: []string{owner.ID, agent.ID}}
	if _, err := s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: channel.ID, Payload: channel}); err != nil {
		t.Fatal(err)
	}
	a := newTestAPI(s, owner.ID, "test")
	rule := domain.ApprovalRule{ID: store.NewID(), ChannelID: channel.ID, Paths: []string{}, MaxLines: 50, CreatedBy: owner.ID, CreatedAt: time.Now().UTC()}
	if _, err := s.Append(ctx, events.Draft{Type: events.ApprovalRuleCreated, Actor: events.Human(owner.ID), ChannelID: channel.ID, Payload: rule}); err != nil {
		t.Fatal(err)
	}
	request := func(method, url, body string, member domain.Member, handler http.HandlerFunc) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, url, strings.NewReader(body)).WithContext(context.WithValue(ctx, actorKey{}, member))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler(w, r)
		return w
	}
	for _, tc := range []struct {
		name, method, url, body string
		handler                 http.HandlerFunc
	}{
		{"list", "GET", "/api/v1/approval-rules", "", a.listApprovalRules},
		{"create", "POST", "/api/v1/approval-rules", `{"channel_id":"private","max_lines":50}`, a.createApprovalRule},
		{"delete", "DELETE", "/api/v1/approval-rules/" + rule.ID, "", a.deleteApprovalRule},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := request(tc.method, tc.url, tc.body, agent, tc.handler).Code; got != 403 {
				t.Fatalf("agent got %d", got)
			}
		})
	}
	if got := request("GET", "/api/v1/approval-rules", "", outsider, a.listApprovalRules); got.Code != 200 || strings.Contains(got.Body.String(), rule.ID) {
		t.Fatalf("outsider list %d %s", got.Code, got.Body.String())
	}
	if got := request("GET", "/api/v1/approval-rules?channel_id=private", "", outsider, a.listApprovalRules).Code; got != 404 {
		t.Fatalf("outsider channel got %d", got)
	}
	if got := request("POST", "/api/v1/approval-rules", `{"channel_id":"private","max_lines":50}`, outsider, a.createApprovalRule).Code; got != 404 {
		t.Fatalf("outsider create got %d", got)
	}
	if got := request("DELETE", "/api/v1/approval-rules/"+rule.ID, "", outsider, a.deleteApprovalRule).Code; got != 404 {
		t.Fatalf("outsider delete got %d", got)
	}
	for _, body := range []string{`{"channel_id":"private","max_lines":0}`, `{"channel_id":"private","max_lines":50,"paths":["../secret"]}`, `{"channel_id":"private","max_lines":50,"paths":["foo/[abc"]}`} {
		if got := request("POST", "/api/v1/approval-rules", body, owner, a.createApprovalRule).Code; got != 400 {
			t.Fatalf("invalid %s got %d", body, got)
		}
	}
}

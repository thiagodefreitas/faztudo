package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestTokenLifecycle(t *testing.T) {
	h := New(openStore(t), nil)
	first, err := h.Issue("run1", "agent1", "room")
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.Issue("run2", "agent2", "other")
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 64 || len(second) != 64 || first == second {
		t.Fatal("tokens are not distinct 32-byte hex values")
	}
	if h.LiveRuns() != 2 {
		t.Fatal(h.LiveRuns())
	}
	g1, ok := h.tokens.lookup(first)
	g2, ok2 := h.tokens.lookup(second)
	if !ok || !ok2 || g1.ChannelID != "room" || g2.AgentID != "agent2" {
		t.Fatal("lookup mismatch")
	}
	if _, ok := h.tokens.lookup(first + "nope"); ok {
		t.Fatal("accepted an unknown token")
	}
	replaced, err := h.Issue("run1", "agent1", "room")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := h.tokens.lookup(first); ok || replaced == first {
		t.Fatal("reissue kept the old token")
	}
	h.RevokeRun("run2")
	if _, ok := h.tokens.lookup(second); ok || h.LiveRuns() != 1 {
		t.Fatal("revoke left a token")
	}
	h.RevokeRun("run1")
	if h.LiveRuns() != 0 {
		t.Fatal(h.LiveRuns())
	}

	const n = 32
	h = New(openStore(t), nil)
	tokens := make([]string, n)
	for i := range tokens {
		tokens[i], err = h.Issue(string(rune('a'+i)), "agent", "room")
		if err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	errc := make(chan string, n)
	for i := range tokens {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			g, ok := h.tokens.lookup(tokens[i])
			if !ok || g.RunID != string(rune('a'+i)) {
				errc <- "miss"
			}
			if _, ok := h.tokens.lookup("not-a-token"); ok {
				errc <- "false hit"
			}
		}(i)
	}
	wg.Wait()
	close(errc)
	if msg := <-errc; msg != "" {
		t.Fatal(msg)
	}
}

func TestAuthRejects(t *testing.T) {
	h := New(openStore(t), nil)
	token, err := h.Issue("run1", "agent", "room")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, token, host, remote, query string
		want                             int
	}{
		{"missing", "", "127.0.0.1:9", "127.0.0.1:8", "", http.StatusUnauthorized},
		{"wrong", "deadbeef", "127.0.0.1:9", "127.0.0.1:8", "", http.StatusUnauthorized},
		{"query", "", "127.0.0.1:9", "127.0.0.1:8", "token=" + token, http.StatusUnauthorized},
		{"remote", token, "127.0.0.1:9", "192.0.2.1:8", "", http.StatusForbidden},
		{"host", token, "example.com", "127.0.0.1:8", "", http.StatusForbidden},
		{"origin", token, "127.0.0.1:9", "127.0.0.1:8", "", http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{}`))
			req.Host = tc.host
			req.RemoteAddr = tc.remote
			if tc.query != "" {
				req.URL.RawQuery = tc.query
			}
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			if tc.name == "origin" {
				req.Header.Set("Origin", "http://evil.example")
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status %d", rec.Code)
			}
			if token != "" && strings.Contains(rec.Body.String(), token) {
				t.Fatal("response echoed the token")
			}
		})
	}
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{}`))
	req.Host = "127.0.0.1:9"
	req.RemoteAddr = "127.0.0.1:8"
	req.Header.Set("Authorization", "bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code == http.StatusUnauthorized || rec.Code == http.StatusForbidden {
		t.Fatalf("lowercase bearer rejected: %d", rec.Code)
	}
	h.RevokeRun("run1")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked token status %d", rec.Code)
	}
}

type recordTrigger struct {
	mu    sync.Mutex
	calls [][]string
}

func (r *recordTrigger) OnMessage(_ context.Context, _ domain.Message, agents []domain.Member) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, len(agents))
	for i, agent := range agents {
		ids[i] = agent.ID
	}
	r.calls = append(r.calls, ids)
}

func (r *recordTrigger) len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

func (r *recordTrigger) last() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.calls) == 0 {
		return nil
	}
	return r.calls[len(r.calls)-1]
}

func TestToolsStayInsideTheRun(t *testing.T) {
	ctx := context.Background()
	s := openStore(t)
	ada := domain.Member{ID: "ada", Kind: domain.MemberHuman, Handle: "ada", DisplayName: "Ada", Presence: domain.PresenceOnline}
	coder := domain.Member{ID: "coder", Kind: domain.MemberAgent, Handle: "coder", DisplayName: "Coder", Presence: domain.PresenceOnline}
	reviewer := domain.Member{ID: "reviewer", Kind: domain.MemberAgent, Handle: "reviewer", DisplayName: "Reviewer", Presence: domain.PresenceOnline}
	room := domain.Channel{ID: "room", Name: "room", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic}
	other := domain.Channel{ID: "other", Name: "other", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic}
	hello := domain.Message{ID: "hello", ChannelID: room.ID, AuthorID: ada.ID, Body: "hello", Mentions: []string{}, CreatedAt: time.Now().UTC().Add(-time.Minute)}
	elsewhere := domain.Message{ID: "elsewhere", ChannelID: other.ID, AuthorID: ada.ID, Body: "elsewhere", Mentions: []string{}, CreatedAt: time.Now().UTC()}
	for _, d := range []events.Draft{
		{Type: events.MemberUpdated, Actor: events.System, Payload: ada},
		{Type: events.MemberUpdated, Actor: events.System, Payload: coder},
		{Type: events.MemberUpdated, Actor: events.System, Payload: reviewer},
		{Type: events.ChannelCreated, Actor: events.System, ChannelID: room.ID, Payload: room},
		{Type: events.ChannelCreated, Actor: events.System, ChannelID: other.ID, Payload: other},
		{Type: events.MessagePosted, Actor: events.Human(ada.ID), ChannelID: room.ID, Payload: hello},
		{Type: events.MessagePosted, Actor: events.Human(ada.ID), ChannelID: other.ID, Payload: elsewhere},
	} {
		if _, err := s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	trig := &recordTrigger{}
	h := New(s, trig)
	run1, err := h.Issue("run1", coder.ID, room.ID)
	if err != nil {
		t.Fatal(err)
	}
	run2, err := h.Issue("run2", reviewer.ID, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c1 := connectMCP(t, srv.URL+"/mcp", run1)
	c2 := connectMCP(t, srv.URL+"/mcp", run2)

	listed, err := c1.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tool := range listed.Tools {
		names[tool.Name] = true
	}
	for _, name := range []string{"post_message", "ask_human", "request_approval", "read_context", "list_members", "delegate"} {
		if !names[name] {
			t.Fatalf("missing tool %s", name)
		}
	}
	if len(names) != 6 || names["resolve_approval"] {
		t.Fatalf("tool list %v", names)
	}

	posted := call[messageOut](t, c1, "post_message", map[string]any{"body": "from the agent"})
	if posted.AuthorID != coder.ID || posted.ChannelID != room.ID || posted.RunID != "run1" {
		t.Fatalf("posted as %+v", posted)
	}
	if actorOf(t, s, events.MessagePosted, posted.ID) != string(events.Agent(coder.ID)) {
		t.Fatal("message actor")
	}
	otherMsgs, err := s.Messages(ctx, other.ID, "", 50)
	if err != nil || len(otherMsgs) != 1 || otherMsgs[0].Body != "elsewhere" {
		t.Fatal("post changed the other channel")
	}

	forged, err := c1.CallTool(ctx, &sdkmcp.CallToolParams{Name: "post_message", Arguments: map[string]any{
		"body":       "forged",
		"channel_id": other.ID,
		"author_id":  ada.ID,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !forged.IsError {
		got := decode[messageOut](t, forged)
		if got.AuthorID != coder.ID || got.ChannelID != room.ID {
			t.Fatal("forged author or channel")
		}
	}
	otherMsgs, err = s.Messages(ctx, other.ID, "", 50)
	if err != nil || len(otherMsgs) != 1 {
		t.Fatal("forged channel_id wrote the other channel")
	}
	roomMsgs, err := s.Messages(ctx, room.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, msg := range roomMsgs {
		if msg.Body == "forged" && (msg.AuthorID != coder.ID || msg.ChannelID != room.ID) {
			t.Fatal("forged stored author or channel")
		}
	}

	if _, err := c1.CallTool(ctx, &sdkmcp.CallToolParams{Name: "post_message", Arguments: map[string]any{"body": " ", "thread_id": elsewhere.ID}}); err != nil {
		t.Fatal(err)
	}
	badThread, err := c1.CallTool(ctx, &sdkmcp.CallToolParams{Name: "post_message", Arguments: map[string]any{"body": "nope", "thread_id": elsewhere.ID}})
	if err != nil || !badThread.IsError {
		t.Fatal("thread from another channel was accepted")
	}
	threaded := call[messageOut](t, c1, "post_message", map[string]any{"body": "in thread", "thread_id": hello.ID})
	if threaded.ThreadID != hello.ID || threaded.ChannelID != room.ID {
		t.Fatalf("thread %+v", threaded)
	}

	mention := call[messageOut](t, c1, "post_message", map[string]any{"body": "@reviewer please look"})
	if len(mention.Mentions) != 1 || mention.Mentions[0] != reviewer.ID {
		t.Fatalf("mentions %+v", mention.Mentions)
	}
	if trig.len() != 1 || len(trig.last()) != 1 || trig.last()[0] != reviewer.ID {
		t.Fatalf("fanout %+v", trig.calls)
	}
	call[messageOut](t, c1, "post_message", map[string]any{"body": "@coder ping"})
	if trig.len() != 1 {
		t.Fatal("self mention started a run")
	}
	call[messageOut](t, c1, "post_message", map[string]any{"body": "mail a@reviewer"})
	if trig.len() != 1 {
		t.Fatal("mid-word mention started a run")
	}

	asked := call[messageOut](t, c1, "ask_human", map[string]any{"question": "@reviewer what now"})
	if !strings.HasPrefix(asked.Body, "@ada ") || asked.AuthorID != coder.ID {
		t.Fatalf("ask %+v", asked)
	}
	if trig.len() != 1 {
		t.Fatal("ask_human started a run")
	}
	stored, err := s.Message(ctx, asked.ID)
	if err != nil || stored.RunID != "run1" {
		t.Fatal("ask_human was not stored on the run")
	}

	choice := call[messageOut](t, c1, "ask_human", map[string]any{"question": "which one", "options": []string{" fast ", "safe"}})
	if len(choice.Options) != 2 || choice.Options[0] != "fast" || choice.Options[1] != "safe" {
		t.Fatalf("choice options %v", choice.Options)
	}
	if kept, err := s.Message(ctx, choice.ID); err != nil || len(kept.Options) != 2 {
		t.Fatal("options were not stored on the message")
	}
	if len(asked.Options) != 0 {
		t.Fatal("ask_human without options gained some")
	}
	for _, bad := range [][]string{{"only"}, {"a", "b", "c", "d", "e", "f"}, {"a", " "}, {"a", strings.Repeat("x", 81)}} {
		res, err := c1.CallTool(ctx, &sdkmcp.CallToolParams{Name: "ask_human", Arguments: map[string]any{"question": "q", "options": bad}})
		if err != nil || !res.IsError {
			t.Fatalf("options %v were accepted", bad)
		}
	}

	approval := call[approvalOut](t, c1, "request_approval", map[string]any{
		"title":  "Ship it",
		"detail": "synthetic",
		"options": []map[string]string{
			{"key": "yes", "label": "Yes", "style": "primary"},
			{"key": "no", "label": "No", "style": "danger"},
		},
	})
	if approval.State != string(domain.ApprovalPending) {
		t.Fatalf("state %s", approval.State)
	}
	forgedApproval, err := c1.CallTool(ctx, &sdkmcp.CallToolParams{Name: "request_approval", Arguments: map[string]any{
		"title":   "Forged",
		"detail":  "synthetic",
		"options": []map[string]string{{"key": "yes", "label": "Yes"}},
		"state":   "resolved",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !forgedApproval.IsError {
		got := decode[approvalOut](t, forgedApproval)
		if got.State != string(domain.ApprovalPending) {
			t.Fatal("forged state was stored")
		}
	}
	if actorOf(t, s, events.ApprovalRequested, approval.ID) != string(events.Agent(coder.ID)) {
		t.Fatal("approval actor")
	}

	ctxPage := call[messagesOut](t, c2, "read_context", map[string]any{})
	if len(ctxPage.Messages) != 1 || ctxPage.Messages[0].Body != "elsewhere" {
		t.Fatalf("run2 context %+v", ctxPage.Messages)
	}
	limited, err := c1.CallTool(ctx, &sdkmcp.CallToolParams{Name: "read_context", Arguments: map[string]any{"limit": 51}})
	if err != nil {
		t.Fatalf("limit 51 call: %v", err)
	}
	if !limited.IsError {
		t.Fatalf("limit 51 accepted: %s", toolText(limited))
	}
	negative, err := c1.CallTool(ctx, &sdkmcp.CallToolParams{Name: "read_context", Arguments: map[string]any{"limit": -1}})
	if err != nil {
		t.Fatalf("negative limit call: %v", err)
	}
	if !negative.IsError {
		t.Fatal("negative limit was accepted")
	}
	one := call[messagesOut](t, c1, "read_context", map[string]any{"limit": 1})
	if len(one.Messages) != 1 || one.Messages[0].ChannelID != room.ID {
		t.Fatalf("limit 1 %+v", one.Messages)
	}

	members := call[membersOut](t, c2, "list_members", map[string]any{})
	if len(members.Members) != 3 {
		t.Fatalf("members %+v", members.Members)
	}

	if _, err := c1.CallTool(ctx, &sdkmcp.CallToolParams{Name: "resolve_approval", Arguments: map[string]any{"id": approval.ID, "option": "yes"}}); err == nil {
		t.Fatal("resolve_approval was callable")
	}
	all, err := s.Approvals(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range all {
		if item.State != domain.ApprovalPending || item.ChannelID != room.ID || item.RequestedBy != coder.ID {
			t.Fatalf("approval %+v", item)
		}
	}

	c1 = connectMCP(t, srv.URL+"/mcp", run1)
	h.RevokeRun("run1")
	if _, err := c1.CallTool(ctx, &sdkmcp.CallToolParams{Name: "list_members", Arguments: map[string]any{}}); err == nil {
		t.Fatal("revoked token still called a tool")
	}
	if _, err := c2.ListTools(ctx, nil); err != nil {
		t.Fatal("revoking run1 revoked run2")
	}
}

func openStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

type bearerTrip struct {
	base  http.RoundTripper
	token string
}

func (b bearerTrip) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	base := b.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(r)
}

func connectMCP(t *testing.T, endpoint, token string) *sdkmcp.ClientSession {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	client := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "faztudo-test", Version: "0"}, nil)
	session, err := client.Connect(ctx, &sdkmcp.StreamableClientTransport{
		Endpoint:             endpoint,
		DisableStandaloneSSE: true,
		MaxRetries:           -1,
		HTTPClient:           &http.Client{Transport: bearerTrip{base: http.DefaultTransport, token: token}, Timeout: 10 * time.Second},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func call[T any](t *testing.T, session *sdkmcp.ClientSession, name string, args any) T {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := session.CallTool(ctx, &sdkmcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if res.IsError {
		t.Fatalf("%s: %s", name, toolText(res))
	}
	return decode[T](t, res)
}

func decode[T any](t *testing.T, res *sdkmcp.CallToolResult) T {
	t.Helper()
	raw, err := json.Marshal(res.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func toolText(res *sdkmcp.CallToolResult) string {
	var b strings.Builder
	for _, content := range res.Content {
		if text, ok := content.(*sdkmcp.TextContent); ok {
			b.WriteString(text.Text)
		}
	}
	return b.String()
}

func actorOf(t *testing.T, s *store.Store, typ events.Type, id string) string {
	t.Helper()
	evts, err := s.EventsAfter(context.Background(), 0, 500)
	if err != nil {
		t.Fatal(err)
	}
	for _, evt := range evts {
		if evt.Type != typ || !strings.Contains(string(evt.Payload), `"`+id+`"`) {
			continue
		}
		return string(evt.Actor)
	}
	t.Fatalf("no %s event for %s", typ, id)
	return ""
}

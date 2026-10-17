package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

type countTrigger struct{ count int }

func (t *countTrigger) OnMessage(context.Context, domain.Message, []domain.Member) { t.count++ }

func TestMessageStreamAndHumanApproval(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	human := domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: "user", DisplayName: "User"}
	agent := domain.Member{ID: store.NewID(), Kind: domain.MemberAgent, Handle: "codex", DisplayName: "Codex"}
	for _, m := range []domain.Member{human, agent} {
		if _, err = s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: m}); err != nil {
			t.Fatal(err)
		}
	}
	h := New(s, human.ID, "test")
	trigger := &countTrigger{}
	h.Trigger = trigger
	srv := httptest.NewServer(h)
	defer srv.Close()
	req, _ := http.NewRequest("POST", srv.URL+"/api/v1/channels", bytes.NewBufferString(`{"name":"general","kind":"team","visibility":"public"}`))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var ch domain.Channel
	json.NewDecoder(res.Body).Decode(&ch)
	res.Body.Close()
	if res.StatusCode != 201 {
		t.Fatalf("channel status %d", res.StatusCode)
	}
	ws, _, err := websocket.DefaultDialer.Dial("ws"+srv.URL[4:]+"/api/v1/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if err = ws.WriteMessage(websocket.TextMessage, []byte(`{"op":"subscribe","after_seq":0}`)); err != nil {
		t.Fatal(err)
	}
	req, _ = http.NewRequest("POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", bytes.NewBufferString(`{"body":"hello @codex","idempotency_key":"same"}`))
	req.Header.Set("Content-Type", "application/json")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var msg domain.Message
	json.NewDecoder(res.Body).Decode(&msg)
	res.Body.Close()
	if res.StatusCode != 201 || len(msg.Mentions) != 1 || msg.Mentions[0] != agent.ID {
		t.Fatalf("message %d %+v", res.StatusCode, msg)
	}
	if trigger.count != 1 {
		t.Fatalf("trigger count %d", trigger.count)
	}
	duplicateReq, _ := http.NewRequest("POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", bytes.NewBufferString(`{"body":"hello @codex","idempotency_key":"same"}`))
	duplicateReq.Header.Set("Content-Type", "application/json")
	duplicateRes, err := http.DefaultClient.Do(duplicateReq)
	if err != nil {
		t.Fatal(err)
	}
	var duplicate domain.Message
	json.NewDecoder(duplicateRes.Body).Decode(&duplicate)
	duplicateRes.Body.Close()
	if duplicate.ID != msg.ID || trigger.count != 1 {
		t.Fatalf("duplicate retriggered: %+v count %d", duplicate, trigger.count)
	}
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	var cursor int64
	for {
		_, b, e := ws.ReadMessage()
		if e != nil {
			t.Fatal(e)
		}
		var evt events.Event
		if json.Unmarshal(b, &evt) != nil {
			t.Fatal("invalid stream frame")
		}
		if evt.Type == events.MessagePosted {
			cursor = evt.Seq
			break
		}
	}
	ws.Close()
	req, _ = http.NewRequest("POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", bytes.NewBufferString(`{"body":"second synthetic message"}`))
	req.Header.Set("Content-Type", "application/json")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 201 {
		t.Fatal(res.StatusCode)
	}
	resumed, _, err := websocket.DefaultDialer.Dial("ws"+srv.URL[4:]+"/api/v1/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resumed.Close()
	sub, _ := json.Marshal(map[string]any{"op": "subscribe", "after_seq": cursor})
	if err = resumed.WriteMessage(websocket.TextMessage, sub); err != nil {
		t.Fatal(err)
	}
	resumed.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, b, err := resumed.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var replay events.Event
	if err = json.Unmarshal(b, &replay); err != nil {
		t.Fatal(err)
	}
	if replay.Type != events.MessagePosted || replay.Seq <= cursor {
		t.Fatalf("resume: %+v", replay)
	}
	approval := domain.Approval{ID: store.NewID(), ChannelID: ch.ID, RequestedBy: agent.ID, Title: "Synthetic", State: domain.ApprovalPending, Options: []domain.ApprovalOption{{Key: "yes", Label: "Yes"}}}
	if _, err = s.Append(ctx, events.Draft{Type: events.ApprovalRequested, Actor: events.Agent(agent.ID), Payload: approval}); err != nil {
		t.Fatal(err)
	}
	req, _ = http.NewRequest("POST", srv.URL+"/api/v1/approvals/"+approval.ID+"/resolve", bytes.NewBufferString(`{"option":"yes"}`))
	req.RemoteAddr = "127.0.0.1:1234"
	req.Host = "127.0.0.1"
	req.Header.Set("Content-Type", "application/json")
	agentHandler := New(s, human.ID, "test")
	agentHandler.actorForRequest = func(*http.Request) (domain.Member, error) { return agent, nil }
	rec := httptest.NewRecorder()
	agentHandler.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("agent approval: %d", rec.Code)
	}
	humanRec := httptest.NewRecorder()
	h.ServeHTTP(humanRec, req)
	if humanRec.Code != 200 {
		t.Fatalf("human approval: %d %s", humanRec.Code, humanRec.Body.String())
	}
	resolved, err := s.Approval(ctx, approval.ID)
	if err != nil || resolved.State != domain.ApprovalResolved || resolved.Resolution.By != human.ID {
		t.Fatalf("human resolution: %+v %v", resolved, err)
	}
}

func TestEndpointSurface(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	human := domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: "user", DisplayName: "User"}
	ch := domain.Channel{ID: store.NewID(), Name: "general", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic, MemberIDs: []string{human.ID}}
	msg := domain.Message{ID: store.NewID(), ChannelID: ch.ID, AuthorID: human.ID, Body: "synthetic", CreatedAt: time.Now().UTC()}
	run := domain.Run{ID: store.NewID(), ChannelID: ch.ID, TriggerMessageID: msg.ID, AgentID: "agent", State: domain.RunQueued}
	approval := domain.Approval{ID: store.NewID(), ChannelID: ch.ID, Title: "Synthetic", State: domain.ApprovalPending, Options: []domain.ApprovalOption{{Key: "yes", Label: "Yes"}}}
	lane := domain.Lane{ID: "codex/default", CLI: "codex", Capacity: 1, Health: domain.LaneUnknown}
	for _, v := range []struct {
		typ     events.Type
		payload any
		channel string
	}{{events.MemberUpdated, human, ""}, {events.ChannelCreated, ch, ch.ID}, {events.MessagePosted, msg, ch.ID}, {events.RunCreated, run, ch.ID}, {events.ApprovalRequested, approval, ch.ID}, {events.LaneUpdated, lane, ""}} {
		if _, err = s.Append(ctx, events.Draft{Type: v.typ, Actor: events.System, ChannelID: v.channel, Payload: v.payload}); err != nil {
			t.Fatal(err)
		}
	}
	evts, err := s.EventsAfter(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	h := New(s, human.ID, "test")
	cases := []struct {
		method, path, body string
		want               int
	}{
		{"GET", "/api/v1/health", "", 200}, {"GET", "/api/v1/me", "", 200}, {"GET", "/api/v1/members", "", 200}, {"GET", "/api/v1/channels", "", 200},
		{"PATCH", "/api/v1/channels/" + ch.ID, `{"topic":"Updated"}`, 200},
		{"GET", "/api/v1/channels/" + ch.ID + "/messages?limit=1", "", 200}, {"GET", "/api/v1/messages/" + msg.ID + "/thread", "", 200},
		{"POST", "/api/v1/channels/" + ch.ID + "/read", `{"event_id":"` + evts[2].ID + `"}`, 200},
		{"GET", "/api/v1/runs", "", 200}, {"GET", "/api/v1/runs/" + run.ID, "", 200}, {"GET", "/api/v1/runs/" + run.ID + "/output", "", 200},
		{"GET", "/api/v1/runs/" + run.ID + "/diff", "", 409}, {"POST", "/api/v1/runs/" + run.ID + "/cancel", "{}", 409}, {"POST", "/api/v1/runs/" + run.ID + "/retry", "{}", 409},
		{"GET", "/api/v1/approvals?state=pending", "", 200}, {"POST", "/api/v1/approvals/" + approval.ID + "/resolve", `{"option":"yes"}`, 200},
		{"GET", "/api/v1/lanes", "", 200}, {"PATCH", "/api/v1/lanes/codex/default", `{"capacity":2}`, 200}, {"POST", "/api/v1/lanes/codex/default/probe", "{}", 409},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
			req.RemoteAddr = "127.0.0.1:1234"
			req.Host = "127.0.0.1"
			if tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
	req := httptest.NewRequest("GET", "/api/v1/me", nil)
	req.RemoteAddr = "192.0.2.1:1234"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("remote accepted: %d", rec.Code)
	}
}

func TestDiffIncludesCommittedAgentWork(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "-q")
	if err := os.WriteFile(filepath.Join(repo, "file.txt"), []byte("base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git("add", "file.txt")
	base := git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", git("write-tree"), "-m", "base")
	git("update-ref", "HEAD", base)
	if err := os.WriteFile(filepath.Join(repo, "file.txt"), []byte("changed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git("add", "file.txt")
	commit := git("-c", "user.name=Agent", "-c", "user.email=agent@example.invalid", "commit-tree", git("write-tree"), "-p", base, "-m", "agent")
	git("update-ref", "HEAD", commit)
	s, err := store.Open(filepath.Join(root, "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	human := domain.Member{ID: "human", Kind: domain.MemberHuman, Handle: "human"}
	run := domain.Run{ID: "run", Mode: domain.RunWrite, State: domain.RunWaitingApproval, Worktree: repo, BaseCommit: base}
	for _, entry := range []struct {
		typ     events.Type
		payload any
	}{{events.MemberUpdated, human}, {events.RunCreated, run}} {
		if _, err := s.Append(ctx, events.Draft{Type: entry.typ, Actor: events.System, Payload: entry.payload}); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest("GET", "/api/v1/runs/run/diff", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Host = "127.0.0.1"
	rec := httptest.NewRecorder()
	New(s, human.ID, "test").ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "+changed") {
		t.Fatalf("diff after agent commit: %d %q", rec.Code, rec.Body.String())
	}
}

func TestAppendStoreErrorIsInternal(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	h := New(s, "human", "test")
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/api/v1/channels", nil)
	req = req.WithContext(context.WithValue(req.Context(), actorKey{}, domain.Member{ID: "human", Kind: domain.MemberHuman}))
	rec := httptest.NewRecorder()
	h.append(rec, req, events.Notice, "", "", events.NoticePayload{Level: "info", Text: "synthetic"})
	if rec.Code != 500 || strings.Contains(rec.Body.String(), "closed") {
		t.Fatalf("store error response: %d %q", rec.Code, rec.Body.String())
	}
}

func TestAppendConstraintIsConflict(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	human := domain.Member{ID: "human", Kind: domain.MemberHuman, Handle: "human"}
	if _, err := s.Append(context.Background(), events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: human}); err != nil {
		t.Fatal(err)
	}
	h := New(s, human.ID, "test")
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest("POST", "/api/v1/channels", strings.NewReader(`{"name":"same"}`))
		req.RemoteAddr = "127.0.0.1:1234"
		req.Host = "127.0.0.1"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		want := 201
		if i == 1 {
			want = 409
		}
		if rec.Code != want || strings.Contains(rec.Body.String(), "constraint") {
			t.Fatalf("create %d: status %d body %q", i, rec.Code, rec.Body.String())
		}
	}
}

func TestPatchProbePathIsNotLanePatch(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	human := domain.Member{ID: "human", Kind: domain.MemberHuman, Handle: "human"}
	lane := domain.Lane{ID: "codex/default", CLI: "codex", Capacity: 1, Health: domain.LaneAvailable}
	for _, d := range []events.Draft{{Type: events.MemberUpdated, Actor: events.System, Payload: human}, {Type: events.LaneUpdated, Actor: events.System, Payload: lane}} {
		if _, err := s.Append(context.Background(), d); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest("PATCH", "/api/v1/lanes/codex/default/probe", strings.NewReader(`{"capacity":9}`))
	req.RemoteAddr = "127.0.0.1:1234"
	req.Host = "127.0.0.1"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	New(s, human.ID, "test").ServeHTTP(rec, req)
	got, err := s.Lane(context.Background(), lane.ID)
	if err != nil || rec.Code != 404 || got.Capacity != 1 {
		t.Fatalf("probe path patched lane: status %d lane %+v error %v", rec.Code, got, err)
	}
}

func TestConcurrentApprovalOnlyOneResolution(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	human := domain.Member{ID: "human", Kind: domain.MemberHuman, Handle: "human"}
	approval := domain.Approval{ID: "approval", RunID: "run", ChannelID: "channel", State: domain.ApprovalPending, Options: []domain.ApprovalOption{{Key: "yes", Label: "Yes"}}}
	for _, d := range []events.Draft{{Type: events.MemberUpdated, Actor: events.System, Payload: human}, {Type: events.ApprovalRequested, Actor: events.System, Payload: approval}} {
		if _, err := s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	h := New(s, human.ID, "test")
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	h.ResolveApproval = func(context.Context, domain.Approval, string, string) (string, error) {
		entered <- struct{}{}
		<-release
		return "synthetic outcome", nil
	}
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest("POST", "/api/v1/approvals/approval/resolve", strings.NewReader(`{"option":"yes"}`))
			req.RemoteAddr = "127.0.0.1:1234"
			req.Host = "127.0.0.1"
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			codes <- rec.Code
		}()
	}
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("first resolve did not enter")
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	first, second := <-codes, <-codes
	if !((first == 200 && second == 409) || (first == 409 && second == 200)) {
		t.Fatalf("resolution statuses %d, %d", first, second)
	}
	all, err := s.EventsAfter(ctx, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, e := range all {
		if e.Type == events.ApprovalResolved {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("resolution events %d", count)
	}
}

func TestMessageKeyCanRepeatInAnotherChannel(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	human := domain.Member{ID: "human", Kind: domain.MemberHuman, Handle: "human"}
	if _, err := s.Append(context.Background(), events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: human}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b"} {
		channel := domain.Channel{ID: id, Name: id, Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic}
		if _, err := s.Append(context.Background(), events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: id, Payload: channel}); err != nil {
			t.Fatal(err)
		}
	}
	h := New(s, human.ID, "test")
	for _, id := range []string{"a", "b"} {
		req := httptest.NewRequest("POST", "/api/v1/channels/"+id+"/messages", strings.NewReader(`{"body":"synthetic `+id+`","idempotency_key":"same"}`))
		req.RemoteAddr = "127.0.0.1:1234"
		req.Host = "127.0.0.1"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var msg domain.Message
		if err := json.Unmarshal(rec.Body.Bytes(), &msg); err != nil {
			t.Fatal(err)
		}
		if rec.Code != 201 || msg.ChannelID != id {
			t.Fatalf("channel %s: status %d message %+v", id, rec.Code, msg)
		}
	}
}

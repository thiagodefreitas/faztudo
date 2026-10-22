package bridge

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/files"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

type triggerCount struct {
	mu sync.Mutex
	n  int
}

func (v *triggerCount) OnMessage(_ context.Context, _ domain.Message, _ []domain.Member) {
	v.mu.Lock()
	v.n++
	v.mu.Unlock()
}
func (v *triggerCount) Count() int { v.mu.Lock(); defer v.mu.Unlock(); return v.n }

func fixture(t *testing.T) (*Handler, *triggerCount) {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	human := domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: "user", DisplayName: "User"}
	agent := domain.Member{ID: store.NewID(), Kind: domain.MemberAgent, Handle: "coder", DisplayName: "Coder"}
	for _, m := range []domain.Member{human, agent} {
		if _, err := s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: m}); err != nil {
			t.Fatal(err)
		}
	}
	c := domain.Channel{ID: store.NewID(), Name: "general", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic, MemberIDs: []string{human.ID, agent.ID}}
	if _, err := s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: c.ID, Payload: c}); err != nil {
		t.Fatal(err)
	}
	a := api.New(s, human.ID, "test")
	trigger := &triggerCount{}
	a.Trigger = trigger
	h := &Handler{Config: config.SignalBridge{Enabled: true, Account: "self", SignalCLI: "signal-cli", Allow: []string{"sender-1"}, Bind: map[string]string{"self": c.ID}}, API: a, Store: s, Human: human, FilesDir: t.TempDir(), MaxUpload: 3}
	return h, trigger
}

func TestInboundGateIdempotencyAndAttachments(t *testing.T) {
	h, trigger := fixture(t)
	ctx := context.Background()
	hello, err := h.Hello(ctx, Hello{Protocol: "1", Bridge: "signal", Version: "1"})
	if err != nil || hello.Bindings["self"] == "" || len(hello.Allowed) != 1 {
		t.Fatalf("hello: %+v %v", hello, err)
	}
	v := Inbound{Conversation: Conversation{Kind: "self"}, Sender: Sender{ID: "sender-1"}, SentAtMS: time.Now().UnixMilli(), ExternalID: "external-1", Body: "@coder read this", Attachments: []Attachment{{Name: "a.txt", DataBase64: base64.StdEncoding.EncodeToString([]byte("hi"))}}}
	bad := v
	bad.Sender.ID = "intruder"
	if _, err := h.Inbound(ctx, bad); err == nil || err.(RPCError).Code != "not_allowed" {
		t.Fatalf("sender: %v", err)
	}
	bad = v
	bad.Conversation = Conversation{Kind: "group", ID: "other"}
	if _, err := h.Inbound(ctx, bad); err == nil || err.(RPCError).Code != "unbound" {
		t.Fatalf("conversation: %v", err)
	}
	bad = v
	bad.Attachments = []Attachment{{DataBase64: base64.StdEncoding.EncodeToString([]byte("long"))}}
	if _, err := h.Inbound(ctx, bad); err == nil || err.(RPCError).Code != "too_large" {
		t.Fatalf("limit: %v", err)
	}
	result, err := h.Inbound(ctx, v)
	if err != nil || result.MessageID == "" || result.Duplicate || trigger.Count() != 1 {
		t.Fatalf("post: %+v %v triggers=%d", result, err, trigger.Count())
	}
	duplicate, err := h.Inbound(ctx, v)
	if err != nil || !duplicate.Duplicate || duplicate.MessageID != result.MessageID || trigger.Count() != 1 {
		t.Fatalf("duplicate: %+v %v triggers=%d", duplicate, err, trigger.Count())
	}
	eventsAfter, err := h.Store.EventsAfter(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	posts := 0
	for _, e := range eventsAfter {
		if e.Type == events.MessagePosted {
			posts++
			if e.Actor != events.Bridge("signal") {
				t.Fatalf("actor: %s", e.Actor)
			}
		}
	}
	if posts != 1 {
		t.Fatalf("posts=%d", posts)
	}
	m, err := h.Store.Message(ctx, result.MessageID)
	if err != nil || m.AuthorID != h.Human.ID || len(m.Attachments) != 1 || m.Attachments[0].ContentType != "application/octet-stream" {
		t.Fatalf("message: %+v %v", m, err)
	}
	follow := v
	follow.ExternalID = "external-2"
	follow.Body = "reply"
	follow.Attachments = nil
	follow.Quote = &Quote{ExternalID: v.ExternalID, AuthorID: v.Sender.ID}
	got, err := h.Inbound(ctx, follow)
	if err != nil {
		t.Fatal(err)
	}
	reply, err := h.Store.Message(ctx, got.MessageID)
	if err != nil || reply.ThreadID != result.MessageID {
		t.Fatalf("reply: %+v %v", reply, err)
	}
}

func TestCodecHelloAndNoEcho(t *testing.T) {
	h, _ := fixture(t)
	request := `{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":"1","bridge":"signal","version":"1","capabilities":[]}}` + "\n"
	var output bytes.Buffer
	if err := NewConn(strings.NewReader(request), &output, h).Serve(context.Background()); err != nil {
		t.Fatal(err)
	}
	var response struct {
		Result HelloResult `json:"result"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &response); err != nil {
		t.Fatal(err)
	}
	if response.Result.Bindings["self"] == "" {
		t.Fatal(response)
	}
	e := events.Event{Type: events.MessagePosted, Actor: events.Bridge("signal"), ChannelID: response.Result.Bindings["self"], Payload: json.RawMessage(`{"id":"one","body":"hello"}`)}
	if _, ok := OutboundFor(e, response.Result.Bindings); ok {
		t.Fatal("bridge post echoed")
	}
}

func TestFakeBridgeProcess(t *testing.T) {
	if os.Getenv("FAZTUDO_BRIDGE_HELPER") != "1" {
		return
	}
	path := os.Getenv("FAZTUDO_BRIDGE_COUNT")
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	_, _ = f.WriteString("start\n")
	_ = f.Close()
	_, _ = os.Stdout.WriteString(`{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":"1","bridge":"signal","version":"1","capabilities":[]}}` + "\n")
	if os.Getenv("FAZTUDO_BRIDGE_MODE") == "post" {
		scanner := bufio.NewScanner(os.Stdin)
		if !scanner.Scan() {
			os.Exit(2)
		}
		_, _ = os.Stdout.WriteString(`{"jsonrpc":"2.0","id":2,"method":"inbound.message","params":{"conversation":{"kind":"self","id":""},"sender":{"id":"sender-1","number":""},"sent_at_ms":1760810400000,"external_id":"process-1","body":"@coder from process","attachments":[]}}` + "\n")
		if !scanner.Scan() {
			os.Exit(3)
		}
		var response struct {
			Result InboundResult `json:"result"`
			Error  *rpcWireError `json:"error"`
		}
		if json.Unmarshal(scanner.Bytes(), &response) != nil || response.Error != nil || response.Result.MessageID == "" {
			os.Exit(4)
		}
	}
	if os.Getenv("FAZTUDO_BRIDGE_MODE") == "outbound" || os.Getenv("FAZTUDO_BRIDGE_MODE") == "draft_outbound" {
		scanner := bufio.NewScanner(os.Stdin)
		if !scanner.Scan() {
			os.Exit(6)
		}
		if !scanner.Scan() {
			os.Exit(7)
		}
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params Outbound        `json:"params"`
		}
		wantText := "hello from agent"
		wantAttachments := 1
		if os.Getenv("FAZTUDO_BRIDGE_MODE") == "draft_outbound" {
			wantText, wantAttachments = os.Getenv("FAZTUDO_BRIDGE_WANT_TEXT"), 0
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil || request.Method != "outbound.send" || request.Params.Text != wantText || len(request.Params.Attachments) != wantAttachments {
			os.Exit(8)
		}
		if wantAttachments == 1 && request.Params.Attachments[0].DataBase64 != base64.StdEncoding.EncodeToString([]byte("hi")) {
			os.Exit(8)
		}
		if os.Getenv("FAZTUDO_BRIDGE_MODE") == "draft_outbound" {
			_ = os.WriteFile(os.Getenv("FAZTUDO_BRIDGE_COUNT")+".sent", []byte(request.Params.Text), 0600)
		}
		_, _ = os.Stdout.WriteString(`{"jsonrpc":"2.0","id":` + string(request.ID) + `,"result":{"external_id":"sent-1"}}` + "\n")
		time.Sleep(200 * time.Millisecond)
	}
	if os.Getenv("FAZTUDO_BRIDGE_MODE") == "disconnected" {
		scanner := bufio.NewScanner(os.Stdin)
		if !scanner.Scan() {
			os.Exit(5)
		}
		_, _ = os.Stdout.WriteString(`{"jsonrpc":"2.0","method":"status","params":{"state":"disconnected","detail":"offline"}}` + "\n")
		time.Sleep(2 * time.Second)
	}
	os.Exit(0)
}

func TestFakeBridgePostsThroughCodec(t *testing.T) {
	h, trigger := fixture(t)
	t.Setenv("FAZTUDO_BRIDGE_HELPER", "1")
	t.Setenv("FAZTUDO_BRIDGE_MODE", "post")
	t.Setenv("FAZTUDO_BRIDGE_COUNT", filepath.Join(t.TempDir(), "count"))
	if err := RunCommand(context.Background(), []string{os.Args[0], "-test.run=TestFakeBridgeProcess"}, h); err != nil {
		t.Fatal(err)
	}
	if trigger.Count() != 1 {
		t.Fatalf("triggers=%d", trigger.Count())
	}
	posts := 0
	eventsAfter, err := h.Store.EventsAfter(context.Background(), 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range eventsAfter {
		if e.Type == events.MessagePosted {
			posts++
			if e.Actor != events.Bridge("signal") {
				t.Fatalf("actor=%s", e.Actor)
			}
		}
	}
	if posts != 1 {
		t.Fatalf("posts=%d", posts)
	}
}

func TestFakeBridgeReceivesOutboundAndCursorPersists(t *testing.T) {
	h, _ := fixture(t)
	if err := h.Store.SetBridgeCursor(context.Background(), "signal", 0); err != nil {
		t.Fatal(err)
	}
	channelID := h.Config.Bind["self"]
	id, size, err := (files.Store{Dir: h.FilesDir}).Put(strings.NewReader("hi"), h.MaxUpload)
	if err != nil {
		t.Fatal(err)
	}
	m := domain.Message{ID: store.NewID(), ChannelID: channelID, AuthorID: "agent", Body: "hello from agent", Attachments: []domain.Attachment{{ID: id, Name: "note.txt", Size: size}}, CreatedAt: time.Now().UTC()}
	e, err := h.Store.Append(context.Background(), events.Draft{Type: events.MessagePosted, Actor: events.Agent("agent"), ChannelID: channelID, Payload: m})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAZTUDO_BRIDGE_HELPER", "1")
	t.Setenv("FAZTUDO_BRIDGE_MODE", "outbound")
	t.Setenv("FAZTUDO_BRIDGE_COUNT", filepath.Join(t.TempDir(), "count"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := RunCommand(ctx, []string{os.Args[0], "-test.run=TestFakeBridgeProcess"}, h); err != nil {
		t.Fatal(err)
	}
	cursor, err := h.Store.BridgeCursor(context.Background(), "signal")
	if err != nil || cursor < e.Seq {
		t.Fatalf("cursor=%d want >=%d: %v", cursor, e.Seq, err)
	}
	ref, err := h.Store.BridgeOutbound(context.Background(), "signal", "sent-1")
	if err != nil || ref.MessageID != m.ID {
		t.Fatalf("outbound: %+v %v", ref, err)
	}
}

func TestSupervisorRestartsAndNoticesOnce(t *testing.T) {
	h, _ := fixture(t)
	path := filepath.Join(t.TempDir(), "count")
	t.Setenv("FAZTUDO_BRIDGE_HELPER", "1")
	t.Setenv("FAZTUDO_BRIDGE_COUNT", path)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := Supervisor{Command: []string{os.Args[0], "-test.run=TestFakeBridgeProcess"}, Handler: h, BackoffMin: 20 * time.Millisecond, BackoffMax: 40 * time.Millisecond, DisconnectNoticeAfter: 50 * time.Millisecond, ShutdownGrace: 5 * time.Millisecond}
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	waitUntil(t, func() bool {
		b, _ := os.ReadFile(path)
		return bytes.Count(b, []byte("start")) >= 2 && noticeCount(t, h) >= 1
	})
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	notices := noticeCount(t, h)
	if notices != 1 {
		t.Fatalf("notices=%d", notices)
	}
}

func TestSupervisorNoticesWhileProcessIsDisconnected(t *testing.T) {
	h, _ := fixture(t)
	t.Setenv("FAZTUDO_BRIDGE_HELPER", "1")
	t.Setenv("FAZTUDO_BRIDGE_MODE", "disconnected")
	t.Setenv("FAZTUDO_BRIDGE_COUNT", filepath.Join(t.TempDir(), "count"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := Supervisor{Command: []string{os.Args[0], "-test.run=TestFakeBridgeProcess"}, Handler: h, DisconnectNoticeAfter: 100 * time.Millisecond, ShutdownGrace: 5 * time.Millisecond}
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	waitUntil(t, func() bool { return noticeCount(t, h) >= 1 })
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	notices := noticeCount(t, h)
	if notices != 1 {
		t.Fatalf("notices=%d", notices)
	}
}

func waitUntil(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not reached")
}

func noticeCount(t *testing.T, h *Handler) int {
	t.Helper()
	list, err := h.Store.EventsAfter(context.Background(), 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range list {
		if e.Type == events.Notice {
			n++
		}
	}
	return n
}

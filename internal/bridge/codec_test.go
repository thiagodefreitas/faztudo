package bridge

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/files"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

const helloLine = `{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":"1","bridge":"signal","version":"1","capabilities":[]}}` + "\n"

// pipeBridge is a bridge on the other end of two in-process pipes. The pipes
// are unbuffered, which is stricter than an OS pipe.
type pipeBridge struct {
	send  io.WriteCloser // bridge -> daemon
	recv  *bufio.Scanner // daemon -> bridge
	close func()
	done  chan error
}

func startConn(t *testing.T, h *Handler, tweak func(*Conn)) *pipeBridge {
	t.Helper()
	daemonIn, bridgeOut := io.Pipe()
	bridgeIn, daemonOut := io.Pipe()
	conn := NewConn(daemonIn, daemonOut, h)
	conn.drainTimeout = 100 * time.Millisecond
	if tweak != nil {
		tweak(conn)
	}
	ctx, cancel := context.WithCancel(context.Background())
	scanner := bufio.NewScanner(bridgeIn)
	scanner.Buffer(make([]byte, 64*1024), 16<<20)
	b := &pipeBridge{send: bridgeOut, recv: scanner, done: make(chan error, 1)}
	go func() { b.done <- conn.Serve(ctx) }()
	b.close = func() {
		_ = bridgeOut.Close()
		_ = bridgeIn.Close()
		cancel()
		select {
		case <-b.done:
		case <-time.After(5 * time.Second):
			t.Error("Serve did not return")
		}
	}
	t.Cleanup(b.close)
	return b
}

func (b *pipeBridge) hello(t *testing.T) {
	t.Helper()
	if _, err := io.WriteString(b.send, helloLine); err != nil {
		t.Fatal(err)
	}
	if !b.recv.Scan() || !strings.Contains(b.recv.Text(), `"result"`) {
		t.Fatalf("hello answer: %q %v", b.recv.Text(), b.recv.Err())
	}
}

type request struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params Outbound        `json:"params"`
}

func (b *pipeBridge) next(t *testing.T) request {
	t.Helper()
	if !b.recv.Scan() {
		t.Fatalf("daemon went quiet: %v", b.recv.Err())
	}
	var r request
	if err := json.Unmarshal(b.recv.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func (b *pipeBridge) answer(t *testing.T, r request, result string) {
	t.Helper()
	if _, err := io.WriteString(b.send, `{"jsonrpc":"2.0","id":`+string(r.ID)+`,"result":`+result+"}\n"); err != nil {
		t.Fatal(err)
	}
}

func agentMessage(t *testing.T, h *Handler, body string, attachments ...domain.Attachment) events.Event {
	t.Helper()
	channelID := h.Config.Bind["self"]
	m := domain.Message{ID: store.NewID(), ChannelID: channelID, AuthorID: "agent", Body: body, Attachments: attachments, CreatedAt: time.Now().UTC()}
	e, err := h.Store.Append(context.Background(), events.Draft{Type: events.MessagePosted, Actor: events.Agent("agent"), ChannelID: channelID, Payload: m})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func noticeTexts(t *testing.T, h *Handler) []string {
	t.Helper()
	list, err := h.Store.EventsAfter(context.Background(), 0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range list {
		if e.Type == events.Notice {
			var n events.NoticePayload
			_ = json.Unmarshal(e.Payload, &n)
			out = append(out, n.Text)
		}
	}
	return out
}

func TestOutboundRetriesATimedOutSend(t *testing.T) {
	h, _ := fixture(t)
	e := agentMessage(t, h, "hello")
	b := startConn(t, h, func(c *Conn) { c.callTimeout = 50 * time.Millisecond; c.retryDelay = 10 * time.Millisecond })
	b.hello(t)
	first := b.next(t) // never answered: the call times out
	second := b.next(t)
	if first.Params.Text != "hello" || second.Params.Text != "hello" {
		t.Fatalf("requests: %+v %+v", first, second)
	}
	b.answer(t, second, `{"external_id":"sent-retry"}`)
	waitUntil(t, func() bool {
		cursor, _ := h.Store.BridgeCursor(context.Background(), "signal")
		_, err := h.Store.BridgeOutbound(context.Background(), "signal", "sent-retry")
		return cursor >= e.Seq && err == nil
	})
	if len(noticeTexts(t, h)) != 0 {
		t.Fatalf("notices: %v", noticeTexts(t, h))
	}
}

func TestOutboundSkipsAnUndeliverableEventAndKeepsGoing(t *testing.T) {
	h, _ := fixture(t)
	missing := strings.Repeat("0", 64)
	agentMessage(t, h, "bad")
	agentMessage(t, h, "empty")
	agentMessage(t, h, "gone", domain.Attachment{ID: missing, Name: "gone.txt", Size: 1})
	last := agentMessage(t, h, "good")
	b := startConn(t, h, func(c *Conn) { c.callTimeout = time.Second })
	b.hello(t)
	for sent := 0; sent < 3; {
		r := b.next(t)
		sent++
		switch r.Params.Text {
		case "bad":
			if _, err := io.WriteString(b.send, `{"jsonrpc":"2.0","id":`+string(r.ID)+`,"error":{"code":-32000,"message":"nope","data":"bad_request"}}`+"\n"); err != nil {
				t.Fatal(err)
			}
		case "empty":
			b.answer(t, r, `{"external_id":""}`)
		case "good":
			b.answer(t, r, `{"external_id":"sent-good"}`)
		default:
			t.Fatalf("unexpected send %q (the missing attachment must not be sent)", r.Params.Text)
		}
	}
	waitUntil(t, func() bool {
		cursor, _ := h.Store.BridgeCursor(context.Background(), "signal")
		_, err := h.Store.BridgeOutbound(context.Background(), "signal", "sent-good")
		return cursor >= last.Seq && err == nil
	})
	notices := noticeTexts(t, h)
	if len(notices) != 3 {
		t.Fatalf("notices: %v", notices)
	}
	for _, n := range notices {
		if !strings.Contains(n, "not sent to Signal") {
			t.Fatalf("notice: %q", n)
		}
	}
}

// The bridge writes a burst larger than any pipe buffer without reading its
// stdin, while the daemon has a large outbound.send to deliver. Neither side
// may wait on the other.
func TestBurstWhileLargeOutboundSendDoesNotDeadlock(t *testing.T) {
	h, _ := fixture(t)
	h.MaxUpload = 4 << 20
	id, size, err := (files.Store{Dir: h.FilesDir}).Put(strings.NewReader(strings.Repeat("a", 1<<20)), h.MaxUpload)
	if err != nil {
		t.Fatal(err)
	}
	e := agentMessage(t, h, "big", domain.Attachment{ID: id, Name: "big.txt", Size: size})
	b := startConn(t, h, func(c *Conn) { c.callTimeout = 20 * time.Second })
	if _, err := io.WriteString(b.send, helloLine); err != nil {
		t.Fatal(err)
	}
	const burst = 1500
	wrote := make(chan error, 1)
	go func() {
		for i := 0; i < burst; i++ {
			line := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"inbound.message","params":{"conversation":{"kind":"self","id":""},"sender":{"id":"sender-1","number":""},"sent_at_ms":1760810400000,"external_id":"burst-1","body":"@coder burst %s","attachments":[]}}`+"\n", 100+i, strings.Repeat("x", 200))
			if _, err := io.WriteString(b.send, line); err != nil {
				wrote <- err
				return
			}
		}
		wrote <- nil
	}()
	// Read nothing until the whole burst is written.
	select {
	case err := <-wrote:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("deadlock: the daemon stopped reading the bridge")
	}
	answers, sawSend := 0, false
	for answers < burst || !sawSend {
		if !b.recv.Scan() {
			t.Fatalf("daemon closed early: answers=%d send=%v err=%v", answers, sawSend, b.recv.Err())
		}
		var r request
		if err := json.Unmarshal(b.recv.Bytes(), &r); err != nil {
			t.Fatal(err)
		}
		switch {
		case r.Method == "outbound.send":
			if len(r.Params.Attachments) != 1 || len(r.Params.Attachments[0].DataBase64) < 1<<20 {
				t.Fatalf("attachment: %d", len(r.Params.Attachments))
			}
			b.answer(t, r, `{"external_id":"sent-big"}`)
			sawSend = true
		default:
			var id int
			if json.Unmarshal(r.ID, &id) == nil && id >= 100 {
				answers++
			}
		}
	}
	waitUntil(t, func() bool {
		cursor, _ := h.Store.BridgeCursor(context.Background(), "signal")
		return cursor >= e.Seq
	})
}

func TestInboundBodyOverTheHTTPLimitIsTooLarge(t *testing.T) {
	h, _ := fixture(t)
	v := Inbound{Conversation: Conversation{Kind: "self"}, Sender: Sender{ID: "sender-1"}, SentAtMS: time.Now().UnixMilli(), ExternalID: "big-body", Body: strings.Repeat("a", api.MaxMessageBytes+1)}
	if _, err := h.Inbound(context.Background(), v); err == nil || err.(RPCError).Code != "too_large" {
		t.Fatalf("over the limit: %v", err)
	}
	v.Body = strings.Repeat("a", api.MaxMessageBytes)
	if _, err := h.Inbound(context.Background(), v); err != nil {
		t.Fatalf("at the limit: %v", err)
	}
}

func TestSupervisorBacksOffWhenTheProcessCannotStart(t *testing.T) {
	h, _ := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := Supervisor{Command: []string{"/nonexistent/faztudo-bridge"}, Handler: h, BackoffMin: 10 * time.Millisecond, BackoffMax: 20 * time.Millisecond, DisconnectNoticeAfter: 50 * time.Millisecond}
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	waitUntil(t, func() bool { return len(noticeTexts(t, h)) >= 1 })
	select {
	case err := <-done:
		t.Fatalf("Run ended on a start error: %v", err)
	default:
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	texts := noticeTexts(t, h)
	if len(texts) != 1 || !strings.Contains(texts[0], "over 50ms") {
		t.Fatalf("notices: %v", texts)
	}
}

func TestDescribeDuration(t *testing.T) {
	for d, want := range map[time.Duration]string{2 * time.Minute: "2 minutes", time.Minute: "1 minute", 90 * time.Second: "1m30s"} {
		if got := describeDuration(d); got != want {
			t.Errorf("%v: %q want %q", d, got, want)
		}
	}
}

func TestNoticeWorksWhenABindingNamesAMissingChannel(t *testing.T) {
	h, _ := fixture(t)
	h.Config.Bind = map[string]string{"group:x": "no-such-channel"}
	if _, err := h.Hello(context.Background(), Hello{Protocol: "1", Bridge: "signal", Version: "1"}); err == nil {
		t.Fatal("hello accepted a missing channel")
	}
	h.Notice(context.Background(), "Signal bridge is off")
	if texts := noticeTexts(t, h); len(texts) != 1 || texts[0] != "Signal bridge is off" {
		t.Fatalf("notices: %v", texts)
	}
}

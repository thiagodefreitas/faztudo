package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func streamHandlers() int {
	buf := make([]byte, 1<<20)
	n := runtime.Stack(buf, true)
	return strings.Count(string(buf[:n]), "api.(*API).stream(")
}

func waitStreamHandlers(t *testing.T, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for streamHandlers() != want {
		if time.Now().After(deadline) {
			t.Fatalf("stream handlers = %d, want %d", streamHandlers(), want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func dialStream(t *testing.T, h *API, after int64) (*websocket.Conn, func()) {
	t.Helper()
	srv := httptest.NewServer(h)
	ws, _, err := websocket.DefaultDialer.Dial("ws"+srv.URL[4:]+"/api/v1/stream", nil)
	if err != nil {
		srv.Close()
		t.Fatal(err)
	}
	if err = ws.WriteMessage(websocket.TextMessage, []byte(`{"op":"subscribe","after_seq":`+itoa(after)+`}`)); err != nil {
		t.Fatal(err)
	}
	return ws, func() { ws.Close(); srv.Close() }
}

func TestStreamEndsWhenClientVanishes(t *testing.T) {
	_, h, _, _ := setupLANTestAPI(t, "")
	base := streamHandlers()
	ws, closeAll := dialStream(t, h, 0)
	defer closeAll()
	waitStreamHandlers(t, base+1)
	// An abrupt close, no close frame: the read loop must notice and release
	// the handler and its subscription without any event being written.
	ws.UnderlyingConn().Close()
	waitStreamHandlers(t, base)
}

func fastStreamTimers(t *testing.T) {
	t.Helper()
	oldPing, oldWait := streamPingEvery.Load(), streamReadWait.Load()
	streamPingEvery.Store(int64(30 * time.Millisecond))
	streamReadWait.Store(int64(200 * time.Millisecond))
	t.Cleanup(func() { streamPingEvery.Store(oldPing); streamReadWait.Store(oldWait) })
}

func TestStreamEndsWhenClientStopsAnswering(t *testing.T) {
	fastStreamTimers(t)
	_, h, _, _ := setupLANTestAPI(t, "")
	base := streamHandlers()
	// The client keeps the connection open but never reads, so it never
	// answers a ping: a half-open peer.
	_, closeAll := dialStream(t, h, 0)
	defer closeAll()
	waitStreamHandlers(t, base+1)
	waitStreamHandlers(t, base)
}

func TestStreamKeepsOrderAndAnswersPings(t *testing.T) {
	fastStreamTimers(t)
	s, h, _, ch := setupLANTestAPI(t, "")
	last, err := s.LastSeq(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	ws, _, err := websocket.DefaultDialer.Dial("ws"+srv.URL[4:]+"/api/v1/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if err = ws.WriteMessage(websocket.TextMessage, []byte(`{"op":"subscribe","after_seq":`+itoa(last)+`}`)); err != nil {
		t.Fatal(err)
	}
	// Outlive several read deadlines: only answered pings keep it alive.
	go func() {
		time.Sleep(700 * time.Millisecond)
		for i := 0; i < 20; i++ {
			_, _ = s.Append(context.Background(), events.Draft{Type: events.Notice, Actor: events.System, ChannelID: ch.ID, Payload: events.NoticePayload{Level: "info", Text: itoa(int64(i))}})
		}
	}()
	var got []int64
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	for len(got) < 20 {
		_, b, err := ws.ReadMessage()
		if err != nil {
			t.Fatalf("after %d events: %v", len(got), err)
		}
		var e events.Event
		if err := json.Unmarshal(b, &e); err != nil {
			t.Fatal(err)
		}
		got = append(got, e.Seq)
	}
	for i := 1; i < len(got); i++ {
		if got[i] != got[i-1]+1 {
			t.Fatalf("out of order: %v", got)
		}
	}
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

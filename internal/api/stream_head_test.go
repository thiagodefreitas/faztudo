package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func TestStreamHeadIsTheLastSeqAndNeedsSignIn(t *testing.T) {
	s, h, _, ch := setupLANTestAPI(t, "synthetic-pass")
	h.localAuthBypass = false
	h.LocalTokenPath = auth.LocalTokenPath(t.TempDir())
	token, err := auth.EnsureLocalToken(h.LocalTokenPath)
	if err != nil {
		t.Fatal(err)
	}
	last, err := s.LastSeq(context.Background())
	if err != nil || last == 0 {
		t.Fatalf("last seq %d %v", last, err)
	}

	get := func(remote, host, bearer string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/v1/stream/head", nil)
		req.RemoteAddr = remote
		req.Host = host
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	head := func(rec *httptest.ResponseRecorder) int64 {
		t.Helper()
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var out struct {
			Seq int64 `json:"seq"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out.Seq
	}

	if got := head(get("127.0.0.1:1234", "127.0.0.1:7457", token)); got != last {
		t.Fatalf("head %d, want %d", got, last)
	}
	e, err := s.Append(context.Background(), events.Draft{Type: events.Notice, Actor: events.System, ChannelID: ch.ID, Payload: map[string]string{"level": "info", "text": "x"}})
	if err != nil {
		t.Fatal(err)
	}
	if got := head(get("127.0.0.1:1234", "127.0.0.1:7457", token)); got != e.Seq {
		t.Fatalf("head after append %d, want %d", got, e.Seq)
	}
	if rec := get("127.0.0.1:1234", "127.0.0.1:7457", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", rec.Code)
	}
	if rec := get("192.168.1.50:54321", "192.168.1.10:7458", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("LAN no session: %d", rec.Code)
	}
}

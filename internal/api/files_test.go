package api

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func (f *threadFixture) withFiles(t *testing.T, limit int64) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "files")
	f.h.FilesDir = dir
	f.h.MaxUploadBytes = limit
	return dir
}

// upload posts a multipart form and returns the recorder.
func (f *threadFixture) upload(t *testing.T, field, name string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile(field, name)
	if err != nil {
		t.Fatal(err)
	}
	part.Write(content)
	mw.Close()
	req := httptest.NewRequest("POST", "/api/v1/files", &buf)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Host = "127.0.0.1"
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)
	return rec
}

func (f *threadFixture) get(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Host = "127.0.0.1"
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)
	return rec
}

func TestUploadStoresByHashAndEnforcesTheLimit(t *testing.T) {
	f := newThreadFixture(t)
	dir := f.withFiles(t, 100)
	rec := f.upload(t, "file", "../../notes.txt", []byte("hello notes"))
	if rec.Code != 201 {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body.String())
	}
	var att domain.Attachment
	if err := json.Unmarshal(rec.Body.Bytes(), &att); err != nil {
		t.Fatal(err)
	}
	if att.Name != "notes.txt" || att.Size != 11 || len(att.ID) != 64 {
		t.Fatalf("attachment %+v", att)
	}
	if _, err := os.Stat(filepath.Join(dir, att.ID)); err != nil {
		t.Fatalf("not stored under its hash: %v", err)
	}
	big := f.upload(t, "file", "big.bin", bytes.Repeat([]byte("x"), 101))
	if big.Code != 413 {
		t.Fatalf("over the limit: %d %s", big.Code, big.Body.String())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("oversize upload left files: %v", entries)
	}
	if rec := f.upload(t, "other", "a.txt", []byte("x")); rec.Code != 400 {
		t.Fatalf("wrong field name: %d", rec.Code)
	}
	f.h.FilesDir = ""
	if rec := f.upload(t, "file", "a.txt", []byte("x")); rec.Code != 503 {
		t.Fatalf("uploads off: %d", rec.Code)
	}
}

func TestServeFileIsSafeAndSniffed(t *testing.T) {
	f := newThreadFixture(t)
	f.withFiles(t, 0)
	var html, png domain.Attachment
	rec := f.upload(t, "file", "evil.png", []byte("<html><script>alert(1)</script></html>"))
	if err := json.Unmarshal(rec.Body.Bytes(), &html); err != nil || rec.Code != 201 {
		t.Fatalf("%d %v", rec.Code, err)
	}
	rec = f.upload(t, "file", "pic.png", []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"))
	if err := json.Unmarshal(rec.Body.Bytes(), &png); err != nil || rec.Code != 201 {
		t.Fatalf("%d %v", rec.Code, err)
	}

	got := f.get(t, "/api/v1/files/"+html.ID+"?name=evil.png")
	h := got.Header()
	if got.Code != 200 || h.Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(h.Get("Content-Disposition"), "attachment") {
		t.Fatalf("html named .png must download as octet-stream: %d %v", got.Code, h)
	}
	if h.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(h.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("missing hardening headers: %v", h)
	}
	got = f.get(t, "/api/v1/files/"+png.ID+"?name=pic.png")
	if got.Header().Get("Content-Type") != "image/png" || !strings.HasPrefix(got.Header().Get("Content-Disposition"), "inline") {
		t.Fatalf("png should be inline: %v", got.Header())
	}
}

func TestServeFileRejectsTraversal(t *testing.T) {
	f := newThreadFixture(t)
	dir := f.withFiles(t, 0)
	if err := os.WriteFile(filepath.Join(filepath.Dir(dir), "secret.txt"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"..%2Fsecret.txt", "secret.txt", strings.Repeat("a", 64), "%2e%2e%2f%2e%2e%2fetc%2fpasswd"} {
		got := f.get(t, "/api/v1/files/"+id)
		// A cleaned path may redirect before it reaches the handler; what must
		// never happen is serving the planted file.
		if got.Code == 200 {
			t.Fatalf("GET /files/%s = %d %s", id, got.Code, got.Body.String())
		}
	}
}

func TestMessageAttachmentsComeFromTheStoredBytes(t *testing.T) {
	f := newThreadFixture(t)
	f.withFiles(t, 0)
	var att domain.Attachment
	rec := f.upload(t, "file", "report.pdf", []byte("%PDF-1.4 fake"))
	if err := json.Unmarshal(rec.Body.Bytes(), &att); err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/channels/" + f.team.ID + "/messages"
	var msg domain.Message
	// The client lies about nothing it can control: type and size are ignored on input.
	f.do(t, "POST", base, `{"body":"","attachments":[{"id":"`+att.ID+`","name":"..\\report.pdf"}]}`, 201, &msg)
	if len(msg.Attachments) != 1 || msg.Attachments[0].Name != "report.pdf" || msg.Attachments[0].Size != 13 {
		t.Fatalf("attachments %+v", msg.Attachments)
	}
	f.do(t, "POST", base, `{"body":"","attachments":[{"id":"`+strings.Repeat("b", 64)+`","name":"x"}]}`, 400, nil)
	f.do(t, "POST", base, `{"body":"","attachments":[{"id":"../x","name":"x"}]}`, 400, nil)
	f.do(t, "POST", base, `{"body":""}`, 400, nil)
}

func TestSearchEndpointScopesToReadableChannels(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	other := domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: "other", DisplayName: "Other"}
	private := domain.Channel{ID: store.NewID(), Name: "secret-room", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPrivate, MemberIDs: []string{other.ID}}
	for _, d := range []events.Draft{
		{Type: events.MemberUpdated, Actor: events.System, Payload: other},
		{Type: events.ChannelCreated, Actor: events.System, ChannelID: private.ID, Payload: private},
		{Type: events.MessagePosted, Actor: events.Human(other.ID), ChannelID: private.ID, Payload: domain.Message{ID: store.NewID(), ChannelID: private.ID, AuthorID: other.ID, Body: "launch codes for the zebra"}},
	} {
		if _, err := f.h.Store.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	base := "/api/v1/channels/" + f.team.ID + "/messages"
	f.do(t, "POST", base, `{"body":"the zebra plan is ready"}`, 201, nil)

	var hits []domain.SearchHit
	f.do(t, "GET", "/api/v1/search?q=zebra", "", 200, &hits)
	if len(hits) != 1 || hits[0].Message.ChannelID != f.team.ID {
		t.Fatalf("private channel leaked into search: %+v", hits)
	}
	f.do(t, "GET", "/api/v1/search?q=zebra&channel_id="+private.ID, "", 404, nil)
	f.do(t, "GET", "/api/v1/search?q=zebra&channel_id="+f.team.ID, "", 200, &hits)
	if len(hits) != 1 {
		t.Fatalf("channel scope: %+v", hits)
	}
	f.do(t, "GET", "/api/v1/search?q=", "", 200, &hits)
	if len(hits) != 0 {
		t.Fatalf("empty query: %+v", hits)
	}
}

func TestPinPermissionsAndEvents(t *testing.T) {
	f := newThreadFixture(t)
	base := "/api/v1/channels/" + f.team.ID + "/messages"
	var msg domain.Message
	f.do(t, "POST", base, `{"body":"remember this"}`, 201, &msg)
	pinURL := "/api/v1/messages/" + msg.ID + "/pin"

	f.h.actorForRequest = func(*http.Request) (domain.Member, error) { return f.coder, nil }
	f.do(t, "POST", pinURL, "", 403, nil)
	f.h.actorForRequest = nil

	f.do(t, "POST", pinURL, "", 200, nil)
	f.do(t, "POST", pinURL, "", 200, nil) // repeating changes nothing
	var pins []domain.PinnedMessage
	f.do(t, "GET", "/api/v1/channels/"+f.team.ID+"/pins", "", 200, &pins)
	if len(pins) != 1 || pins[0].Message.ID != msg.ID || pins[0].PinnedBy != f.human.ID {
		t.Fatalf("pins %+v", pins)
	}
	evs, _ := f.h.Store.EventsAfter(context.Background(), 0, 500)
	count := 0
	for _, e := range evs {
		if e.Type == events.MessagePinned {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("pinned events %d, want 1", count)
	}

	f.h.actorForRequest = func(*http.Request) (domain.Member, error) { return f.coder, nil }
	f.do(t, "DELETE", pinURL, "", 403, nil)
	f.h.actorForRequest = nil
	f.do(t, "DELETE", pinURL, "", 200, nil)
	f.do(t, "GET", "/api/v1/channels/"+f.team.ID+"/pins", "", 200, &pins)
	if len(pins) != 0 {
		t.Fatalf("after unpin %+v", pins)
	}
	f.do(t, "POST", "/api/v1/messages/nope/pin", "", 404, nil)
}

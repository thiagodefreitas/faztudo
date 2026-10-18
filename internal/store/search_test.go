package store

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func searchStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	ctx := context.Background()
	for _, id := range []string{"c1", "c2"} {
		if _, err = s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: id, Payload: domain.Channel{ID: id, Name: id, Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic}}); err != nil {
			t.Fatal(err)
		}
	}
	return s
}

func post(t *testing.T, s *Store, id, channel, thread, body string) {
	t.Helper()
	m := domain.Message{ID: id, ChannelID: channel, ThreadID: thread, AuthorID: "h", Body: body, CreatedAt: time.Now().UTC()}
	if _, err := s.Append(context.Background(), events.Draft{Type: events.MessagePosted, Actor: events.Human("h"), ChannelID: channel, Payload: m}); err != nil {
		t.Fatal(err)
	}
}

func ids(hits []domain.SearchHit) string {
	var out []string
	for _, h := range hits {
		out = append(out, h.Message.ID)
	}
	return strings.Join(out, ",")
}

func TestSearchFindsPrefixesAndScopesToChannel(t *testing.T) {
	s := searchStore(t)
	ctx := context.Background()
	post(t, s, "m1", "c1", "", "We should deploy the staging build tonight")
	post(t, s, "m2", "c2", "", "Deploy checklist for production")
	post(t, s, "m3", "c1", "m1", "reply: deploying now")
	post(t, s, "m4", "c1", "", "nothing relevant here")
	hits, err := s.Search(ctx, "deplo", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(hits); got != 3 {
		t.Fatalf("prefix search across channels: %d hits (%s)", got, ids(hits))
	}
	hits, err = s.Search(ctx, "deploy", "c2", 10)
	if err != nil || ids(hits) != "m2" {
		t.Fatalf("channel scope: %s %v", ids(hits), err)
	}
	if !strings.Contains(hits[0].Snippet, "\x01Deploy\x02") {
		t.Fatalf("snippet must mark the match: %q", hits[0].Snippet)
	}
	hits, err = s.Search(ctx, "staging tonight", "", 10)
	if err != nil || ids(hits) != "m1" {
		t.Fatalf("all words must match: %s %v", ids(hits), err)
	}
	for _, q := range []string{"", "   ", `"`, "AND OR NOT", "*", "col:thing", "a(b"} {
		if _, err := s.Search(ctx, q, "", 10); err != nil {
			t.Fatalf("query %q must not error: %v", q, err)
		}
	}
}

func TestSearchRanksTheBetterMatchFirst(t *testing.T) {
	s := searchStore(t)
	if !s.HasFullTextIndex(context.Background()) {
		t.Skip("this SQLite build has no FTS5; ranking applies to the index only")
	}
	post(t, s, "weak", "c1", "", "we talked about many things today and one of them was the release but mostly lunch plans and travel")
	post(t, s, "strong", "c1", "", "release release release")
	hits, err := s.Search(context.Background(), "release", "", 10)
	if err != nil || ids(hits) != "strong,weak" {
		t.Fatalf("ranking: %s %v", ids(hits), err)
	}
}

func TestSearchFollowsEditsAndRebuild(t *testing.T) {
	s := searchStore(t)
	ctx := context.Background()
	post(t, s, "m1", "c1", "", "alpha text")
	edit := struct {
		ID       string    `json:"id"`
		Body     string    `json:"body"`
		EditedAt time.Time `json:"edited_at"`
	}{"m1", "beta text", time.Now().UTC()}
	if _, err := s.Append(ctx, events.Draft{Type: events.MessageEdited, Actor: events.Human("h"), ChannelID: "c1", Payload: edit}); err != nil {
		t.Fatal(err)
	}
	if hits, _ := s.Search(ctx, "alpha", "", 10); len(hits) != 0 {
		t.Fatalf("old body still found: %s", ids(hits))
	}
	if hits, _ := s.Search(ctx, "beta", "", 10); ids(hits) != "m1" {
		t.Fatalf("new body not found: %s", ids(hits))
	}
	if err := s.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	if hits, _ := s.Search(ctx, "beta", "", 10); ids(hits) != "m1" {
		t.Fatalf("rebuild lost the index: %s", ids(hits))
	}
}

func TestSearchLikeFallbackMatchesAndHighlights(t *testing.T) {
	s := searchStore(t)
	post(t, s, "m1", "c1", "", "Ship the Release notes")
	post(t, s, "m2", "c2", "", "unrelated")
	hits, err := s.searchLike(context.Background(), searchTokens("release NOTES"), "", 10)
	if err != nil || ids(hits) != "m1" {
		t.Fatalf("like search: %s %v", ids(hits), err)
	}
	if hits[0].Snippet != "Ship the \x01Release\x02 \x01notes\x02" {
		t.Fatalf("snippet %q", hits[0].Snippet)
	}
}

func TestSearchFindsMessagesPostedBeforeTheIndexExisted(t *testing.T) {
	s := searchStore(t)
	ctx := context.Background()
	if !s.HasFullTextIndex(ctx) {
		t.Skip("no FTS5")
	}
	post(t, s, "m1", "c1", "", "legacy words")
	if _, err := s.db.ExecContext(ctx, "DELETE FROM msg_fts"); err != nil {
		t.Fatal(err)
	}
	setupSearch(s.db)
	if hits, _ := s.Search(ctx, "legacy", "", 10); ids(hits) != "m1" {
		t.Fatalf("backfill: %s", ids(hits))
	}
}

func TestPinsProjectListAndSurviveRebuild(t *testing.T) {
	s := searchStore(t)
	ctx := context.Background()
	post(t, s, "m1", "c1", "", "first")
	post(t, s, "m2", "c1", "", "second")
	pin := func(typ events.Type, id string) {
		t.Helper()
		p := domain.Pin{ChannelID: "c1", MessageID: id, PinnedBy: "h", PinnedAt: time.Now().UTC()}
		if _, err := s.Append(ctx, events.Draft{Type: typ, Actor: events.Human("h"), ChannelID: "c1", Payload: p}); err != nil {
			t.Fatal(err)
		}
	}
	pin(events.MessagePinned, "m1")
	time.Sleep(2 * time.Millisecond)
	pin(events.MessagePinned, "m2")
	pins, err := s.Pins(ctx, "c1")
	if err != nil || len(pins) != 2 || pins[0].Message.ID != "m2" {
		t.Fatalf("pins newest first: %+v %v", pins, err)
	}
	pin(events.MessageUnpinned, "m2")
	if err = s.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	pins, err = s.Pins(ctx, "c1")
	if err != nil || len(pins) != 1 || pins[0].Message.Body != "first" {
		t.Fatalf("after unpin and rebuild: %+v %v", pins, err)
	}
	if ok, _ := s.IsPinned(ctx, "c1", "m1"); !ok {
		t.Fatal("m1 must be pinned")
	}
}

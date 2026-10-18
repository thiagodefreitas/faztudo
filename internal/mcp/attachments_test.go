package mcp

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/files"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestReadContextShowsOnlyTheTriggerMessageAttachments(t *testing.T) {
	ctx := context.Background()
	s := openStore(t)
	h := New(s, nil)
	h.FilesDir = t.TempDir()
	fs := files.Store{Dir: h.FilesDir}

	textID, textSize, err := fs.Put(strings.NewReader("TODO: ship it"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	binID, binSize, err := fs.Put(bytes.NewReader([]byte{0x00, 0x01, 0x02, 0xff}), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	otherID, otherSize, err := fs.Put(strings.NewReader("not for this run"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}

	channel := domain.Channel{ID: store.NewID(), Name: "room", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic, MemberIDs: []string{}}
	trigger := domain.Message{ID: store.NewID(), ChannelID: channel.ID, AuthorID: "h", Body: "see files", CreatedAt: time.Now().UTC(), Attachments: []domain.Attachment{
		{ID: textID, Name: "todo.txt", ContentType: "application/octet-stream", Size: textSize},
		{ID: binID, Name: "blob.bin", ContentType: "application/octet-stream", Size: binSize},
	}}
	earlier := domain.Message{ID: store.NewID(), ChannelID: channel.ID, AuthorID: "h", Body: "old", CreatedAt: trigger.CreatedAt.Add(-time.Minute), Attachments: []domain.Attachment{
		{ID: otherID, Name: "old.txt", ContentType: "application/octet-stream", Size: otherSize},
	}}
	run := domain.Run{ID: store.NewID(), ChannelID: channel.ID, TriggerMessageID: trigger.ID, AgentID: "a1", State: domain.RunRunning}
	for _, d := range []events.Draft{
		{Type: events.ChannelCreated, Actor: events.System, ChannelID: channel.ID, Payload: channel},
		{Type: events.MessagePosted, Actor: events.Human("h"), ChannelID: channel.ID, Payload: earlier},
		{Type: events.MessagePosted, Actor: events.Human("h"), ChannelID: channel.ID, Payload: trigger},
		{Type: events.RunCreated, Actor: events.System, ChannelID: channel.ID, Payload: run},
	} {
		if _, err := s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}

	out, err := h.readContext(ctx, Grant{RunID: run.ID, AgentID: "a1", ChannelID: channel.ID}, 10)
	if err != nil {
		t.Fatal(err)
	}
	byBody := map[string]messageOut{}
	for _, m := range out.Messages {
		byBody[m.Body] = m
	}
	if got := byBody["old"].Attachments; len(got) != 0 {
		t.Fatalf("an earlier message leaked its attachments: %+v", got)
	}
	got := byBody["see files"].Attachments
	if len(got) != 2 || got[0].Text != "TODO: ship it" || got[0].Note != "" {
		t.Fatalf("text attachment: %+v", got)
	}
	if got[1].Text != "" || got[1].Note == "" {
		t.Fatalf("binary attachment must be described, not shown: %+v", got[1])
	}

	h.FilesDir = ""
	out, _ = h.readContext(ctx, Grant{RunID: run.ID, AgentID: "a1", ChannelID: channel.ID}, 10)
	for _, m := range out.Messages {
		for _, a := range m.Attachments {
			if a.Text != "" {
				t.Fatalf("content shown without an upload directory: %+v", a)
			}
		}
	}
}

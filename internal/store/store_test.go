package store

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func TestAppendRebuildAndSubscribe(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	m := domain.Member{ID: "m1", Kind: domain.MemberHuman, Handle: "user", DisplayName: "User", Presence: domain.PresenceOnline}
	first, err := s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: m, IdempotencyKey: "same"})
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: m, IdempotencyKey: "same"})
	if err != nil || first.Seq != again.Seq {
		t.Fatalf("duplicate: %v %v", again, err)
	}
	c := domain.Channel{ID: "c1", Name: "general", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic, MemberIDs: []string{"m1"}}
	replay, err := s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: c.ID, Payload: c})
	if err != nil {
		t.Fatal(err)
	}
	subCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	ch, err := s.Subscribe(subCtx, first.Seq)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-ch:
		if got.Seq != replay.Seq {
			t.Fatal(got.Seq)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no replay event")
	}
	live, err := s.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, Payload: events.NoticePayload{Level: "info", Text: "synthetic"}})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-ch:
		if got.Seq != live.Seq {
			t.Fatal(got.Seq)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no live event")
	}
	before, err := s.Channels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	after, err := s.Channels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(before)
	b, _ := json.Marshal(after)
	if string(a) != string(b) {
		t.Fatalf("rebuild changed projection: %s != %s", a, b)
	}
}

func TestConcurrentAppendAndRollback(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var wg sync.WaitGroup
	for range 30 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := s.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, Payload: events.NoticePayload{Level: "info", Text: "synthetic"}})
			if e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	got, err := s.EventsAfter(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 30 {
		t.Fatal(len(got))
	}
	for i, e := range got {
		if e.Seq != int64(i+1) {
			t.Fatal(e.Seq)
		}
	}
	_, err = s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.System, Payload: domain.Message{ID: "x", ChannelID: "missing", Body: "synthetic"}})
	if err == nil {
		t.Fatal("expected projection failure")
	}
	got, err = s.EventsAfter(ctx, 0, 100)
	if err != nil || len(got) != 30 {
		t.Fatalf("partial write: %d %v", len(got), err)
	}
}

func TestCrashRollbackAndClosedBackup(t *testing.T) {
	path := os.Getenv("FAZTUDO_CRASH_DB")
	if path != "" {
		s, err := Open(path)
		if err != nil {
			os.Exit(2)
		}
		tx, err := s.db.Begin()
		if err != nil {
			os.Exit(3)
		}
		_, err = tx.Exec("INSERT INTO events(id,version,type,actor,channel_id,payload,ts) VALUES(?,?,?,?,?,?,?)", "synthetic", 1, "notice", "system", "", `{"level":"info","text":"synthetic"}`, time.Now().UTC().Format(time.RFC3339Nano))
		if err != nil {
			os.Exit(4)
		}
		os.Exit(0)
	}
	path = filepath.Join(t.TempDir(), "crash.db")
	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashRollbackAndClosedBackup$")
	cmd.Env = append(os.Environ(), "FAZTUDO_CRASH_DB="+path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child: %v %s", err, out)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.EventsAfter(context.Background(), 0, 10)
	if err != nil || len(got) != 0 {
		t.Fatalf("uncommitted event survived: %d %v", len(got), err)
	}
	_, err = s.Append(context.Background(), events.Draft{Type: events.Notice, Actor: events.System, Payload: events.NoticePayload{Level: "info", Text: "synthetic"}})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	copyPath := filepath.Join(t.TempDir(), "backup.db")
	if err = os.WriteFile(copyPath, b, 0600); err != nil {
		t.Fatal(err)
	}
	backup, err := Open(copyPath)
	if err != nil {
		t.Fatal(err)
	}
	defer backup.Close()
	got, err = backup.EventsAfter(context.Background(), 0, 10)
	if err != nil || len(got) != 1 {
		t.Fatalf("backup restore: %d %v", len(got), err)
	}
}

func TestProjectionRebuildWithUnread(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	member := domain.Member{ID: "member", Kind: domain.MemberHuman, Handle: "user", DisplayName: "User"}
	channel := domain.Channel{ID: "channel", Name: "general", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic, MemberIDs: []string{member.ID}}
	message := domain.Message{ID: "message", ChannelID: channel.ID, AuthorID: member.ID, Body: "synthetic", CreatedAt: time.Now().UTC()}
	run := domain.Run{ID: "run", ChannelID: channel.ID, TriggerMessageID: message.ID, AgentID: "agent", State: domain.RunQueued}
	approval := domain.Approval{ID: "approval", ChannelID: channel.ID, Title: "Synthetic", State: domain.ApprovalPending}
	lane := domain.Lane{ID: "codex/default", CLI: "codex", Capacity: 1, Health: domain.LaneUnknown}
	for _, entry := range []struct {
		typ     events.Type
		payload any
		channel string
	}{{events.MemberUpdated, member, ""}, {events.ChannelCreated, channel, channel.ID}, {events.MessagePosted, message, channel.ID}, {events.RunCreated, run, channel.ID}, {events.ApprovalRequested, approval, channel.ID}, {events.LaneUpdated, lane, ""}} {
		if _, err = s.Append(ctx, events.Draft{Type: entry.typ, Actor: events.System, ChannelID: entry.channel, Payload: entry.payload}); err != nil {
			t.Fatal(err)
		}
	}
	n, err := s.Unread(ctx, channel.ID, member.ID)
	if err != nil || n != 1 {
		t.Fatalf("unread before read: %d %v", n, err)
	}
	evt, err := s.EventsAfter(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Read(ctx, channel.ID, member.ID, evt[2].Seq); err != nil {
		t.Fatal(err)
	}
	if err = s.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	n, err = s.Unread(ctx, channel.ID, member.ID)
	if err != nil || n != 0 {
		t.Fatalf("unread after rebuild: %d %v", n, err)
	}
	if got, err := s.Run(ctx, run.ID); err != nil || got.State != run.State {
		t.Fatalf("run: %+v %v", got, err)
	}
	if got, err := s.Approval(ctx, approval.ID); err != nil || got.State != approval.State {
		t.Fatalf("approval: %+v %v", got, err)
	}
	if got, err := s.Lane(ctx, lane.ID); err != nil || got.Capacity != lane.Capacity {
		t.Fatalf("lane: %+v %v", got, err)
	}
}

package store

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/events"
)

// fillOutput inserts n run.output events spread over many runs, straight into
// the events table, which is much faster than Append for a big log.
func fillOutput(t *testing.T, s *Store, n, runs int) {
	t.Helper()
	tx, err := s.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	stmt, err := tx.Prepare("INSERT INTO events(id,version,type,actor,channel_id,payload,ts) VALUES(?,?,?,?,?,?,?)")
	if err != nil {
		t.Fatal(err)
	}
	ts := time.Now().UTC().Format(time.RFC3339Nano)
	for i := 0; i < n; i++ {
		payload := fmt.Sprintf(`{"run_id":"run%d","seq":%d,"stream":"stdout","text":"line %d"}`, i%runs, i/runs+1, i)
		if _, err := stmt.Exec(fmt.Sprintf("e%d", i), 1, string(events.RunOutput), "system", "c1", payload, ts); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func TestRunOutputOnLargeLog(t *testing.T) {
	if testing.Short() {
		t.Skip("fills 300000 events")
	}
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "big.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	fillOutput(t, s, 300000, 600)
	start := time.Now()
	out, err := s.RunOutput(ctx, "run7", 0)
	took := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 500 {
		t.Fatalf("got %d lines, want 500", len(out))
	}
	t.Logf("RunOutput over 300000 events: %v", took)
	// Timing is only a coarse guard (the race detector slows it down); the
	// query plan check below is the real assertion.
	if took > time.Second {
		t.Fatalf("RunOutput took %v, want an indexed lookup", took)
	}
	var plan string
	rows, err := s.rdb.Query("EXPLAIN QUERY PLAN SELECT payload FROM events WHERE type='run.output' AND json_extract(payload,'$.run_id')=? AND CAST(json_extract(payload,'$.seq') AS INTEGER)>? ORDER BY seq", "run7", 0)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var a, b, c int
		var detail string
		if err := rows.Scan(&a, &b, &c, &detail); err != nil {
			t.Fatal(err)
		}
		plan += detail + "\n"
	}
	rows.Close()
	if !strings.Contains(plan, "events_run_output") {
		t.Fatalf("plan does not use the index:\n%s", plan)
	}
}

// An old database gets the index, and with it the backfill, when it opens.
func TestRunOutputIndexIsBackfilledOnOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	fillOutput(t, s, 2000, 10)
	if _, err := s.db.Exec("DROP INDEX events_run_output; DELETE FROM schema_version WHERE version=10"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var n int
	if err := s.rdb.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='events_run_output'").Scan(&n); err != nil || n != 1 {
		t.Fatalf("index count %d %v", n, err)
	}
	out, err := s.RunOutput(context.Background(), "run3", 0)
	if err != nil || len(out) != 200 {
		t.Fatalf("got %d lines, %v", len(out), err)
	}
}

// A long write transaction must not block reads, and a long read must not
// block Append.
func TestReadsRunBesideAWrite(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "rw.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	fillOutput(t, s, 1000, 10)
	tx, err := s.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("INSERT INTO events(id,version,type,actor,channel_id,payload,ts) VALUES('hold',1,'notice','system','c1','{}','x')"); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		out, err := s.RunOutput(ctx, "run1", 0)
		if err == nil && len(out) != 100 {
			err = errors.New("wrong line count")
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("read blocked behind an open write transaction")
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func TestSubscribeWakesOnAppendAndKeepsOrder(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s, err := Open(filepath.Join(t.TempDir(), "sub.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ch, err := s.Subscribe(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond) // let the subscriber go idle
	start := time.Now()
	for i := 0; i < 50; i++ {
		if _, err := s.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, ChannelID: "c1", Payload: events.NoticePayload{Level: "info", Text: "n"}}); err != nil {
			t.Fatal(err)
		}
	}
	var last int64
	for i := 0; i < 50; i++ {
		select {
		case e := <-ch:
			if e.Seq != last+1 {
				t.Fatalf("seq %d after %d", e.Seq, last)
			}
			last = e.Seq
		case <-time.After(3 * time.Second):
			t.Fatalf("only %d events arrived", i)
		}
	}
	// The old poll took 20 ms per idle round; the wake does not wait for it.
	if took := time.Since(start); took > 500*time.Millisecond {
		t.Fatalf("50 events took %v", took)
	}
}

func TestSubscribeEndsWithTheStore(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "end.db"))
	if err != nil {
		t.Fatal(err)
	}
	ch, err := s.Subscribe(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("unexpected event")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("subscription outlived the store")
	}
}

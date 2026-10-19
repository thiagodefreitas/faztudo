package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/oklog/ulid/v2"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrations embed.FS

var ErrNotFound = errors.New("not found")
var ErrConflict = errors.New("conflict")
var ErrInvalidOption = errors.New("invalid option")

// Store keeps all writes on one connection (db, so Append keeps its order) and
// serves reads from a separate pool (rdb), which WAL lets run beside a write.
type Store struct {
	db     *sql.DB
	rdb    *sql.DB
	closed chan struct{}
	mu     sync.Mutex
	wakeCh chan struct{}
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, err
	}
	fi, err := file.Stat()
	file.Close()
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() || fi.Mode().Perm()&0077 != 0 {
		return nil, errors.New("database must be a private regular file")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	for _, q := range []string{"PRAGMA journal_mode=WAL", "PRAGMA busy_timeout=5000", "PRAGMA foreign_keys=ON"} {
		if _, err = db.Exec(q); err != nil {
			db.Close()
			return nil, err
		}
	}
	migration, err := migrations.ReadFile("migrations/001.sql")
	if err != nil {
		db.Close()
		return nil, err
	}
	if _, err = db.Exec(string(migration)); err != nil {
		db.Close()
		return nil, err
	}
	var version int
	if err = db.QueryRow("SELECT max(version) FROM schema_version").Scan(&version); err != nil {
		db.Close()
		return nil, err
	}
	if version < 2 {
		migration, err = migrations.ReadFile("migrations/002.sql")
		if err == nil {
			_, err = db.Exec(string(migration))
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	if version < 3 {
		migration, err = migrations.ReadFile("migrations/003.sql")
		if err == nil {
			_, err = db.Exec(string(migration))
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	if version < 4 {
		migration, err = migrations.ReadFile("migrations/004.sql")
		if err == nil {
			_, err = db.Exec(string(migration))
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	if version < 5 {
		migration, err = migrations.ReadFile("migrations/005.sql")
		if err == nil {
			_, err = db.Exec(string(migration))
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	if version < 6 {
		migration, err = migrations.ReadFile("migrations/006.sql")
		if err == nil {
			_, err = db.Exec(string(migration))
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	if version < 7 {
		migration, err = migrations.ReadFile("migrations/007.sql")
		if err == nil {
			_, err = db.Exec(string(migration))
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	if version < 8 {
		migration, err = migrations.ReadFile("migrations/008.sql")
		if err == nil {
			_, err = db.Exec(string(migration))
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	if version < 9 {
		migration, err = migrations.ReadFile("migrations/009.sql")
		if err == nil {
			_, err = db.Exec(string(migration))
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	if version < 10 {
		migration, err = migrations.ReadFile("migrations/010.sql")
		if err == nil {
			_, err = db.Exec(string(migration))
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	// Search is optional: if this SQLite build has no FTS5 the table is not
	// created and Search falls back to LIKE.
	setupSearch(db)
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "query_only(1)")
	rdb, err := sql.Open("sqlite", (&url.URL{Scheme: "file", Path: path, RawQuery: q.Encode()}).String())
	if err != nil {
		db.Close()
		return nil, err
	}
	rdb.SetMaxOpenConns(4)
	return &Store{db: db, rdb: rdb, closed: make(chan struct{}), wakeCh: make(chan struct{})}, nil
}
func (s *Store) Close() error {
	select {
	case <-s.closed:
	default:
		close(s.closed)
	}
	s.rdb.Close()
	return s.db.Close()
}

// wake tells subscribers that the log grew.
func (s *Store) wake() {
	s.mu.Lock()
	close(s.wakeCh)
	s.wakeCh = make(chan struct{})
	s.mu.Unlock()
}
func (s *Store) woken() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.wakeCh
}
func NewID() string { return ulid.MustNew(ulid.Timestamp(time.Now()), rand.Reader).String() }

func (s *Store) Append(ctx context.Context, d events.Draft) (events.Event, error) {
	if d.Type == "" || d.Actor == "" {
		return events.Event{}, errors.New("type and actor required")
	}
	payload, err := json.Marshal(d.Payload)
	if err != nil {
		return events.Event{}, err
	}
	if !json.Valid(payload) {
		return events.Event{}, errors.New("invalid payload")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return events.Event{}, err
	}
	defer tx.Rollback()
	if d.IdempotencyKey != "" {
		e, err := eventByKey(ctx, tx, d.ChannelID, d.IdempotencyKey)
		if err == nil {
			return e, tx.Commit()
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return events.Event{}, err
		}
	}
	e, err := appendTx(ctx, tx, d, payload)
	if err != nil {
		return events.Event{}, storeError(err)
	}
	if err = tx.Commit(); err != nil {
		return events.Event{}, err
	}
	s.wake()
	return e, nil
}

func storeError(err error) error {
	var sqlErr *sqlite.Error
	if errors.As(err, &sqlErr) && sqlErr.Code()&255 == 19 {
		return fmt.Errorf("%w: %v", ErrConflict, err)
	}
	return err
}

func appendTx(ctx context.Context, tx *sql.Tx, d events.Draft, payload []byte) (events.Event, error) {
	version := d.Version
	if version == 0 {
		version = 1
	}
	e := events.Event{ID: NewID(), Type: d.Type, Version: version, Actor: d.Actor, ChannelID: d.ChannelID, IdempotencyKey: d.IdempotencyKey, Payload: payload, TS: time.Now().UTC()}
	var key any
	if d.IdempotencyKey != "" {
		key = d.IdempotencyKey
	}
	res, err := tx.ExecContext(ctx, "INSERT INTO events(id,version,type,actor,channel_id,idempotency_key,payload,ts) VALUES(?,?,?,?,?,?,?,?)", e.ID, e.Version, e.Type, e.Actor, e.ChannelID, key, e.Payload, e.TS.Format(time.RFC3339Nano))
	if err != nil {
		return events.Event{}, err
	}
	e.Seq, err = res.LastInsertId()
	if err != nil {
		return events.Event{}, err
	}
	if err = project(ctx, tx, e); err != nil {
		return events.Event{}, err
	}
	return e, nil
}
func eventByKey(ctx context.Context, tx *sql.Tx, channel, key string) (events.Event, error) {
	return scanEvent(tx.QueryRowContext(ctx, "SELECT seq,id,version,type,actor,channel_id,COALESCE(idempotency_key,''),payload,ts FROM events WHERE channel_id=? AND idempotency_key=?", channel, key))
}
func scanEvent(row interface{ Scan(...any) error }) (events.Event, error) {
	var e events.Event
	var ts string
	err := row.Scan(&e.Seq, &e.ID, &e.Version, &e.Type, &e.Actor, &e.ChannelID, &e.IdempotencyKey, &e.Payload, &ts)
	if err != nil {
		return e, err
	}
	e.TS, err = time.Parse(time.RFC3339Nano, ts)
	return e, err
}
func (s *Store) Event(ctx context.Context, id string) (events.Event, error) {
	e, err := scanEvent(s.rdb.QueryRowContext(ctx, "SELECT seq,id,version,type,actor,channel_id,COALESCE(idempotency_key,''),payload,ts FROM events WHERE id=?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return e, ErrNotFound
	}
	return e, err
}

// LastSeq is the sequence number of the newest event, 0 for an empty log.
func (s *Store) LastSeq(ctx context.Context) (int64, error) {
	var seq int64
	err := s.rdb.QueryRowContext(ctx, "SELECT COALESCE(MAX(seq),0) FROM events").Scan(&seq)
	return seq, err
}
func (s *Store) EventsAfter(ctx context.Context, after int64, limit int) ([]events.Event, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := s.rdb.QueryContext(ctx, "SELECT seq,id,version,type,actor,channel_id,COALESCE(idempotency_key,''),payload,ts FROM events WHERE seq>? ORDER BY seq LIMIT ?", after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []events.Event{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// EventsOfTypes returns one channel's events of the given types in log
// order, through the events_type_channel index.
func (s *Store) EventsOfTypes(ctx context.Context, channelID string, types ...events.Type) ([]events.Event, error) {
	out := []events.Event{}
	for _, t := range types {
		rows, err := s.rdb.QueryContext(ctx, "SELECT seq,id,version,type,actor,channel_id,COALESCE(idempotency_key,''),payload,ts FROM events WHERE type=? AND channel_id=? ORDER BY seq", string(t), channelID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			e, err := scanEvent(rows)
			if err != nil {
				rows.Close()
				return nil, err
			}
			out = append(out, e)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out, nil
}
func (s *Store) Subscribe(ctx context.Context, afterSeq int64) (<-chan events.Event, error) {
	if afterSeq < 0 {
		return nil, errors.New("negative cursor")
	}
	ch := make(chan events.Event, 32)
	go func() {
		defer close(ch)
		// Append wakes the loop; the slow ticker only covers a write made by
		// another process. A read error is retried with backoff from the last
		// delivered seq, it does not end the subscription.
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		backoff := 100 * time.Millisecond
		for {
			wake := s.woken()
			batch, err := s.EventsAfter(ctx, afterSeq, 200)
			if err != nil {
				select {
				case <-ctx.Done():
					return
				case <-s.closed:
					return
				case <-time.After(backoff):
				}
				if backoff *= 2; backoff > 5*time.Second {
					backoff = 5 * time.Second
				}
				continue
			}
			backoff = 100 * time.Millisecond
			for _, e := range batch {
				select {
				case ch <- e:
					afterSeq = e.Seq
				case <-ctx.Done():
					return
				}
			}
			if len(batch) == 200 {
				continue
			}
			select {
			case <-ctx.Done():
				return
			case <-s.closed:
				return
			case <-wake:
			case <-ticker.C:
			}
		}
	}()
	return ch, nil
}
func (s *Store) Rebuild(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range []string{"unread", "messages", "channels", "members", "runs", "approvals", "lanes", "org", "lane_usage_history", "channel_summaries", "pins", "tasks"} {
		if _, err = tx.ExecContext(ctx, "DELETE FROM "+table); err != nil {
			return err
		}
	}
	if err = clearIndex(ctx, tx); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, "SELECT seq,id,version,type,actor,channel_id,COALESCE(idempotency_key,''),payload,ts FROM events ORDER BY seq")
	if err != nil {
		return err
	}
	var all []events.Event
	for rows.Next() {
		e, eerr := scanEvent(rows)
		if eerr != nil {
			rows.Close()
			return eerr
		}
		all = append(all, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, e := range all {
		if err = project(ctx, tx, e); err != nil {
			return fmt.Errorf("project seq %d: %w", e.Seq, err)
		}
	}
	return tx.Commit()
}
func project(ctx context.Context, tx *sql.Tx, e events.Event) error {
	switch e.Type {
	case events.MemberUpdated:
		var m domain.Member
		if err := json.Unmarshal(e.Payload, &m); err != nil {
			return err
		}
		if m.ID == "" || m.Handle == "" {
			return errors.New("member id and handle required")
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO members(id,handle,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET handle=excluded.handle,data=excluded.data", m.ID, m.Handle, e.Payload)
		return err
	case events.ChannelCreated, events.ChannelUpdated:
		var c domain.Channel
		if err := json.Unmarshal(e.Payload, &c); err != nil {
			return err
		}
		if c.ID == "" || c.Name == "" {
			return errors.New("channel id and name required")
		}
		c.LastSeq = e.Seq
		if c.MemberIDs == nil {
			c.MemberIDs = []string{}
		}
		b, _ := json.Marshal(c)
		_, err := tx.ExecContext(ctx, "INSERT INTO channels(id,name,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data", c.ID, c.Name, b)
		if err != nil {
			return err
		}
		for _, id := range c.MemberIDs {
			if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO unread(channel_id,member_id) VALUES(?,?)", c.ID, id); err != nil {
				return err
			}
		}
		return nil
	case events.MessagePosted:
		var m domain.Message
		if err := json.Unmarshal(e.Payload, &m); err != nil {
			return err
		}
		if m.ID == "" || m.ChannelID == "" {
			return errors.New("message id and channel required")
		}
		if m.CreatedAt.IsZero() {
			m.CreatedAt = e.TS
		}
		if m.Mentions == nil {
			m.Mentions = []string{}
		}
		b, _ := json.Marshal(m)
		_, err := tx.ExecContext(ctx, "INSERT INTO messages(id,channel_id,thread_id,created_at,data) VALUES(?,?,?,?,?)", m.ID, m.ChannelID, m.ThreadID, m.CreatedAt.Format(time.RFC3339Nano), b)
		if err != nil {
			return err
		}
		if m.ThreadID != "" {
			if _, err = tx.ExecContext(ctx, "UPDATE messages SET data=json_set(data,'$.reply_count',COALESCE(json_extract(data,'$.reply_count'),0)+1) WHERE id=?", m.ThreadID); err != nil {
				return err
			}
		}
		if err = indexMessage(ctx, tx, m.ID, m.ChannelID, m.Body); err != nil {
			return err
		}
		return updateChannelSeq(ctx, tx, m.ChannelID, e.Seq)
	case events.MessagePinned:
		var p domain.Pin
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		if p.ChannelID == "" || p.MessageID == "" || p.PinnedBy == "" {
			return errors.New("pin needs channel, message and pinned_by")
		}
		if p.PinnedAt.IsZero() {
			p.PinnedAt = e.TS
		}
		_, err := tx.ExecContext(ctx, "INSERT OR REPLACE INTO pins(channel_id,message_id,pinned_by,pinned_at) VALUES(?,?,?,?)", p.ChannelID, p.MessageID, p.PinnedBy, p.PinnedAt.Format(time.RFC3339Nano))
		return err
	case events.MessageUnpinned:
		var p domain.Pin
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "DELETE FROM pins WHERE channel_id=? AND message_id=?", p.ChannelID, p.MessageID)
		return err
	case events.MessageEdited:
		var m struct {
			ID       string    `json:"id"`
			Body     string    `json:"body"`
			EditedAt time.Time `json:"edited_at"`
		}
		if err := json.Unmarshal(e.Payload, &m); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "UPDATE messages SET data=json_set(data,'$.body',?,'$.edited_at',?) WHERE id=?", m.Body, m.EditedAt.Format(time.RFC3339Nano), m.ID)
		if err != nil {
			return err
		}
		return reindexMessage(ctx, tx, m.ID, m.Body)
	case events.RunCreated, events.RunUpdated:
		var r domain.Run
		if err := json.Unmarshal(e.Payload, &r); err != nil {
			return err
		}
		if r.ID == "" {
			return errors.New("run id required")
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO runs(id,channel_id,state,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET channel_id=excluded.channel_id,state=excluded.state,data=excluded.data", r.ID, r.ChannelID, r.State, e.Payload)
		return err
	case events.ApprovalRequested, events.ApprovalResolved:
		var a domain.Approval
		if err := json.Unmarshal(e.Payload, &a); err != nil {
			return err
		}
		if a.ID == "" {
			return errors.New("approval id required")
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO approvals(id,state,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data", a.ID, a.State, e.Payload)
		return err
	case events.LaneUpdated:
		var l domain.Lane
		if err := json.Unmarshal(e.Payload, &l); err != nil {
			return err
		}
		if l.ID == "" {
			return errors.New("lane id required")
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO lanes(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", l.ID, e.Payload)
		return err
	case events.LaneUsageRead:
		var reading LaneUsageReading
		if err := json.Unmarshal(e.Payload, &reading); err != nil {
			return err
		}
		if reading.LaneID == "" || reading.Window.Name == "" || reading.ReadAt.IsZero() {
			return errors.New("invalid lane usage reading")
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO lane_usage_history(seq,lane_id,window_name,measured_at,data) VALUES(?,?,?,?,?)", e.Seq, reading.LaneID, reading.Window.Name, reading.ReadAt.UTC().Format("2006-01-02T15:04:05.000000000Z"), e.Payload)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "DELETE FROM lane_usage_history WHERE measured_at<?", time.Now().UTC().Add(-31*24*time.Hour).Format("2006-01-02T15:04:05.000000000Z"))
		return err
	case events.ChannelSummarized:
		var summary ChannelSummary
		if err := json.Unmarshal(e.Payload, &summary); err != nil {
			return err
		}
		if summary.ChannelID == "" || summary.ThroughMessageID == "" {
			return errors.New("invalid channel summary")
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO channel_summaries(channel_id,data) VALUES(?,?) ON CONFLICT(channel_id) DO UPDATE SET data=excluded.data", summary.ChannelID, e.Payload)
		return err
	case events.DepartmentUpdated:
		var d domain.Department
		if err := json.Unmarshal(e.Payload, &d); err != nil {
			return err
		}
		if d.Handle == "" {
			return errors.New("department handle required")
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO org(kind,handle,data) VALUES('department',?,?) ON CONFLICT(kind,handle) DO UPDATE SET data=excluded.data", d.Handle, e.Payload)
		return err
	case events.ProjectUpdated:
		var p domain.Project
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		if p.Handle == "" {
			return errors.New("project handle required")
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO org(kind,handle,data) VALUES('project',?,?) ON CONFLICT(kind,handle) DO UPDATE SET data=excluded.data", p.Handle, e.Payload)
		return err
	case events.RoutineUpdated:
		var r domain.Routine
		if err := json.Unmarshal(e.Payload, &r); err != nil {
			return err
		}
		if r.Handle == "" {
			return errors.New("routine handle required")
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO org(kind,handle,data) VALUES('routine',?,?) ON CONFLICT(kind,handle) DO UPDATE SET data=excluded.data", r.Handle, e.Payload)
		return err
	case events.TaskCreated, events.TaskUpdated:
		var t domain.Task
		if err := json.Unmarshal(e.Payload, &t); err != nil {
			return err
		}
		if t.ID == "" || t.ChannelID == "" {
			return errors.New("task id and channel required")
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO tasks(id,channel_id,message_id,status,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id,status=excluded.status,data=excluded.data", t.ID, t.ChannelID, t.MessageID, t.Status, e.Payload)
		return err
	case events.Type("channel.read"):
		var read struct {
			ChannelID string `json:"channel_id"`
			MemberID  string `json:"member_id"`
			Seq       int64  `json:"seq"`
		}
		if err := json.Unmarshal(e.Payload, &read); err != nil {
			return err
		}
		if read.ChannelID == "" || read.MemberID == "" || read.Seq < 0 {
			return errors.New("invalid read cursor")
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO unread(channel_id,member_id,last_read_seq) VALUES(?,?,?) ON CONFLICT(channel_id,member_id) DO UPDATE SET last_read_seq=max(last_read_seq,excluded.last_read_seq)", read.ChannelID, read.MemberID, read.Seq)
		return err
	case events.PresenceChanged:
		var p struct {
			MemberID string          `json:"member_id"`
			Presence domain.Presence `json:"presence"`
		}
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "UPDATE members SET data=json_set(data,'$.presence',?) WHERE id=?", p.Presence, p.MemberID)
		return err
	default:
		return nil
	}
}
func updateChannelSeq(ctx context.Context, tx *sql.Tx, id string, seq int64) error {
	_, err := tx.ExecContext(ctx, "UPDATE channels SET data=json_set(data,'$.last_seq',?) WHERE id=?", seq, id)
	return err
}
func (s *Store) Read(ctx context.Context, channelID, memberID string, seq int64) error {
	_, err := s.Append(ctx, events.Draft{Type: events.Type("channel.read"), Actor: events.Human(memberID), ChannelID: channelID, Payload: struct {
		ChannelID string `json:"channel_id"`
		MemberID  string `json:"member_id"`
		Seq       int64  `json:"seq"`
	}{channelID, memberID, seq}})
	return err
}
func queryJSON[T any](ctx context.Context, db *sql.DB, q string, args ...any) ([]T, error) {
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		var v T
		if err = json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func oneJSON[T any](ctx context.Context, db *sql.DB, q string, args ...any) (T, error) {
	var v T
	var raw []byte
	err := db.QueryRowContext(ctx, q, args...).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, ErrNotFound
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(raw, &v)
	return v, err
}
func (s *Store) Members(ctx context.Context) ([]domain.Member, error) {
	return queryJSON[domain.Member](ctx, s.db, "SELECT data FROM members ORDER BY handle")
}
func (s *Store) Member(ctx context.Context, id string) (domain.Member, error) {
	return oneJSON[domain.Member](ctx, s.db, "SELECT data FROM members WHERE id=?", id)
}
func (s *Store) MemberByHandle(ctx context.Context, handle string) (domain.Member, error) {
	return oneJSON[domain.Member](ctx, s.db, "SELECT data FROM members WHERE handle=?", handle)
}
func (s *Store) Channels(ctx context.Context) ([]domain.Channel, error) {
	return queryJSON[domain.Channel](ctx, s.db, "SELECT data FROM channels ORDER BY name")
}
func (s *Store) Channel(ctx context.Context, id string) (domain.Channel, error) {
	return oneJSON[domain.Channel](ctx, s.db, "SELECT data FROM channels WHERE id=?", id)
}
func (s *Store) Message(ctx context.Context, id string) (domain.Message, error) {
	return oneJSON[domain.Message](ctx, s.db, "SELECT data FROM messages WHERE id=?", id)
}

// FileChannels lists the channels with a message that attaches the file id.
func (s *Store) FileChannels(ctx context.Context, fileID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT channel_id FROM messages WHERE instr(data, ?)>0`, `"id":"`+fileID+`"`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) Messages(ctx context.Context, channelID, before string, limit int) ([]domain.Message, error) {
	return s.messages(ctx, channelID, before, limit, false)
}

// RootMessages is Messages without thread replies: the channel transcript.
func (s *Store) RootMessages(ctx context.Context, channelID, before string, limit int) ([]domain.Message, error) {
	return s.messages(ctx, channelID, before, limit, true)
}
func (s *Store) messages(ctx context.Context, channelID, before string, limit int, rootsOnly bool) ([]domain.Message, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	cutoff := "9999"
	cutoffID := "9999"
	if before != "" {
		m, err := s.Message(ctx, before)
		if err != nil {
			return nil, err
		}
		if m.ChannelID != channelID {
			return nil, ErrNotFound
		}
		cutoff = m.CreatedAt.Format(time.RFC3339Nano)
		cutoffID = m.ID
	}
	return queryJSON[domain.Message](ctx, s.db, "SELECT data FROM (SELECT data,created_at,id FROM messages WHERE channel_id=? AND (?=0 OR thread_id='') AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?) ORDER BY created_at,id", channelID, rootsOnly, cutoff, cutoff, cutoffID, limit)
}
func (s *Store) Thread(ctx context.Context, id string) ([]domain.Message, error) {
	return queryJSON[domain.Message](ctx, s.db, "SELECT data FROM messages WHERE id=? OR thread_id=? ORDER BY created_at,id", id, id)
}
func (s *Store) Runs(ctx context.Context, channelID, state string) ([]domain.Run, error) {
	return queryJSON[domain.Run](ctx, s.db, "SELECT data FROM runs WHERE (?='' OR channel_id=?) AND (?='' OR state=?) ORDER BY id", channelID, channelID, state, state)
}
func (s *Store) Run(ctx context.Context, id string) (domain.Run, error) {
	return oneJSON[domain.Run](ctx, s.db, "SELECT data FROM runs WHERE id=?", id)
}
func (s *Store) Approvals(ctx context.Context, state string) ([]domain.Approval, error) {
	return queryJSON[domain.Approval](ctx, s.db, "SELECT data FROM approvals WHERE (?='' OR state=?) ORDER BY id", state, state)
}
func (s *Store) Approval(ctx context.Context, id string) (domain.Approval, error) {
	return oneJSON[domain.Approval](ctx, s.db, "SELECT data FROM approvals WHERE id=?", id)
}

// ResolveApproval checks pending state and appends its resolution in one transaction.
func (s *Store) ResolveApproval(ctx context.Context, id, option, note, by string) (domain.Approval, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Approval{}, err
	}
	defer tx.Rollback()
	var raw []byte
	if err := tx.QueryRowContext(ctx, "SELECT data FROM approvals WHERE id=?", id).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.Approval{}, ErrNotFound
		}
		return domain.Approval{}, err
	}
	var approval domain.Approval
	if err := json.Unmarshal(raw, &approval); err != nil {
		return domain.Approval{}, err
	}
	if approval.State != domain.ApprovalPending {
		return domain.Approval{}, ErrConflict
	}
	valid := false
	for _, o := range approval.Options {
		valid = valid || o.Key == option
	}
	if !valid {
		return domain.Approval{}, ErrInvalidOption
	}
	approval.State = domain.ApprovalResolved
	approval.Resolution = &domain.ApprovalResolution{Option: option, By: by, At: time.Now().UTC(), Note: note}
	payload, err := json.Marshal(approval)
	if err != nil {
		return domain.Approval{}, err
	}
	if _, err := appendTx(ctx, tx, events.Draft{Type: events.ApprovalResolved, Actor: events.Human(by), ChannelID: approval.ChannelID}, payload); err != nil {
		return domain.Approval{}, storeError(err)
	}
	if err := tx.Commit(); err != nil {
		return domain.Approval{}, err
	}
	s.wake()
	return approval, nil
}
func (s *Store) Departments(ctx context.Context) ([]domain.Department, error) {
	return queryJSON[domain.Department](ctx, s.db, "SELECT data FROM org WHERE kind='department' ORDER BY handle")
}
func (s *Store) Projects(ctx context.Context) ([]domain.Project, error) {
	return queryJSON[domain.Project](ctx, s.db, "SELECT data FROM org WHERE kind='project' ORDER BY handle")
}
func (s *Store) Project(ctx context.Context, handle string) (domain.Project, error) {
	return oneJSON[domain.Project](ctx, s.db, "SELECT data FROM org WHERE kind='project' AND handle=?", handle)
}

// Routines lists the routines. They share the org table, as kind "routine".
func (s *Store) Routines(ctx context.Context) ([]domain.Routine, error) {
	return queryJSON[domain.Routine](ctx, s.db, "SELECT data FROM org WHERE kind='routine' ORDER BY handle")
}
func (s *Store) Routine(ctx context.Context, handle string) (domain.Routine, error) {
	return oneJSON[domain.Routine](ctx, s.db, "SELECT data FROM org WHERE kind='routine' AND handle=?", handle)
}
func (s *Store) Lanes(ctx context.Context) ([]domain.Lane, error) {
	return queryJSON[domain.Lane](ctx, s.db, "SELECT data FROM lanes ORDER BY id")
}
func (s *Store) Lane(ctx context.Context, id string) (domain.Lane, error) {
	return oneJSON[domain.Lane](ctx, s.db, "SELECT data FROM lanes WHERE id=?", id)
}
func (s *Store) RunOutput(ctx context.Context, id string, after int) ([]events.RunOutputPayload, error) {
	rows, err := s.rdb.QueryContext(ctx, "SELECT payload FROM events WHERE type='run.output' AND json_extract(payload,'$.run_id')=? AND CAST(json_extract(payload,'$.seq') AS INTEGER)>? ORDER BY seq", id, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []events.RunOutputPayload{}
	for rows.Next() {
		var b []byte
		if err = rows.Scan(&b); err != nil {
			return nil, err
		}
		var p events.RunOutputPayload
		if err = json.Unmarshal(b, &p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
func (s *Store) Unread(ctx context.Context, channelID, memberID string) (int, error) {
	var n int
	err := s.rdb.QueryRowContext(ctx, "SELECT COUNT(*) FROM events e LEFT JOIN unread u ON u.channel_id=e.channel_id AND u.member_id=? WHERE e.channel_id=? AND e.type=? AND e.seq>COALESCE(u.last_read_seq,0)", memberID, channelID, events.MessagePosted).Scan(&n)
	return n, err
}

var _ events.Appender = (*Store)(nil)
var _ events.Subscriber = (*Store)(nil)

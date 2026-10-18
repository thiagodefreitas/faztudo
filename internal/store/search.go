package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"
	"unicode"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// Search finds messages by body. It uses an FTS5 index (bm25 ranking, prefix
// match on the last word) when this SQLite build has FTS5, and a plain LIKE
// scan, newest first, when it does not. Snippets mark each match with U+0001
// before and U+0002 after. Thread replies are included; a hit carries its
// thread_id so a client can open the thread.
//
// Note on the fallback: the index is created at start-up and kept in step with
// the event log in project(). If FTS5 is missing, nothing is indexed and every
// search scans the messages table, which is fine for a personal workspace.
func (s *Store) Search(ctx context.Context, query, channelID string, limit int) ([]domain.SearchHit, error) {
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	tokens := searchTokens(query)
	if len(tokens) == 0 {
		return []domain.SearchHit{}, nil
	}
	if hasIndex(ctx, s.db) {
		return s.searchFTS(ctx, tokens, channelID, limit)
	}
	return s.searchLike(ctx, tokens, channelID, limit)
}

// HasFullTextIndex reports whether searches use FTS5.
func (s *Store) HasFullTextIndex(ctx context.Context) bool { return hasIndex(ctx, s.db) }

// searchTokens splits a query into lowercase words of letters and digits, so
// no query text can reach the FTS5 query syntax.
func searchTokens(q string) []string {
	var out []string
	for _, w := range strings.FieldsFunc(strings.ToLower(q), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		out = append(out, w)
		if len(out) == 8 {
			break
		}
	}
	return out
}

func (s *Store) searchFTS(ctx context.Context, tokens []string, channelID string, limit int) ([]domain.SearchHit, error) {
	parts := make([]string, len(tokens))
	for i, t := range tokens {
		parts[i] = `"` + t + `"`
	}
	parts[len(parts)-1] += "*"
	rows, err := s.db.QueryContext(ctx, "SELECT m.data, snippet(msg_fts,0,char(1),char(2),'...',12) FROM msg_fts JOIN messages m ON m.id=msg_fts.message_id WHERE msg_fts MATCH ? AND (?='' OR msg_fts.channel_id=?) ORDER BY rank LIMIT ?", strings.Join(parts, " "), channelID, channelID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanHits(rows, nil)
}

func (s *Store) searchLike(ctx context.Context, tokens []string, channelID string, limit int) ([]domain.SearchHit, error) {
	q := "SELECT data FROM messages WHERE (?='' OR channel_id=?)"
	args := []any{channelID, channelID}
	for _, t := range tokens {
		q += " AND lower(json_extract(data,'$.body')) LIKE ?"
		args = append(args, "%"+t+"%")
	}
	q += " ORDER BY created_at DESC, id DESC LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanHits(rows, tokens)
}

// scanHits reads rows of (data) or (data, snippet). When tokens is set the
// snippet is built here.
func scanHits(rows *sql.Rows, tokens []string) ([]domain.SearchHit, error) {
	out := []domain.SearchHit{}
	for rows.Next() {
		var raw []byte
		var snippet string
		var err error
		if tokens == nil {
			err = rows.Scan(&raw, &snippet)
		} else {
			err = rows.Scan(&raw)
		}
		if err != nil {
			return nil, err
		}
		var m domain.Message
		if err = json.Unmarshal(raw, &m); err != nil {
			return nil, err
		}
		if tokens != nil {
			snippet = likeSnippet(m.Body, tokens)
		}
		out = append(out, domain.SearchHit{Message: m, Snippet: snippet})
	}
	return out, rows.Err()
}

// likeSnippet cuts a window around the first match and marks every match in it.
func likeSnippet(body string, tokens []string) string {
	lower := strings.ToLower(body)
	if len(lower) != len(body) {
		lower = body // case folding changed byte lengths; match case-sensitively
	}
	first := -1
	for _, t := range tokens {
		if i := strings.Index(lower, t); i >= 0 && (first < 0 || i < first) {
			first = i
		}
	}
	if first < 0 {
		first = 0
	}
	start, end := first-40, first+80
	if start < 0 {
		start = 0
	}
	if end > len(body) {
		end = len(body)
	}
	for start > 0 && !isRuneStart(body[start]) {
		start--
	}
	for end < len(body) && !isRuneStart(body[end]) {
		end++
	}
	window, lowerWindow := body[start:end], lower[start:end]
	var b strings.Builder
	if start > 0 {
		b.WriteString("...")
	}
	for i := 0; i < len(window); {
		hit := 0
		for _, t := range tokens {
			if len(t) > hit && strings.HasPrefix(lowerWindow[i:], t) {
				hit = len(t)
			}
		}
		if hit == 0 {
			b.WriteByte(window[i])
			i++
			continue
		}
		b.WriteString("\x01" + window[i:i+hit] + "\x02")
		i += hit
	}
	if end < len(body) {
		b.WriteString("...")
	}
	return b.String()
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

type sqlRunner interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func hasIndex(ctx context.Context, q sqlRunner) bool {
	var n int
	return q.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE name='msg_fts'").Scan(&n) == nil && n > 0
}

// setupSearch creates the index and fills it for messages that predate it.
// Any failure leaves search on the LIKE fallback.
func setupSearch(db *sql.DB) {
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, "CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(body, message_id UNINDEXED, channel_id UNINDEXED, tokenize='unicode61 remove_diacritics 2')"); err != nil {
		return
	}
	var indexed, total int
	if db.QueryRowContext(ctx, "SELECT count(*) FROM msg_fts").Scan(&indexed) != nil || db.QueryRowContext(ctx, "SELECT count(*) FROM messages").Scan(&total) != nil {
		return
	}
	if indexed < total {
		_, _ = db.ExecContext(ctx, "INSERT INTO msg_fts(body,message_id,channel_id) SELECT json_extract(data,'$.body'), id, channel_id FROM messages WHERE id NOT IN (SELECT message_id FROM msg_fts)")
	}
}

func indexMessage(ctx context.Context, tx sqlRunner, id, channelID, body string) error {
	if !hasIndex(ctx, tx) {
		return nil
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO msg_fts(body,message_id,channel_id) VALUES(?,?,?)", body, id, channelID)
	return err
}

func reindexMessage(ctx context.Context, tx sqlRunner, id, body string) error {
	if !hasIndex(ctx, tx) {
		return nil
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM msg_fts WHERE message_id=?", id); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO msg_fts(body,message_id,channel_id) SELECT ?, id, channel_id FROM messages WHERE id=?", body, id)
	return err
}

func clearIndex(ctx context.Context, tx sqlRunner) error {
	if !hasIndex(ctx, tx) {
		return nil
	}
	_, err := tx.ExecContext(ctx, "DELETE FROM msg_fts")
	return err
}

// Pins lists a channel's pinned messages, newest pin first.
func (s *Store) Pins(ctx context.Context, channelID string) ([]domain.PinnedMessage, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT channel_id,message_id,pinned_by,pinned_at FROM pins WHERE channel_id=? ORDER BY pinned_at DESC, message_id DESC", channelID)
	if err != nil {
		return nil, err
	}
	var pins []domain.Pin
	for rows.Next() {
		var p domain.Pin
		var at string
		if err = rows.Scan(&p.ChannelID, &p.MessageID, &p.PinnedBy, &at); err != nil {
			rows.Close()
			return nil, err
		}
		p.PinnedAt, _ = time.Parse(time.RFC3339Nano, at)
		pins = append(pins, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	out := []domain.PinnedMessage{}
	for _, p := range pins {
		m, err := s.Message(ctx, p.MessageID)
		if err != nil {
			continue // the message is gone; the pin is a dangling row
		}
		out = append(out, domain.PinnedMessage{Pin: p, Message: m})
	}
	return out, nil
}

// IsPinned reports whether the message is pinned in its channel.
func (s *Store) IsPinned(ctx context.Context, channelID, messageID string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM pins WHERE channel_id=? AND message_id=?", channelID, messageID).Scan(&n)
	return n > 0, err
}

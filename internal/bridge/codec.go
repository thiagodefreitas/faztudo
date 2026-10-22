package bridge

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/files"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

const (
	// maxPendingInbound bounds the inbound.message requests queued behind the
	// handler. More than this is answered with an error, never by blocking the
	// reader.
	maxPendingInbound = 256
	// sendAttempts is how many times one outbound.send is tried when the
	// transport fails (a timeout or a write error).
	sendAttempts = 3
)

type packet struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcWireError   `json:"error,omitempty"`
}

type rpcWireError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    string `json:"data,omitempty"`
}

// queue is an unbounded FIFO with one consumer. Pushing never blocks, which is
// what keeps the stdout reader from ever waiting on the stdin writer.
type queue[T any] struct {
	mu     sync.Mutex
	items  []T
	closed bool
	wake   chan struct{}
}

func newQueue[T any]() *queue[T] { return &queue[T]{wake: make(chan struct{}, 1)} }

func (q *queue[T]) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *queue[T]) push(v T) bool {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return false
	}
	q.items = append(q.items, v)
	q.mu.Unlock()
	q.signal()
	return true
}

func (q *queue[T]) len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

func (q *queue[T]) close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	q.signal()
}

// next returns the oldest item. It reports false once the queue is closed and
// empty, or when done closes.
func (q *queue[T]) next(done <-chan struct{}) (T, bool) {
	for {
		q.mu.Lock()
		if len(q.items) > 0 {
			var zero T
			v := q.items[0]
			q.items[0] = zero
			q.items = q.items[1:]
			q.mu.Unlock()
			return v, true
		}
		closed := q.closed
		q.mu.Unlock()
		if closed {
			var zero T
			return zero, false
		}
		select {
		case <-q.wake:
		case <-done:
			var zero T
			return zero, false
		}
	}
}

// Conn handles one newline-delimited JSON-RPC connection. Only the child
// process may call hello and inbound.message; notifications have no id.
//
// The reader loop never waits on the writer or on a handler: responses go
// through the write queue and inbound.message runs on a worker, so a bridge
// that writes while the daemon writes a large outbound.send cannot deadlock
// the two pipes.
type Conn struct {
	reader   *bufio.Scanner
	writer   io.Writer
	mu       sync.Mutex // guards pending and nextID
	handler  *Handler
	ready    bool
	pending  map[string]chan packet
	nextID   int64
	OnStatus func(state, detail string)

	out        *queue[[]byte]
	in         *queue[packet]
	done       chan struct{}
	writerDone chan struct{}
	wg         sync.WaitGroup // the outbound loop

	// Timing knobs, set by tests.
	callTimeout  time.Duration
	retryDelay   time.Duration
	drainTimeout time.Duration
}

func NewConn(in io.Reader, out io.Writer, h *Handler) *Conn {
	s := bufio.NewScanner(in)
	s.Buffer(make([]byte, 64*1024), 40<<20)
	return &Conn{
		reader: s, writer: out, handler: h, pending: map[string]chan packet{},
		out: newQueue[[]byte](), in: newQueue[packet](),
		done: make(chan struct{}), writerDone: make(chan struct{}),
		callTimeout: 30 * time.Second, retryDelay: time.Second, drainTimeout: 2 * time.Second,
	}
}

// write queues one packet. It fails only when the connection is closed.
func (c *Conn) write(v packet) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if !c.out.push(b) {
		return io.ErrClosedPipe
	}
	return nil
}

// writeLoop is the only goroutine that writes to the bridge's stdin.
func (c *Conn) writeLoop() {
	defer close(c.writerDone)
	for {
		b, ok := c.out.next(c.done)
		if !ok {
			return
		}
		for len(b) > 0 {
			n, err := c.writer.Write(b)
			if err != nil || n == 0 {
				c.out.close()
				return
			}
			b = b[n:]
		}
	}
}

func (c *Conn) Notify(method string, params any) error {
	b, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return c.write(packet{JSONRPC: "2.0", Method: method, Params: b})
}

func (c *Conn) reply(id json.RawMessage, result any, err error) error {
	response := packet{JSONRPC: "2.0", ID: id, Result: result}
	if err != nil {
		var rpcErr RPCError
		if !errors.As(err, &rpcErr) {
			slog.Warn("bridge request failed", "error", err)
			rpcErr = RPCError{"bad_request", "request could not be handled"}
		}
		response.Result = nil
		response.Error = &rpcWireError{Code: -32000, Message: rpcErr.Message, Data: rpcErr.Code}
	}
	return c.write(response)
}

func (c *Conn) inboundLoop(ctx context.Context) {
	for {
		p, ok := c.in.next(nil)
		if !ok {
			return
		}
		var v Inbound
		var result any
		err := json.Unmarshal(p.Params, &v)
		if err == nil {
			result, err = c.handler.Inbound(ctx, v)
		}
		// A closed connection cannot answer; the bridge redelivers and the
		// idempotency key makes that harmless.
		_ = c.reply(p.ID, result, err)
	}
}

func (c *Conn) Serve(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	go c.writeLoop()
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); c.inboundLoop(parent) }()
	defer func() {
		c.in.close()
		<-workerDone
		cancel()
		c.wg.Wait()
		c.out.close()
		select {
		case <-c.writerDone:
		case <-time.After(c.drainTimeout):
		}
		close(c.done)
	}()
	for c.reader.Scan() {
		var p packet
		if err := json.Unmarshal(c.reader.Bytes(), &p); err != nil {
			return err
		}
		if p.JSONRPC != "2.0" {
			return errors.New("invalid JSON-RPC request")
		}
		if p.Method == "" && len(p.ID) > 0 {
			c.mu.Lock()
			ch := c.pending[string(p.ID)]
			delete(c.pending, string(p.ID))
			c.mu.Unlock()
			if ch != nil {
				ch <- p
			}
			continue
		}
		if p.Method == "" {
			return errors.New("invalid JSON-RPC request")
		}
		if len(p.ID) == 0 && p.Method == "status" {
			var v struct {
				State  string `json:"state"`
				Detail string `json:"detail"`
			}
			if json.Unmarshal(p.Params, &v) == nil && c.OnStatus != nil {
				c.OnStatus(v.State, v.Detail)
			}
			continue
		}
		if len(p.ID) == 0 {
			continue
		}
		switch p.Method {
		case "hello":
			var result any
			var err error
			if c.ready {
				err = RPCError{"bad_request", "hello already completed"}
			} else {
				var v Hello
				if err = json.Unmarshal(p.Params, &v); err == nil {
					result, err = c.handler.Hello(ctx, v)
				}
			}
			if rerr := c.reply(p.ID, result, err); rerr != nil {
				return rerr
			}
			if err == nil {
				c.ready = true
				c.wg.Add(1)
				go func() { defer c.wg.Done(); c.outbound(ctx) }()
			}
		case "inbound.message":
			switch {
			case !c.ready:
				_ = c.reply(p.ID, nil, RPCError{"bad_request", "hello required"})
			case c.in.len() >= maxPendingInbound:
				_ = c.reply(p.ID, nil, RPCError{"bad_request", "too many messages in flight; retry later"})
			default:
				c.in.push(p)
			}
		default:
			if err := c.reply(p.ID, nil, RPCError{"bad_request", "unknown method"}); err != nil {
				return err
			}
		}
	}
	return c.reader.Err()
}

func (c *Conn) call(ctx context.Context, method string, value any, result any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.nextID++
	id, _ := json.Marshal(c.nextID)
	ch := make(chan packet, 1)
	c.pending[string(id)] = ch
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, string(id)); c.mu.Unlock() }()
	if err := c.write(packet{JSONRPC: "2.0", ID: id, Method: method, Params: b}); err != nil {
		return err
	}
	select {
	case p := <-ch:
		if p.Error != nil {
			return RPCError{p.Error.Data, p.Error.Message}
		}
		raw, err := json.Marshal(p.Result)
		if err != nil {
			return err
		}
		return json.Unmarshal(raw, result)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// outbound mirrors events to the bridge. No failure ends it: a send that
// cannot be delivered is skipped with a notice, a store error is retried on
// the next tick, and only ctx ends the loop.
func (c *Conn) outbound(ctx context.Context) {
	var cursor int64
	for {
		v, err := c.handler.Store.BridgeCursor(ctx, "signal")
		if err == nil {
			cursor = v
			break
		}
		slog.Warn("signal bridge: reading outbound cursor", "error", err)
		if !sleepCtx(ctx, c.retryDelay) {
			return
		}
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	lastWarn := ""
	for {
		if err := c.pump(ctx, &cursor); err != nil && ctx.Err() == nil && err.Error() != lastWarn {
			lastWarn = err.Error()
			slog.Warn("signal bridge: outbound", "error", err)
		} else if err == nil {
			lastWarn = ""
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// pump sends the events after the cursor and advances the cursor past each
// one, delivered or not.
func (c *Conn) pump(ctx context.Context, cursor *int64) error {
	bindings, err := c.handler.bindings(ctx)
	if err != nil {
		return err
	}
	eventsAfter, err := c.handler.Store.EventsAfter(ctx, *cursor, 100)
	if err != nil {
		return err
	}
	for _, e := range eventsAfter {
		for conversation, channel := range bindings {
			if channel == e.ChannelID {
				if err := c.deliver(ctx, e, conversation, channel); err != nil {
					return err
				}
			}
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		*cursor = e.Seq
		// The stored cursor only moves forward, so a failed write here is
		// repaired by the next successful one.
		if err := c.handler.Store.SetBridgeCursor(ctx, "signal", *cursor); err != nil {
			slog.Warn("signal bridge: saving outbound cursor", "error", err)
		}
	}
	return nil
}

func (c *Conn) deliver(ctx context.Context, e events.Event, conversation, channel string) error {
	// Approval cards (merge cards included, which the system posts for an
	// agent's run) reach a Signal conversation only when agent messages may
	// go there unasked; with draft or off they stay in faztudo.
	if e.Type == events.ApprovalRequested {
		policy, err := c.handler.Store.BridgeAgentPolicy(ctx, "signal", conversation, channel)
		if err != nil {
			return err
		}
		if policy != "send" {
			return nil
		}
	}
	if strings.HasPrefix(string(e.Actor), "agent:") && e.Type == events.MessagePosted {
		policy, err := c.handler.Store.BridgeAgentPolicy(ctx, "signal", conversation, channel)
		if err != nil {
			return err
		}
		if policy == "off" {
			return nil
		}
		if policy == "draft" {
			var m domain.Message
			if err := json.Unmarshal(e.Payload, &m); err != nil {
				return err
			}
			kind, recipient, _ := strings.Cut(conversation, ":")
			title := "Send to Signal " + kind + " " + recipient + "?"
			recipients := conversation
			if conversation == "self" {
				title, recipients = "Send to Signal note-to-self?", "the Director's note-to-self"
			}
			approval := domain.Approval{
				ID: store.NewID(), ChannelID: channel, RequestedBy: m.AuthorID,
				Title:       title,
				Detail:      draftDetail(conversation, len(m.Attachments)),
				Options:     []domain.ApprovalOption{{Key: "send", Label: "Send", Style: "primary"}, {Key: "edit_send", Label: "Edit and send"}, {Key: "dont_send", Label: "Don't send"}},
				State:       domain.ApprovalPending,
				SignalDraft: &domain.SignalDraft{Conversation: conversation, MessageID: m.ID, Text: m.Body, Recipients: recipients, Attachments: m.Attachments},
			}
			_, err := c.handler.Store.Append(ctx, events.Draft{Type: events.ApprovalRequested, Actor: events.System, ChannelID: channel, IdempotencyKey: "signal-draft:" + conversation + ":" + m.ID, Payload: approval})
			return err
		}
	}
	outbound, ok := OutboundFor(e, map[string]string{conversation: channel})
	if !ok {
		return nil
	}
	approvedDraft := e.Type == events.ApprovalResolved && outbound.Ref.MessageID != ""
	claimKey := "draft:" + conversation + ":" + outbound.Ref.MessageID
	sent := false
	if approvedDraft {
		claimed, err := c.handler.Store.ClaimBridgeDelivery(ctx, "signal", claimKey)
		if err != nil {
			return err
		}
		if !claimed {
			return nil
		}
		defer func() {
			if !sent {
				if err := c.handler.Store.ReleaseBridgeDelivery(context.Background(), "signal", claimKey); err != nil {
					slog.Warn("signal bridge: releasing a failed draft claim", "error", err)
				}
			}
		}()
	}
	if err := c.attachments(&outbound, e); err != nil {
		slog.Warn("signal bridge: attachment", "event", e.Seq, "error", err)
		reason := "an attachment could not be read"
		if errors.Is(err, files.ErrTooLarge) {
			reason = "an attachment is too large"
		}
		c.skipped(ctx, e, reason)
		return nil
	}
	var result struct {
		ExternalID string `json:"external_id"`
	}
	var err error
	attempts := sendAttempts
	if approvedDraft {
		attempts = 1
	}
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 && !sleepCtx(ctx, c.retryDelay) {
			return nil
		}
		callCtx, cancel := context.WithTimeout(ctx, c.callTimeout)
		err = c.call(callCtx, "outbound.send", outbound, &result)
		cancel()
		if err == nil || ctx.Err() != nil {
			break
		}
		var rpcErr RPCError
		if errors.As(err, &rpcErr) {
			break // the bridge answered with an error; asking again will not help
		}
	}
	if ctx.Err() != nil {
		return nil
	}
	if err == nil && result.ExternalID == "" {
		err = errors.New("bridge returned no external_id")
	}
	if err != nil {
		slog.Warn("signal bridge: outbound.send", "event", e.Seq, "error", err)
		c.skipped(ctx, e, "the bridge did not accept it")
		return nil
	}
	sent = true
	ref := store.BridgeOutbound{ExternalID: result.ExternalID, MessageID: outbound.Ref.MessageID, ApprovalID: outbound.Ref.ApprovalID}
	if err := c.recordOutbound(ctx, ref); err != nil {
		slog.Warn("signal bridge: recording outbound", "event", e.Seq, "error", err)
	}
	return nil
}

// draftDetail says where a drafted agent message would go, and that its files
// go with it unchanged, also after Edit and send.
func draftDetail(conversation string, files int) string {
	text := "An agent wants to send this message to " + conversation + "."
	if files > 0 {
		text += fmt.Sprintf(" Its %d attached file(s) go with it as they are, also after Edit and send; choose Don't send to keep them here.", files)
	}
	return text
}

// skipped tells the channel that one message did not reach Signal.
func (c *Conn) skipped(ctx context.Context, e events.Event, reason string) {
	_, err := c.handler.Store.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, ChannelID: e.ChannelID, Payload: events.NoticePayload{Level: "warn", Text: "A message was not sent to Signal: " + reason + "."}})
	if err != nil {
		slog.Warn("signal bridge: posting notice", "error", err)
	}
}

func (c *Conn) recordOutbound(ctx context.Context, ref store.BridgeOutbound) error {
	err := c.handler.Store.PutBridgeOutbound(ctx, "signal", ref)
	if !errors.Is(err, store.ErrConflict) {
		return err
	}
	old, lookupErr := c.handler.Store.BridgeOutbound(ctx, "signal", ref.ExternalID)
	if lookupErr != nil {
		return lookupErr
	}
	if old != ref {
		return store.ErrConflict
	}
	return nil
}

func (c *Conn) attachments(out *Outbound, e events.Event) error {
	var items []domain.Attachment
	switch e.Type {
	case events.MessagePosted:
		var m domain.Message
		if err := json.Unmarshal(e.Payload, &m); err != nil {
			return err
		}
		items = m.Attachments
	case events.ApprovalResolved:
		var a domain.Approval
		if err := json.Unmarshal(e.Payload, &a); err != nil {
			return err
		}
		if a.SignalDraft != nil {
			items = a.SignalDraft.Attachments
		}
	default:
		return nil
	}
	limit := c.handler.MaxUpload
	if limit <= 0 {
		limit = 25 << 20
	}
	for _, item := range items {
		f, err := (files.Store{Dir: c.handler.FilesDir}).Open(item.ID)
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(f, limit+1))
		_ = f.Close()
		if err != nil {
			return err
		}
		if int64(len(data)) > limit {
			return files.ErrTooLarge
		}
		head := data
		if len(head) > 512 {
			head = head[:512]
		}
		typ, _ := files.Sniff(head)
		out.Attachments = append(out.Attachments, Attachment{Name: files.CleanName(item.Name), ContentType: typ, DataBase64: base64.StdEncoding.EncodeToString(data)})
	}
	return nil
}

type Outbound struct {
	Conversation    Conversation `json:"conversation"`
	Text            string       `json:"text"`
	QuoteExternalID string       `json:"quote_external_id,omitempty"`
	Attachments     []Attachment `json:"attachments"`
	Ref             struct {
		MessageID  string `json:"message_id,omitempty"`
		ApprovalID string `json:"approval_id,omitempty"`
	} `json:"ref"`
}

// OutboundFor skips bridge-authored messages so a post from Signal is never
// echoed back to the same Signal conversation.
func OutboundFor(e events.Event, bindings map[string]string) (Outbound, bool) {
	if e.Actor == events.Bridge("signal") {
		return Outbound{}, false
	}
	key := ""
	for conversation, channel := range bindings {
		if channel == e.ChannelID {
			key = conversation
			break
		}
	}
	if key == "" {
		return Outbound{}, false
	}
	out := Outbound{Attachments: []Attachment{}}
	if key == "self" {
		out.Conversation = Conversation{Kind: "self"}
	} else {
		for i := range key {
			if key[i] == ':' {
				out.Conversation = Conversation{Kind: key[:i], ID: key[i+1:]}
				break
			}
		}
	}
	switch e.Type {
	case events.MessagePosted:
		var m domain.Message
		if json.Unmarshal(e.Payload, &m) != nil {
			return Outbound{}, false
		}
		out.Text = m.Body
		out.Ref.MessageID = m.ID
	case events.ApprovalRequested:
		var a domain.Approval
		if json.Unmarshal(e.Payload, &a) != nil {
			return Outbound{}, false
		}
		if a.SignalDraft != nil {
			return Outbound{}, false
		}
		out.Text = a.Title + "\nOpen the web app to keep or discard."
		out.Ref.ApprovalID = a.ID
	case events.ApprovalResolved:
		var a domain.Approval
		if json.Unmarshal(e.Payload, &a) != nil || a.SignalDraft == nil || a.SignalDraft.Conversation != key || a.Resolution == nil || a.Resolution.Option != "send" && a.Resolution.Option != "edit_send" {
			return Outbound{}, false
		}
		out.Text = a.SignalDraft.Text
		if a.Resolution.Option == "edit_send" {
			out.Text = a.Resolution.Note
		}
		out.Ref.MessageID = a.SignalDraft.MessageID
	default:
		return Outbound{}, false
	}
	return out, true
}

package bridge

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/files"
	"github.com/thiagodefreitas/faztudo/internal/store"
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

// Conn handles one newline-delimited JSON-RPC connection. Only the child
// process may call hello and inbound.message; notifications have no id.
type Conn struct {
	reader   *bufio.Scanner
	writer   io.Writer
	mu       sync.Mutex
	handler  *Handler
	ready    bool
	pending  map[string]chan packet
	nextID   int64
	OnStatus func(state, detail string)
}

func NewConn(in io.Reader, out io.Writer, h *Handler) *Conn {
	s := bufio.NewScanner(in)
	s.Buffer(make([]byte, 64*1024), 40<<20)
	return &Conn{reader: s, writer: out, handler: h, pending: map[string]chan packet{}}
}

func (c *Conn) write(v packet) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	for len(b) > 0 {
		var n int
		n, err = c.writer.Write(b)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return err
}

func (c *Conn) Notify(method string, params any) error {
	b, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return c.write(packet{JSONRPC: "2.0", Method: method, Params: b})
}

func (c *Conn) Serve(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
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
		var result any
		var err error
		startOutbound := false
		switch p.Method {
		case "hello":
			if c.ready {
				err = RPCError{"bad_request", "hello already completed"}
				break
			}
			var v Hello
			if err = json.Unmarshal(p.Params, &v); err == nil {
				result, err = c.handler.Hello(ctx, v)
			}
			if err == nil {
				c.ready = true
				startOutbound = true
			}
		case "inbound.message":
			if !c.ready {
				err = RPCError{"bad_request", "hello required"}
				break
			}
			var v Inbound
			if err = json.Unmarshal(p.Params, &v); err == nil {
				result, err = c.handler.Inbound(ctx, v)
			}
		default:
			err = RPCError{"bad_request", "unknown method"}
		}
		response := packet{JSONRPC: "2.0", ID: p.ID, Result: result}
		if err != nil {
			var rpcErr RPCError
			if !errors.As(err, &rpcErr) {
				rpcErr = RPCError{"bad_request", "request could not be handled"}
			}
			response.Result = nil
			response.Error = &rpcWireError{Code: -32000, Message: rpcErr.Message, Data: rpcErr.Code}
		}
		if err := c.write(response); err != nil {
			return err
		}
		if startOutbound {
			go c.outbound(ctx)
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

func (c *Conn) outbound(ctx context.Context) {
	bindings, err := c.handler.bindings(ctx)
	if err != nil {
		return
	}
	cursor, err := c.handler.Store.BridgeCursor(ctx, "signal")
	if err != nil {
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		eventsAfter, err := c.handler.Store.EventsAfter(ctx, cursor, 100)
		if err != nil {
			return
		}
		for _, e := range eventsAfter {
			for conversation, channel := range bindings {
				if channel != e.ChannelID {
					continue
				}
				outbound, ok := OutboundFor(e, map[string]string{conversation: channel})
				if !ok {
					continue
				}
				if err := c.attachments(&outbound, e); err != nil {
					return
				}
				var result struct {
					ExternalID string `json:"external_id"`
				}
				callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
				err = c.call(callCtx, "outbound.send", outbound, &result)
				cancel()
				if err != nil || result.ExternalID == "" {
					return
				}
				ref := store.BridgeOutbound{ExternalID: result.ExternalID, MessageID: outbound.Ref.MessageID, ApprovalID: outbound.Ref.ApprovalID}
				if err := c.recordOutbound(ctx, ref); err != nil {
					return
				}
			}
			cursor = e.Seq
			if err := c.handler.Store.SetBridgeCursor(ctx, "signal", cursor); err != nil {
				return
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
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
	if e.Type != events.MessagePosted {
		return nil
	}
	var m domain.Message
	if err := json.Unmarshal(e.Payload, &m); err != nil {
		return err
	}
	limit := c.handler.MaxUpload
	if limit <= 0 {
		limit = 25 << 20
	}
	for _, item := range m.Attachments {
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
		out.Text = a.Title + "\nOpen the web app to keep or discard."
		out.Ref.ApprovalID = a.ID
	default:
		return Outbound{}, false
	}
	return out, true
}

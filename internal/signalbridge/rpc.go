package signalbridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

const maxLine = 40 << 20

type rpcPacket struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    string `json:"data,omitempty"`
}

func (e *rpcError) Error() string { return e.Message }

// rpcPeer reads independently of its single writer. Handlers may call the
// other peer without stopping this reader, including for large pipe writes.
type rpcPeer struct {
	in      io.Reader
	out     io.Writer
	writes  chan rpcWrite
	done    chan struct{}
	onInput func(rpcPacket)
	once    sync.Once
	mu      sync.Mutex
	nextID  int64
	pending map[string]chan rpcPacket
	err     error
}

type rpcWrite struct {
	data []byte
	ack  chan error
}

func newRPCPeer(in io.Reader, out io.Writer, onInput func(rpcPacket)) *rpcPeer {
	return &rpcPeer{in: in, out: out, writes: make(chan rpcWrite, 64), done: make(chan struct{}), onInput: onInput, pending: make(map[string]chan rpcPacket)}
}

func (p *rpcPeer) start() {
	go p.readLoop()
	go p.writeLoop()
}

func (p *rpcPeer) stop(err error) {
	p.once.Do(func() {
		p.mu.Lock()
		p.err = err
		p.mu.Unlock()
		close(p.done)
	})
}

func (p *rpcPeer) failure() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.err
}

func (p *rpcPeer) readLoop() {
	s := bufio.NewScanner(p.in)
	s.Buffer(make([]byte, 64*1024), maxLine)
	for s.Scan() {
		var v rpcPacket
		if err := json.Unmarshal(s.Bytes(), &v); err != nil || v.JSONRPC != "2.0" {
			p.stop(errors.New("invalid JSON-RPC line"))
			return
		}
		if v.Method == "" && len(v.ID) > 0 {
			p.mu.Lock()
			ch := p.pending[string(v.ID)]
			p.mu.Unlock()
			if ch != nil {
				select {
				case ch <- v:
				default:
				}
			}
			continue
		}
		if v.Method != "" && p.onInput != nil {
			go p.onInput(v)
		}
	}
	if err := s.Err(); err != nil {
		p.stop(err)
	} else {
		p.stop(io.EOF)
	}
}

func (p *rpcPeer) writeLoop() {
	for {
		select {
		case <-p.done:
			return
		case item := <-p.writes:
			b := item.data
			for len(b) > 0 {
				n, err := p.out.Write(b)
				if err != nil || n == 0 {
					if err == nil {
						err = io.ErrShortWrite
					}
					p.stop(err)
					if item.ack != nil {
						item.ack <- err
					}
					return
				}
				b = b[n:]
			}
			if item.ack != nil {
				item.ack <- nil
			}
		}
	}
}

func (p *rpcPeer) send(v rpcPacket) error { return p.sendWithAck(v, false) }

func (p *rpcPeer) sendWithAck(v rpcPacket, wait bool) error {
	v.JSONRPC = "2.0"
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	item := rpcWrite{data: b}
	if wait {
		item.ack = make(chan error, 1)
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case p.writes <- item:
	case <-p.done:
		return p.failure()
	case <-timer.C:
		return context.DeadlineExceeded
	}
	if !wait {
		return nil
	}
	select {
	case err := <-item.ack:
		return err
	case <-p.done:
		return p.failure()
	case <-timer.C:
		return context.DeadlineExceeded
	}
}

func (p *rpcPeer) notify(method string, params any) error {
	b, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return p.send(rpcPacket{Method: method, Params: b})
}

func (p *rpcPeer) notifySync(method string, params any) error {
	b, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return p.sendWithAck(rpcPacket{Method: method, Params: b}, true)
}

func (p *rpcPeer) reply(id json.RawMessage, result any, rpcErr *rpcError) error {
	if len(id) == 0 {
		return nil
	}
	v := rpcPacket{ID: id, Error: rpcErr}
	if rpcErr == nil {
		b, err := json.Marshal(result)
		if err != nil {
			return err
		}
		v.Result = b
	}
	return p.send(v)
}

func (p *rpcPeer) call(ctx context.Context, method string, params any, result any) error {
	b, err := json.Marshal(params)
	if err != nil {
		return err
	}
	p.mu.Lock()
	p.nextID++
	id := json.RawMessage(fmt.Sprintf("%d", p.nextID))
	ch := make(chan rpcPacket, 1)
	p.pending[string(id)] = ch
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.pending, string(id)); p.mu.Unlock() }()
	if err := p.send(rpcPacket{ID: id, Method: method, Params: b}); err != nil {
		return err
	}
	select {
	case v := <-ch:
		if v.Error != nil {
			return v.Error
		}
		if len(v.Result) == 0 {
			return errors.New("missing JSON-RPC result")
		}
		return json.Unmarshal(v.Result, result)
	case <-p.done:
		return p.failure()
	case <-ctx.Done():
		return ctx.Err()
	}
}

func call30(ctx context.Context, p *rpcPeer, method string, params any, result any) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return p.call(ctx, method, params, result)
}

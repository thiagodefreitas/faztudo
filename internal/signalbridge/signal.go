// Package signalbridge translates the local bridge protocol to signal-cli.
// signal-cli runs as a separate process and is never linked into faztudo.
package signalbridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/bridge"
)

type Options struct {
	SignalCLI string
	Account   string
	DataDir   string
	MaxUpload int64
	In        io.Reader
	Out       io.Writer
	Err       io.Writer
}

func (o Options) limit() int64 {
	if o.MaxUpload > 0 {
		return o.MaxUpload
	}
	return 25 << 20
}

func DataDir(faztudoDataDir string) string {
	return filepath.Join(faztudoDataDir, "bridges", "signal")
}

func EnsureDataDir(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	return os.Chmod(dir, 0700)
}

// Linked is a file-only doctor check. accounts.json contains account metadata,
// while the account data stays below data/<path>. It never reads keys.
func Linked(dir, account string) bool {
	if account == "" {
		return false
	}
	accounts, err := accountMetadata(dir)
	if err != nil {
		return false
	}
	for _, entry := range accounts {
		if entry.Number != account && entry.UUID != account && entry.ACI != account {
			continue
		}
		if entry.Path == "" || filepath.Base(entry.Path) != entry.Path || strings.ContainsAny(entry.Path, `/\`) {
			continue
		}
		_, err := os.Stat(filepath.Join(dir, "data", entry.Path))
		if err == nil {
			return true
		}
	}
	return false
}

type accountEntry struct {
	Path   string `json:"path"`
	Number string `json:"number"`
	UUID   string `json:"uuid"`
	ACI    string `json:"aci"`
}

func accountMetadata(dir string) ([]accountEntry, error) {
	b, err := os.ReadFile(filepath.Join(dir, "accounts.json"))
	if err != nil {
		return nil, err
	}
	var meta struct {
		Accounts []accountEntry `json:"accounts"`
	}
	if err := json.Unmarshal(b, &meta); err != nil {
		return nil, err
	}
	return meta.Accounts, nil
}

// signalArgs contains the signal-cli syntax in one place. The flags are from
// signal-cli's jsonRpc manual; jsonRpc is the stdio variant of its daemon API.
func signalArgs(o Options) []string {
	return []string{"--config", o.DataDir, "-a", o.Account, "--trust-new-identities", "on-first-use", "jsonRpc", "--receive-mode", "on-start"}
}

type signalMessage struct {
	Timestamp int64  `json:"timestamp"`
	Message   string `json:"message"`
	GroupInfo struct {
		GroupID string `json:"groupId"`
	} `json:"groupInfo"`
	Quote struct {
		ID         json.Number `json:"id"`
		AuthorUUID string      `json:"authorUuid"`
		Author     string      `json:"author"`
	} `json:"quote"`
	Attachments []struct {
		ID          string `json:"id"`
		Filename    string `json:"filename"`
		ContentType string `json:"contentType"`
		Size        int64  `json:"size"`
	} `json:"attachments"`
}

type envelope struct {
	Source       string        `json:"source"`
	SourceUUID   string        `json:"sourceUuid"`
	SourceNumber string        `json:"sourceNumber"`
	Timestamp    int64         `json:"timestamp"`
	DataMessage  signalMessage `json:"dataMessage"`
	SyncMessage  struct {
		SentMessage struct {
			Destination       string `json:"destination"`
			DestinationNumber string `json:"destinationNumber"`
			DestinationUUID   string `json:"destinationUuid"`
			signalMessage
		} `json:"sentMessage"`
	} `json:"syncMessage"`
}

type transport struct {
	opts     Options
	daemon   *rpcPeer
	signal   *rpcPeer
	bindings map[string]string
	allowed  map[string]bool
	ready    chan struct{}
	cancel   context.CancelFunc
}

func (t *transport) status(state string) {
	if err := t.daemon.notifySync("status", map[string]string{"state": state, "detail": ""}); err != nil {
		slog.Warn("signal bridge status", "error", err)
	}
}

func Run(ctx context.Context, o Options) error {
	if o.SignalCLI == "" || o.Account == "" || o.DataDir == "" || o.In == nil || o.Out == nil {
		return errors.New("signal bridge requires CLI, account, data dir and protocol pipes")
	}
	if err := EnsureDataDir(o.DataDir); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	t := &transport{opts: o, allowed: map[string]bool{}, ready: make(chan struct{}), cancel: cancel}
	defer func() {
		select {
		case <-t.ready:
		default:
			close(t.ready)
		}
	}()
	t.daemon = newRPCPeer(o.In, o.Out, t.fromDaemon)
	t.daemon.start()
	defer t.daemon.stop(io.EOF)
	var hello bridge.HelloResult
	if err := call30(ctx, t.daemon, "hello", bridge.Hello{Protocol: "1", Bridge: "signal", Version: "1", Capabilities: []string{"attachments"}}, &hello); err != nil {
		return fmt.Errorf("bridge hello: %w", err)
	}
	t.bindings = hello.Bindings
	for _, sender := range hello.Allowed {
		t.allowed[sender] = true
	}
	cmd := exec.Command(o.SignalCLI, signalArgs(o)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if o.Err != nil {
		cmd.Stderr = o.Err
	} else {
		cmd.Stderr = os.Stderr
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		t.status("error")
		return fmt.Errorf("start signal-cli: %w", err)
	}
	defer func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = stdin.Close()
		_ = stdout.Close()
		_ = cmd.Wait()
	}()
	t.signal = newRPCPeer(stdout, stdin, t.fromSignal)
	t.status("connected")
	t.signal.start()
	close(t.ready)
	defer t.signal.stop(io.EOF)
	select {
	case <-ctx.Done():
		return nil
	case <-t.daemon.done:
		if ctx.Err() != nil {
			return nil
		}
		return fmt.Errorf("daemon protocol closed: %w", t.daemon.failure())
	case <-t.signal.done:
		t.status("disconnected")
		return fmt.Errorf("signal-cli exited: %w", t.signal.failure())
	}
}

func (t *transport) fromDaemon(p rpcPacket) {
	if p.Method == "shutdown" {
		t.cancel()
		return
	}
	if p.Method != "outbound.send" {
		_ = t.daemon.reply(p.ID, nil, &rpcError{Code: -32601, Message: "unknown method"})
		return
	}
	var out bridge.Outbound
	if err := json.Unmarshal(p.Params, &out); err != nil {
		_ = t.daemon.reply(p.ID, nil, &rpcError{Code: -32602, Message: "invalid outbound request"})
		return
	}
	result, err := t.sendOutbound(out)
	if err != nil {
		var wireErr *rpcError
		if errors.As(err, &wireErr) {
			slog.Warn("signal bridge: send failed", "code", wireErr.Code)
		} else {
			slog.Warn("signal bridge: send failed", "reason", "transport or invalid request")
		}
		_ = t.daemon.reply(p.ID, nil, &rpcError{Code: -32000, Message: "Signal send failed"})
		return
	}
	_ = t.daemon.reply(p.ID, result, nil)
}

func (t *transport) sendOutbound(out bridge.Outbound) (map[string]string, error) {
	if t.ready != nil {
		select {
		case <-t.ready:
		case <-time.After(25 * time.Second):
			return nil, errors.New("signal-cli not ready")
		}
	}
	if t.signal == nil {
		return nil, errors.New("signal-cli unavailable")
	}
	key := out.Conversation.Key()
	if _, ok := t.bindings[key]; !ok {
		return nil, errors.New("unbound conversation")
	}
	// Current signal-cli uses recipients/groupIds; older JSON-RPC releases
	// used recipient/groupId. Retry only a parameter-shape rejection, never a
	// transport failure or a send error that might have delivered the text.
	params := map[string]any{"message": out.Text}
	legacy := map[string]any{"message": out.Text}
	switch out.Conversation.Kind {
	case "self":
		params["noteToSelf"] = true
		params["recipients"] = []string{}
		legacy["noteToSelf"] = true
		legacy["recipient"] = []string{t.opts.Account}
	case "group":
		params["groupIds"] = []string{out.Conversation.ID}
		legacy["groupId"] = out.Conversation.ID
	case "direct":
		params["recipients"] = []string{out.Conversation.ID}
		legacy["recipient"] = []string{out.Conversation.ID}
	default:
		return nil, errors.New("invalid conversation")
	}
	if out.QuoteExternalID != "" {
		ts, err := strconv.ParseInt(out.QuoteExternalID, 10, 64)
		if err != nil || ts <= 0 {
			return nil, errors.New("invalid quote timestamp")
		}
		params["quoteTimestamp"] = ts
		params["quoteAuthor"] = t.opts.Account
		legacy["quoteTimestamp"] = ts
		legacy["quoteAuthor"] = t.opts.Account
	}
	var temp string
	if len(out.Attachments) > 0 {
		var err error
		temp, err = os.MkdirTemp(t.opts.DataDir, "send-")
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(temp)
		paths := make([]string, 0, len(out.Attachments))
		for i, a := range out.Attachments {
			if int64(base64.StdEncoding.DecodedLen(len(a.DataBase64))) > t.opts.limit()+3 {
				return nil, errors.New("attachment too large")
			}
			data, err := base64.StdEncoding.DecodeString(a.DataBase64)
			if err != nil || int64(len(data)) > t.opts.limit() {
				return nil, errors.New("invalid attachment")
			}
			path := filepath.Join(temp, strconv.Itoa(i)+"-"+filepath.Base(a.Name))
			if err := os.WriteFile(path, data, 0600); err != nil {
				return nil, err
			}
			paths = append(paths, path)
		}
		params["attachments"] = paths
		legacy["attachments"] = paths
	}
	var reply struct {
		Timestamp json.Number `json:"timestamp"`
	}
	err := call30(context.Background(), t.signal, "send", params, &reply)
	var rpcErr *rpcError
	if errors.As(err, &rpcErr) && (rpcErr.Code == -32602 || rpcErr.Code == -32600 && strings.Contains(strings.ToLower(rpcErr.Message), "parameter")) {
		err = call30(context.Background(), t.signal, "send", legacy, &reply)
	}
	if err != nil {
		return nil, err
	}
	if _, err := strconv.ParseInt(reply.Timestamp.String(), 10, 64); err != nil {
		return nil, errors.New("send returned no timestamp")
	}
	return map[string]string{"external_id": reply.Timestamp.String()}, nil
}

func (t *transport) fromSignal(p rpcPacket) {
	if p.Method != "receive" {
		return
	}
	var incoming struct {
		Envelope envelope `json:"envelope"`
		Result   struct {
			Envelope envelope `json:"envelope"`
		} `json:"result"`
	}
	if json.Unmarshal(p.Params, &incoming) != nil {
		return
	}
	e := incoming.Envelope
	if e.Timestamp == 0 {
		e = incoming.Result.Envelope
	}
	v, ok := t.inbound(e)
	if !ok {
		return
	}
	var result bridge.InboundResult
	if err := call30(context.Background(), t.daemon, "inbound.message", v, &result); err != nil {
		var rpcErr *rpcError
		if errors.As(err, &rpcErr) {
			slog.Warn("signal bridge: inbound rejected", "code", rpcErr.Data)
		} else {
			slog.Warn("signal bridge: inbound failed", "error", err)
		}
	}
}

func (t *transport) inbound(e envelope) (bridge.Inbound, bool) {
	m := e.DataMessage
	conversation := bridge.Conversation{Kind: "direct", ID: e.SourceUUID}
	if e.SyncMessage.SentMessage.Timestamp != 0 {
		sent := e.SyncMessage.SentMessage
		if sent.Destination != t.opts.Account && sent.DestinationNumber != t.opts.Account && sent.DestinationUUID != t.opts.Account {
			return bridge.Inbound{}, false
		}
		m = sent.signalMessage
		conversation = bridge.Conversation{Kind: "self"}
	} else if m.GroupInfo.GroupID != "" {
		conversation = bridge.Conversation{Kind: "group", ID: m.GroupInfo.GroupID}
	}
	if conversation.Kind == "direct" && conversation.ID == "" {
		return bridge.Inbound{}, false
	}
	if _, ok := t.bindings[conversation.Key()]; !ok {
		return bridge.Inbound{}, false
	}
	id := e.SourceUUID
	if id == "" {
		id = e.SourceNumber
	}
	if id == "" {
		id = e.Source
	}
	number := e.SourceNumber
	if conversation.Kind == "self" && id == "" {
		id = t.opts.Account
		number = t.opts.Account
	}
	if !t.allowed[id] && !t.allowed[number] {
		return bridge.Inbound{}, false
	}
	ts := m.Timestamp
	if ts <= 0 {
		ts = e.Timestamp
	}
	if ts <= 0 {
		return bridge.Inbound{}, false
	}
	v := bridge.Inbound{Conversation: conversation, Sender: bridge.Sender{ID: id, Number: number}, SentAtMS: ts, ExternalID: strconv.FormatInt(ts, 10), Body: m.Message}
	if m.Quote.ID != "" {
		author := m.Quote.AuthorUUID
		if author == "" {
			author = m.Quote.Author
		}
		v.Quote = &bridge.Quote{ExternalID: m.Quote.ID.String(), AuthorID: author}
	}
	encodedBytes := int64(len(v.Body))
	for _, a := range m.Attachments {
		if len(v.Attachments) == 10 {
			break
		}
		if a.ID == "" || filepath.Base(a.ID) != a.ID || strings.ContainsAny(a.ID, `/\`) || a.Size > t.opts.limit() {
			slog.Warn("signal bridge: attachment skipped")
			continue
		}
		path := filepath.Join(t.opts.DataDir, "attachments", a.ID)
		f, err := os.Open(path)
		if err != nil {
			slog.Warn("signal bridge: attachment missing")
			continue
		}
		data, err := io.ReadAll(io.LimitReader(f, t.opts.limit()+1))
		_ = f.Close()
		if err != nil || int64(len(data)) > t.opts.limit() {
			slog.Warn("signal bridge: attachment too large or unreadable")
			continue
		}
		encodedSize := int64(base64.StdEncoding.EncodedLen(len(data))) + 1024
		if encodedBytes+encodedSize > maxLine-(2<<20) {
			slog.Warn("signal bridge: attachment skipped; protocol line would be too large")
			continue
		}
		encodedBytes += encodedSize
		v.Attachments = append(v.Attachments, bridge.Attachment{Name: a.Filename, ContentType: a.ContentType, DataBase64: base64.StdEncoding.EncodeToString(data)})
	}
	if strings.TrimSpace(v.Body) == "" && len(v.Attachments) == 0 {
		return bridge.Inbound{}, false
	}
	return v, true
}

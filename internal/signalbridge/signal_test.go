package signalbridge

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/bridge"
)

const testAccount = "+15551234567"

func TestSignalArgsAndPrivateDataDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "signal")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDataDir(dir); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dir)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("data dir mode: %v, %v", info, err)
	}
	got := strings.Join(signalArgs(Options{Account: testAccount, DataDir: dir}), " ")
	want := "--config " + dir + " -a " + testAccount + " --trust-new-identities on-first-use jsonRpc --receive-mode on-start"
	if got != want {
		t.Fatalf("signal-cli args: %q", got)
	}
}

func TestInboundMappingAndGate(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "attachments"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "attachments", "a1"), []byte("file bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	tr := &transport{opts: Options{Account: testAccount, DataDir: dir, MaxUpload: 1024}, bindings: map[string]string{"self": "c1", "group:g1": "c1"}, allowed: map[string]bool{testAccount: true, "sender-uuid": true}}
	var group envelope
	if err := json.Unmarshal([]byte(`{"sourceUuid":"sender-uuid","sourceNumber":"+15550000000","timestamp":123,"dataMessage":{"timestamp":123,"message":"hi","groupInfo":{"groupId":"g1"},"quote":{"id":100,"authorUuid":"other-uuid"},"attachments":[{"id":"a1","filename":"note.txt","contentType":"text/plain"},{"id":"missing","filename":"gone"}]}}`), &group); err != nil {
		t.Fatal(err)
	}
	v, ok := tr.inbound(group)
	if !ok || v.Conversation.Key() != "group:g1" || v.Sender.ID != "sender-uuid" || v.ExternalID != "123" {
		t.Fatalf("group mapping: %#v, %t", v, ok)
	}
	if v.Quote == nil || v.Quote.ExternalID != "100" || v.Quote.AuthorID != "other-uuid" {
		t.Fatalf("quote: %#v", v.Quote)
	}
	if len(v.Attachments) != 1 || v.Attachments[0].DataBase64 != base64.StdEncoding.EncodeToString([]byte("file bytes")) {
		t.Fatalf("attachments: %#v", v.Attachments)
	}
	group.SourceUUID = "blocked-uuid"
	if _, ok := tr.inbound(group); ok {
		t.Fatal("non-allowlisted group sender passed")
	}
	group.SourceUUID = "sender-uuid"
	group.DataMessage.GroupInfo.GroupID = "unbound"
	if _, ok := tr.inbound(group); ok {
		t.Fatal("unbound group passed")
	}
	var self envelope
	if err := json.Unmarshal([]byte(`{"sourceUuid":"own-uuid","sourceNumber":"+15551234567","timestamp":124,"syncMessage":{"sentMessage":{"destinationNumber":"+15551234567","timestamp":124,"message":"my note"}}}`), &self); err != nil {
		t.Fatal(err)
	}
	v, ok = tr.inbound(self)
	if !ok || v.Conversation.Key() != "self" || v.Body != "my note" {
		t.Fatalf("note to self: %#v, %t", v, ok)
	}
	self.SyncMessage.SentMessage.DestinationNumber = "+15550000000"
	if _, ok := tr.inbound(self); ok {
		t.Fatal("sync to another recipient passed")
	}
}

func fakeCLI(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "signal-cli")
	script := fmt.Sprintf("#!/bin/sh\nexec %q -test.run=TestFakeSignalProcess -- \"$@\"\n", os.Args[0])
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestFakeSignalProcess(t *testing.T) {
	if os.Getenv("FAZTUDO_TEST_SIGNAL_HELPER") == "" {
		return
	}
	fakeSignalMain()
	os.Exit(0)
}

func fakeSignalMain() {
	args := strings.Join(os.Args, " ")
	if strings.Contains(args, " listAccounts") {
		fmt.Print(`[{"number":"+15551234567"}]`)
		return
	}
	if strings.Contains(args, " link ") {
		for i, arg := range os.Args {
			if arg == "--config" && i+1 < len(os.Args) {
				dir := os.Args[i+1]
				if os.MkdirAll(filepath.Join(dir, "data"), 0700) != nil || os.WriteFile(filepath.Join(dir, "accounts.json"), []byte(`{"accounts":[{"path":"123","number":"+15551234567"}]}`), 0600) != nil || os.WriteFile(filepath.Join(dir, "data", "123"), []byte("fixture"), 0600) != nil {
					os.Exit(4)
				}
			}
		}
		fmt.Println("sgnl://linkdevice?uuid=test&pub_key=test")
		return
	}
	if os.Getenv("FAZTUDO_TEST_SIGNAL_HELPER") == "exit" {
		return
	}
	if os.Getenv("FAZTUDO_TEST_SIGNAL_HELPER") == "fixtures" {
		for i, arg := range os.Args {
			if arg == "--config" && i+1 < len(os.Args) {
				dir := filepath.Join(os.Args[i+1], "attachments")
				if os.MkdirAll(dir, 0700) != nil || os.WriteFile(filepath.Join(dir, "a1"), []byte("fixture bytes"), 0600) != nil {
					os.Exit(4)
				}
			}
		}
		fmt.Println(`{"jsonrpc":"2.0","method":"receive","params":{"envelope":{"sourceUuid":"blocked","sourceNumber":"+15550000001","timestamp":101,"dataMessage":{"timestamp":101,"message":"blocked","groupInfo":{"groupId":"g1"}}}}}`)
		fmt.Println(`{"jsonrpc":"2.0","method":"receive","params":{"envelope":{"sourceUuid":"sender-uuid","sourceNumber":"+15550000000","timestamp":102,"dataMessage":{"timestamp":102,"message":"group note","groupInfo":{"groupId":"g1"},"quote":{"id":99,"authorUuid":"quoted-uuid"},"attachments":[{"id":"a1","filename":"file.txt"},{"id":"missing","filename":"gone"}]}}}}`)
		fmt.Println(`{"jsonrpc":"2.0","method":"receive","params":{"envelope":{"sourceUuid":"own-uuid","sourceNumber":"+15551234567","timestamp":103,"syncMessage":{"sentMessage":{"destinationNumber":"+15551234567","timestamp":103,"message":"self note"}}}}}`)
	}
	if os.Getenv("FAZTUDO_TEST_SIGNAL_HELPER") == "burst" {
		fmt.Printf(`{"jsonrpc":"2.0","method":"receive","params":{"envelope":{"sourceUuid":"sender-uuid","sourceNumber":"+15550000000","timestamp":123,"dataMessage":{"timestamp":123,"message":%q,"groupInfo":{"groupId":"g1"}}}}}`+"\n", strings.Repeat("x", 900000))
	}
	s := bufio.NewScanner(os.Stdin)
	s.Buffer(make([]byte, 64*1024), maxLine)
	sends := 0
	for s.Scan() {
		var p rpcPacket
		if json.Unmarshal(s.Bytes(), &p) != nil {
			os.Exit(2)
		}
		if p.Method != "send" {
			continue
		}
		sends++
		if path := os.Getenv("FAZTUDO_TEST_SIGNAL_RECORD"); path != "" {
			_ = os.WriteFile(path, p.Params, 0600)
			var send struct {
				Attachments []string `json:"attachments"`
			}
			if json.Unmarshal(p.Params, &send) == nil && len(send.Attachments) > 0 {
				if b, err := os.ReadFile(send.Attachments[0]); err == nil {
					_ = os.WriteFile(path+".attachment", b, 0600)
				}
			}
		}
		if os.Getenv("FAZTUDO_TEST_SIGNAL_HELPER") == "legacy" && sends == 1 {
			fmt.Printf(`{"jsonrpc":"2.0","id":%s,"error":{"code":-32602,"message":"invalid parameters"}}`+"\n", p.ID)
		} else if os.Getenv("FAZTUDO_TEST_SIGNAL_HELPER") == "fail" {
			fmt.Printf(`{"jsonrpc":"2.0","id":%s,"error":{"code":-32000,"message":"send refused"}}`+"\n", p.ID)
		} else {
			fmt.Printf(`{"jsonrpc":"2.0","id":%s,"result":{"timestamp":987654321}}`+"\n", p.ID)
		}
	}
	if err := s.Err(); err != nil {
		os.Exit(3)
	}
}

type harness struct {
	t      *testing.T
	ctx    context.Context
	cancel context.CancelFunc
	in     *io.PipeWriter
	read   *bufio.Scanner
	done   chan error
}

func startHarness(t *testing.T, cli, mode, record string) *harness {
	t.Helper()
	t.Setenv("FAZTUDO_TEST_SIGNAL_HELPER", mode)
	t.Setenv("FAZTUDO_TEST_SIGNAL_RECORD", record)
	bridgeIn, daemonWrite := io.Pipe()
	daemonRead, bridgeOut := io.Pipe()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	done := make(chan error, 1)
	dataDir := t.TempDir()
	go func() {
		done <- Run(ctx, Options{SignalCLI: cli, Account: testAccount, DataDir: dataDir, MaxUpload: 2 << 20, In: bridgeIn, Out: bridgeOut, Err: io.Discard})
	}()
	h := &harness{t: t, ctx: ctx, cancel: cancel, in: daemonWrite, read: bufio.NewScanner(daemonRead), done: done}
	go func() { <-ctx.Done(); _ = daemonRead.Close() }()
	h.read.Buffer(make([]byte, 64*1024), maxLine)
	p := h.next()
	if p.Method != "hello" {
		t.Fatalf("first packet: %#v", p)
	}
	h.write(rpcPacket{ID: p.ID, Result: json.RawMessage(`{"bindings":{"self":"c1","group:g1":"c1"},"allowed_senders":["sender-uuid","+15551234567"]}`)})
	return h
}

func (h *harness) next() rpcPacket {
	h.t.Helper()
	if !h.read.Scan() {
		h.t.Fatalf("protocol EOF: %v", h.read.Err())
	}
	var p rpcPacket
	if err := json.Unmarshal(h.read.Bytes(), &p); err != nil {
		h.t.Fatal(err)
	}
	return p
}

func (h *harness) write(p rpcPacket) {
	h.t.Helper()
	p.JSONRPC = "2.0"
	b, err := json.Marshal(p)
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.in.Write(append(b, '\n')); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) close() {
	h.cancel()
	_ = h.in.Close()
	select {
	case <-h.done:
	case <-time.After(5 * time.Second):
		h.t.Fatal("bridge did not stop")
	}
}

func TestRunOutboundAndFailure(t *testing.T) {
	for _, tc := range []struct {
		name, mode, conversation string
		wantError                bool
	}{{"self", "serve", `{"kind":"self","id":""}`, false}, {"group", "serve", `{"kind":"group","id":"g1"}`, false}, {"legacy", "legacy", `{"kind":"group","id":"g1"}`, false}, {"failure", "fail", `{"kind":"self","id":""}`, true}} {
		t.Run(tc.name, func(t *testing.T) {
			record := filepath.Join(t.TempDir(), "send.json")
			h := startHarness(t, fakeCLI(t), tc.mode, record)
			defer h.close()
			if p := h.next(); p.Method != "status" {
				t.Fatalf("status: %#v", p)
			}
			h.write(rpcPacket{ID: json.RawMessage(`9`), Method: "outbound.send", Params: json.RawMessage(`{"conversation":` + tc.conversation + `,"text":"hello","quote_external_id":"123","attachments":[],"ref":{"message_id":"m1"}}`)})
			p := h.next()
			if string(p.ID) != "9" {
				t.Fatalf("reply id: %s", p.ID)
			}
			if tc.wantError != (p.Error != nil) {
				t.Fatalf("reply: %#v", p)
			}
			if !tc.wantError && !bytes.Contains(p.Result, []byte(`"external_id":"987654321"`)) {
				t.Fatalf("send result: %s", p.Result)
			}
			var sent map[string]any
			b, err := os.ReadFile(record)
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(b, &sent); err != nil {
				t.Fatal(err)
			}
			if tc.name == "self" && sent["noteToSelf"] != true {
				t.Fatalf("self send: %#v", sent)
			}
			if tc.name == "group" {
				groups, ok := sent["groupIds"].([]any)
				if !ok || len(groups) != 1 || groups[0] != "g1" {
					t.Fatalf("group send: %#v", sent)
				}
			}
			if tc.name == "legacy" && sent["groupId"] != "g1" {
				t.Fatalf("legacy group send: %#v", sent)
			}
			if sent["quoteTimestamp"] != float64(123) || sent["quoteAuthor"] != testAccount {
				t.Fatalf("quote send: %#v", sent)
			}
		})
	}
}

func TestRunSignalExitReportsDisconnected(t *testing.T) {
	h := startHarness(t, fakeCLI(t), "exit", "")
	defer h.cancel()
	if p := h.next(); p.Method != "status" || !bytes.Contains(p.Params, []byte("connected")) {
		t.Fatalf("connected: %#v", p)
	}
	if p := h.next(); p.Method != "status" || !bytes.Contains(p.Params, []byte("disconnected")) {
		t.Fatalf("disconnected: %#v", p)
	}
	select {
	case err := <-h.done:
		if err == nil {
			t.Fatal("signal-cli exit succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("bridge did not exit")
	}
}

func TestSignalStartFailureReportsError(t *testing.T) {
	bridgeIn, daemonWrite := io.Pipe()
	daemonRead, bridgeOut := io.Pipe()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	defer daemonWrite.Close()
	go func() { <-ctx.Done(); _ = daemonRead.Close() }()
	done := make(chan error, 1)
	dir := t.TempDir()
	go func() {
		done <- Run(ctx, Options{SignalCLI: filepath.Join(dir, "missing-cli"), Account: testAccount, DataDir: dir, In: bridgeIn, Out: bridgeOut, Err: io.Discard})
	}()
	h := &harness{t: t, ctx: ctx, cancel: cancel, in: daemonWrite, read: bufio.NewScanner(daemonRead), done: done}
	h.read.Buffer(make([]byte, 64*1024), maxLine)
	hello := h.next()
	h.write(rpcPacket{ID: hello.ID, Result: json.RawMessage(`{"bindings":{"self":"c1"},"allowed_senders":["+15551234567"]}`)})
	if p := h.next(); p.Method != "status" || !bytes.Contains(p.Params, []byte(`"error"`)) {
		t.Fatalf("start status: %#v", p)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("missing signal-cli succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("bridge did not fail")
	}
}

func TestOutboundArrivingWithHelloWaitsForSignalCLI(t *testing.T) {
	t.Setenv("FAZTUDO_TEST_SIGNAL_HELPER", "serve")
	cli := fakeCLI(t)
	bridgeIn, daemonWrite := io.Pipe()
	daemonRead, bridgeOut := io.Pipe()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	go func() { <-ctx.Done(); _ = daemonRead.Close() }()
	done := make(chan error, 1)
	dataDir := t.TempDir()
	go func() {
		done <- Run(ctx, Options{SignalCLI: cli, Account: testAccount, DataDir: dataDir, In: bridgeIn, Out: bridgeOut, Err: io.Discard})
	}()
	h := &harness{t: t, ctx: ctx, cancel: cancel, in: daemonWrite, read: bufio.NewScanner(daemonRead), done: done}
	defer h.close()
	h.read.Buffer(make([]byte, 64*1024), maxLine)
	hello := h.next()
	h.write(rpcPacket{ID: hello.ID, Result: json.RawMessage(`{"bindings":{"self":"c1"},"allowed_senders":["+15551234567"]}`)})
	h.write(rpcPacket{ID: json.RawMessage(`21`), Method: "outbound.send", Params: json.RawMessage(`{"conversation":{"kind":"self"},"text":"early","attachments":[],"ref":{"message_id":"m1"}}`)})
	seenStatus, seenReply := false, false
	for !seenStatus || !seenReply {
		p := h.next()
		if p.Method == "status" {
			seenStatus = true
		}
		if string(p.ID) == "21" {
			if p.Error != nil {
				t.Fatalf("early outbound failed: %#v", p.Error)
			}
			seenReply = true
		}
	}
}

func TestRunFakeReceiveFixtures(t *testing.T) {
	h := startHarness(t, fakeCLI(t), "fixtures", "")
	defer h.close()
	seen := map[string]bool{}
	for len(seen) < 3 {
		p := h.next()
		if p.Method == "status" {
			seen["connected"] = true
			continue
		}
		if p.Method != "inbound.message" {
			t.Fatalf("unexpected packet: %#v", p)
		}
		var v bridge.Inbound
		if err := json.Unmarshal(p.Params, &v); err != nil {
			t.Fatal(err)
		}
		if v.Body == "blocked" {
			t.Fatal("non-allowlisted sender reached daemon")
		}
		if seen[v.Body] {
			t.Fatalf("duplicate inbound: %q", v.Body)
		}
		seen[v.Body] = true
		if v.Body == "group note" {
			if v.Conversation.Key() != "group:g1" || v.Quote == nil || v.Quote.ExternalID != "99" || len(v.Attachments) != 1 || v.Attachments[0].DataBase64 != base64.StdEncoding.EncodeToString([]byte("fixture bytes")) {
				t.Fatalf("group fixture: %#v", v)
			}
		}
		if v.Body == "self note" && v.Conversation.Key() != "self" {
			t.Fatalf("self fixture: %#v", v)
		}
		h.write(rpcPacket{ID: p.ID, Result: json.RawMessage(`{"message_id":"m1","duplicate":false}`)})
	}
	if !seen["connected"] || !seen["group note"] || !seen["self note"] {
		t.Fatalf("missing fixture: %#v", seen)
	}
}

func TestOutboundAttachmentUsesPrivateTemporaryFile(t *testing.T) {
	record := filepath.Join(t.TempDir(), "send.json")
	h := startHarness(t, fakeCLI(t), "serve", record)
	defer h.close()
	if p := h.next(); p.Method != "status" {
		t.Fatalf("status: %#v", p)
	}
	data := base64.StdEncoding.EncodeToString([]byte("secret fixture"))
	h.write(rpcPacket{ID: json.RawMessage(`10`), Method: "outbound.send", Params: json.RawMessage(`{"conversation":{"kind":"self"},"text":"file","attachments":[{"name":"note.txt","data_b64":"` + data + `"}],"ref":{"message_id":"m1"}}`)})
	if p := h.next(); string(p.ID) != "10" || p.Error != nil {
		t.Fatalf("reply: %#v", p)
	}
	got, err := os.ReadFile(record + ".attachment")
	if err != nil || string(got) != "secret fixture" {
		t.Fatalf("signal-cli did not read attachment: %q, %v", got, err)
	}
	b, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	var sent struct {
		Attachments []string `json:"attachments"`
	}
	if err := json.Unmarshal(b, &sent); err != nil {
		t.Fatal(err)
	}
	if len(sent.Attachments) != 1 {
		t.Fatalf("paths: %#v", sent.Attachments)
	}
	if _, err := os.Stat(sent.Attachments[0]); !os.IsNotExist(err) {
		t.Fatalf("temporary file remains: %v", err)
	}
}

func TestRunLargeLinesBothWays(t *testing.T) {
	h := startHarness(t, fakeCLI(t), "burst", "")
	defer h.close()
	if p := h.next(); p.Method != "status" {
		t.Fatalf("status: %#v", p)
	}
	data := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("z"), 1<<20))
	h.write(rpcPacket{ID: json.RawMessage(`11`), Method: "outbound.send", Params: json.RawMessage(`{"conversation":{"kind":"self"},"text":"large","attachments":[{"name":"big.bin","data_b64":"` + data + `"}],"ref":{"message_id":"m1"}}`)})
	seenInbound, seenOutbound := false, false
	for !seenInbound || !seenOutbound {
		p := h.next()
		if p.Method == "inbound.message" {
			seenInbound = true
			if !bytes.Contains(p.Params, []byte(strings.Repeat("x", 1000))) {
				t.Fatal("large inbound line truncated")
			}
			h.write(rpcPacket{ID: p.ID, Result: json.RawMessage(`{"message_id":"m2","duplicate":false}`)})
		} else if string(p.ID) == "11" {
			seenOutbound = true
			if p.Error != nil {
				t.Fatalf("large send failed: %#v", p.Error)
			}
		}
	}
}

func TestLinkAndDoctorFile(t *testing.T) {
	t.Setenv("FAZTUDO_TEST_SIGNAL_HELPER", "link")
	if Linked(t.TempDir(), testAccount) {
		t.Fatal("unlinked directory reported linked")
	}
	cli := fakeCLI(t)
	dir := t.TempDir()
	var out bytes.Buffer
	if err := Link(context.Background(), cli, dir, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "sgnl://linkdevice?") || !strings.Contains(out.String(), "Linked Signal account: "+testAccount) {
		t.Fatalf("link output: %q", out.String())
	}
	if !Linked(dir, testAccount) {
		t.Fatal("linked account file not found")
	}
	if Linked(dir, "+15550000000") {
		t.Fatal("wrong account reported linked")
	}
	aciDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(aciDir, "data"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(aciDir, "accounts.json"), []byte(`{"accounts":[{"path":"a","aci":"own-uuid"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(aciDir, "data", "a"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if !Linked(aciDir, "own-uuid") {
		t.Fatal("ACI account file not found")
	}
	if account, err := linkedAccount(aciDir); err != nil || account != "own-uuid" {
		t.Fatalf("ACI account: %q, %v", account, err)
	}
}

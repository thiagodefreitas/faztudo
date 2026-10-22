package bridge

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/files"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestSignalDraftGateAndEditedDelivery(t *testing.T) {
	ctx := context.Background()
	h, _ := fixture(t)
	channel := h.Config.Bind["self"]
	h.Config.Bind = map[string]string{"group:people": channel}
	h.API.SignalBindings = h.Config.Bind
	message := domain.Message{ID: store.NewID(), ChannelID: channel, AuthorID: "agent", Body: "original text", CreatedAt: time.Now().UTC()}
	e, err := h.Store.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Agent("agent"), ChannelID: channel, Payload: message})
	if err != nil {
		t.Fatal(err)
	}
	conn := NewConn(nil, nil, h)
	if err := conn.deliver(ctx, e, "group:people", channel); err != nil {
		t.Fatal(err)
	}
	if err := conn.deliver(ctx, e, "group:people", channel); err != nil {
		t.Fatal(err)
	}
	approvals, err := h.Store.Approvals(ctx, "")
	if err != nil || len(approvals) != 1 {
		t.Fatalf("drafts: %d %v", len(approvals), err)
	}
	draft := approvals[0]
	if draft.SignalDraft == nil || draft.SignalDraft.Text != message.Body || draft.SignalDraft.Recipients != "group:people" {
		t.Fatalf("draft: %+v", draft)
	}
	if _, err := h.API.ResolveBridgeAs(ctx, h.Human, draft.ID, "send"); err == nil {
		t.Fatal("Signal resolved send draft")
	}
	if _, err := h.API.ResolveAs(ctx, h.Human, draft.ID, "dont_send", ""); err != nil {
		t.Fatal(err)
	}
	resolved, err := h.Store.Approval(ctx, draft.ID)
	if err != nil {
		t.Fatal(err)
	}
	resolvedEvent := events.Event{Type: events.ApprovalResolved, Actor: events.Human(h.Human.ID), ChannelID: channel}
	// Read the stored event because outbound uses its serialized resolution.
	eventsAfter, err := h.Store.EventsAfter(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range eventsAfter {
		if item.Type == events.ApprovalResolved {
			resolvedEvent = item
		}
	}
	if _, ok := OutboundFor(resolvedEvent, h.Config.Bind); ok {
		t.Fatal("declined draft was outbound")
	}
	if resolved.Resolution == nil || resolved.Resolution.Option != "dont_send" {
		t.Fatalf("resolution: %+v", resolved)
	}

	// A second draft is edited by the Director. Replaying its resolution does
	// not send it again, even if the outbound cursor moves backwards.
	message.ID = store.NewID()
	message.Body = "second text"
	e, err = h.Store.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Agent("agent"), ChannelID: channel, Payload: message})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.deliver(ctx, e, "group:people", channel); err != nil {
		t.Fatal(err)
	}
	approvals, err = h.Store.Approvals(ctx, "pending")
	if err != nil || len(approvals) != 1 {
		t.Fatalf("pending: %+v %v", approvals, err)
	}
	if _, err := h.API.ResolveAs(ctx, h.Human, approvals[0].ID, "send", ""); err != nil {
		t.Fatal(err)
	}
	// The plain Send preserves the exact original bytes.
	eventsAfter, err = h.Store.EventsAfter(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range eventsAfter {
		if item.Type == events.ApprovalResolved {
			if out, ok := OutboundFor(item, h.Config.Bind); ok && out.Text != message.Body {
				t.Fatalf("sent text %q", out.Text)
			}
		}
	}
	if err := h.Store.SetBridgeCursor(ctx, "signal", 0); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAZTUDO_BRIDGE_HELPER", "1")
	t.Setenv("FAZTUDO_BRIDGE_MODE", "draft_outbound")
	t.Setenv("FAZTUDO_BRIDGE_WANT_TEXT", message.Body)
	count := filepath.Join(t.TempDir(), "count")
	t.Setenv("FAZTUDO_BRIDGE_COUNT", count)
	runCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := RunCommand(runCtx, []string{os.Args[0], "-test.run=TestFakeBridgeProcess"}, h); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(count + ".sent"); err != nil || string(b) != message.Body {
		t.Fatalf("delivery %q %v", b, err)
	}
	if err := conn.deliver(ctx, eventsAfter[len(eventsAfter)-1], "group:people", channel); err != nil {
		t.Fatal(err)
	}
	edited := domain.Approval{SignalDraft: &domain.SignalDraft{Conversation: "group:people", MessageID: "edited-message", Text: "original"}, Resolution: &domain.ApprovalResolution{Option: "edit_send", Note: "edited text"}}
	raw, err := json.Marshal(edited)
	if err != nil {
		t.Fatal(err)
	}
	if out, ok := OutboundFor(events.Event{Type: events.ApprovalResolved, ChannelID: channel, Payload: raw}, h.Config.Bind); !ok || out.Text != "edited text" {
		t.Fatalf("edited outbound: %+v %v", out, ok)
	}
}

func TestSignalAgentPolicyDefaultsAndOff(t *testing.T) {
	h, _ := fixture(t)
	ctx := context.Background()
	for conversation, want := range map[string]string{"self": "send", "group:people": "draft", "direct:person": "draft"} {
		got, err := h.Store.BridgeAgentPolicy(ctx, "signal", conversation, h.Config.Bind["self"])
		if err != nil || got != want {
			t.Fatalf("%s: %s %v", conversation, got, err)
		}
	}
	if err := h.Store.SetBridgeAgentPolicy(ctx, "signal", "group:people", h.Config.Bind["self"], "off"); err != nil {
		t.Fatal(err)
	}
	if moved, err := h.Store.BridgeAgentPolicy(ctx, "signal", "group:people", "new-channel"); err != nil || moved != "draft" {
		t.Fatalf("moved binding: %s %v", moved, err)
	}
	channel := h.Config.Bind["self"]
	m := domain.Message{ID: store.NewID(), ChannelID: channel, AuthorID: "agent", Body: "off"}
	e, err := h.Store.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Agent("agent"), ChannelID: channel, Payload: m})
	if err != nil {
		t.Fatal(err)
	}
	if err := NewConn(nil, nil, h).deliver(ctx, e, "group:people", channel); err != nil {
		t.Fatal(err)
	}
	if err := h.Store.SetBridgeAgentPolicy(ctx, "signal", "group:people", h.Config.Bind["self"], "draft"); err != nil {
		t.Fatal(err)
	}
	approvalEvent := events.Event{Type: events.ApprovalRequested, Actor: events.Agent("agent"), ChannelID: channel}
	if err := NewConn(nil, nil, h).deliver(ctx, approvalEvent, "group:people", channel); err != nil {
		t.Fatal(err)
	}
	approvals, err := h.Store.Approvals(ctx, "")
	if err != nil || len(approvals) != 0 {
		t.Fatalf("off created drafts: %+v %v", approvals, err)
	}
	// A human's post remains eligible even when the agent policy is off.
	e.Actor = events.Human(h.Human.ID)
	if out, ok := OutboundFor(e, map[string]string{"group:people": channel}); !ok || out.Text != m.Body {
		t.Fatalf("human outbound: %+v %v", out, ok)
	}
}

func TestSignalExplicitSendAndHumanWithOff(t *testing.T) {
	for _, tc := range []struct {
		name, policy string
		actor        events.Actor
	}{
		{"agent send", "send", events.Agent("agent")},
		{"human despite off", "off", events.Human("human")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			h, _ := fixture(t)
			channel := h.Config.Bind["self"]
			h.Config.Bind = map[string]string{"group:people": channel}
			if err := h.Store.SetBridgeAgentPolicy(ctx, "signal", "group:people", channel, tc.policy); err != nil {
				t.Fatal(err)
			}
			message := domain.Message{ID: store.NewID(), ChannelID: channel, AuthorID: "agent", Body: "visible text", CreatedAt: time.Now().UTC()}
			if _, err := h.Store.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: tc.actor, ChannelID: channel, Payload: message}); err != nil {
				t.Fatal(err)
			}
			if err := h.Store.SetBridgeCursor(ctx, "signal", 0); err != nil {
				t.Fatal(err)
			}
			t.Setenv("FAZTUDO_BRIDGE_HELPER", "1")
			t.Setenv("FAZTUDO_BRIDGE_MODE", "draft_outbound")
			t.Setenv("FAZTUDO_BRIDGE_WANT_TEXT", message.Body)
			t.Setenv("FAZTUDO_BRIDGE_COUNT", filepath.Join(t.TempDir(), "count"))
			runCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			if err := RunCommand(runCtx, []string{os.Args[0], "-test.run=TestFakeBridgeProcess"}, h); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(os.Getenv("FAZTUDO_BRIDGE_COUNT") + ".sent"); err != nil {
				t.Fatalf("not delivered: %v", err)
			}
		})
	}
}

func TestApprovedDraftKeepsAttachments(t *testing.T) {
	h, _ := fixture(t)
	id, size, err := (files.Store{Dir: h.FilesDir}).Put(strings.NewReader("hi"), h.MaxUpload)
	if err != nil {
		t.Fatal(err)
	}
	attachment := domain.Attachment{ID: id, Name: "note.txt", Size: size}
	approval := domain.Approval{SignalDraft: &domain.SignalDraft{Attachments: []domain.Attachment{attachment}}}
	raw, err := json.Marshal(approval)
	if err != nil {
		t.Fatal(err)
	}
	out := Outbound{}
	if err := NewConn(nil, nil, h).attachments(&out, events.Event{Type: events.ApprovalResolved, Payload: raw}); err != nil {
		t.Fatal(err)
	}
	if len(out.Attachments) != 1 || out.Attachments[0].Name != attachment.Name || out.Attachments[0].DataBase64 != "aGk=" {
		t.Fatalf("attachments: %+v", out.Attachments)
	}
}

// A merge card is posted by the system for an agent's run. With draft (the
// group default) or off it must not reach the group either.
func TestSignalMergeCardStaysHomeUnlessSend(t *testing.T) {
	ctx := context.Background()
	h, _ := fixture(t)
	channel := h.Config.Bind["self"]
	h.Config.Bind = map[string]string{"group:people": channel}
	h.API.SignalBindings = h.Config.Bind
	card := domain.Approval{ID: store.NewID(), ChannelID: channel, RequestedBy: "agent", Title: "Choose what to do with branch fz/run", State: domain.ApprovalPending, Options: []domain.ApprovalOption{{Key: "merge", Label: "Merge"}}}
	e, err := h.Store.Append(ctx, events.Draft{Type: events.ApprovalRequested, Actor: events.System, ChannelID: channel, Payload: card})
	if err != nil {
		t.Fatal(err)
	}
	conn := NewConn(nil, nil, h)
	if err := conn.deliver(ctx, e, "group:people", channel); err != nil {
		t.Fatal(err)
	}
	after, err := h.Store.EventsAfter(ctx, e.Seq, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range after {
		if item.Type == events.Notice || item.Type == events.ApprovalRequested {
			t.Fatalf("merge card went toward the group: %s %s", item.Type, item.Payload)
		}
	}
}

func TestDraftDetailNamesAttachments(t *testing.T) {
	if got := draftDetail("group:people", 0); strings.Contains(got, "file") {
		t.Fatalf("no files: %q", got)
	}
	if got := draftDetail("group:people", 2); !strings.Contains(got, "2 attached file(s) go with it") {
		t.Fatalf("files: %q", got)
	}
}

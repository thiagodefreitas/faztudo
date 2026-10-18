// Package events defines the event envelope and the event types. The log is
// the source of truth; see docs/architecture.md.
package events

import (
	"context"
	"encoding/json"
	"time"
)

type Type string

const (
	MessagePosted     Type = "message.posted"
	MessageEdited     Type = "message.edited"
	ChannelCreated    Type = "channel.created"
	ChannelUpdated    Type = "channel.updated"
	MemberUpdated     Type = "member.updated"
	PresenceChanged   Type = "presence.changed"
	RunCreated        Type = "run.created"
	RunUpdated        Type = "run.updated"
	RunOutput         Type = "run.output"
	ApprovalRequested Type = "approval.requested"
	ApprovalResolved  Type = "approval.resolved"
	DepartmentUpdated Type = "department.updated"
	ProjectUpdated    Type = "project.updated"
	LaneUpdated       Type = "lane.updated"
	LaneUsageRead     Type = "lane.usage_read"
	LaneAlert         Type = "lane.alert"
	ChannelSummarized Type = "channel.summarized"
	LaneSwitched      Type = "lane.switched"
	Notice            Type = "notice"
)

// Actor identifies who caused an event: "human:<id>", "agent:<id>",
// "bridge:<id>" or "system". It is always set by the server from the
// authenticated connection, never read from a request body.
type Actor string

const System Actor = "system"

func Human(id string) Actor  { return Actor("human:" + id) }
func Agent(id string) Actor  { return Actor("agent:" + id) }
func Bridge(id string) Actor { return Actor("bridge:" + id) }

// Event is one entry in the append-only log.
type Event struct {
	Seq            int64           `json:"seq"` // strictly increasing, the delivery cursor
	ID             string          `json:"id"`  // ULID
	Type           Type            `json:"type"`
	Version        int             `json:"version"`
	Actor          Actor           `json:"actor"`
	ChannelID      string          `json:"channel_id,omitempty"`
	IdempotencyKey string          `json:"-"`
	Payload        json.RawMessage `json:"payload"`
	TS             time.Time       `json:"ts"`
}

// Draft is what a caller hands to Append; the log fills Seq, ID and TS.
type Draft struct {
	Type           Type
	Version        int
	Actor          Actor
	ChannelID      string
	IdempotencyKey string
	Payload        any
}

// RunOutputPayload is the payload of a run.output event.
type RunOutputPayload struct {
	RunID  string `json:"run_id"`
	Seq    int    `json:"seq"`
	Stream string `json:"stream"` // "stdout" or "stderr"
	Text   string `json:"text"`
}

// LaneSwitchedPayload is the payload of a lane.switched event.
type LaneSwitchedPayload struct {
	RunID  string `json:"run_id"`
	From   string `json:"from"`
	To     string `json:"to"`
	Reason string `json:"reason"`
}

// NoticePayload is the payload of a notice event.
type NoticePayload struct {
	Level  string        `json:"level"` // "info", "warn", "error"
	Text   string        `json:"text"`
	Action *NoticeAction `json:"action,omitempty"`
}

// NoticeAction is a button on a notice. Kind "assign" asks the Director to
// assign the specialist Agent (a handle) to the project with handle Project.
type NoticeAction struct {
	Kind    string `json:"kind"`
	Label   string `json:"label"`
	Project string `json:"project"`
	Agent   string `json:"agent"`
}

// Appender is the narrow interface the runner and lanes code use to record
// what happens. The store implements it; tests use an in-memory fake.
type Appender interface {
	// Append writes the event and updates projections in one transaction.
	// A repeated non-empty IdempotencyKey returns the first event unchanged.
	Append(ctx context.Context, d Draft) (Event, error)
}

// Subscriber delivers events after a cursor, then live ones, in seq order.
type Subscriber interface {
	Subscribe(ctx context.Context, afterSeq int64) (<-chan Event, error)
}

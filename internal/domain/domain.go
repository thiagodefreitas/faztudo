// Package domain holds the types shared by the store, the API, the runner
// and the lanes code. Field names and JSON tags follow docs/api.md, which is
// the contract with the web app.
package domain

import "time"

// ID is a ULID in its canonical 26 character string form.
type ID = string

type MemberKind string

const (
	MemberHuman MemberKind = "human"
	MemberAgent MemberKind = "agent"
)

type Presence string

const (
	PresenceOnline  Presence = "online"
	PresenceIdle    Presence = "idle"
	PresenceBusy    Presence = "busy"
	PresenceOffline Presence = "offline"
)

type AgentInfo struct {
	Lanes []string `json:"lanes"`
	Role  string   `json:"role,omitempty"`
	Mode  RunMode  `json:"mode,omitempty"`
}

type Member struct {
	ID          ID         `json:"id"`
	Kind        MemberKind `json:"kind"`
	Handle      string     `json:"handle"`
	DisplayName string     `json:"display_name"`
	Avatar      string     `json:"avatar,omitempty"`
	Agent       *AgentInfo `json:"agent,omitempty"`
	Presence    Presence   `json:"presence"`
}

type ChannelKind string

const (
	ChannelTeam       ChannelKind = "team"
	ChannelDepartment ChannelKind = "department"
	ChannelProject    ChannelKind = "project"
	ChannelAgent      ChannelKind = "agent"
	ChannelDirect     ChannelKind = "direct"
)

type Visibility string

const (
	VisibilityPublic  Visibility = "public"
	VisibilityPrivate Visibility = "private"
	VisibilityDirect  Visibility = "direct"
)

type Channel struct {
	ID             ID          `json:"id"`
	Name           string      `json:"name"`
	Kind           ChannelKind `json:"kind"`
	Visibility     Visibility  `json:"visibility"`
	Topic          string      `json:"topic,omitempty"`
	RepoPath       string      `json:"repo_path,omitempty"`
	TestCommand    string      `json:"test_command,omitempty"`
	DefaultAgentID ID          `json:"default_agent_id,omitempty"`
	MemberIDs      []ID        `json:"member_ids"`
	Unread         int         `json:"unread"`
	LastSeq        int64       `json:"last_seq,omitempty"`
}

type Message struct {
	ID         ID         `json:"id"`
	ChannelID  ID         `json:"channel_id"`
	ThreadID   ID         `json:"thread_id,omitempty"`
	AuthorID   ID         `json:"author_id"`
	Body       string     `json:"body"`
	Mentions   []ID       `json:"mentions"`
	RunID      ID         `json:"run_id,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	EditedAt   *time.Time `json:"edited_at,omitempty"`
	ReplyCount int        `json:"reply_count,omitempty"`
}

type RunMode string

const (
	RunRead  RunMode = "read"
	RunWrite RunMode = "write"
)

type RunState string

const (
	RunQueued          RunState = "queued"
	RunRunning         RunState = "running"
	RunWaitingApproval RunState = "waiting_approval"
	RunVerifying       RunState = "verifying"
	RunDone            RunState = "done"
	RunFailed          RunState = "failed"
	RunCancelled       RunState = "cancelled"
)

// Terminal reports whether no further transition is allowed.
func (s RunState) Terminal() bool {
	return s == RunDone || s == RunFailed || s == RunCancelled
}

type FailureClass string

const (
	FailureTransient FailureClass = "transient" // retry later: timeouts, 5xx, rate limits
	FailureSemantic  FailureClass = "semantic"  // quota exhausted, tests failed, auth missing
	FailureUnknown   FailureClass = "unknown"   // never retried automatically
)

type Verification struct {
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

type DiffStat struct {
	Files      int `json:"files"`
	Insertions int `json:"insertions"`
	Deletions  int `json:"deletions"`
}

type Run struct {
	ID               ID            `json:"id"`
	ChannelID        ID            `json:"channel_id"`
	TriggerMessageID ID            `json:"trigger_message_id"`
	AgentID          ID            `json:"agent_id"`
	LaneID           string        `json:"lane_id"`
	Mode             RunMode       `json:"mode"`
	State            RunState      `json:"state"`
	Worktree         string        `json:"worktree,omitempty"`
	BaseCommit       string        `json:"base_commit,omitempty"`
	StartedAt        *time.Time    `json:"started_at,omitempty"`
	EndedAt          *time.Time    `json:"ended_at,omitempty"`
	ExitCode         *int          `json:"exit_code,omitempty"`
	FailureClass     FailureClass  `json:"failure_class,omitempty"`
	FailureReason    string        `json:"failure_reason,omitempty"`
	Verification     *Verification `json:"verification,omitempty"`
	DiffStat         *DiffStat     `json:"diff_stat,omitempty"`
}

type ApprovalOption struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Style string `json:"style,omitempty"` // "primary" or "danger"
}

type ApprovalState string

const (
	ApprovalPending  ApprovalState = "pending"
	ApprovalResolved ApprovalState = "resolved"
	ApprovalExpired  ApprovalState = "expired"
)

type ApprovalResolution struct {
	Option string    `json:"option"`
	By     ID        `json:"by"`
	At     time.Time `json:"at"`
	Note   string    `json:"note,omitempty"`
}

type Approval struct {
	ID          ID                  `json:"id"`
	RunID       ID                  `json:"run_id,omitempty"`
	ChannelID   ID                  `json:"channel_id"`
	RequestedBy ID                  `json:"requested_by"`
	Title       string              `json:"title"`
	Detail      string              `json:"detail"`
	Options     []ApprovalOption    `json:"options"`
	State       ApprovalState       `json:"state"`
	Resolution  *ApprovalResolution `json:"resolution,omitempty"`

	// CommitMessage is the proposed message for a write run's Merge.
	CommitMessage string `json:"commit_message,omitempty"`
}

type LaneHealth string

const (
	LaneAvailable   LaneHealth = "available"
	LaneConserve    LaneHealth = "conserve"
	LaneExhausted   LaneHealth = "exhausted"
	LaneUnavailable LaneHealth = "unavailable"
	LaneUnknown     LaneHealth = "unknown"
)

type CostClass string

const (
	CostPremium  CostClass = "premium"
	CostStandard CostClass = "standard"
	CostCheap    CostClass = "cheap"
	CostLocal    CostClass = "local"
)

// UsageSource says where a usage number came from. Every number shown to a
// person carries its source and the time it was measured.
type UsageSource string

const (
	SourceCLILog  UsageSource = "cli-log"
	SourceProbe   UsageSource = "probe"
	SourceError   UsageSource = "error"
	SourceManual  UsageSource = "manual"
	SourceUnknown UsageSource = "unknown"
)

type LaneWindow struct {
	Name       string      `json:"name"` // "5h", "day", "week", "month"
	UsedPct    *float64    `json:"used_pct,omitempty"`
	ResetsAt   *time.Time  `json:"resets_at,omitempty"`
	Source     UsageSource `json:"source"`
	MeasuredAt *time.Time  `json:"measured_at,omitempty"`
}

type LaneError struct {
	Class   string    `json:"class"`
	Message string    `json:"message"`
	At      time.Time `json:"at"`
}

type Lane struct {
	ID             string       `json:"id"`
	CLI            string       `json:"cli"`
	Model          string       `json:"model,omitempty"`
	CostClass      CostClass    `json:"cost_class"`
	Capacity       int          `json:"capacity"`
	Running        int          `json:"running"`
	Health         LaneHealth   `json:"health"`
	HealthReason   string       `json:"health_reason,omitempty"`
	Windows        []LaneWindow `json:"windows"`
	RunsToday      int          `json:"runs_today"`
	TokensLastHour *int64       `json:"tokens_last_hour,omitempty"`
	LastError      *LaneError   `json:"last_error,omitempty"`
}

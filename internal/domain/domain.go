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
	// Description says what the specialist is for, shown on the Organization page.
	Description string  `json:"description,omitempty"`
	Mode        RunMode `json:"mode,omitempty"`
	// ChiefOfStaff marks the persona that receives unaddressed messages in
	// channels that opt in, and routes them to the owner.
	ChiefOfStaff bool `json:"chief_of_staff,omitempty"`
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

type Lesson struct {
	ID              ID        `json:"id"`
	Persona         string    `json:"persona"`
	ChannelID       string    `json:"channel_id"`
	Text            string    `json:"text"`
	SourceMessageID string    `json:"source_message_id"`
	CreatedBy       string    `json:"created_by"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// Department is a named team of specialists with a lead. Lead and Members are
// agent handles.
type Department struct {
	Handle      string   `json:"handle"`
	DisplayName string   `json:"display_name"`
	Lead        string   `json:"lead,omitempty"`
	Members     []string `json:"members"`
}

// Project groups channels and a repository. Only the departments and
// specialists assigned to it act in its channels. Channels are channel names;
// Lead, Departments and Specialists are handles.
type Project struct {
	Handle      string   `json:"handle"`
	Name        string   `json:"name"`
	RepoPath    string   `json:"repo_path,omitempty"`
	Lead        string   `json:"lead,omitempty"`
	Channels    []string `json:"channels"`
	Departments []string `json:"departments"`
	Specialists []string `json:"specialists"`
	Archived    bool     `json:"archived"`
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
	// LaneOverrides maps a persona handle to the lane it prefers in this
	// channel, set with "/lane <persona> <lane>".
	LaneOverrides map[string]string `json:"lane_overrides,omitempty"`
	MemberIDs     []ID              `json:"member_ids"`
	Unread        int               `json:"unread"`
	LastSeq       int64             `json:"last_seq,omitempty"`
}

type Message struct {
	ID              ID           `json:"id"`
	ChannelID       ID           `json:"channel_id"`
	ThreadID        ID           `json:"thread_id,omitempty"`
	AuthorID        ID           `json:"author_id"`
	Body            string       `json:"body"`
	Mentions        []ID         `json:"mentions"`
	Options         []string     `json:"options,omitempty"`
	Attachments     []Attachment `json:"attachments,omitempty"` // uploaded files, by content hash
	RunID           ID           `json:"run_id,omitempty"`
	CreatedAt       time.Time    `json:"created_at"`
	EditedAt        *time.Time   `json:"edited_at,omitempty"`
	ReplyCount      int          `json:"reply_count,omitempty"`
	Handoff         *Handoff     `json:"handoff,omitempty"` // set when an agent posted it with the delegate tool
	CollectForRunID ID           `json:"collect_for_run_id,omitempty"`
	Routine         string       `json:"routine,omitempty"` // handle of the routine that posted it
	Task            ID           `json:"task,omitempty"`    // id of the task whose start posted it
}

// Attachment describes a file stored by content hash. ContentType is what the
// server sniffed from the bytes, not what the uploader claimed.
type Attachment struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
}

// Pin marks a message as pinned in its channel.
type Pin struct {
	ChannelID string    `json:"channel_id"`
	MessageID ID        `json:"message_id"`
	PinnedBy  ID        `json:"pinned_by"`
	PinnedAt  time.Time `json:"pinned_at"`
}

// PinnedMessage is a pin with the message it points at.
type PinnedMessage struct {
	Pin
	Message Message `json:"message"`
}

// SearchHit is one message found by a search. Snippet wraps each match in
// U+0001 and U+0002 so a client can highlight without trusting HTML.
type SearchHit struct {
	Message Message `json:"message"`
	Snippet string  `json:"snippet"`
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
	ID               ID `json:"id"`
	ChannelID        ID `json:"channel_id"`
	TriggerMessageID ID `json:"trigger_message_id"`
	// ThreadID is the thread of the trigger message, empty for a root. Runs
	// recorded before it existed have none.
	ThreadID ID `json:"thread_id,omitempty"`
	// Handoff is set when the trigger message handed work over with the
	// delegate tool, so the run is one piece of a delegation.
	Handoff         bool         `json:"handoff,omitempty"`
	AgentID         ID           `json:"agent_id"`
	LaneID          string       `json:"lane_id"`
	Mode            RunMode      `json:"mode"`
	State           RunState     `json:"state"`
	Worktree        string       `json:"worktree,omitempty"`
	BaseCommit      string       `json:"base_commit,omitempty"`
	ChannelBranch   string       `json:"channel_branch,omitempty"`
	ApprovalOption  string       `json:"approval_option,omitempty"`
	ApprovalOutcome string       `json:"approval_outcome,omitempty"`
	StartedAt       *time.Time   `json:"started_at,omitempty"`
	EndedAt         *time.Time   `json:"ended_at,omitempty"`
	ExitCode        *int         `json:"exit_code,omitempty"`
	FailureClass    FailureClass `json:"failure_class,omitempty"`
	FailureReason   string       `json:"failure_reason,omitempty"`
	PeakMemoryBytes int64        `json:"peak_memory_bytes,omitempty"`
	// RetryOf is the failed run this one retried on the next lane.
	RetryOf      ID            `json:"retry_of,omitempty"`
	Verification *Verification `json:"verification,omitempty"`
	DiffStat     *DiffStat     `json:"diff_stat,omitempty"`
	// Tokens is what the CLI's own local log says this run used. It is absent
	// when the CLI keeps no such log or the run cannot be told apart from
	// another in the same directory.
	Tokens *RunTokens `json:"tokens,omitempty"`
	// CostUSD is an estimate from the lane's configured prices, never billing.
	// It is absent when Tokens is unknown or the lane has no prices.
	CostUSD *float64 `json:"cost_usd,omitempty"`
}

// RunTokens splits a run's tokens the way prices do. Cached input is not
// part of Input.
type RunTokens struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
	TotalOnly  int64 `json:"total_only,omitempty"` // total with no input/output split
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
	Name    string   `json:"name"` // "5h", "day", "week", "month"
	UsedPct *float64 `json:"used_pct,omitempty"`
	// Tokens used in the window, for CLIs that log tokens but report no
	// quota percentage (claude, grok).
	Tokens     *int64      `json:"tokens,omitempty"`
	ResetsAt   *time.Time  `json:"resets_at,omitempty"`
	Source     UsageSource `json:"source"`
	MeasuredAt *time.Time  `json:"measured_at,omitempty"`
}

// UserError is an error written for the person who acted. The API shows its
// message as is; other errors go only to the daemon log.
type UserError struct {
	Message string
}

func (e UserError) Error() string { return e.Message }

type LaneError struct {
	Class   string    `json:"class"`
	Message string    `json:"message"`
	At      time.Time `json:"at"`
	// ResetAt is when the CLI said the limit ends, if it said. It is kept
	// with the lane so the limit still ends after faztudo restarts.
	ResetAt *time.Time `json:"reset_at,omitempty"`
}

type Lane struct {
	ID           string       `json:"id"`
	CLI          string       `json:"cli"`
	Model        string       `json:"model,omitempty"`
	CostClass    CostClass    `json:"cost_class"`
	Capacity     int          `json:"capacity"`
	Running      int          `json:"running"`
	Health       LaneHealth   `json:"health"`
	HealthReason string       `json:"health_reason,omitempty"`
	Windows      []LaneWindow `json:"windows"`
	RunsToday    int          `json:"runs_today"`
	// RunsDate is the local day (2006-01-02) that RunsToday counts.
	RunsDate       string     `json:"runs_date,omitempty"`
	TokensLastHour *int64     `json:"tokens_last_hour,omitempty"`
	CostTodayUSD   *float64   `json:"cost_today_usd,omitempty"`
	Alerted        bool       `json:"alerted,omitempty"`
	LastError      *LaneError `json:"last_error,omitempty"`
}

// Handoff says that an agent handed work to another agent. RequestID is the id
// of the human message that started the chain, Depth how many handoffs deep
// this one is (1 for the first), and From and To are agent handles.
type Handoff struct {
	RequestID ID     `json:"request_id"`
	From      string `json:"from"`
	To        string `json:"to"`
	Depth     int    `json:"depth"`
}

// RoutineResult is how the last run of a routine ended. Status is "ok",
// "failed" or "skipped" (lane health, a budget or a missing piece).
type RoutineResult struct {
	At     time.Time `json:"at"`
	Status string    `json:"status"`
	Detail string    `json:"detail,omitempty"`
	RunID  ID        `json:"run_id,omitempty"`
}

// RoutineInput is what a human gives to make a routine in the app.
type RoutineInput struct {
	Name     string `json:"name"`
	Prompt   string `json:"prompt"`
	Persona  string `json:"persona"`
	Channel  string `json:"channel"`
	Schedule string `json:"schedule"`
}

// Routine is a prompt that runs by itself: on a schedule (Schedule, a cron
// expression) or when a human posts in the channel (Trigger "message"). It
// runs as Persona in Channel, which is a channel name. Template names a
// built-in that adds facts to the prompt, such as "debrief". Source is
// "config" for a routine from lanes.toml and "app" for one a human made in
// the app; only the second can be deleted.
type Routine struct {
	Handle    string         `json:"handle"`
	Name      string         `json:"name"`
	Prompt    string         `json:"prompt"`
	Persona   string         `json:"persona"`
	Channel   string         `json:"channel"`
	Schedule  string         `json:"schedule,omitempty"`
	Trigger   string         `json:"trigger,omitempty"`
	Template  string         `json:"template,omitempty"`
	Enabled   bool           `json:"enabled"`
	Source    string         `json:"source"`
	CreatedBy string         `json:"created_by,omitempty"` // set for an app routine
	CreatedAt *time.Time     `json:"created_at,omitempty"`
	NextRun   *time.Time     `json:"next_run,omitempty"`
	Last      *RoutineResult `json:"last,omitempty"`
}

package domain

import "time"

// TaskStatus is where a task stands on the board.
type TaskStatus string

const (
	TaskTodo      TaskStatus = "todo"
	TaskRunning   TaskStatus = "running"
	TaskReview    TaskStatus = "review"
	TaskDone      TaskStatus = "done"
	TaskFailed    TaskStatus = "failed"
	TaskCancelled TaskStatus = "cancelled"
)

// Task is a structured piece of work for one agent. Starting it posts a
// message that triggers a run; the runs and the approval it leads to are
// linked back here. Assignee is an agent handle, Lane is optional, and Order
// sorts the Todo column.
type Task struct {
	ID         ID         `json:"id"`
	ChannelID  ID         `json:"channel_id"`
	Title      string     `json:"title"`
	Body       string     `json:"body,omitempty"`
	Assignee   string     `json:"assignee"`
	Lane       string     `json:"lane,omitempty"`
	Mode       RunMode    `json:"mode"`
	Scope      []string   `json:"scope"`
	Checks     []string   `json:"checks"`
	Acceptance []string   `json:"acceptance"`
	Status     TaskStatus `json:"status"`
	Order      float64    `json:"order"`
	// MessageID is the message that started the task. RunIDs and ApprovalID
	// are derived from it as the runs report back.
	MessageID  ID        `json:"message_id,omitempty"`
	RunIDs     []ID      `json:"run_ids"`
	ApprovalID ID        `json:"approval_id,omitempty"`
	CreatedBy  ID        `json:"created_by"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

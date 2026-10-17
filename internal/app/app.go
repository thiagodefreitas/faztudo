// Package app connects the API, lane registry, runner and local usage readers.
package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/lanes"
	"github.com/thiagodefreitas/faztudo/internal/runner"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/usage"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

const maxAnswerBytes = 8192

type App struct {
	Store    *store.Store
	Config   config.Config
	Paths    config.Paths
	Registry *lanes.Registry
	Runner   *runner.Runner
	Adapters map[string]adapters.Adapter
	mu       sync.Mutex
	activeMu sync.Mutex
	active   map[string]context.CancelFunc
}

func New(ctx context.Context, s *store.Store, c config.Config, p config.Paths) (*App, error) {
	members, err := s.Members(ctx)
	if err != nil {
		return nil, err
	}
	stored, err := s.Lanes(ctx)
	if err != nil {
		return nil, err
	}
	var lc []lanes.LaneConfig
	for _, l := range stored {
		lc = append(lc, lanes.LaneConfig{ID: l.ID, CLI: l.CLI, Model: l.Model, CostClass: l.CostClass, Capacity: l.Capacity})
	}
	var pc []lanes.PersonaConfig
	byID := map[string]string{}
	for _, m := range members {
		if m.Kind == domain.MemberAgent && m.Agent != nil && len(m.Agent.Lanes) > 0 {
			pc = append(pc, lanes.PersonaConfig{Handle: m.Handle, Lanes: m.Agent.Lanes, Mode: m.Agent.Mode})
			byID[m.ID] = m.Handle
		}
	}
	reg, err := lanes.New(lc, pc, s)
	if err != nil {
		return nil, err
	}
	for _, l := range stored {
		reg.Restore(l)
	}
	a := &App{Store: s, Config: c, Paths: p, Registry: reg, Adapters: map[string]adapters.Adapter{
		"claude":   adapters.Claude{},
		"codex":    adapters.Codex{},
		"grok":     adapters.Grok{},
		"kimi":     adapters.Kimi{},
		"agy":      adapters.Agy{},
		"opencode": adapters.OpenCode{},
	}}
	a.Runner = &runner.Runner{RunDir: p.RunsDir, Appender: s, Lanes: reg, PersonaForRun: func(r domain.Run) string { return byID[r.AgentID] }}
	return a, nil
}

func (a *App) Bind(h *api.API) {
	h.Trigger = a
	h.ResolveApproval = a.ResolveApproval
	h.ReadDiff = func(id string) ([]byte, error) {
		return os.ReadFile(filepath.Join(a.Paths.RunsDir, id, "diff.patch"))
	}
	h.CancelRun = a.CancelRun
	h.RetryRun = a.RetryRun
	h.ProbeLane = a.ProbeLane
}

func (a *App) Start(ctx context.Context) error {
	if err := os.MkdirAll(a.Paths.RunsDir, 0700); err != nil {
		return err
	}
	if _, err := a.Runner.Recover(ctx); err != nil {
		return err
	}
	if err := a.RefreshUsage(ctx); err != nil {
		return err
	}
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = a.RefreshUsage(ctx)
			}
		}
	}()
	return nil
}

func (a *App) RefreshUsage(ctx context.Context) error {
	ls, err := a.Store.Lanes(ctx)
	if err != nil {
		return err
	}
	for _, l := range ls {
		if l.CLI != "codex" && l.CLI != "claude" {
			continue
		}
		if _, err = a.ProbeLane(ctx, l.ID); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) ProbeLane(ctx context.Context, id string) (domain.Lane, error) {
	lane, err := a.Store.Lane(ctx, id)
	if err != nil {
		return domain.Lane{}, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return domain.Lane{}, err
	}
	var windows []domain.LaneWindow
	switch lane.CLI {
	case "codex":
		windows, err = usage.ReadCodex(home, usage.Options{})
	case "claude":
		var result usage.ClaudeResult
		result, err = usage.ReadClaude(home, usage.Options{})
		windows = result.Windows
	default:
		return domain.Lane{}, fmt.Errorf("%w: usage reader unavailable for lane", store.ErrConflict)
	}
	if err != nil {
		return domain.Lane{}, err
	}
	if err := a.Registry.UpdateUsage(ctx, id, windows); err != nil {
		return domain.Lane{}, err
	}
	return a.Store.Lane(ctx, id)
}

func (a *App) OnMessage(_ context.Context, m domain.Message, agents []domain.Member) {
	for _, agent := range agents {
		agent := agent
		go a.run(context.Background(), m, agent, "")
	}
}

func (a *App) run(ctx context.Context, m domain.Message, agent domain.Member, override string) {
	if err := a.execute(ctx, m, agent, override); err != nil {
		a.notice(ctx, m.ChannelID, "error", err.Error())
	}
}

func (a *App) execute(ctx context.Context, m domain.Message, agent domain.Member, override string) error {
	if agent.Agent == nil {
		return errors.New("agent has no lane chain")
	}
	channel, err := a.Store.Channel(ctx, m.ChannelID)
	if err != nil {
		return err
	}
	mode := agent.Agent.Mode
	if mode == "" {
		mode = domain.RunRead
	}
	if mode == domain.RunWrite && channel.RepoPath == "" {
		a.notice(ctx, channel.ID, "warn", "Write runs need a channel repo_path. Set it with PATCH /api/v1/channels/"+channel.ID+".")
		return nil
	}
	lane, skipped, err := a.Registry.WaitPick(ctx, agent.Handle, override, func(busy []lanes.Skipped) {
		ids := make([]string, 0, len(busy))
		for _, b := range busy {
			ids = append(ids, b.ID)
		}
		a.notice(ctx, channel.ID, "info", fmt.Sprintf("@%s is queued: %s busy; it starts when a lane frees up.", agent.Handle, strings.Join(ids, ", ")))
	})
	if err != nil {
		return err
	}
	if len(skipped) > 0 {
		a.notice(ctx, channel.ID, "warn", fmt.Sprintf("Using %s; %s was skipped: %s", lane.ID, skipped[0].ID, skipped[0].Reason))
	}
	adapter := a.Adapters[lane.CLI]
	if adapter == nil {
		return fmt.Errorf("no adapter for %s", lane.CLI)
	}
	prompt, err := a.prompt(ctx, m)
	if err != nil {
		return err
	}
	if mode == domain.RunWrite {
		prompt += "\n\nDo not commit changes in the worktree."
	}
	timeout, err := time.ParseDuration(a.Config.Runs.DefaultTimeout)
	if err != nil {
		return err
	}
	run := domain.Run{ID: store.NewID(), ChannelID: channel.ID, TriggerMessageID: m.ID, AgentID: agent.ID, LaneID: lane.ID, Mode: mode, State: domain.RunQueued}
	runCtx, cancel := context.WithCancel(ctx)
	a.activeMu.Lock()
	if a.active == nil {
		a.active = map[string]context.CancelFunc{}
	}
	a.active[run.ID] = cancel
	a.activeMu.Unlock()
	defer func() {
		cancel()
		a.activeMu.Lock()
		delete(a.active, run.ID)
		a.activeMu.Unlock()
	}()
	if _, err := a.Store.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: channel.ID, Payload: run}); err != nil {
		return err
	}
	workdir := channel.RepoPath
	if workdir == "" {
		workdir = a.Paths.DataDir
	}
	req := adapters.Request{Prompt: prompt, Mode: mode, Model: lane.Model, Workdir: workdir, Timeout: timeout}
	if mode == domain.RunWrite {
		err = a.Runner.ExecuteWrite(runCtx, &run, adapter, req, runner.WriteOptions{Repo: channel.RepoPath, Worktrees: worktree.Manager{BaseDir: a.Paths.WorktreesDir}, TestCommand: channel.TestCommand})
	} else {
		err = a.Runner.Execute(runCtx, &run, adapter, req)
	}
	if run.StartedAt == nil && err != nil {
		run.State = domain.RunFailed
		if errors.Is(err, context.Canceled) {
			run.State = domain.RunCancelled
		}
		run.FailureReason = err.Error()
		_, _ = a.Store.Append(ctx, events.Draft{Type: events.RunUpdated, Actor: events.System, ChannelID: channel.ID, Payload: run})
	}
	if run.StartedAt != nil {
		answer := adapters.CleanAnswer(adapter, a.answer(run.ID))
		if err != nil {
			if answer != "" {
				answer = "Run failed: " + run.FailureReason + "\n\n" + answer
			} else {
				answer = "Run failed: " + run.FailureReason
			}
		}
		if answer == "" {
			answer = "Run completed without a final answer."
		}
		reply := domain.Message{ID: store.NewID(), ChannelID: channel.ID, ThreadID: m.ThreadID, AuthorID: agent.ID, Body: answer, Mentions: []string{}, RunID: run.ID, CreatedAt: time.Now().UTC()}
		if _, postErr := a.Store.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Agent(agent.ID), ChannelID: channel.ID, Payload: reply}); postErr != nil {
			return postErr
		}
	}
	if err != nil {
		return fmt.Errorf("run %s failed: %w", run.ID, err)
	}
	if mode == domain.RunWrite && run.State == domain.RunWaitingApproval && run.DiffStat != nil && run.DiffStat.Files > 0 {
		approval := domain.Approval{ID: store.NewID(), RunID: run.ID, ChannelID: channel.ID, RequestedBy: agent.ID, Title: "Choose what to do with branch fz/" + run.ID, Detail: "Merge records any uncommitted worktree changes using your Git identity, then fast-forwards the channel repo's current branch. The repo must be clean.", State: domain.ApprovalPending, Options: []domain.ApprovalOption{{Key: "merge", Label: "Merge", Style: "primary"}, {Key: "keep", Label: "Keep"}, {Key: "discard", Label: "Discard", Style: "danger"}}}
		if _, err := a.Store.Append(ctx, events.Draft{Type: events.ApprovalRequested, Actor: events.System, ChannelID: channel.ID, Payload: approval}); err != nil {
			return err
		}
	}
	return err
}

func (a *App) CancelRun(_ context.Context, id string) error {
	a.activeMu.Lock()
	cancel := a.active[id]
	a.activeMu.Unlock()
	if cancel == nil {
		if a.Runner.CancelRecovered(id) {
			return nil
		}
		return errors.New("run is not active")
	}
	cancel()
	return nil
}

func (a *App) RetryRun(ctx context.Context, id, laneID string) error {
	prior, err := a.Store.Run(ctx, id)
	if err != nil {
		return err
	}
	if !prior.State.Terminal() {
		return errors.New("run is not terminal")
	}
	message, err := a.Store.Message(ctx, prior.TriggerMessageID)
	if err != nil {
		return err
	}
	agent, err := a.Store.Member(ctx, prior.AgentID)
	if err != nil {
		return err
	}
	if _, _, err := a.Registry.Pick(agent.Handle, laneID); err != nil {
		return err
	}
	go a.run(context.Background(), message, agent, laneID)
	return nil
}

func (a *App) prompt(ctx context.Context, m domain.Message) (string, error) {
	n := a.Config.Runs.ContextMessages
	if n < 1 {
		n = 1
	}
	if n > 200 {
		n = 200
	}
	messages, err := a.Store.Messages(ctx, m.ChannelID, "", n)
	if err != nil {
		return "", err
	}
	members, err := a.Store.Members(ctx)
	if err != nil {
		return "", err
	}
	handles := map[string]string{}
	for _, member := range members {
		handles[member.ID] = member.Handle
	}
	var b strings.Builder
	b.WriteString("Recent channel messages (oldest first):\n")
	for _, msg := range messages {
		fmt.Fprintf(&b, "@%s: %s\n", handles[msg.AuthorID], msg.Body)
	}
	fmt.Fprintf(&b, "\nRequest:\n%s", m.Body)
	return b.String(), nil
}

func (a *App) answer(id string) string {
	f, err := os.Open(filepath.Join(a.Paths.RunsDir, id, "stdout.log"))
	if err != nil {
		return ""
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return ""
	}
	if info.Size() > maxAnswerBytes {
		_, _ = f.Seek(info.Size()-maxAnswerBytes, io.SeekStart)
	}
	b, _ := io.ReadAll(io.LimitReader(f, maxAnswerBytes))
	return strings.TrimSpace(string(b))
}

func (a *App) notice(ctx context.Context, channel, level, message string) {
	_, _ = a.Store.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, ChannelID: channel, Payload: events.NoticePayload{Level: level, Text: message}})
}

func (a *App) ResolveApproval(ctx context.Context, approval domain.Approval, option string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	run, err := a.Store.Run(ctx, approval.RunID)
	if err != nil {
		return "", err
	}
	channel, err := a.Store.Channel(ctx, run.ChannelID)
	if err != nil {
		return "", err
	}
	if run.Mode != domain.RunWrite || run.Worktree == "" || channel.RepoPath == "" || run.State != domain.RunWaitingApproval {
		return "", errors.New("run is not awaiting a write approval")
	}
	w := worktree.Worktree{Repo: channel.RepoPath, Path: run.Worktree, Branch: "fz/" + run.ID}
	var outcome string
	switch option {
	case "merge":
		// Untracked files in the channel repo do not block a fast-forward;
		// uncommitted changes to tracked files do.
		out, err := git(ctx, w.Repo, "status", "--porcelain", "--untracked-files=no")
		if err != nil {
			return "", err
		}
		if out != "" {
			return "", errors.New("channel repo has uncommitted changes; clean it before merge")
		}
		if run.BaseCommit == "" {
			return "", errors.New("run has no base commit")
		}
		if _, err := git(ctx, w.Path, "reset", "--soft", run.BaseCommit); err != nil {
			return "", err
		}
		if err := (worktree.Manager{BaseDir: a.Paths.WorktreesDir}).Stage(ctx, w); err != nil {
			return "", err
		}
		if _, err := git(ctx, w.Path, "diff", "--cached", "--quiet"); err != nil {
			// A normal commit, not plumbing, so the repository's own hooks
			// (secret scanning, message rules) see agent changes before they
			// land. The author is the human's Git identity: they approved it.
			if err := gitHumanCommit(ctx, w.Path, a.commitMessage(ctx, run)); err != nil {
				return "", fmt.Errorf("committing run changes (repository hooks may have refused them): %w", err)
			}
		}
		if _, err := git(ctx, w.Repo, "merge", "--ff-only", w.Branch); err != nil {
			return "", err
		}
		outcome = "Fast-forwarded " + w.Branch + " into the current branch."
		if err := (worktree.Manager{BaseDir: a.Paths.WorktreesDir}).Cleanup(ctx, w); err != nil {
			outcome += " Worktree cleanup failed: " + err.Error()
		}
	case "keep":
		outcome = "Kept " + w.Branch + " and its worktree for review."
	case "discard":
		if err := (worktree.Manager{BaseDir: a.Paths.WorktreesDir}).Cleanup(ctx, w); err != nil {
			return "", err
		}
		outcome = "Discarded " + w.Branch + " and removed its worktree."
	default:
		return "", errors.New("invalid write approval option")
	}
	a.notice(ctx, channel.ID, "info", outcome)
	run.State = domain.RunDone
	_, err = a.Store.Append(ctx, events.Draft{Type: events.RunUpdated, Actor: events.System, ChannelID: channel.ID, Payload: run})
	return outcome, err
}

// commitMessage builds a subject from the request that started the run, so
// the history says what was asked for rather than an internal id.
func (a *App) commitMessage(ctx context.Context, run domain.Run) string {
	subject := "Apply changes from faztudo run " + run.ID
	if m, err := a.Store.Message(ctx, run.TriggerMessageID); err == nil {
		line := strings.TrimSpace(strings.SplitN(m.Body, "\n", 2)[0])
		line = strings.TrimSpace(mentionPrefix.ReplaceAllString(line, ""))
		if line != "" {
			words := strings.Fields(line)
			line = ""
			for _, word := range words {
				candidate := word
				if line != "" {
					candidate = line + " " + word
				}
				if len(candidate) > 72 {
					break
				}
				line = candidate
			}
			if line != "" {
				subject = strings.ToUpper(line[:1]) + line[1:]
			}
		}
	}
	return subject + "\n\nfaztudo run " + run.ID
}

var mentionPrefix = regexp.MustCompile(`^(@[A-Za-z0-9_-]+[\s,:]*)+`)

func git(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

func gitHumanCommit(ctx context.Context, dir, message string) error {
	cmd := exec.CommandContext(ctx, "git", "-C", dir, "commit", "-q", "-m", message)
	for _, kv := range os.Environ() {
		key, _, _ := strings.Cut(kv, "=")
		if !strings.HasPrefix(key, "GIT_AUTHOR_") && !strings.HasPrefix(key, "GIT_COMMITTER_") {
			cmd.Env = append(cmd.Env, kv)
		}
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git commit: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Package app connects the API, lane registry, runner and local usage readers.
package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/lanes"
	"github.com/thiagodefreitas/faztudo/internal/mcp"
	"github.com/thiagodefreitas/faztudo/internal/org"
	"github.com/thiagodefreitas/faztudo/internal/runner"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/usage"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

const maxAnswerBytes = 8192

const mcpPromptNote = "Faztudo MCP tools are available for this channel only. ask_human returns immediately. You cannot resolve an approval."

type App struct {
	Store    *store.Store
	Config   config.Config
	Paths    config.Paths
	Registry *lanes.Registry
	Runner   *runner.Runner
	Adapters map[string]adapters.Adapter
	// MCP is the in-process server. MCPBase is its loopback origin with no
	// token in it, for example http://127.0.0.1:7457. An empty MCPBase leaves
	// agent commands unchanged.
	MCP      *mcp.Handler
	MCPBase  string
	mu       sync.Mutex
	activeMu sync.Mutex
	active   map[string]context.CancelFunc
	routines *routineEngine
	// extra holds facts that go into one message's prompt, by message id.
	extraMu      sync.Mutex
	extra        map[string]string
	summaryLocks sync.Map
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
	configured := map[string]config.Lane{}
	for _, l := range c.Lanes.Lane {
		configured[l.ID] = l
	}
	for _, l := range stored {
		if c.IsStaleDefaultLane(l.ID, l.CLI) {
			continue
		}
		threshold := 0
		if v := configured[l.ID].ConserveAt; v != nil {
			threshold = *v
		}
		lc = append(lc, lanes.LaneConfig{ID: l.ID, CLI: l.CLI, Model: l.Model, CostClass: l.CostClass, Capacity: l.Capacity, ConserveAt: threshold})
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
		if c.IsStaleDefaultLane(l.ID, l.CLI) {
			continue
		}
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
	reg.SetAlertChannels(func(ctx context.Context, laneID string) ([]string, error) {
		channels, err := s.Channels(ctx)
		if err != nil {
			return nil, err
		}
		members, err := s.Members(ctx)
		if err != nil {
			return nil, err
		}
		using := map[string]bool{}
		usingHandle := map[string]bool{}
		for _, m := range members {
			if m.Agent != nil && slices.Contains(m.Agent.Lanes, laneID) {
				using[m.ID] = true
				usingHandle[m.Handle] = true
			}
		}
		projects, err := s.Projects(ctx)
		if err != nil {
			return nil, err
		}
		departments, err := s.Departments(ctx)
		if err != nil {
			return nil, err
		}
		assignedChannel := map[string]bool{}
		for _, project := range projects {
			assigned := usingHandle[project.Lead]
			for _, specialist := range project.Specialists {
				assigned = assigned || usingHandle[specialist]
			}
			for _, dept := range departments {
				if !slices.Contains(project.Departments, dept.Handle) {
					continue
				}
				assigned = assigned || usingHandle[dept.Lead]
				for _, member := range dept.Members {
					assigned = assigned || usingHandle[member]
				}
			}
			if assigned {
				for _, name := range project.Channels {
					assignedChannel[name] = true
				}
			}
		}
		var ids []string
		for _, ch := range channels {
			if assignedChannel[ch.Name] {
				ids = append(ids, ch.ID)
				continue
			}
			if using[ch.DefaultAgentID] {
				ids = append(ids, ch.ID)
				continue
			}
			preferred := false
			for _, id := range ch.LaneOverrides {
				if id == laneID {
					preferred = true
					break
				}
			}
			if preferred {
				ids = append(ids, ch.ID)
				continue
			}
			for _, id := range ch.MemberIDs {
				if using[id] {
					ids = append(ids, ch.ID)
					break
				}
			}
		}
		return ids, nil
	})
	a.MCP = mcp.New(s, a)
	a.MCP.Policy = mcp.Policy{ChiefOfStaff: a.chiefHandle(), Limits: a.requestLimits()}
	a.routines = newRoutineEngine(a)
	a.MCP.FilesDir = p.FilesDir
	return a, nil
}

// chiefHandle is the handle of the Chief of Staff persona, empty when none is set.
func (a *App) chiefHandle() string {
	for _, p := range a.Config.Lanes.Persona {
		if p.ChiefOfStaff {
			return p.Handle
		}
	}
	return ""
}

// chiefFor reports the Chief of Staff for a channel that opted in.
func (a *App) chiefFor(channel string) (string, bool) {
	for _, p := range a.Config.Lanes.Persona {
		if p.ChiefOfStaff && org.ContainsFold(p.Channels, channel) {
			return p.Handle, true
		}
	}
	return "", false
}

// requestLimits are the delegation budgets of one request.
func (a *App) requestLimits() org.Limits {
	r := a.Config.Runs
	if r.RequestMaxRuns < 1 {
		return org.Limits{MaxRuns: 6, MaxPremium: 2}
	}
	return org.Limits{MaxRuns: r.RequestMaxRuns, MaxPremium: r.RequestMaxPremium}
}

func (a *App) Bind(h *api.API) {
	h.Trigger = a
	h.Chief = a.chiefFor
	h.Routines = a.routines
	h.ResolveApproval = a.ResolveApproval
	h.ReadDiff = func(id string) ([]byte, error) {
		return os.ReadFile(filepath.Join(a.Paths.RunsDir, id, "diff.patch"))
	}
	h.CancelRun = a.CancelRun
	h.RetryRun = a.RetryRun
	h.ProbeLane = a.ProbeLane
	h.RegenerateSummary = a.RegenerateSummary
	h.HideLane = func(l domain.Lane) bool { return a.Config.IsStaleDefaultLane(l.ID, l.CLI) }
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
	go a.routines.loop(ctx)
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
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = a.RefreshSummaries(ctx)
			}
		}
	}()
	return nil
}

// RefreshSummaries also covers quiet channels whose messages mention no agent.
func (a *App) RefreshSummaries(ctx context.Context) error {
	channels, err := a.Store.Channels(ctx)
	if err != nil {
		return err
	}
	for _, channel := range channels {
		lock := a.summaryLock(channel.ID)
		lock.Lock()
		previous, _ := a.Store.ChannelSummary(ctx, channel.ID)
		_, err = a.refreshSummary(ctx, domain.Message{ChannelID: channel.ID}, previous, false)
		lock.Unlock()
		if err != nil {
			return err
		}
	}
	return nil
}

// RegenerateSummary rebuilds the channel summary from the stored transcript.
func (a *App) RegenerateSummary(ctx context.Context, channelID string) (store.ChannelSummary, error) {
	if _, err := a.Store.Channel(ctx, channelID); err != nil {
		return store.ChannelSummary{}, err
	}
	lock := a.summaryLock(channelID)
	lock.Lock()
	defer lock.Unlock()
	return a.refreshSummary(ctx, domain.Message{ChannelID: channelID}, store.ChannelSummary{}, true)
}

func (a *App) RefreshUsage(ctx context.Context) error {
	ls, err := a.Store.Lanes(ctx)
	if err != nil {
		return err
	}
	for _, l := range ls {
		if l.CLI != "codex" && l.CLI != "claude" && l.CLI != "grok" {
			continue
		}
		if _, err = a.probeLane(ctx, l.ID, false); err != nil {
			return err
		}
	}
	return nil
}

// ProbeLane is the probe the human asked for.
func (a *App) ProbeLane(ctx context.Context, id string) (domain.Lane, error) {
	return a.probeLane(ctx, id, true)
}

// probeLane reads the lane's usage. Only a probe the human asked for is their
// "try again": it gives an unavailable lane another chance, and the next
// failed run marks it again. The usage ticker must not, or a lane whose login
// is broken would come back every few minutes.
func (a *App) probeLane(ctx context.Context, id string, asked bool) (domain.Lane, error) {
	lane, err := a.Store.Lane(ctx, id)
	if err != nil {
		return domain.Lane{}, err
	}
	if asked && lane.Health == domain.LaneUnavailable {
		if err := a.Registry.Recover(ctx, id, "probe requested after an error"); err != nil {
			return domain.Lane{}, err
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return domain.Lane{}, err
	}
	var windows []domain.LaneWindow
	var tokensHour *int64
	var estimate *float64
	switch lane.CLI {
	case "codex":
		windows, err = usage.ReadCodex(home, usage.Options{})
	case "claude", "grok":
		read := usage.ReadClaude
		if lane.CLI == "grok" {
			read = usage.ReadGrok
		}
		var result usage.TokenResult
		result, err = read(home, usage.Options{PlanLimitTokens: a.planLimit(id)})
		windows = result.Windows
		for _, configured := range a.Config.Lanes.Lane {
			if configured.ID == id {
				estimate = usage.EstimateUSD(result.Day, configured.USDPerMillionInput, configured.USDPerMillionOutput, configured.USDPerMillionCached)
				break
			}
		}
		if result.FiveHour.Entries > 0 || result.Day.Entries > 0 {
			total := result.LastHour.Total()
			tokensHour = &total
		}
	default:
		return domain.Lane{}, fmt.Errorf("%w: usage reader unavailable for lane", store.ErrConflict)
	}
	if err != nil {
		return domain.Lane{}, err
	}
	if err := a.Registry.UpdateUsage(ctx, id, windows); err != nil {
		return domain.Lane{}, err
	}
	if lane.CLI == "claude" || lane.CLI == "grok" {
		if err := a.Registry.SetTokensLastHour(ctx, id, tokensHour); err != nil {
			return domain.Lane{}, err
		}
		if err := a.Registry.SetCostToday(ctx, id, estimate); err != nil {
			return domain.Lane{}, err
		}
	}
	return a.Store.Lane(ctx, id)
}

// allowedTools returns the lane's allowed_tools, nil when unset.
func (a *App) allowedTools(id string) []string {
	for _, l := range a.Config.Lanes.Lane {
		if l.ID == id {
			return l.AllowedTools
		}
	}
	return nil
}

// instructions returns the standing instructions of the persona with this
// handle, empty when it has none.
func (a *App) instructions(handle string) string {
	for _, p := range a.Config.Lanes.Persona {
		if strings.EqualFold(p.Handle, handle) {
			return strings.TrimSpace(p.Instructions)
		}
	}
	return ""
}

// withInstructions puts a persona's standing instructions ahead of the prompt.
func withInstructions(instructions, prompt string) string {
	if instructions == "" {
		return prompt
	}
	return "Standing instructions for this role:\n" + instructions + "\n\n" + prompt
}

func (a *App) planLimit(id string) int64 {
	for _, l := range a.Config.Lanes.Lane {
		if l.ID == id {
			return l.PlanLimitTokens
		}
	}
	return 0
}

func (a *App) OnMessage(_ context.Context, m domain.Message, agents []domain.Member) {
	for _, agent := range agents {
		agent, msg := agent, m
		override, body, found := parseLaneOverride(m.Body, agent.Handle)
		if found {
			msg.Body = body
			if err := a.checkLaneOverride(agent, override); err != nil {
				channel := m.ChannelID
				go a.notice(context.Background(), channel, "warn", err.Error())
				continue
			}
		}
		go a.run(context.Background(), msg, agent, override)
	}
}

// checkLaneOverride says why a "/lane" override cannot run.
func (a *App) checkLaneOverride(agent domain.Member, id string) error {
	if _, ok := a.Registry.Snapshot(id); !ok {
		return fmt.Errorf("Unknown lane %s; @%s did not run.", id, agent.Handle)
	}
	if agent.Agent != nil {
		for _, l := range agent.Agent.Lanes {
			if l == id {
				return nil
			}
		}
		return fmt.Errorf("Lane %s is not in @%s's chain (%s); @%s did not run.", id, agent.Handle, strings.Join(agent.Agent.Lanes, ", "), agent.Handle)
	}
	return fmt.Errorf("@%s has no lane chain", agent.Handle)
}

// parseLaneOverride finds "/lane <id>" right after a mention of handle, as
// in "@coder /lane claude/opus fix x". It returns the lane id and the body
// with that part removed.
func parseLaneOverride(body, handle string) (string, string, bool) {
	re := regexp.MustCompile(`(?i)(^|[^A-Za-z0-9])(@` + regexp.QuoteMeta(handle) + `)(?:\s+/lane\s+([^\s]+))(\s+|$)`)
	loc := re.FindStringSubmatchIndex(body)
	if loc == nil {
		return "", body, false
	}
	id := body[loc[6]:loc[7]]
	prefix, suffix := body[:loc[5]], body[loc[1]:]
	if suffix == "" {
		return id, prefix, true
	}
	return id, prefix + " " + suffix, true
}

func (a *App) run(ctx context.Context, m domain.Message, agent domain.Member, override string) {
	if err := a.execute(ctx, m, agent, override); err != nil {
		a.notice(ctx, m.ChannelID, "error", err.Error())
	}
}

// execute runs agent on m. When the lane fails because of its login or plan,
// and the human did not choose the lane, the request runs once more on the
// next lane in the persona's chain as a new run linked to the first.
func (a *App) execute(ctx context.Context, m domain.Message, agent domain.Member, override string) error {
	var failed string
	err := a.attempt(ctx, m, agent, override, "", &failed)
	if failed != "" {
		err = a.attempt(ctx, m, agent, "", failed, new(string))
	}
	return err
}

// channelLane returns the lane the channel prefers for agent, or "" when it
// has none or the lane cannot run now.
func (a *App) channelLane(channel domain.Channel, agent domain.Member) string {
	id := channel.LaneOverrides[strings.ToLower(agent.Handle)]
	if id == "" || agent.Agent == nil || !slices.Contains(agent.Agent.Lanes, id) {
		return ""
	}
	if l, ok := a.Registry.Snapshot(id); !ok || l.Health == domain.LaneExhausted || l.Health == domain.LaneUnavailable {
		return ""
	}
	return id
}

// laneFailed reports whether run failed because its lane lost its login or
// plan, so another lane could still do the work.
func (a *App) laneFailed(run domain.Run) bool {
	if run.StartedAt == nil || run.FailureClass != domain.FailureSemantic {
		return false
	}
	l, ok := a.Registry.Snapshot(run.LaneID)
	return ok && l.LastError != nil && !l.LastError.At.Before(*run.StartedAt) &&
		(l.Health == domain.LaneUnavailable || l.Health == domain.LaneExhausted)
}

// attempt is one run of agent on m. It sets *failed to the id of the failed
// run when the caller should retry on the next lane; retryOf is the failed
// run when this attempt is that retry.
func (a *App) attempt(ctx context.Context, m domain.Message, agent domain.Member, override, retryOf string, failed *string) error {
	explicit := override != "" // the human chose the lane for this message
	if agent.Agent == nil {
		return errors.New("agent has no lane chain")
	}
	channel, err := a.Store.Channel(ctx, m.ChannelID)
	if err != nil {
		return err
	}
	if override == "" && retryOf == "" {
		override = a.channelLane(channel, agent)
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
		if explicit && len(skipped) > 0 {
			return fmt.Errorf("lane %s cannot run now: %s. A /lane override does not fall back to another lane.", override, skipped[0].Reason)
		}
		return err
	}
	if retryOf != "" {
		if prior, perr := a.Store.Run(ctx, retryOf); perr == nil {
			a.notice(ctx, channel.ID, "warn", fmt.Sprintf("Run on %s failed (%s). Retrying @%s on %s.", prior.LaneID, prior.FailureReason, agent.Handle, lane.ID))
		}
	}
	if lane.Health == domain.LaneConserve {
		a.notice(ctx, channel.ID, "warn", fmt.Sprintf("Using %s although it is in conserve (%s): no other lane in @%s's chain is usable.", lane.ID, lane.HealthReason, agent.Handle))
	} else if len(skipped) > 0 && retryOf == "" {
		a.notice(ctx, channel.ID, "warn", fmt.Sprintf("Using %s; %s was skipped: %s", lane.ID, skipped[0].ID, skipped[0].Reason))
	}
	adapter := a.Adapters[lane.CLI]
	if adapter == nil {
		return fmt.Errorf("no adapter for %s", lane.CLI)
	}
	network := true
	if mode == domain.RunWrite {
		for _, configured := range a.Config.Lanes.Lane {
			if configured.ID == lane.ID && configured.SandboxNetwork != nil {
				network = *configured.SandboxNetwork
				break
			}
		}
	}
	mcpReachable := mcpReachableForRun(mode, a.Config.Runs.Sandbox, network)
	runStarted := time.Now().UTC()
	a.Registry.RecordRun(lane.ID)
	prompt, err := a.prompt(ctx, m)
	if err != nil {
		return err
	}
	prompt = withInstructions(a.instructions(agent.Handle), prompt)
	if extra := a.extraContext(m.ID); extra != "" {
		prompt += "\n\nFacts for this request:\n" + extra
	}
	if mode == domain.RunWrite {
		prompt += "\n\nDo not commit changes in the worktree.\nEnd your answer with a line \"COMMIT: <imperative subject under 72 characters>\", optionally followed by a short body."
	}
	if mcpReachable && mcpCLI(lane.CLI) && a.MCP != nil && a.MCPBase != "" {
		prompt += "\n\n" + mcpPromptNote
		if note := a.delegationNote(ctx, agent, m); note != "" {
			prompt += "\n\n" + note
		}
	}
	timeout, err := time.ParseDuration(a.Config.Runs.DefaultTimeout)
	if err != nil {
		return err
	}
	run := domain.Run{ID: store.NewID(), ChannelID: channel.ID, TriggerMessageID: m.ID, AgentID: agent.ID, LaneID: lane.ID, Mode: mode, State: domain.RunQueued, RetryOf: retryOf}
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
	req := adapters.Request{Prompt: prompt, Mode: mode, Model: lane.Model, Workdir: workdir, Timeout: timeout, AllowedTools: a.allowedTools(lane.ID)}
	if mcpReachable && mcpCLI(lane.CLI) && a.MCP != nil && a.MCPBase != "" {
		token, issueErr := a.MCP.Issue(run.ID, agent.ID, channel.ID)
		if issueErr != nil {
			err = issueErr
		} else {
			defer a.MCP.RevokeRun(run.ID)
			req.MCP = &adapters.MCP{URL: strings.TrimRight(a.MCPBase, "/") + "/mcp", Token: token, Dir: filepath.Join(a.Paths.RunsDir, run.ID)}
		}
	}
	if err == nil {
		if mode == domain.RunWrite {
			err = a.Runner.ExecuteWrite(runCtx, &run, adapter, req, runner.WriteOptions{
				Repo: channel.RepoPath, Worktrees: worktree.Manager{BaseDir: a.Paths.WorktreesDir}, TestCommand: channel.TestCommand,
				SandboxMode: a.Config.Runs.Sandbox, Network: network, MemoryMax: a.Config.Runs.SandboxMemoryMax, TasksMax: a.Config.Runs.SandboxTasksMax, ReadOnly: a.Config.Runs.SandboxReadOnly,
				OnFallback: func(message string) { a.notice(ctx, channel.ID, "warn", message) },
			})
		} else {
			err = a.Runner.Execute(runCtx, &run, adapter, req)
		}
	}
	if run.StartedAt == nil && err != nil {
		run.State = domain.RunFailed
		if errors.Is(err, context.Canceled) {
			run.State = domain.RunCancelled
		}
		run.FailureReason = err.Error()
		_, _ = a.Store.Append(ctx, events.Draft{Type: events.RunUpdated, Actor: events.System, ChannelID: channel.ID, Payload: run})
	}
	if err != nil && a.laneFailed(run) {
		if explicit {
			a.notice(ctx, channel.ID, "warn", fmt.Sprintf("You chose lane %s for this message, so @%s was not moved to another lane.", lane.ID, agent.Handle))
		} else if retryOf == "" {
			// Retry once, if another lane in the chain can take the work.
			if _, left, perr := a.Registry.Pick(agent.Handle, ""); perr == nil || lanes.Busy(left) {
				*failed = run.ID
				return nil
			}
		}
	}
	if err == nil {
		_ = a.Registry.RecoverSince(ctx, lane.ID, "last run succeeded", runStarted)
	}
	var proposal string
	if run.StartedAt != nil {
		answer := adapters.CleanAnswer(adapter, a.answer(run.ID))
		if mode == domain.RunWrite {
			answer, proposal = splitCommit(answer)
		}
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
	if mode == domain.RunWrite && run.State == domain.RunDone && run.DiffStat != nil && run.DiffStat.Files == 0 {
		a.notice(ctx, channel.ID, "info", fmt.Sprintf("No changes: @%s did not change any files, so there is nothing to approve.", agent.Handle))
	}
	if mode == domain.RunWrite && run.State == domain.RunWaitingApproval && run.DiffStat != nil && run.DiffStat.Files > 0 {
		approval := domain.Approval{ID: store.NewID(), RunID: run.ID, ChannelID: channel.ID, RequestedBy: agent.ID, Title: "Choose what to do with branch fz/" + run.ID, Detail: "Merge records any uncommitted worktree changes using your Git identity, then fast-forwards the channel repo's current branch. The repo must be clean.", CommitMessage: buildCommitMessage(proposal, m.Body, run.ID), State: domain.ApprovalPending, Options: []domain.ApprovalOption{{Key: "merge", Label: "Merge", Style: "primary"}, {Key: "keep", Label: "Keep"}, {Key: "discard", Label: "Discard", Style: "danger"}}}
		if _, err := a.Store.Append(ctx, events.Draft{Type: events.ApprovalRequested, Actor: events.System, ChannelID: channel.ID, Payload: approval}); err != nil {
			return err
		}
	}
	return err
}

func mcpReachableForRun(mode domain.RunMode, sandboxMode string, network bool) bool {
	return mode != domain.RunWrite || sandboxMode == "off" || network
}

func mcpCLI(name string) bool {
	return name == "claude" || name == "codex"
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
	// Summary generation is serialized so simultaneous agents do not charge
	// the same channel twice or overwrite a newer boundary.
	lock := a.summaryLock(m.ChannelID)
	lock.Lock()
	summary, _ := a.Store.ChannelSummary(ctx, m.ChannelID)
	summary, _ = a.refreshSummary(ctx, m, summary, false)
	lock.Unlock()
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
	if summary.Text != "" {
		fmt.Fprintf(&b, "Channel summary through %s (lane %s):\n%s\n\n", summary.ThroughMessageID, summary.LaneID, summary.Text)
	}
	if summary.ThroughMessageID != "" {
		for i, msg := range messages {
			if msg.ID == summary.ThroughMessageID {
				messages = messages[i+1:]
				break
			}
		}
	}
	messages = rolloverMessages(messages, summary.Text, a.Config.Runs.ContextLimitTokens)
	b.WriteString("Recent channel messages (oldest first):\n")
	for _, msg := range messages {
		body := msg.Body
		if msg.ID == m.ID {
			body = m.Body
		}
		fmt.Fprintf(&b, "@%s: %s\n", handles[msg.AuthorID], body)
	}
	fmt.Fprintf(&b, "\nRequest:\n%s", m.Body)
	return b.String(), nil
}

func (a *App) summaryLock(channelID string) *sync.Mutex {
	v, _ := a.summaryLocks.LoadOrStore(channelID, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// rolloverMessages keeps the newest messages under 65 percent of the
// configured model context. The conservative four-bytes-per-token estimate
// is only a guardrail, not a tokenizer or a provider measurement.
func rolloverMessages(messages []domain.Message, summary string, limit int) []domain.Message {
	if limit < 1 {
		return messages
	}
	budget := int(float64(limit) * 0.65)
	used := estimatedContextTokens(messages, summary)
	for len(messages) > 1 && used > budget {
		used -= (len(messages[0].Body)+3)/4 + 16
		messages = messages[1:]
	}
	return messages
}

func estimatedContextTokens(messages []domain.Message, summary string) int {
	used := (len(summary) + 3) / 4
	for _, m := range messages {
		used += (len(m.Body)+3)/4 + 16
	}
	return used
}

func (a *App) refreshSummary(ctx context.Context, current domain.Message, previous store.ChannelSummary, force bool) (store.ChannelSummary, error) {
	messages, err := a.Store.RootMessagesAfter(ctx, current.ChannelID, previous.ThroughMessageID)
	if err != nil {
		return previous, err
	}
	if current.ID != "" {
		for i, msg := range messages {
			if msg.ID == current.ID {
				messages = messages[:i]
				break
			}
		}
	}
	if len(messages) == 0 {
		return previous, nil
	}
	every := a.Config.Runs.SummaryEvery
	if every < 1 {
		every = 20
	}
	limit := a.Config.Runs.ContextLimitTokens
	if limit < 1 {
		limit = 128000
	}
	if !force && len(messages) < every && len(messages) <= a.Config.Runs.ContextMessages && estimatedContextTokens(messages, previous.Text) <= int(float64(limit)*0.65) {
		return previous, nil
	}
	lane, err := a.summaryLane(ctx)
	if err != nil {
		return previous, err
	}
	var input strings.Builder
	input.WriteString("Summarize this channel for future agent runs in under 1800 characters. Preserve decisions, constraints, open tasks and named facts. Do not invent facts. Return only the summary.\n\n")
	if previous.Text != "" {
		input.WriteString("Previous summary:\n" + previous.Text + "\n\n")
	}
	input.WriteString("New messages:\n")
	for _, msg := range messages {
		fmt.Fprintf(&input, "%s: %s\n", msg.AuthorID, msg.Body)
	}
	answer, err := a.generateSummary(ctx, lane, input.String(), current.ChannelID)
	if err != nil {
		return previous, err
	}
	answer = strings.TrimSpace(answer)
	if answer == "" {
		return previous, errors.New("summary lane returned no text")
	}
	if len(answer) > 4000 {
		answer = answer[:4000]
	}
	updated := store.ChannelSummary{ChannelID: current.ChannelID, LaneID: lane.ID, Text: answer, ThroughMessageID: messages[len(messages)-1].ID, UpdatedAt: time.Now().UTC()}
	_, err = a.Store.Append(ctx, events.Draft{Type: events.ChannelSummarized, Actor: events.System, ChannelID: current.ChannelID, Payload: updated})
	if err != nil {
		return previous, err
	}
	if len(messages) == 80 {
		return a.refreshSummary(ctx, current, updated, force)
	}
	return updated, nil
}

func (a *App) summaryLane(ctx context.Context) (domain.Lane, error) {
	all, err := a.Store.Lanes(ctx)
	if err != nil {
		return domain.Lane{}, err
	}
	preferred := a.Config.Runs.SummaryLane
	if preferred != "" {
		for _, l := range all {
			if l.ID == preferred && a.Adapters[l.CLI] != nil && l.Running < l.Capacity && l.Health != domain.LaneExhausted && l.Health != domain.LaneUnavailable {
				return l, nil
			}
		}
		return domain.Lane{}, fmt.Errorf("summary lane %s unavailable", preferred)
	}
	rank := func(c domain.CostClass) int {
		switch c {
		case domain.CostLocal:
			return 0
		case domain.CostCheap:
			return 1
		case domain.CostStandard:
			return 2
		default:
			return 3
		}
	}
	sort.Slice(all, func(i, j int) bool {
		if rank(all[i].CostClass) != rank(all[j].CostClass) {
			return rank(all[i].CostClass) < rank(all[j].CostClass)
		}
		return all[i].ID < all[j].ID
	})
	for _, l := range all {
		if a.Adapters[l.CLI] != nil && l.Running < l.Capacity && l.Health != domain.LaneExhausted && l.Health != domain.LaneUnavailable {
			return l, nil
		}
	}
	return domain.Lane{}, errors.New("no summary lane available")
}

func (a *App) generateSummary(ctx context.Context, lane domain.Lane, prompt, channelID string) (string, error) {
	if err := a.Registry.Acquire(lane.ID); err != nil {
		return "", err
	}
	defer a.Registry.Release(lane.ID)
	a.Registry.RecordRun(lane.ID)
	adapter := a.Adapters[lane.CLI]
	if adapter == nil {
		return "", fmt.Errorf("no summary adapter for %s", lane.CLI)
	}
	channel, err := a.Store.Channel(ctx, channelID)
	if err != nil {
		return "", err
	}
	dir := channel.RepoPath
	if dir == "" {
		dir = a.Paths.DataDir
	}
	command, err := adapter.Command(adapters.Request{Prompt: prompt, Mode: domain.RunRead, Model: lane.Model, Workdir: dir, Timeout: 2 * time.Minute})
	if err != nil {
		return "", err
	}
	for _, file := range command.Remove {
		defer os.Remove(file)
	}
	callCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(callCtx, command.Path, command.Args...)
	cmd.Dir = command.Dir
	cmd.Env = append([]string{}, os.Environ()...)
	for key, value := range command.EnvAdd {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	for _, key := range command.EnvRemove {
		filtered := cmd.Env[:0]
		for _, item := range cmd.Env {
			if !strings.HasPrefix(item, key+"=") {
				filtered = append(filtered, item)
			}
		}
		cmd.Env = filtered
	}
	var out summaryOutput
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return "", err
	}
	return adapters.CleanAnswer(adapter, out.String()), nil
}

type summaryOutput struct{ bytes.Buffer }

func (o *summaryOutput) Write(p []byte) (int, error) {
	n := len(p)
	if o.Len() < 8192 {
		remaining := 8192 - o.Len()
		if len(p) > remaining {
			p = p[:remaining]
		}
		_, _ = o.Buffer.Write(p)
	}
	return n, nil
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

func (a *App) ResolveApproval(ctx context.Context, approval domain.Approval, option, commitMessage string) (string, error) {
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
			return "", domain.UserError{Message: "The channel repository has uncommitted changes to tracked files. Commit or stash them, then merge again."}
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
			// The author is the human's Git identity: they approved it.
			// Hooks are disabled because the run could have changed Git metadata.
			message := strings.TrimSpace(commitMessage)
			if message == "" {
				message = strings.TrimSpace(approval.CommitMessage)
			}
			if message == "" {
				message = a.commitMessage(ctx, run)
			}
			if err := gitHumanCommit(ctx, w.Path, message); err != nil {
				return "", fmt.Errorf("committing run changes (repository hooks may have refused them): %w", err)
			}
		}
		head, err := git(ctx, w.Repo, "rev-parse", "HEAD")
		if err != nil {
			return "", err
		}
		replayed := head != run.BaseCommit
		if replayed {
			// The branch moved while the run waited (another merge, a human
			// commit). Replay the run's single commit on top instead of
			// failing the fast-forward; on a conflict, leave everything as it
			// was so Keep and Discard still work.
			if _, err := git(ctx, w.Path, "rebase", "--no-autostash", head); err != nil {
				files, _ := git(ctx, w.Path, "diff", "--name-only", "--diff-filter=U")
				_, _ = git(ctx, w.Path, "rebase", "--abort")
				return "", domain.UserError{Message: "The branch moved since this run started and the run's changes conflict in: " +
					strings.Join(strings.Fields(files), ", ") + ". Choose Keep to resolve it by hand, or Discard."}
			}
		}
		if _, err := git(ctx, w.Repo, "merge", "--ff-only", w.Branch); err != nil {
			return "", err
		}
		outcome = "Fast-forwarded " + w.Branch + " into the current branch."
		if replayed {
			outcome = "Merged " + w.Branch + " on top of changes made since the run started."
		}
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

// commitMessage is the message for a run whose agent proposed none.
func (a *App) commitMessage(ctx context.Context, run domain.Run) string {
	trigger := ""
	if m, err := a.Store.Message(ctx, run.TriggerMessageID); err == nil {
		trigger = m.Body
	}
	return buildCommitMessage("", trigger, run.ID)
}

// buildCommitMessage turns the agent's proposal (a subject line, then an
// optional body) into a full message and appends a Closes line for each issue
// the request mentioned. With no proposal the subject comes from the request
// that started the run, so the history says what was asked for rather than an
// internal id.
func buildCommitMessage(proposal, trigger, runID string) string {
	subject, body, _ := strings.Cut(strings.TrimSpace(proposal), "\n")
	subject = fitSubject(subject)
	if subject == "" {
		line := strings.TrimSpace(strings.SplitN(trigger, "\n", 2)[0])
		subject = fitSubject(mentionPrefix.ReplaceAllString(line, ""))
		if subject == "" {
			subject = "Apply changes from faztudo run " + runID
		} else {
			subject = strings.ToUpper(subject[:1]) + subject[1:]
		}
	}
	msg := subject
	if body = strings.TrimSpace(attributionTrailer.ReplaceAllString(body, "")); body != "" {
		msg += "\n\n" + body
	}
	seen := map[string]bool{}
	for _, m := range closesRef.FindAllStringSubmatch(proposal, -1) {
		seen[m[1]] = true
	}
	var closes string
	for _, m := range issueRef.FindAllStringSubmatch(trigger, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			closes += "\nCloses #" + m[1]
		}
	}
	if closes != "" {
		msg += "\n" + closes
	}
	return msg + "\n\nfaztudo run " + runID
}

// fitSubject cuts a line at a word boundary so it fits in 72 bytes.
func fitSubject(line string) string {
	out := ""
	for _, word := range strings.Fields(line) {
		candidate := word
		if out != "" {
			candidate = out + " " + word
		}
		if len(candidate) > 72 {
			break
		}
		out = candidate
	}
	return out
}

// splitCommit cuts the last COMMIT: block (that line and everything after it)
// out of an answer and returns it as the proposed message.
func splitCommit(answer string) (reply, proposal string) {
	locs := commitLine.FindAllStringIndex(answer, -1)
	if len(locs) == 0 {
		return answer, ""
	}
	last := locs[len(locs)-1]
	return strings.TrimSpace(answer[:last[0]]), strings.TrimSpace(answer[last[1]:])
}

var (
	mentionPrefix = regexp.MustCompile(`^(@[A-Za-z0-9_-]+[\s,:]*)+`)
	commitLine    = regexp.MustCompile(`(?m)^COMMIT:[ \t]*`)
	issueRef      = regexp.MustCompile(`#(\d+)\b`)
	closesRef     = regexp.MustCompile(`(?i)\bcloses #(\d+)`)
	// Tool attribution lines are dropped from agent proposals: the human
	// who approves the merge is the author (docs/adr/0003).
	attributionTrailer = regexp.MustCompile(`(?im)^\s*(co-authored-by|claude-session|generated-by|assisted-by):.*$\n?`)
)

func git(ctx context.Context, dir string, args ...string) (string, error) {
	flags := []string{"-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-C", dir}
	if len(args) > 0 && args[0] == "diff" {
		args = append([]string{"diff", "--no-ext-diff", "--no-textconv"}, args[1:]...)
	}
	cmd := exec.CommandContext(ctx, "git", append(flags, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

func gitHumanCommit(ctx context.Context, dir, message string) error {
	cmd := exec.CommandContext(ctx, "git", "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-C", dir, "commit", "-q", "-m", message)
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

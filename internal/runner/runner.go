package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/lanes"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

var transitions = map[domain.RunState]map[domain.RunState]bool{
	domain.RunQueued:          {domain.RunRunning: true, domain.RunCancelled: true},
	domain.RunRunning:         {domain.RunVerifying: true, domain.RunDone: true, domain.RunFailed: true, domain.RunCancelled: true, domain.RunWaitingApproval: true},
	domain.RunVerifying:       {domain.RunDone: true, domain.RunFailed: true, domain.RunCancelled: true, domain.RunWaitingApproval: true},
	domain.RunWaitingApproval: {domain.RunDone: true, domain.RunFailed: true, domain.RunCancelled: true},
}

func Transition(from, to domain.RunState) error {
	if !transitions[from][to] {
		return fmt.Errorf("illegal run transition %s -> %s", from, to)
	}
	return nil
}

type Capacity struct {
	mu           sync.Mutex
	limits, used map[string]int
	changed      chan struct{}
}

func NewCapacity(limits map[string]int) *Capacity {
	copyLimits := map[string]int{}
	for k, v := range limits {
		copyLimits[k] = v
	}
	return &Capacity{limits: copyLimits, used: map[string]int{}, changed: make(chan struct{})}
}
func (c *Capacity) Acquire(ids ...string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	need := map[string]int{}
	for _, id := range ids {
		need[id]++
	}
	for id, n := range need {
		if c.limits[id] < 1 || c.used[id]+n > c.limits[id] {
			return fmt.Errorf("lane %s at capacity", id)
		}
	}
	for id, n := range need {
		c.used[id] += n
	}
	return nil
}
func (c *Capacity) Release(ids ...string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, id := range ids {
		if c.used[id] > 0 {
			c.used[id]--
		}
	}
	close(c.changed)
	c.changed = make(chan struct{})
}

func (c *Capacity) WaitAcquire(ctx context.Context, ids ...string) error {
	for {
		c.mu.Lock()
		need := map[string]int{}
		for _, id := range ids {
			need[id]++
		}
		for id, n := range need {
			if c.limits[id] < n {
				c.mu.Unlock()
				return fmt.Errorf("lane %s has insufficient capacity", id)
			}
		}
		free := true
		for id, n := range need {
			if c.used[id]+n > c.limits[id] {
				free = false
				break
			}
		}
		if free {
			for id, n := range need {
				c.used[id] += n
			}
			c.mu.Unlock()
			return nil
		}
		changed := c.changed
		c.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

type Metadata struct {
	Run           domain.Run       `json:"run"`
	PID           int              `json:"pid"`
	PGID          int              `json:"pgid"`
	StartTime     string           `json:"start_time"`
	BaseTime      time.Time        `json:"base_time"`
	OutputOffsets map[string]int64 `json:"output_offsets,omitempty"`
	OutputSeq     int64            `json:"output_seq,omitempty"`
}
type Runner struct {
	RunDir         string
	Appender       events.Appender
	Capacity       *Capacity
	ExtraEnvRemove []string
	Grace          time.Duration
	Backoff        []time.Duration
	Lanes          *lanes.Registry
	PersonaForRun  func(domain.Run) string
	mu             sync.Mutex
	outputMu       sync.Mutex
	active         map[string]bool
	recovered      map[string]context.CancelFunc
}

var runIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type WriteOptions struct {
	Repo        string
	Worktrees   worktree.Manager
	TestCommand string
	TestTimeout time.Duration
	SandboxMode string
	Network     bool
	MemoryMax   string
	TasksMax    int
	ReadOnly    []string
	OnFallback  func(string)
	runStateDir string
	sandboxArgs []string
	sandboxEnv  map[string]string
	scopeUsed   bool
}

func (r *Runner) ExecuteWrite(ctx context.Context, run *domain.Run, adapter adapters.Adapter, req adapters.Request, opts WriteOptions) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if run.Mode != domain.RunWrite || req.Mode != domain.RunWrite {
		return errors.New("write mode required")
	}
	if err := Transition(run.State, domain.RunRunning); err != nil {
		return err
	}
	if !runIDPattern.MatchString(run.ID) || r.RunDir == "" {
		return errors.New("run id and run dir required")
	}
	w, err := opts.Worktrees.Create(ctx, opts.Repo, run.ID)
	if err != nil {
		return err
	}
	run.Worktree = w.Path
	run.BaseCommit = w.BaseCommit
	req.Workdir = w.Path
	err = r.execute(ctx, run, adapter, req, &opts, func() error {
		stat, diff, err := opts.Worktrees.Diff(ctx, w)
		if err != nil {
			return err
		}
		run.DiffStat = &stat
		verifyTimeout := opts.TestTimeout
		if verifyTimeout <= 0 {
			verifyTimeout = 5 * time.Minute
		}
		if diff == "" {
			// Nothing to approve. The run is done, unless the channel's test
			// command fails on the untouched tree.
			output, verifyErr := r.verifyWrite(ctx, w, opts.TestCommand, verifyTimeout, opts)
			if err := r.recordVerification(run, "no changes", output, verifyErr); err != nil {
				return err
			}
			if err := opts.Worktrees.Cleanup(context.Background(), w); err != nil {
				return err
			}
			run.Worktree, run.BaseCommit = "", ""
			return nil
		}
		if err := os.WriteFile(filepath.Join(r.RunDir, run.ID, "diff.patch"), []byte(diff), 0600); err != nil {
			return err
		}
		output, verifyErr := r.verifyWrite(ctx, w, opts.TestCommand, verifyTimeout, opts)
		detail := "diff exists"
		if opts.TestCommand != "" {
			detail = "diff exists and verification passed"
		}
		if err := r.recordVerification(run, detail, output, verifyErr); err != nil {
			return err
		}
		_, after, err := opts.Worktrees.Diff(ctx, w)
		if err != nil {
			return err
		}
		if after != diff {
			return errors.New("verification changed the worktree diff")
		}
		return nil
	}, domain.RunWaitingApproval)
	if err != nil && run.StartedAt == nil {
		cleanupErr := opts.Worktrees.Cleanup(context.Background(), w)
		if cleanupErr == nil {
			run.Worktree = ""
			run.BaseCommit = ""
		}
		return errors.Join(err, cleanupErr)
	}
	return err
}

func (r *Runner) recordVerification(run *domain.Run, passedDetail, output string, verifyErr error) error {
	detail := passedDetail
	if verifyErr != nil {
		detail = verifyErr.Error()
	}
	if output != "" {
		detail += "\n" + strings.TrimRight(output, "\n")
	}
	run.Verification = &domain.Verification{OK: verifyErr == nil, Detail: detail}
	if output != "" {
		if err := r.appendVerificationOutput(run, output); err != nil {
			return errors.Join(verifyErr, fmt.Errorf("record verification output: %w", err))
		}
	}
	return verifyErr
}

func (r *Runner) appendVerificationOutput(run *domain.Run, output string) error {
	r.outputMu.Lock()
	defer r.outputMu.Unlock()
	m, err := r.load(run.ID)
	if err != nil {
		return err
	}
	text := "\n[verification]\n" + output
	path := filepath.Join(r.RunDir, run.ID, "stderr.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	offset, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		_ = f.Close()
		return err
	}
	if _, err := f.WriteString(text); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	for len(text) > 0 {
		n := len(text)
		if n > 16*1024 {
			n = 16 * 1024
		}
		chunk := text[:n]
		text = text[n:]
		m.OutputSeq++
		if err := r.emitRun(context.Background(), run, events.RunOutput, events.RunOutputPayload{RunID: run.ID, Seq: int(m.OutputSeq), Stream: "stderr", Text: chunk}); err != nil {
			return err
		}
		offset += int64(n)
		if err := r.updateOutput(run.ID, "stderr", offset, m.OutputSeq); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runner) Execute(ctx context.Context, run *domain.Run, adapter adapters.Adapter, req adapters.Request) error {
	if run.Mode == domain.RunWrite || req.Mode == domain.RunWrite {
		return errors.New("write runs require ExecuteWrite")
	}
	return r.execute(ctx, run, adapter, req, nil, nil, domain.RunDone)
}
func (r *Runner) execute(ctx context.Context, run *domain.Run, adapter adapters.Adapter, req adapters.Request, write *WriteOptions, verify func() error, successState domain.RunState) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !runIDPattern.MatchString(run.ID) || r.RunDir == "" {
		return errors.New("run id and run dir required")
	}
	if err := r.claimID(run.ID); err != nil {
		return err
	}
	defer r.releaseID(run.ID)
	if err := Transition(run.State, domain.RunRunning); err != nil {
		return err
	}
	if r.Capacity != nil {
		if err := r.Capacity.WaitAcquire(ctx, run.LaneID); err != nil {
			return err
		}
		defer r.Capacity.Release(run.LaneID)
	}
	if r.Lanes != nil {
		if err := r.Lanes.WaitAcquire(ctx, run.LaneID); err != nil {
			return err
		}
		defer r.Lanes.Release(run.LaneID)
	}
	command, err := adapter.Command(req)
	if err != nil {
		return err
	}
	defer removePaths(command.Remove)
	if write != nil && write.SandboxMode != "" && write.SandboxMode != "off" {
		write.runStateDir = filepath.Join(r.RunDir, run.ID, "sandbox")
		defer os.RemoveAll(write.runStateDir)
		command, err = sandboxCommand(ctx, command, adapter.Name(), req, write)
		if err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Join(r.RunDir, run.ID), 0700); err != nil {
		return err
	}
	now := time.Now().UTC()
	run.State = domain.RunRunning
	run.StartedAt = &now
	if err := r.emitRun(ctx, run, events.RunUpdated, *run); err != nil {
		return err
	}
	backoff := r.Backoff
	if backoff == nil {
		backoff = []time.Duration{30 * time.Second, 120 * time.Second, 600 * time.Second}
	}
	var outputSeq atomic.Int64
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return errors.Join(err, r.finish(context.Background(), run, domain.RunCancelled, domain.FailureTransient, err.Error(), nil))
		}
		outStart := r.fileSize(run.ID, "stdout.log")
		code, tail, execErr := r.executeOnce(ctx, run, command, req.Timeout, &outputSeq)
		stdoutTail := r.tailOf(run.ID, "stdout.log", outStart)
		if ctx.Err() != nil {
			state := domain.RunCancelled
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				state = domain.RunFailed
			}
			finishErr := r.finish(context.Background(), run, state, domain.FailureTransient, ctx.Err().Error(), &code)
			return errors.Join(ctx.Err(), finishErr)
		}
		class, signal, reason := adapters.Classify(adapter, code, stdoutTail, tail)
		// A zero exit succeeds unless the adapter reads a lane signal out
		// of the output (agy reports an exhausted quota with exit 0).
		if execErr == nil && code == 0 && signal.Kind == adapters.SignalNone {
			if verify != nil {
				run.State = domain.RunVerifying
				if err := r.emitRun(ctx, run, events.RunUpdated, *run); err != nil {
					return err
				}
				if err := verify(); err != nil {
					if run.Verification == nil || run.Verification.OK {
						run.Verification = &domain.Verification{OK: false, Detail: err.Error()}
					}
					state := domain.RunFailed
					class := domain.FailureSemantic
					if ctx.Err() != nil {
						class = domain.FailureTransient
						if errors.Is(ctx.Err(), context.Canceled) {
							state = domain.RunCancelled
						}
					}
					return errors.Join(err, r.finish(context.Background(), run, state, class, err.Error(), &code))
				}
			}
			if verify != nil && run.DiffStat != nil && run.DiffStat.Files == 0 {
				successState = domain.RunDone // a write run that changed nothing has nothing to approve
			}
			return r.finish(ctx, run, successState, "", "", &code)
		}
		if errors.Is(execErr, context.DeadlineExceeded) {
			class = domain.FailureTransient
			reason = "run timed out"
		}
		if reason == "" {
			if execErr != nil {
				reason = execErr.Error()
			} else {
				reason = fmt.Sprintf("process exited with code %d", code)
			}
		}
		var signalErr error
		if signal.Kind != adapters.SignalNone && r.Lanes != nil && r.PersonaForRun != nil {
			if persona := r.PersonaForRun(*run); persona != "" {
				signalErr = r.Lanes.ApplySignalForChannel(ctx, run.ID, run.ChannelID, persona, run.LaneID, signal, reason)
			}
		}
		if signalErr != nil {
			return errors.Join(signalErr, r.finish(ctx, run, domain.RunFailed, class, reason, &code))
		}
		if class == domain.FailureTransient && attempt < len(backoff) {
			timer := time.NewTimer(backoff[attempt])
			select {
			case <-timer.C:
				timer.Stop()
				if err := ctx.Err(); err != nil {
					return errors.Join(err, r.finish(context.Background(), run, domain.RunCancelled, domain.FailureTransient, err.Error(), &code))
				}
				continue
			case <-ctx.Done():
				timer.Stop()
				return errors.Join(ctx.Err(), r.finish(context.Background(), run, domain.RunCancelled, domain.FailureTransient, ctx.Err().Error(), &code))
			}
		}
		finishErr := r.finish(ctx, run, domain.RunFailed, class, reason, &code)
		if execErr != nil {
			return errors.Join(fmt.Errorf("run failed: %w: %s", execErr, reason), finishErr)
		}
		return errors.Join(errors.New(reason), finishErr)
	}
}
func removePaths(paths []string) {
	for _, path := range paths {
		if path == "" {
			continue
		}
		_ = os.Remove(path)
	}
}
func (r *Runner) claimID(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active == nil {
		r.active = map[string]bool{}
	}
	if r.active[id] {
		return fmt.Errorf("run %s already active", id)
	}
	if _, err := os.Stat(filepath.Join(r.RunDir, id, "run.json")); err == nil {
		return fmt.Errorf("run %s already exists", id)
	} else if !os.IsNotExist(err) {
		return err
	}
	r.active[id] = true
	return nil
}
func (r *Runner) releaseID(id string) { r.mu.Lock(); defer r.mu.Unlock(); delete(r.active, id) }
func (r *Runner) claimRecoveredID(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active == nil {
		r.active = map[string]bool{}
	}
	if r.active[id] {
		return false
	}
	r.active[id] = true
	return true
}
func (r *Runner) finish(ctx context.Context, run *domain.Run, state domain.RunState, class domain.FailureClass, reason string, code *int) error {
	run.State = state
	run.FailureClass = class
	run.FailureReason = reason
	run.ExitCode = code
	now := time.Now().UTC()
	run.EndedAt = &now
	m, err := r.load(run.ID)
	if err != nil {
		m = Metadata{}
	}
	m.Run = *run
	if err := r.save(m); err != nil {
		return err
	}
	return r.emitRun(ctx, run, events.RunUpdated, *run)
}
func (r *Runner) executeOnce(ctx context.Context, run *domain.Run, c adapters.Cmd, timeout time.Duration, seq *atomic.Int64) (int, string, error) {
	path := filepath.Join(r.RunDir, run.ID)
	out, err := os.OpenFile(filepath.Join(path, "stdout.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return -1, "", err
	}
	defer out.Close()
	errFile, err := os.OpenFile(filepath.Join(path, "stderr.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return -1, "", err
	}
	defer errFile.Close()
	startOutOffset, _ := out.Seek(0, io.SeekEnd)
	startErrOffset, _ := errFile.Seek(0, io.SeekEnd)
	cmd := exec.Command(c.Path, c.Args...)
	cmd.Dir = c.Dir
	cmd.Env = stripEnv(os.Environ(), append(r.ExtraEnvRemove, c.EnvRemove...), c.EnvAdd, c.EnvAllow...)
	cmd.Stdin = nil
	cmd.Stdout = out
	cmd.Stderr = errFile
	cmd.SysProcAttr = processGroup()
	if err = cmd.Start(); err != nil {
		return -1, "", err
	}
	start, err := startTime(cmd.Process.Pid)
	if err != nil {
		killGroup(cmd.Process.Pid, r.Grace)
		cmd.Wait()
		return -1, "", err
	}
	meta := Metadata{Run: *run, PID: cmd.Process.Pid, PGID: cmd.Process.Pid, StartTime: start, BaseTime: time.Now().UTC()}
	if previous, err := r.load(run.ID); err == nil {
		meta.OutputOffsets = previous.OutputOffsets
		meta.OutputSeq = previous.OutputSeq
	}
	if err = r.save(meta); err != nil {
		killGroup(cmd.Process.Pid, r.Grace)
		cmd.Wait()
		return -1, "", err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var timer <-chan time.Time
	var t *time.Timer
	if timeout > 0 {
		t = time.NewTimer(timeout)
		timer = t.C
		defer t.Stop()
	}
	// Files remain attached to the child if the daemon exits. Poll them for events.
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		r.streamFile(run, filepath.Join(path, "stdout.log"), "stdout", startOutOffset, stop, seq)
	}()
	go func() {
		defer wg.Done()
		r.streamFile(run, filepath.Join(path, "stderr.log"), "stderr", startErrOffset, stop, seq)
	}()
	var waitErr error
	select {
	case waitErr = <-done:
	case <-ctx.Done():
		killGroup(cmd.Process.Pid, r.Grace)
		waitErr = <-done
	case <-timer:
		killGroup(cmd.Process.Pid, r.Grace)
		waitErr = <-done
		waitErr = context.DeadlineExceeded
	}
	close(stop)
	wg.Wait()
	code := 0
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	} else {
		code = -1
	}
	reader, openErr := os.Open(filepath.Join(path, "stderr.log"))
	if openErr != nil {
		return code, "", waitErr
	}
	defer reader.Close()
	info, _ := reader.Stat()
	endOffset := info.Size()
	if endOffset-startErrOffset > 8192 {
		startErrOffset = endOffset - 8192
	}
	tailBytes := make([]byte, endOffset-startErrOffset)
	_, _ = reader.ReadAt(tailBytes, startErrOffset)
	if waitErr == context.DeadlineExceeded {
		return code, string(tailBytes), waitErr
	}
	return code, string(tailBytes), waitErr
}
func (r *Runner) fileSize(id, name string) int64 {
	info, err := os.Stat(filepath.Join(r.RunDir, id, name))
	if err != nil {
		return 0
	}
	return info.Size()
}

// tailOf returns up to 8 KiB of a run log, never reading before from.
func (r *Runner) tailOf(id, name string, from int64) string {
	f, err := os.Open(filepath.Join(r.RunDir, id, name))
	if err != nil {
		return ""
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return ""
	}
	start := info.Size() - 8192
	if start < from {
		start = from
	}
	if start < 0 || start >= info.Size() {
		return ""
	}
	buf := make([]byte, info.Size()-start)
	n, _ := f.ReadAt(buf, start)
	return string(buf[:n])
}
func (r *Runner) streamFile(run *domain.Run, path, stream string, offset int64, stop <-chan struct{}, seq *atomic.Int64) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Seek(offset, io.SeekStart)
	buf := make([]byte, 16*1024)
	var pending []byte
	emit := func(b []byte) {
		if len(b) > 0 {
			r.outputMu.Lock()
			defer r.outputMu.Unlock()
			n := seq.Add(1)
			if err := r.emitRun(context.Background(), run, events.RunOutput, events.RunOutputPayload{RunID: run.ID, Seq: int(n), Stream: stream, Text: string(b)}); err == nil {
				offset += int64(len(b))
				_ = r.updateOutput(run.ID, stream, offset, n)
			}
		}
	}
	read := func() {
		for {
			n, err := f.Read(buf)
			if n > 0 {
				for _, b := range buf[:n] {
					pending = append(pending, b)
					if b == '\n' || len(pending) == 16*1024 {
						emit(pending)
						pending = pending[:0]
					}
				}
			}
			if err == io.EOF || err != nil {
				return
			}
		}
	}
	for {
		read()
		select {
		case <-stop:
			read()
			emit(pending)
			return
		case <-time.After(20 * time.Millisecond):
		}
	}
}
func (r *Runner) load(id string) (Metadata, error) {
	b, err := os.ReadFile(filepath.Join(r.RunDir, id, "run.json"))
	if err != nil {
		return Metadata{}, err
	}
	var m Metadata
	err = json.Unmarshal(b, &m)
	return m, err
}
func (r *Runner) emitRun(ctx context.Context, run *domain.Run, typ events.Type, payload any) error {
	if r.Appender == nil {
		return nil
	}
	_, err := r.Appender.Append(ctx, events.Draft{Type: typ, Version: 1, Actor: events.System, ChannelID: run.ChannelID, Payload: payload})
	return err
}
func (r *Runner) save(m Metadata) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.saveLocked(m)
}
func (r *Runner) saveLocked(m Metadata) error {
	dir := filepath.Join(r.RunDir, m.Run.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "run-*.json")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err = tmp.Chmod(0600); err == nil {
		_, err = tmp.Write(b)
	}
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, filepath.Join(dir, "run.json"))
}
func (r *Runner) updateOutput(id, stream string, offset, seq int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	m, err := r.load(id)
	if err != nil {
		return err
	}
	if m.OutputOffsets == nil {
		m.OutputOffsets = map[string]int64{}
	}
	if offset > m.OutputOffsets[stream] {
		m.OutputOffsets[stream] = offset
	}
	if seq > m.OutputSeq {
		m.OutputSeq = seq
	}
	return r.saveLocked(m)
}
func processGroup() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }
func killGroup(pgid int, grace time.Duration) {
	if pgid <= 0 {
		return
	}
	syscall.Kill(-pgid, syscall.SIGTERM)
	if grace <= 0 {
		grace = 100 * time.Millisecond
	}
	time.Sleep(grace)
	syscall.Kill(-pgid, syscall.SIGKILL)
}
func startTime(pid int) (string, error) {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", err
	}
	i := strings.LastIndex(string(b), ")")
	if i < 0 {
		return "", errors.New("invalid proc stat")
	}
	fields := strings.Fields(string(b[i+1:]))
	if len(fields) < 20 {
		return "", errors.New("short proc stat")
	}
	return fields[19], nil
}
func processAlive(pid int) bool {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return false
	}
	i := strings.LastIndex(string(b), ")")
	if i < 0 {
		return false
	}
	fields := strings.Fields(string(b[i+1:]))
	return len(fields) > 0 && fields[0] != "Z" && fields[0] != "X"
}
func stripEnv(base, remove []string, add map[string]string, extraAllow ...string) []string {
	blocked := map[string]bool{}
	for _, k := range remove {
		blocked[k] = true
	}
	out := make([]string, 0, len(base)+len(add))
	seen := map[string]bool{}
	allowed := map[string]bool{"PATH": true, "HOME": true, "USER": true, "LOGNAME": true, "SHELL": true, "LANG": true, "TERM": true, "TZ": true, "TMPDIR": true}
	for _, k := range extraAllow {
		allowed[k] = true
	}
	keep := func(k string) bool {
		return !blocked[k] && (allowed[k] || strings.HasPrefix(k, "LC_") || strings.HasPrefix(k, "XDG_"))
	}
	for _, kv := range base {
		k, _, ok := strings.Cut(kv, "=")
		if !ok || seen[k] || !keep(k) || addHas(add, k) {
			continue
		}
		seen[k] = true
		out = append(out, kv)
	}
	for k, v := range add {
		if keep(k) {
			out = append(out, k+"="+v)
		}
	}
	return out
}
func addHas(add map[string]string, k string) bool { _, ok := add[k]; return ok }

// Recover inspects persisted running runs. A matching live process is left
// running; its files remain attached to the child. A stale identity is failed.
func (r *Runner) Recover(ctx context.Context) ([]domain.Run, error) {
	entries, err := os.ReadDir(r.RunDir)
	if os.IsNotExist(err) {
		entries = nil
		err = nil
	}
	if err != nil {
		return nil, err
	}
	var result []domain.Run
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(r.RunDir, e.Name(), "run.json"))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return result, err
		}
		var m Metadata
		if err = json.Unmarshal(b, &m); err != nil {
			return result, err
		}
		if m.Run.State != domain.RunRunning {
			continue
		}
		actual, err := startTime(m.PID)
		if err != nil || actual != m.StartTime || !processAlive(m.PID) {
			// A mismatched pid may now belong to another process. Never signal it.
			if err != nil || actual == m.StartTime {
				cleanupGroup(m.PGID, m.StartTime, r.Grace)
			}
			m.Run.State = domain.RunFailed
			m.Run.FailureClass = domain.FailureTransient
			m.Run.FailureReason = "outcome unknown after daemon restart"
			now := time.Now().UTC()
			m.Run.EndedAt = &now
			if err = r.save(m); err != nil {
				return result, err
			}
			if err = r.emitRun(ctx, &m.Run, events.RunUpdated, m.Run); err != nil {
				return result, err
			}
			_ = os.RemoveAll(filepath.Join(r.RunDir, m.Run.ID, "sandbox"))
		} else {
			if r.claimRecoveredID(m.Run.ID) {
				if r.Capacity != nil {
					if err := r.Capacity.Acquire(m.Run.LaneID); err != nil {
						r.releaseID(m.Run.ID)
						return result, err
					}
				}
				if r.Lanes != nil {
					if err := r.Lanes.Acquire(m.Run.LaneID); err != nil {
						if r.Capacity != nil {
							r.Capacity.Release(m.Run.LaneID)
						}
						r.releaseID(m.Run.ID)
						return result, err
					}
				}
				monitorCtx, cancel := context.WithCancel(ctx)
				r.mu.Lock()
				if r.recovered == nil {
					r.recovered = map[string]context.CancelFunc{}
				}
				r.recovered[m.Run.ID] = cancel
				r.mu.Unlock()
				go r.monitorRecovered(monitorCtx, m)
			}
		}
		result = append(result, m.Run)
	}
	// A crash can happen after RunCreated but before the runner writes run.json.
	// Those queued runs have no process to reattach and otherwise stay queued.
	if source, ok := r.Appender.(interface {
		Runs(context.Context, string, string) ([]domain.Run, error)
	}); ok {
		queued, err := source.Runs(ctx, "", string(domain.RunQueued))
		if err != nil {
			return result, err
		}
		for _, run := range queued {
			_, err := os.Stat(filepath.Join(r.RunDir, run.ID, "run.json"))
			if err == nil {
				continue
			}
			if !os.IsNotExist(err) {
				return result, err
			}
			run.State = domain.RunFailed
			run.FailureClass = domain.FailureTransient
			run.FailureReason = "run never started before daemon restart"
			now := time.Now().UTC()
			run.EndedAt = &now
			if err := r.emitRun(ctx, &run, events.RunUpdated, run); err != nil {
				return result, err
			}
			result = append(result, run)
		}
	}
	return result, nil
}

// CancelRecovered stops a process reattached after daemon restart.
func (r *Runner) CancelRecovered(id string) bool {
	r.mu.Lock()
	cancel := r.recovered[id]
	r.mu.Unlock()
	if cancel == nil {
		return false
	}
	cancel()
	return true
}

func (r *Runner) monitorRecovered(ctx context.Context, m Metadata) {
	defer r.releaseID(m.Run.ID)
	defer os.RemoveAll(filepath.Join(r.RunDir, m.Run.ID, "sandbox"))
	defer func() {
		r.mu.Lock()
		delete(r.recovered, m.Run.ID)
		r.mu.Unlock()
	}()
	if r.Lanes != nil {
		defer r.Lanes.Release(m.Run.LaneID)
	}
	if r.Capacity != nil {
		defer r.Capacity.Release(m.Run.LaneID)
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	var seq atomic.Int64
	seq.Store(m.OutputSeq)
	for _, stream := range []string{"stdout", "stderr"} {
		path := filepath.Join(r.RunDir, m.Run.ID, stream+".log")
		if _, err := os.Stat(path); err != nil {
			continue
		}
		wg.Add(1)
		go func(stream, path string) {
			defer wg.Done()
			r.streamFile(&m.Run, path, stream, m.OutputOffsets[stream], stop, &seq)
		}(stream, path)
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			cleanupGroup(m.PGID, m.StartTime, r.Grace)
			close(stop)
			wg.Wait()
			_ = r.finish(context.Background(), &m.Run, domain.RunCancelled, domain.FailureTransient, "cancelled after daemon restart", nil)
			return
		case <-ticker.C:
			actual, err := startTime(m.PID)
			if err == nil && actual == m.StartTime && processAlive(m.PID) {
				continue
			}
			if err != nil || actual == m.StartTime {
				cleanupGroup(m.PGID, m.StartTime, r.Grace)
			}
			close(stop)
			wg.Wait()
			if latest, loadErr := r.load(m.Run.ID); loadErr == nil {
				m.OutputOffsets = latest.OutputOffsets
				m.OutputSeq = latest.OutputSeq
			}
			m.Run.State = domain.RunFailed
			m.Run.FailureClass = domain.FailureTransient
			m.Run.FailureReason = "outcome unknown after daemon restart"
			now := time.Now().UTC()
			m.Run.EndedAt = &now
			_ = r.save(m)
			_ = r.emitRun(context.Background(), &m.Run, events.RunUpdated, m.Run)
			return
		}
	}
}

func cleanupGroup(pgid int, leaderStart string, grace time.Duration) {
	if pgid <= 0 {
		return
	}
	start, err := strconv.ParseUint(leaderStart, 10, 64)
	if err != nil {
		return
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err != nil {
			continue
		}
		i := strings.LastIndex(string(b), ")")
		if i < 0 {
			continue
		}
		fields := strings.Fields(string(b[i+1:]))
		if len(fields) < 20 {
			continue
		}
		group, gerr := strconv.Atoi(fields[2])
		memberStart, serr := strconv.ParseUint(fields[19], 10, 64)
		if gerr == nil && serr == nil && group == pgid && memberStart >= start && fields[0] != "Z" {
			killGroup(pgid, grace)
			return
		}
	}
}

package bridge

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"syscall"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/events"
)

type Supervisor struct {
	Command               []string
	Handler               *Handler
	BackoffMin            time.Duration
	BackoffMax            time.Duration
	DisconnectNoticeAfter time.Duration
	ShutdownGrace         time.Duration
}

func (s Supervisor) Run(ctx context.Context) error {
	if len(s.Command) == 0 || s.Handler == nil {
		return errors.New("bridge command and handler required")
	}
	min, max := s.BackoffMin, s.BackoffMax
	if min <= 0 {
		min = time.Second
	}
	if max <= 0 {
		max = 5 * time.Minute
	}
	if max < min {
		max = min
	}
	grace := s.ShutdownGrace
	if grace <= 0 {
		grace = 5 * time.Second
	}
	noticeAfter := s.DisconnectNoticeAfter
	if noticeAfter <= 0 {
		noticeAfter = 2 * time.Minute
	}
	backoff := min
	disconnectedAt := time.Time{}
	noticed := false
	for ctx.Err() == nil {
		cmd := exec.Command(s.Command[0], s.Command[1:]...)
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		stdin, err := cmd.StdinPipe()
		if err != nil {
			return err
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return err
		}
		cmd.Stderr = os.Stderr
		if err = cmd.Start(); err != nil {
			return err
		}
		if disconnectedAt.IsZero() {
			disconnectedAt = time.Now()
		}
		conn := NewConn(stdout, stdin, s.Handler)
		status := make(chan string, 4)
		conn.OnStatus = func(state, _ string) {
			select {
			case status <- state:
			default:
			}
		}
		done := make(chan error, 1)
		go func() { done <- conn.Serve(ctx) }()
		started := time.Now()
		poll := noticeAfter / 4
		if poll < time.Millisecond {
			poll = time.Millisecond
		}
		if poll > time.Second {
			poll = time.Second
		}
		ticker := time.NewTicker(poll)
		connected := false
	active:
		for {
			select {
			case <-ctx.Done():
				ticker.Stop()
				_ = conn.Notify("shutdown", struct{}{})
				timer := time.NewTimer(grace)
				select {
				case <-done:
				case <-timer.C:
				}
				timer.Stop()
				_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
				_ = stdin.Close()
				_ = stdout.Close()
				_ = cmd.Wait()
				return nil
			case <-done:
				ticker.Stop()
				_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
				_ = stdin.Close()
				_ = stdout.Close()
				_ = cmd.Wait()
				break active
			case state := <-status:
				if state == "connected" {
					connected = true
					disconnectedAt = time.Time{}
					noticed = false
					backoff = min
				}
				if state == "linking" || state == "disconnected" || state == "error" {
					connected = false
					if disconnectedAt.IsZero() {
						disconnectedAt = time.Now()
					}
				}
			case <-ticker.C:
				if !connected && !disconnectedAt.IsZero() && !noticed && time.Since(disconnectedAt) >= noticeAfter {
					s.notice(ctx, "Signal bridge has been disconnected for over two minutes")
					noticed = true
				}
			}
		}
		if time.Since(started) > time.Minute {
			backoff = min
		}
		if disconnectedAt.IsZero() {
			disconnectedAt = time.Now()
		}
		if !noticed && time.Since(disconnectedAt) >= noticeAfter {
			s.notice(ctx, "Signal bridge has been disconnected for over two minutes")
			noticed = true
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > max {
			backoff = max
		}
	}
	return nil
}

func (s Supervisor) notice(ctx context.Context, message string) {
	bindings, err := s.Handler.bindings(ctx)
	if err != nil {
		return
	}
	key := s.Handler.Config.Alerts
	if key == "" {
		keys := make([]string, 0, len(bindings))
		for k := range bindings {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		if len(keys) == 0 {
			return
		}
		key = keys[0]
	}
	channel := bindings[key]
	if channel != "" {
		_, _ = s.Handler.Store.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, ChannelID: channel, Payload: events.NoticePayload{Level: "warn", Text: message}})
	}
}

// RunCommand runs a bridge process once. It is useful for test fixtures and
// keeps stdout reserved for protocol messages.
func RunCommand(ctx context.Context, command []string, h *Handler) error {
	if len(command) == 0 {
		return fmt.Errorf("bridge command required")
	}
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	err = NewConn(out, in, h).Serve(ctx)
	_ = in.Close()
	_, _ = io.Copy(io.Discard, out)
	waitErr := cmd.Wait()
	if err != nil {
		return err
	}
	return waitErr
}

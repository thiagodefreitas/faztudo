package runner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

type restartAppender struct {
	mu          sync.Mutex
	failUpdates int
	outputs     int
	onOutput    func() error
}

func (a *restartAppender) Append(_ context.Context, d events.Draft) (events.Event, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if d.Type == events.RunUpdated && a.failUpdates > 0 {
		a.failUpdates--
		return events.Event{}, errors.New("temporary append failure")
	}
	if d.Type == events.RunOutput {
		if a.onOutput != nil {
			if err := a.onOutput(); err != nil {
				return events.Event{}, err
			}
		}
		a.outputs++
	}
	return events.Event{}, nil
}

func TestFinishRetriesTerminalEvent(t *testing.T) {
	dir := t.TempDir()
	a := &restartAppender{failUpdates: 1}
	r := Runner{RunDir: dir, Appender: a}
	run := domain.Run{ID: "retry", ChannelID: "channel", State: domain.RunRunning}
	if err := r.save(Metadata{Run: run}); err != nil {
		t.Fatal(err)
	}
	if err := r.finish(context.Background(), &run, domain.RunDone, "", "", nil); err != nil {
		t.Fatal(err)
	}
	if a.failUpdates != 0 {
		t.Fatal("terminal event was not retried")
	}
}

func TestOutputCursorSavedBeforeAppend(t *testing.T) {
	dir := t.TempDir()
	a := &restartAppender{}
	r := Runner{RunDir: dir, Appender: a}
	a.onOutput = func() error {
		m, err := r.load("cursor")
		if err != nil {
			return err
		}
		if m.OutputOffsets["stdout"] == 0 || m.OutputSeq == 0 {
			return errors.New("output event preceded durable cursor")
		}
		return nil
	}
	path := filepath.Join(dir, "cursor")
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "stdout.log"), []byte("line\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := r.save(Metadata{Run: domain.Run{ID: "cursor", ChannelID: "channel", State: domain.RunRunning}}); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	close(stop)
	var seq atomic.Int64
	r.streamFile(&domain.Run{ID: "cursor", ChannelID: "channel"}, filepath.Join(path, "stdout.log"), "stdout", 0, stop, &seq)
	if a.outputs != 1 {
		t.Fatalf("got %d output events", a.outputs)
	}
}

func TestVerificationCursorSavedBeforeAppend(t *testing.T) {
	dir := t.TempDir()
	a := &restartAppender{}
	r := Runner{RunDir: dir, Appender: a}
	a.onOutput = func() error {
		m, err := r.load("verification")
		if err != nil {
			return err
		}
		if m.OutputOffsets["stderr"] == 0 || m.OutputSeq == 0 {
			return errors.New("verification event preceded durable cursor")
		}
		return nil
	}
	run := domain.Run{ID: "verification", ChannelID: "channel", State: domain.RunRunning}
	if err := r.save(Metadata{Run: run}); err != nil {
		t.Fatal(err)
	}
	if err := r.appendVerificationOutput(&run, "passed\n"); err != nil {
		t.Fatal(err)
	}
	if a.outputs != 1 {
		t.Fatalf("got %d output events", a.outputs)
	}
}

func TestRecoveredNonzeroExitUsesRecordedCode(t *testing.T) {
	dir := t.TempDir()
	r := Runner{RunDir: dir}
	run := domain.Run{ID: "failed-orphan", State: domain.RunRunning, Mode: domain.RunRead}
	if err := r.save(Metadata{Run: run}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, run.ID, "exit.status"), []byte("7\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.WaitRecovered()
	m, err := r.load(run.ID)
	if err != nil || m.Run.State != domain.RunFailed || m.Run.ExitCode == nil || *m.Run.ExitCode != 7 {
		t.Fatalf("recovered failure: %+v %v", m.Run, err)
	}
}

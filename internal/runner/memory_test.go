package runner

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/config"
)

func writeMeminfo(t *testing.T, path string, availableKB int) {
	t.Helper()
	body := fmt.Sprintf("MemTotal:       32000000 kB\nMemFree:         1000000 kB\nMemAvailable:   %d kB\n", availableKB)
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}

func fakeMeminfo(t *testing.T, availableKB int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "meminfo")
	writeMeminfo(t, path, availableKB)
	old := config.MemInfoFile
	config.MemInfoFile = path
	memoryReserved = nil
	t.Cleanup(func() { config.MemInfoFile = old; memoryReserved = nil })
	return path
}

func TestMemoryShort(t *testing.T) {
	const g = int64(1) << 30
	cases := []struct {
		limit, avail, reserved int64
		want                   bool
	}{
		{4 * g, 8 * g, 0, false},
		{4 * g, 3 * g, 0, true},
		{4 * g, 8 * g, 5 * g, true},
		{4 * g, 0, 0, false},
		{0, g, 0, false},
	}
	for _, c := range cases {
		if got := memoryShort(c.limit, c.avail, c.reserved); got != c.want {
			t.Errorf("%+v: got %v", c, got)
		}
	}
}

func TestWaitForMemoryQueuesThenStarts(t *testing.T) {
	path := fakeMeminfo(t, 1<<20) // 1 GB free
	old := memoryPoll
	memoryPoll = 10 * time.Millisecond
	t.Cleanup(func() { memoryPoll = old })
	notes := make(chan string, 8)
	done := make(chan error, 1)
	go func() { done <- waitForMemory(context.Background(), "2G", func(s string) { notes <- s }) }()
	select {
	case err := <-done:
		t.Fatalf("started with too little memory: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	writeMeminfo(t, path, 8<<20)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run did not start after memory freed up")
	}
	close(notes)
	var got []string
	for n := range notes {
		got = append(got, n)
	}
	if len(got) != 1 || !strings.Contains(got[0], "waiting for memory: 1.0 GB free, the run needs 2.0 GB") {
		t.Fatalf("notices: %q", got)
	}
}

func TestWaitForMemoryReservesForParallelRuns(t *testing.T) {
	fakeMeminfo(t, 3<<20) // 3 GB free: room for one 2 GB working need, not two
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := waitForMemory(ctx, "4G", nil); err != nil {
		t.Fatal(err)
	}
	if err := waitForMemory(ctx, "4G", nil); err == nil {
		t.Fatal("second run admitted on the same free memory")
	}
}

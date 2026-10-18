package runner

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/config"
)

// A freshly admitted run has not touched its memory yet, so MemAvailable
// still counts it as free. What it needs stays reserved for this long.
const memoryReserveFor = 45 * time.Second

// The limit is a ceiling, not what a run uses: measured on 9b0ea49 the web
// checks peak near 1.2 GB and go test near 0.9 GB plus about 0.4 GB of
// tmpfs. A run waits for this much free memory, or its limit if smaller.
const memoryAdmitNeed = int64(2) << 30

var memoryPoll = 2 * time.Second

type memoryReservation struct {
	bytes   int64
	expires time.Time
}

var (
	memoryMu       sync.Mutex
	memoryReserved []memoryReservation
)

// memoryShort reports whether a run needing limit bytes must wait. Unknown
// availability (zero) never blocks.
func memoryShort(limit, available, reserved int64) bool {
	return limit > 0 && available > 0 && available-reserved < limit
}

// tryAdmit reserves limit bytes when the machine has them.
func tryAdmit(limit int64, now time.Time) (free int64, ok bool) {
	_, available := config.MemInfo()
	memoryMu.Lock()
	defer memoryMu.Unlock()
	var reserved int64
	live := memoryReserved[:0]
	for _, r := range memoryReserved {
		if r.expires.After(now) {
			live = append(live, r)
			reserved += r.bytes
		}
	}
	memoryReserved = live
	if memoryShort(limit, available, reserved) {
		return max(available-reserved, 0), false
	}
	memoryReserved = append(memoryReserved, memoryReservation{limit, now.Add(memoryReserveFor)})
	return available, true
}

// waitForMemory keeps a sandboxed write run queued until its memory limit
// working need fits in MemAvailable. It posts one notice through notify.
func waitForMemory(ctx context.Context, memoryMax string, notify func(string)) error {
	limit, ok := config.MemoryBytes(config.ResolveMemoryMax(memoryMax))
	if !ok {
		return nil
	}
	limit = min(limit, memoryAdmitNeed)
	told := false
	for {
		free, admitted := tryAdmit(limit, time.Now())
		if admitted {
			return nil
		}
		if !told && notify != nil {
			told = true
			notify(fmt.Sprintf("waiting for memory: %.1f GB free, the run needs %.1f GB", float64(free)/(1<<30), float64(limit)/(1<<30)))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(memoryPoll):
		}
	}
}

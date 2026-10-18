package runner

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// The wrapper is outside bubblewrap but inside the systemd scope. It writes
// the scope's counters before systemd-run exits and --collect removes them.
const scopeReportScript = `
report=$1
shift
"$@"
status=$?
group=
while IFS=: read -r id controllers path; do
  if [ "$id" = 0 ]; then group=$path; break; fi
done < /proc/self/cgroup
oom=0
peak=0
if [ -n "$group" ]; then
  base=/sys/fs/cgroup$group
  if [ -r "$base/memory.events" ]; then
    while read -r key value; do
      if [ "$key" = oom_kill ]; then oom=$value; fi
    done < "$base/memory.events"
  fi
  if [ -r "$base/memory.peak" ]; then read -r peak < "$base/memory.peak"; fi
fi
printf 'oom_kill %s\npeak %s\n' "$oom" "$peak" > "$report"
exit "$status"
`

type scopeOOMError string

func (e scopeOOMError) Error() string { return string(e) }

// scopeFailure records the highest measured peak across attempts. Exit 137
// under a MemoryMax scope is an OOM fallback when the scope report is absent.
func scopeFailure(run *domain.Run, code int, opts *WriteOptions) (bool, string) {
	if opts == nil || !opts.scopeUsed || opts.MemoryMax == "" {
		return false, ""
	}
	oomKills := int64(0)
	if data, err := os.ReadFile(opts.scopeReport); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			fields := strings.Fields(line)
			if len(fields) != 2 {
				continue
			}
			value, err := strconv.ParseInt(fields[1], 10, 64)
			if err != nil || value < 0 {
				continue
			}
			switch fields[0] {
			case "oom_kill":
				oomKills = value
			case "peak":
				if value > run.PeakMemoryBytes {
					run.PeakMemoryBytes = value
				}
			}
		}
	}
	if oomKills == 0 && code != 137 {
		return false, ""
	}
	limit := opts.MemoryMax
	if bytes, ok := config.MemoryBytes(limit); ok {
		limit = strconv.FormatFloat(float64(bytes)/(1<<30), 'f', -1, 64) + " GB"
	}
	return true, fmt.Sprintf("killed: out of memory (limit %s)", limit)
}

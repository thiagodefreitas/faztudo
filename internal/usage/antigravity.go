package usage

import (
	"context"
	"encoding/json"
	"os/exec"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// agyProbeTimeout bounds the zero-turn Antigravity probe.
const agyProbeTimeout = 30 * time.Second

// agyQuota mirrors the quota block the Antigravity probe is expected to
// report next to its usage block. Observed agy 1.4.1 output has only
// conversation_id, status, response, duration_seconds, num_turns and usage;
// quota fields are parsed when present and reported as unknown when absent.
type agyQuota struct {
	FiveHour *agyLimit `json:"five_hour"`
	Weekly   *agyLimit `json:"weekly"`
}

type agyLimit struct {
	UsedPercent     float64 `json:"used_percent"`
	ResetsAt        any     `json:"resets_at"`         // unix seconds or RFC 3339
	ResetsInSeconds *int64  `json:"resets_in_seconds"` // relative to the probe
}

// ParseAGY parses Antigravity probe output (agy --output-format json) and
// turns its quota fields into "5h" and "week" windows measured at
// measuredAt. Slots with no quota field keep UsedPct nil and source
// "unknown".
func ParseAGY(data []byte, measuredAt time.Time) ([]domain.LaneWindow, error) {
	var out struct {
		Quota *agyQuota `json:"quota"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}

	slots := map[string]*agyLimit{"5h": nil, "week": nil}
	if out.Quota != nil {
		slots["5h"] = out.Quota.FiveHour
		slots["week"] = out.Quota.Weekly
	}

	w5h := agyWindow("5h", slots["5h"], measuredAt)
	week := agyWindow("week", slots["week"], measuredAt)
	w5h.MeasuredAt = &measuredAt
	week.MeasuredAt = &measuredAt
	return []domain.LaneWindow{w5h, week}, nil
}

func agyWindow(name string, l *agyLimit, measuredAt time.Time) domain.LaneWindow {
	w := domain.LaneWindow{Name: name, Source: domain.SourceUnknown}
	if l == nil {
		return w
	}
	w.Source = domain.SourceProbe
	w.UsedPct = &l.UsedPercent
	if t, ok := agyResetTime(l, measuredAt); ok {
		w.ResetsAt = &t
	}
	return w
}

func agyResetTime(l *agyLimit, measuredAt time.Time) (time.Time, bool) {
	if l.ResetsInSeconds != nil {
		return measuredAt.Add(time.Duration(*l.ResetsInSeconds) * time.Second).UTC(), true
	}
	switch v := l.ResetsAt.(type) {
	case float64:
		return time.Unix(int64(v), 0).UTC(), true
	case string:
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

// ProbeAGY runs the Antigravity CLI as a zero-turn probe
// (agy -p /usr --output-format json) with a 30 second timeout and parses
// the quota fields of its output. exe defaults to "agy".
func ProbeAGY(exe string) ([]domain.LaneWindow, error) {
	if exe == "" {
		exe = "agy"
	}
	ctx, cancel := context.WithTimeout(context.Background(), agyProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "-p", "/usr", "--output-format", "json")
	cmd.Stdin = nil
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	return ParseAGY(out, time.Now().UTC())
}

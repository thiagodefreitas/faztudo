package usage

import (
	"bufio"
	"encoding/json"
	"path/filepath"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// CodexDir is the directory of Codex rollout files under a home dir.
const CodexDir = ".codex"

// codexRateLimits mirrors the rate limit snapshot Codex writes into rollout
// files at payload.rate_limits.
type codexRateLimits struct {
	Primary   *codexLimit `json:"primary"`
	Secondary *codexLimit `json:"secondary"`
}

type codexLimit struct {
	UsedPercent   float64 `json:"used_percent"`
	WindowMinutes int     `json:"window_minutes"`
	ResetsAt      int64   `json:"resets_at"` // unix seconds
}

type codexEntry struct {
	Timestamp string `json:"timestamp"`
	Payload   struct {
		RateLimits *codexRateLimits `json:"rate_limits"`
	} `json:"payload"`
}

// ReadCodex finds the newest rate limit snapshot in Codex rollout files
// under root/CodexDir and turns it into "5h" and "week" windows. Each limit
// is placed by its own window_minutes (300 is 5 hours, 10080 is a week);
// when window_minutes is absent, primary fills "5h" and secondary "week".
// Slots with no limit keep UsedPct nil and source "unknown".
func ReadCodex(root string, opts Options) ([]domain.LaneWindow, error) {
	opts = opts.withDefaults()

	dir := filepath.Join(root, CodexDir)
	files := recentLogFiles(dir, opts, func(name string) bool {
		return len(name) > len("rollout-") && name[:len("rollout-")] == "rollout-" &&
			filepath.Ext(name) == ".jsonl"
	})

	var newest *codexEntry
	var newestTs time.Time
	for _, path := range files {
		rc, err := openCapped(path, opts)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(rc)
		sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
		for sc.Scan() {
			line := sc.Bytes()
			if !json.Valid(line) {
				continue
			}
			var e codexEntry
			if json.Unmarshal(line, &e) != nil || e.Payload.RateLimits == nil {
				continue
			}
			ts, err := time.Parse(time.RFC3339, e.Timestamp)
			if err != nil {
				continue
			}
			if ts.After(opts.Now) {
				continue
			}
			if newest == nil || ts.After(newestTs) {
				entry := e
				newest = &entry
				newestTs = ts
			}
		}
		rc.Close()
	}

	slots := map[string]*codexLimit{"5h": nil, "week": nil}
	if newest != nil {
		assign := func(l *codexLimit, fallback string) {
			if l == nil {
				return
			}
			name := fallback
			if l.WindowMinutes == 300 {
				name = "5h"
			} else if l.WindowMinutes == 10080 {
				name = "week"
			}
			if slots[name] == nil {
				slots[name] = l
			}
		}
		assign(newest.Payload.RateLimits.Primary, "5h")
		assign(newest.Payload.RateLimits.Secondary, "week")
	}

	w5h := codexWindow("5h", slots["5h"], opts.Now)
	week := codexWindow("week", slots["week"], opts.Now)
	if newest != nil {
		measured := newestTs
		w5h.MeasuredAt = &measured
		week.MeasuredAt = &measured
	}
	return []domain.LaneWindow{w5h, week}, nil
}

// codexWindow turns one limit into a window. A snapshot whose reset time has
// already passed says nothing about the current window, so it is reported
// as unknown rather than as the old percentage.
func codexWindow(name string, l *codexLimit, now time.Time) domain.LaneWindow {
	w := domain.LaneWindow{Name: name, Source: domain.SourceUnknown}
	if l == nil {
		return w
	}
	if l.ResetsAt > 0 && !time.Unix(l.ResetsAt, 0).After(now) {
		return w
	}
	w.Source = domain.SourceCLILog
	w.UsedPct = &l.UsedPercent
	if l.ResetsAt > 0 {
		t := time.Unix(l.ResetsAt, 0).UTC()
		w.ResetsAt = &t
	}
	return w
}

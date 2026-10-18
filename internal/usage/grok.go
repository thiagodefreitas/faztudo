package usage

import (
	"encoding/json"
	"io"
	"path/filepath"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// GrokDir is the Grok CLI home under a home dir. Each session keeps a
// usage.json ledger with per-turn token counts and end times.
const GrokDir = ".grok"

// TokenResult is the usage measured from a token-counting CLI's logs.
type TokenResult = ClaudeResult

type grokLedger struct {
	Turns []struct {
		EndedAt             string `json:"endedAt"`
		InputTokens         int64  `json:"inputTokens"`
		OutputTokens        int64  `json:"outputTokens"`
		CachedReadTokens    int64  `json:"cachedReadTokens"`
		CacheCreationTokens int64  `json:"cacheCreationTokens"`
	} `json:"turns"`
}

// ReadGrok sums tokens from the Grok CLI's per-session usage ledgers under
// root/GrokDir/sessions into the rolling 5 hour window, the last hour and the
// current day. Grok reports no rate-limit or quota figure (its docs call it a
// number it cannot source honestly), so UsedPct stays nil unless
// opts.PlanLimitTokens is set.
func ReadGrok(root string, opts Options) (TokenResult, error) {
	opts = opts.withDefaults()
	res := TokenResult{MeasuredAt: opts.Now}

	dir := filepath.Join(root, GrokDir, "sessions")
	files := recentLogFiles(dir, opts, func(name string) bool { return name == "usage.json" })

	dayStart := time.Date(opts.Now.Year(), opts.Now.Month(), opts.Now.Day(), 0, 0, 0, 0, opts.Now.Location())
	winStart := opts.Now.Add(-5 * time.Hour)
	hourStart := opts.Now.Add(-time.Hour)
	var newest time.Time

	for _, path := range files {
		rc, err := openCapped(path, opts)
		if err != nil {
			continue
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			continue
		}
		var ledger grokLedger
		if json.Unmarshal(data, &ledger) != nil {
			continue
		}
		for _, turn := range ledger.Turns {
			ts, err := time.Parse(time.RFC3339Nano, turn.EndedAt)
			if err != nil || ts.After(opts.Now) {
				continue
			}
			if ts.After(newest) {
				newest = ts
			}
			// Grok's inputTokens already include the cached ones; split them
			// out so Total() matches Grok's own totalTokens.
			uncached := turn.InputTokens - turn.CachedReadTokens - turn.CacheCreationTokens
			if uncached < 0 {
				uncached = 0
			}
			tu := TokenUsage{
				InputTokens:      uncached,
				OutputTokens:     turn.OutputTokens,
				CacheReadTokens:  turn.CachedReadTokens,
				CacheWriteTokens: turn.CacheCreationTokens,
				Entries:          1,
			}
			if !ts.Before(winStart) {
				res.FiveHour = addTokens(res.FiveHour, tu)
			}
			if !ts.Before(hourStart) {
				res.LastHour = addTokens(res.LastHour, tu)
			}
			if !ts.Before(dayStart) {
				res.Day = addTokens(res.Day, tu)
			}
		}
	}
	if !newest.IsZero() {
		res.MeasuredAt = newest
	}
	res.Windows = []domain.LaneWindow{
		claudeWindow("5h", res.FiveHour, opts),
		claudeWindow("day", res.Day, opts),
	}
	res.Windows[0].MeasuredAt = &res.MeasuredAt
	res.Windows[1].MeasuredAt = &res.MeasuredAt
	return res, nil
}

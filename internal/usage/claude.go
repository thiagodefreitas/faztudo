package usage

import (
	"bufio"
	"encoding/json"
	"path/filepath"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// ClaudeDir is the directory of Claude Code session logs under a home dir.
const ClaudeDir = ".claude"

// TokenUsage holds token totals for one window. Claude Code logs no quota
// percentage, so this is the honest unit for it.
type TokenUsage struct {
	InputTokens      int64
	OutputTokens     int64
	CacheReadTokens  int64
	CacheWriteTokens int64
	Entries          int
}

// Total is the sum of all token kinds.
func (t TokenUsage) Total() int64 {
	return t.InputTokens + t.OutputTokens + t.CacheReadTokens + t.CacheWriteTokens
}

// ClaudeResult is the usage measured from Claude Code session logs.
type ClaudeResult struct {
	// FiveHour is the rolling 5 hour window ending at Options.Now.
	FiveHour TokenUsage
	// LastHour is the 60 minutes ending at Options.Now.
	LastHour TokenUsage
	// Day is the local calendar day containing Options.Now.
	Day TokenUsage
	// MeasuredAt is the timestamp of the newest assistant entry seen,
	// or Options.Now when no entry had a usable timestamp.
	MeasuredAt time.Time
	// Windows is the domain view: one "5h" and one "day" window.
	Windows []domain.LaneWindow
}

type claudeEntry struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Message   struct {
		Usage *struct {
			InputTokens              int64 `json:"input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

// ReadClaude scans Claude Code session logs under root/ClaudeDir and sums
// tokens from assistant entries into the rolling 5 hour window and the
// current day. UsedPct is left nil unless opts.PlanLimitTokens is set.
func ReadClaude(root string, opts Options) (ClaudeResult, error) {
	opts = opts.withDefaults()
	res := ClaudeResult{MeasuredAt: opts.Now}

	dir := filepath.Join(root, ClaudeDir)
	files := recentLogFiles(dir, opts, func(name string) bool {
		return filepath.Ext(name) == ".jsonl"
	})

	dayStart := time.Date(opts.Now.Year(), opts.Now.Month(), opts.Now.Day(), 0, 0, 0, 0, opts.Now.Location())
	winStart := opts.Now.Add(-5 * time.Hour)
	hourStart := opts.Now.Add(-time.Hour)
	var newest time.Time

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
			var e claudeEntry
			if json.Unmarshal(line, &e) != nil || e.Type != "assistant" || e.Message.Usage == nil {
				continue
			}
			ts, err := time.Parse(time.RFC3339, e.Timestamp)
			if err != nil {
				continue
			}
			if ts.After(opts.Now) {
				continue
			}
			if ts.After(newest) {
				newest = ts
			}
			tu := TokenUsage{
				InputTokens:      e.Message.Usage.InputTokens,
				OutputTokens:     e.Message.Usage.OutputTokens,
				CacheReadTokens:  e.Message.Usage.CacheReadInputTokens,
				CacheWriteTokens: e.Message.Usage.CacheCreationInputTokens,
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
		rc.Close()
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

func addTokens(a, b TokenUsage) TokenUsage {
	a.InputTokens += b.InputTokens
	a.OutputTokens += b.OutputTokens
	a.CacheReadTokens += b.CacheReadTokens
	a.CacheWriteTokens += b.CacheWriteTokens
	a.Entries += b.Entries
	return a
}

func claudeWindow(name string, tu TokenUsage, opts Options) domain.LaneWindow {
	w := domain.LaneWindow{Name: name, Source: domain.SourceCLILog}
	if tu.Entries == 0 {
		w.Source = domain.SourceUnknown
	}
	if tu.Entries > 0 {
		total := tu.Total()
		w.Tokens = &total
	}
	if opts.PlanLimitTokens > 0 && tu.Entries > 0 {
		pct := 100 * float64(tu.Total()) / float64(opts.PlanLimitTokens)
		w.UsedPct = &pct
	}
	return w
}

package usage

import (
	"bufio"
	"encoding/json"
	"io"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// runSlack lets a log entry written just after the process ended still count.
const runSlack = 2 * time.Second

// ReadRun reads the tokens one run used from the CLI's own local logs. It
// looks only at sessions for workdir whose entries fall between start and
// end, and it reports ok=false, never a guess, when the CLI keeps no such log,
// nothing was logged, or more than one session matches (two runs in the same
// directory at the same time cannot be told apart).
func ReadRun(cli, home, workdir string, start, end time.Time) (TokenUsage, bool) {
	if workdir == "" || start.IsZero() || end.Before(start) {
		return TokenUsage{}, false
	}
	end = end.Add(runSlack)
	opts := Options{Now: end, MaxFileAge: end.Sub(start) + time.Hour}.withDefaults()
	var tu TokenUsage
	var sessions int
	switch cli {
	case "claude":
		tu, sessions = runClaude(home, workdir, start, end, opts)
	case "codex":
		tu, sessions = runCodex(home, workdir, start, end, opts)
	case "grok":
		tu, sessions = runGrok(home, workdir, start, end, opts)
	}
	if sessions != 1 || tu.Entries == 0 {
		return TokenUsage{}, false
	}
	return tu, true
}

func inWindow(ts string, start, end time.Time) bool {
	t, err := time.Parse(time.RFC3339Nano, ts)
	return err == nil && !t.Before(start) && !t.After(end)
}

// scanLines calls fn for every valid JSON line of the file, capped in size.
func scanLines(path string, opts Options, fn func(line []byte)) {
	rc, err := openCapped(path, opts)
	if err != nil {
		return
	}
	defer rc.Close()
	sc := bufio.NewScanner(rc)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		if line := sc.Bytes(); json.Valid(line) {
			fn(line)
		}
	}
}

// runClaude sums the assistant entries of one project directory. Claude names
// the directory after the working directory with "/" and "." as "-", and logs
// one entry per content block of a message, so entries are counted by message id.
func runClaude(home, workdir string, start, end time.Time, opts Options) (TokenUsage, int) {
	slug := strings.NewReplacer("/", "-", ".", "-").Replace(workdir)
	dir := filepath.Join(home, ClaudeDir, "projects", slug)
	files := recentLogFiles(dir, opts, func(name string) bool { return filepath.Ext(name) == ".jsonl" })
	var total TokenUsage
	sessions := 0
	for _, path := range files {
		seen := map[string]TokenUsage{}
		anon := 0
		scanLines(path, opts, func(line []byte) {
			var e claudeEntry
			var extra struct {
				CWD     string `json:"cwd"`
				Message struct {
					ID string `json:"id"`
				} `json:"message"`
			}
			if json.Unmarshal(line, &e) != nil || json.Unmarshal(line, &extra) != nil {
				return
			}
			if e.Type != "assistant" || e.Message.Usage == nil || !inWindow(e.Timestamp, start, end) {
				return
			}
			if extra.CWD != "" && extra.CWD != workdir {
				return
			}
			id := extra.Message.ID
			if id == "" {
				anon++
				id = "anon-" + strconv.Itoa(anon)
			}
			seen[id] = TokenUsage{
				InputTokens:      e.Message.Usage.InputTokens,
				OutputTokens:     e.Message.Usage.OutputTokens,
				CacheReadTokens:  e.Message.Usage.CacheReadInputTokens,
				CacheWriteTokens: e.Message.Usage.CacheCreationInputTokens,
				Entries:          1,
			}
		})
		if len(seen) == 0 {
			continue
		}
		sessions++
		for _, tu := range seen {
			total = addTokens(total, tu)
		}
	}
	return total, sessions
}

type codexTotals struct {
	InputTokens       int64 `json:"input_tokens"`
	CachedInputTokens int64 `json:"cached_input_tokens"`
	OutputTokens      int64 `json:"output_tokens"`
}

// runCodex finds the rollout files that started in the run for workdir and
// takes the last cumulative total of each. A codex exec writes one rollout.
func runCodex(home, workdir string, start, end time.Time, opts Options) (TokenUsage, int) {
	files := recentLogFiles(filepath.Join(home, CodexDir, "sessions"), opts, func(name string) bool {
		return strings.HasPrefix(name, "rollout-") && filepath.Ext(name) == ".jsonl"
	})
	var total TokenUsage
	sessions := 0
	for _, path := range files {
		matched := false
		var last *codexTotals
		scanLines(path, opts, func(line []byte) {
			var e struct {
				Type      string `json:"type"`
				Timestamp string `json:"timestamp"`
				Payload   struct {
					Type string `json:"type"`
					CWD  string `json:"cwd"`
					Info *struct {
						Total json.RawMessage `json:"total_token_usage"`
					} `json:"info"`
				} `json:"payload"`
			}
			if json.Unmarshal(line, &e) != nil {
				return
			}
			switch {
			case e.Type == "session_meta":
				matched = e.Payload.CWD == workdir && inWindow(e.Timestamp, start, end)
			case matched && e.Payload.Type == "token_count" && e.Payload.Info != nil && inWindow(e.Timestamp, start, end):
				var t codexTotals
				if json.Unmarshal(e.Payload.Info.Total, &t) == nil {
					last = &t
				}
			}
		})
		if !matched || last == nil {
			continue
		}
		// Codex counts cached tokens inside input_tokens.
		uncached := last.InputTokens - last.CachedInputTokens
		if uncached < 0 {
			uncached = 0
		}
		sessions++
		total = addTokens(total, TokenUsage{InputTokens: uncached, OutputTokens: last.OutputTokens, CacheReadTokens: last.CachedInputTokens, Entries: 1})
	}
	return total, sessions
}

// runGrok sums the turns that ended during the run in the sessions Grok keeps
// for workdir (the directory name is the escaped path).
func runGrok(home, workdir string, start, end time.Time, opts Options) (TokenUsage, int) {
	dir := filepath.Join(home, GrokDir, "sessions", url.PathEscape(workdir))
	files := recentLogFiles(dir, opts, func(name string) bool { return name == "usage.json" })
	var total TokenUsage
	sessions := 0
	for _, path := range files {
		rc, err := openCapped(path, opts)
		if err != nil {
			continue
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		var ledger grokLedger
		if err != nil || json.Unmarshal(data, &ledger) != nil {
			continue
		}
		var session TokenUsage
		for _, turn := range ledger.Turns {
			if !inWindow(turn.EndedAt, start, end) {
				continue
			}
			uncached := turn.InputTokens - turn.CachedReadTokens - turn.CacheCreationTokens
			if uncached < 0 {
				uncached = 0
			}
			session = addTokens(session, TokenUsage{InputTokens: uncached, OutputTokens: turn.OutputTokens, CacheReadTokens: turn.CachedReadTokens, CacheWriteTokens: turn.CacheCreationTokens, Entries: 1})
		}
		if session.Entries == 0 {
			continue
		}
		sessions++
		total = addTokens(total, session)
	}
	return total, sessions
}

package usage

import (
	"testing"
	"time"
)

var (
	runStart = time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC)
	runEnd   = time.Date(2026, 10, 18, 10, 5, 0, 0, time.UTC)
)

func TestReadRunClaudeCountsOnlyThisRunsEntries(t *testing.T) {
	home := t.TempDir()
	cwd := "/work/.local/repo"
	// Claude names the project directory after the working directory, with
	// "/" and "." turned into "-". The same message id is logged once per
	// content block, so it must be counted once.
	writeLog(t, home, ".claude/projects/-work--local-repo/s1.jsonl",
		`{"type":"assistant","timestamp":"2026-10-18T09:00:00Z","cwd":"/work/.local/repo","message":{"id":"m0","usage":{"input_tokens":999,"output_tokens":999}}}
{"type":"assistant","timestamp":"2026-10-18T10:01:00Z","cwd":"/work/.local/repo","message":{"id":"m1","usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":50,"cache_creation_input_tokens":5}}}
{"type":"assistant","timestamp":"2026-10-18T10:01:01Z","cwd":"/work/.local/repo","message":{"id":"m1","usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":50,"cache_creation_input_tokens":5}}}
{"type":"assistant","timestamp":"2026-10-18T10:03:00Z","cwd":"/work/.local/repo","message":{"id":"m2","usage":{"input_tokens":20,"output_tokens":30}}}
{"type":"assistant","timestamp":"2026-10-18T11:00:00Z","cwd":"/work/.local/repo","message":{"id":"m3","usage":{"input_tokens":888,"output_tokens":888}}}
`)
	got, ok := ReadRun("claude", home, cwd, runStart, runEnd)
	if !ok {
		t.Fatal("usage should be known")
	}
	want := TokenUsage{InputTokens: 120, OutputTokens: 40, CacheReadTokens: 50, CacheWriteTokens: 5, Entries: 2}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestReadRunUnknownWhenNothingWasLogged(t *testing.T) {
	home := t.TempDir()
	for _, cli := range []string{"claude", "codex", "grok", "kimi", "agy", "opencode"} {
		if _, ok := ReadRun(cli, home, "/work/repo", runStart, runEnd); ok {
			t.Fatalf("%s: unknown usage must stay unknown", cli)
		}
	}
}

func TestReadRunUnknownWhenTwoSessionsOverlap(t *testing.T) {
	home := t.TempDir()
	line := func(id string) string {
		return `{"type":"assistant","timestamp":"2026-10-18T10:01:00Z","cwd":"/work/repo","message":{"id":"` + id + `","usage":{"input_tokens":1,"output_tokens":1}}}` + "\n"
	}
	writeLog(t, home, ".claude/projects/-work-repo/a.jsonl", line("a"))
	writeLog(t, home, ".claude/projects/-work-repo/b.jsonl", line("b"))
	if _, ok := ReadRun("claude", home, "/work/repo", runStart, runEnd); ok {
		t.Fatal("two sessions in one directory cannot be told apart, so the usage is unknown")
	}
}

func TestReadRunCodexUsesTheRolloutOfThisRun(t *testing.T) {
	home := t.TempDir()
	meta := func(ts, cwd string) string {
		return `{"type":"session_meta","timestamp":"` + ts + `","payload":{"id":"x","cwd":"` + cwd + `","timestamp":"` + ts + `"}}` + "\n"
	}
	// An older rollout in the same directory must not be counted.
	writeLog(t, home, ".codex/sessions/2026/10/18/rollout-old.jsonl",
		meta("2026-10-18T08:00:00Z", "/work/repo")+
			`{"type":"event_msg","timestamp":"2026-10-18T08:01:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5000,"cached_input_tokens":0,"output_tokens":500,"total_tokens":5500}}}}`+"\n")
	// Totals are cumulative, so the last one in the run is the run's usage.
	// Codex counts cached tokens inside input_tokens.
	writeLog(t, home, ".codex/sessions/2026/10/18/rollout-new.jsonl",
		meta("2026-10-18T10:00:30Z", "/work/repo")+
			`{"type":"event_msg","timestamp":"2026-10-18T10:01:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"total_tokens":110}}}}`+"\n"+
			`{"type":"event_msg","timestamp":"2026-10-18T10:02:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":100,"output_tokens":60,"total_tokens":360}}}}`+"\n"+
			`{"type":"event_msg","timestamp":"2026-10-18T10:02:01Z","payload":{"type":"token_count","info":null}}`+"\n")
	got, ok := ReadRun("codex", home, "/work/repo", runStart, runEnd)
	if !ok {
		t.Fatal("usage should be known")
	}
	want := TokenUsage{InputTokens: 200, OutputTokens: 60, CacheReadTokens: 100, Entries: 1}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if _, ok := ReadRun("codex", home, "/work/other", runStart, runEnd); ok {
		t.Fatal("a rollout from another directory is not this run")
	}
}

func TestReadRunGrokCountsTurnsEndedInTheRun(t *testing.T) {
	home := t.TempDir()
	writeLog(t, home, ".grok/sessions/%2Fwork%2Frepo/01aaaaaa/usage.json", `{
  "turns": [
    {"endedAt": "2026-10-18T09:00:00+00:00", "inputTokens": 7000, "outputTokens": 700, "cachedReadTokens": 0, "cacheCreationTokens": 0},
    {"endedAt": "2026-10-18T10:02:00+00:00", "inputTokens": 1000, "outputTokens": 100, "cachedReadTokens": 500, "cacheCreationTokens": 100},
    {"endedAt": "2026-10-18T10:04:00+00:00", "inputTokens": 1200, "outputTokens": 120, "cachedReadTokens": 600, "cacheCreationTokens": 0},
    {"endedAt": "2026-10-18T12:00:00+00:00", "inputTokens": 9000, "outputTokens": 900, "cachedReadTokens": 0, "cacheCreationTokens": 0}
  ]}`)
	got, ok := ReadRun("grok", home, "/work/repo", runStart, runEnd)
	if !ok {
		t.Fatal("usage should be known")
	}
	// Grok counts cached tokens inside inputTokens.
	want := TokenUsage{InputTokens: 1000, OutputTokens: 220, CacheReadTokens: 1100, CacheWriteTokens: 100, Entries: 2}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

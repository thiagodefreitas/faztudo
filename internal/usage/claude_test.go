package usage

import (
	"os"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// testNow is fixed inside the day covered by the synthetic fixture.
var testNow = time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)

func TestReadClaudeSumsWindows(t *testing.T) {
	home := copyTestdata(t, ".claude")
	res, err := ReadClaude(home, Options{Now: testNow})
	if err != nil {
		t.Fatal(err)
	}

	// 5h window: entries at 08:00 (outside) and 11:31, 11:45, 12:00 (inside)
	if got, want := res.FiveHour.InputTokens, int64(600); got != want {
		t.Errorf("FiveHour.InputTokens = %d, want %d", got, want)
	}
	if got, want := res.FiveHour.OutputTokens, int64(300); got != want {
		t.Errorf("FiveHour.OutputTokens = %d, want %d", got, want)
	}
	if got, want := res.FiveHour.CacheReadTokens, int64(60); got != want {
		t.Errorf("FiveHour.CacheReadTokens = %d, want %d", got, want)
	}
	if got, want := res.FiveHour.CacheWriteTokens, int64(30); got != want {
		t.Errorf("FiveHour.CacheWriteTokens = %d, want %d", got, want)
	}
	if got, want := res.FiveHour.Entries, 3; got != want {
		t.Errorf("FiveHour.Entries = %d, want %d", got, want)
	}

	if got, want := res.LastHour.Total(), int64(990); got != want {
		t.Errorf("LastHour.Total() = %d, want %d", got, want)
	}

	// day: all valid entries count, including the 06:30 one
	if got, want := res.Day.InputTokens, int64(1600); got != want {
		t.Errorf("Day.InputTokens = %d, want %d", got, want)
	}
	if got, want := res.Day.Total(), int64(2490); got != want {
		t.Errorf("Day.Total() = %d, want 2490", got)
	}

	if !res.MeasuredAt.Equal(testNow) {
		t.Errorf("MeasuredAt = %v, want %v (no entry may be newer than Now)", res.MeasuredAt, testNow)
	}

	if len(res.Windows) != 2 {
		t.Fatalf("len(Windows) = %d, want 2", len(res.Windows))
	}
	for _, w := range res.Windows {
		if w.Source != domain.SourceCLILog {
			t.Errorf("window %q source = %q, want cli-log", w.Name, w.Source)
		}
		if w.UsedPct != nil {
			t.Errorf("window %q UsedPct = %v, want nil without a plan limit", w.Name, *w.UsedPct)
		}
		if w.MeasuredAt == nil {
			t.Errorf("window %q MeasuredAt is nil", w.Name)
		}
	}
	if res.Windows[0].Name != "5h" || res.Windows[1].Name != "day" {
		t.Errorf("window names = %q, %q", res.Windows[0].Name, res.Windows[1].Name)
	}
}

func TestReadClaudePlanLimitSetsPct(t *testing.T) {
	home := copyTestdata(t, ".claude")
	res, err := ReadClaude(home, Options{Now: testNow, PlanLimitTokens: 10000})
	if err != nil {
		t.Fatal(err)
	}
	// day total is 2490 of 10000
	if res.Windows[1].UsedPct == nil {
		t.Fatal("day UsedPct is nil, want 24.9 with a plan limit")
	}
	if got, want := *res.Windows[1].UsedPct, 24.9; got != want {
		t.Errorf("day UsedPct = %v, want %v", got, want)
	}
}

func TestReadClaudeSkipsOldFiles(t *testing.T) {
	home := t.TempDir()
	path := writeLog(t, home, ".claude/projects/p/s.jsonl",
		`{"type":"assistant","timestamp":"2026-10-18T11:00:00Z","message":{"usage":{"input_tokens":999,"output_tokens":1}}}`+"\n")
	old := time.Now().Add(-9 * 24 * time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}

	res, err := ReadClaude(home, Options{Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	if res.Day.Total() != 0 {
		t.Errorf("Day.Total() = %d, want 0 for an old file", res.Day.Total())
	}
}

func TestReadClaudeCapsFileSize(t *testing.T) {
	home := t.TempDir()
	big := `{"type":"assistant","timestamp":"2026-10-18T11:00:00Z","message":{"usage":{"input_tokens":1,"output_tokens":1}}}` + "\n"
	big += string(make([]byte, 64*1024)) + "\n"
	big += `{"type":"assistant","timestamp":"2026-10-18T11:30:00Z","message":{"usage":{"input_tokens":100,"output_tokens":100}}}` + "\n"
	writeLog(t, home, ".claude/projects/p/big.jsonl", big)

	res, err := ReadClaude(home, Options{Now: testNow, MaxFileBytes: 128})
	if err != nil {
		t.Fatal(err)
	}
	if res.Day.Entries != 1 {
		t.Errorf("Day.Entries = %d, want 1 with a 128 byte cap", res.Day.Entries)
	}
}

func TestReadClaudeMissingDirIsNotAnError(t *testing.T) {
	res, err := ReadClaude(t.TempDir(), Options{Now: testNow, PlanLimitTokens: 10000})
	if err != nil {
		t.Fatal(err)
	}
	if res.Day.Total() != 0 || res.FiveHour.Total() != 0 {
		t.Error("empty root must give zero usage")
	}
	for _, w := range res.Windows {
		if w.UsedPct != nil {
			t.Errorf("window %q UsedPct set with no data", w.Name)
		}
		if w.Source != domain.SourceUnknown {
			t.Errorf("window %q source = %q, want unknown", w.Name, w.Source)
		}
	}
}

package usage

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func TestReadCodexNewestSnapshot(t *testing.T) {
	home := copyTestdata(t, ".codex")
	windows, err := ReadCodex(home, Options{Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	if len(windows) != 2 {
		t.Fatalf("len(windows) = %d, want 2", len(windows))
	}

	w5h, week := windows[0], windows[1]
	if w5h.Name != "5h" || week.Name != "week" {
		t.Fatalf("names = %q, %q", w5h.Name, week.Name)
	}
	// the 11:00 snapshot is newer than the 09:00 one
	if w5h.UsedPct == nil || *w5h.UsedPct != 42.5 {
		t.Errorf("5h UsedPct = %v, want 42.5", w5h.UsedPct)
	}
	if week.UsedPct == nil || *week.UsedPct != 17.0 {
		t.Errorf("week UsedPct = %v, want 17.0", week.UsedPct)
	}
	for _, w := range windows {
		if w.Source != domain.SourceCLILog {
			t.Errorf("window %q source = %q, want cli-log", w.Name, w.Source)
		}
		if w.ResetsAt == nil {
			t.Errorf("window %q ResetsAt is nil", w.Name)
		}
		if w.MeasuredAt == nil {
			t.Errorf("window %q MeasuredAt is nil", w.Name)
		}
	}
	wantReset := time.Unix(1892293200, 0).UTC()
	if !w5h.ResetsAt.Equal(wantReset) {
		t.Errorf("5h ResetsAt = %v, want %v", w5h.ResetsAt, wantReset)
	}
}

func TestReadCodexNoSnapshot(t *testing.T) {
	home := t.TempDir()
	writeLog(t, home, ".codex/sessions/2026/10/18/rollout-x.jsonl",
		`{"type":"event_msg","timestamp":"2026-10-18T09:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":1}}}`+"\n")

	windows, err := ReadCodex(home, Options{Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range windows {
		if w.Source != domain.SourceUnknown {
			t.Errorf("window %q source = %q, want unknown", w.Name, w.Source)
		}
		if w.UsedPct != nil {
			t.Errorf("window %q UsedPct set without a snapshot", w.Name)
		}
	}
}

func TestReadCodexWeeklyPrimary(t *testing.T) {
	// observed real data: primary carries window_minutes 10080 and
	// secondary is null, so primary must fill the week slot
	home := t.TempDir()
	writeLog(t, home, ".codex/sessions/2026/10/18/rollout-y.jsonl",
		`{"type":"event_msg","timestamp":"2026-10-18T09:00:00Z","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":4.0,"window_minutes":10080,"resets_at":1792344024},"secondary":null}}}`+"\n")

	windows, err := ReadCodex(home, Options{Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	if windows[0].Source != domain.SourceUnknown || windows[0].UsedPct != nil {
		t.Errorf("5h window = %+v, want unknown with nil pct", windows[0])
	}
	if windows[1].UsedPct == nil || *windows[1].UsedPct != 4.0 {
		t.Errorf("week UsedPct = %v, want 4.0", windows[1].UsedPct)
	}
}

func TestReadCodexSkipsOldAndUnrelatedFiles(t *testing.T) {
	home := t.TempDir()
	old := writeLog(t, home, ".codex/sessions/2026/10/18/rollout-old.jsonl",
		`{"type":"event_msg","timestamp":"2026-10-18T09:00:00Z","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":99.0,"window_minutes":300,"resets_at":1892293200}}}}`+"\n")
	stale := time.Now().Add(-10 * 24 * time.Hour)
	if err := os.Chtimes(old, stale, stale); err != nil {
		t.Fatal(err)
	}
	writeLog(t, home, ".codex/sessions/2026/10/18/other.jsonl",
		`{"type":"event_msg","timestamp":"2026-10-18T09:00:00Z","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":99.0,"window_minutes":300,"resets_at":1892293200}}}}`+"\n")

	windows, err := ReadCodex(home, Options{Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range windows {
		if w.UsedPct != nil {
			t.Errorf("window %q UsedPct = %v, want nil (only stale/unrelated files)", w.Name, *w.UsedPct)
		}
	}
}

func TestReadCodexSnapshotPastResetIsUnknown(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, CodexDir, "sessions", "2026", "10", "18")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	line := `{"type":"event_msg","timestamp":"2026-10-18T09:00:00Z","payload":{"rate_limits":{"primary":{"used_percent":80,"window_minutes":300,"resets_at":1792310400}}}}`
	if err := os.WriteFile(filepath.Join(dir, "rollout-x.jsonl"), []byte(line+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// resets_at 1792310400 is 2026-10-18T08:00:00Z; three hours later the
	// window has reset and the old 80 percent must not be shown.
	now := time.Date(2026, 10, 18, 11, 0, 0, 0, time.UTC)
	ws, err := ReadCodex(root, Options{Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if ws[0].UsedPct != nil || ws[0].Source != domain.SourceUnknown {
		t.Fatalf("stale 5h window reported as %v from %s", ws[0].UsedPct, ws[0].Source)
	}
}

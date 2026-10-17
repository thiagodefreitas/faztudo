package usage

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

var agyMeasuredAt = time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)

func readTestFile(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "agy", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestParseAGYQuota(t *testing.T) {
	windows, err := ParseAGY(readTestFile(t, "quota.json"), agyMeasuredAt)
	if err != nil {
		t.Fatal(err)
	}
	if len(windows) != 2 {
		t.Fatalf("len(windows) = %d, want 2", len(windows))
	}
	w5h, week := windows[0], windows[1]

	if w5h.UsedPct == nil || *w5h.UsedPct != 12.5 {
		t.Errorf("5h UsedPct = %v, want 12.5", w5h.UsedPct)
	}
	// resets_in_seconds 7200 after the measurement time
	wantReset := agyMeasuredAt.Add(2 * time.Hour).UTC()
	if w5h.ResetsAt == nil || !w5h.ResetsAt.Equal(wantReset) {
		t.Errorf("5h ResetsAt = %v, want %v", w5h.ResetsAt, wantReset)
	}

	if week.UsedPct == nil || *week.UsedPct != 30.0 {
		t.Errorf("week UsedPct = %v, want 30.0", week.UsedPct)
	}
	wantWeekReset := time.Unix(1893456000, 0).UTC()
	if week.ResetsAt == nil || !week.ResetsAt.Equal(wantWeekReset) {
		t.Errorf("week ResetsAt = %v, want %v", week.ResetsAt, wantWeekReset)
	}

	for _, w := range windows {
		if w.Source != domain.SourceProbe {
			t.Errorf("window %q source = %q, want probe", w.Name, w.Source)
		}
		if w.MeasuredAt == nil || !w.MeasuredAt.Equal(agyMeasuredAt) {
			t.Errorf("window %q MeasuredAt = %v, want %v", w.Name, w.MeasuredAt, agyMeasuredAt)
		}
	}
}

func TestParseAGYNoQuotaIsUnknown(t *testing.T) {
	windows, err := ParseAGY(readTestFile(t, "noquota.json"), agyMeasuredAt)
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range windows {
		if w.Source != domain.SourceUnknown {
			t.Errorf("window %q source = %q, want unknown", w.Name, w.Source)
		}
		if w.UsedPct != nil {
			t.Errorf("window %q UsedPct = %v, want nil", w.Name, *w.UsedPct)
		}
	}
}

func TestParseAGYBadJSON(t *testing.T) {
	if _, err := ParseAGY([]byte("{nope"), agyMeasuredAt); err == nil {
		t.Error("want an error for invalid JSON")
	}
}

func TestParseAGYRFCRReset(t *testing.T) {
	data := []byte(`{"quota":{"five_hour":{"used_percent":7.0,"resets_at":"2026-10-18T17:00:00Z"}}}`)
	windows, err := ParseAGY(data, agyMeasuredAt)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 10, 18, 17, 0, 0, 0, time.UTC)
	if windows[0].ResetsAt == nil || !windows[0].ResetsAt.Equal(want) {
		t.Errorf("5h ResetsAt = %v, want %v", windows[0].ResetsAt, want)
	}
	if windows[1].Source != domain.SourceUnknown {
		t.Errorf("week source = %q, want unknown", windows[1].Source)
	}
}

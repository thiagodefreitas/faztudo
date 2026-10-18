package cron

import (
	"testing"
	"time"
)

func TestParseRejectsBadExpressions(t *testing.T) {
	for _, expr := range []string{
		"", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *",
		"* * * 13 *", "* * * * 8", "*/0 * * * *", "5-1 * * * *", "a * * * *", "1,,2 * * * *", "-1 * * * *",
	} {
		if _, err := Parse(expr); err == nil {
			t.Errorf("Parse(%q) accepted a bad expression", expr)
		}
	}
}

func TestNextInAZone(t *testing.T) {
	plus5 := time.FixedZone("UTC+5", 5*3600)
	at := func(day, hour, min int) time.Time { return time.Date(2026, time.October, day, hour, min, 0, 0, plus5) }
	for _, tc := range []struct {
		expr  string
		after time.Time
		want  time.Time
	}{
		{"30 8 * * *", at(18, 15, 0), at(19, 8, 30)},
		{"30 8 * * *", at(18, 8, 0), at(18, 8, 30)},
		{"30 8 * * *", at(18, 8, 30), at(19, 8, 30)},
		{"*/15 * * * *", at(18, 10, 14), at(18, 10, 15)},
		{"0 9 * * 1-5", at(18, 10, 0), at(19, 9, 0)},
		{"0 9 * * mon-fri", at(23, 10, 0), at(26, 9, 0)},
		{"0 0 1 jan *", at(18, 0, 0), time.Date(2027, time.January, 1, 0, 0, 0, 0, plus5)},
		{"0,30 * * * *", at(18, 10, 31), at(18, 11, 0)},
		{"@daily", at(18, 3, 0), at(19, 0, 0)},
		{"0 12 * * 7", at(18, 13, 0), at(25, 12, 0)},
	} {
		s, err := Parse(tc.expr)
		if err != nil {
			t.Fatalf("Parse(%q): %v", tc.expr, err)
		}
		got, ok := s.Next(tc.after)
		if !ok || !got.Equal(tc.want) {
			t.Errorf("%q after %s: got %s, want %s", tc.expr, tc.after, got, tc.want)
		}
		if ok && got.Location() != plus5 {
			t.Errorf("%q: result is not in the input location", tc.expr)
		}
	}
}

func TestNextAcrossDaylightSavingChange(t *testing.T) {
	berlin, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Skip("no time zone database:", err)
	}
	s, err := Parse("0 9 * * 1-5")
	if err != nil {
		t.Fatal(err)
	}
	// Clocks go back on Sunday 25 October 2026. Monday 09:00 is CET, UTC+1.
	friday := time.Date(2026, time.October, 23, 10, 0, 0, 0, berlin)
	got, ok := s.Next(friday)
	if !ok || got.Hour() != 9 || got.Day() != 26 || got.UTC().Hour() != 8 {
		t.Fatalf("got %s (UTC %s)", got, got.UTC())
	}
}

func TestDayOfMonthAndWeekdayOrWhenBothAreSet(t *testing.T) {
	s, err := Parse("0 0 13 * 5") // the 13th or a Friday
	if err != nil {
		t.Fatal(err)
	}
	utc := time.UTC
	got, _ := s.Next(time.Date(2026, time.October, 11, 0, 0, 0, 0, utc)) // Sunday
	if want := time.Date(2026, time.October, 13, 0, 0, 0, 0, utc); !got.Equal(want) {
		t.Fatalf("got %s, want the 13th", got)
	}
	got, _ = s.Next(time.Date(2026, time.October, 13, 0, 0, 0, 0, utc))
	if want := time.Date(2026, time.October, 16, 0, 0, 0, 0, utc); !got.Equal(want) {
		t.Fatalf("got %s, want Friday the 16th", got)
	}
}

func TestNextGivesUpOnImpossibleDays(t *testing.T) {
	s, err := Parse("0 0 30 2 *")
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := s.Next(time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)); ok {
		t.Fatalf("February 30 matched %s", got)
	}
}

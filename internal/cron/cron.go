// Package cron parses five-field cron expressions and finds the next minute
// that matches one, in any time zone.
//
// The fields are minute, hour, day of month, month and day of week. Each field
// takes "*", a number, a range (a-b), a list (a,b) and steps (*/n, a-b/n).
// Month and weekday names (jan, mon) work. Like Vixie cron, a day matches when
// both day fields match if either is "*", and when either matches otherwise.
// The shortcuts @hourly, @daily, @weekly and @monthly work too.
package cron

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Schedule is a parsed expression.
type Schedule struct {
	minute, hour, dom, month, dow uint64
	domStar, dowStar              bool
}

type bounds struct {
	min, max int
	names    []string
	base     int // value of the first name
}

var (
	monthNames = []string{"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}
	dayNames   = []string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}
	fieldNames = [5]string{"minute", "hour", "day of month", "month", "day of week"}
	fieldLimit = [5]bounds{
		{0, 59, nil, 0},
		{0, 23, nil, 0},
		{1, 31, nil, 0},
		{1, 12, monthNames, 1},
		{0, 7, dayNames, 0},
	}
	shortcuts = map[string]string{
		"@hourly":   "0 * * * *",
		"@daily":    "0 0 * * *",
		"@midnight": "0 0 * * *",
		"@weekly":   "0 0 * * 0",
		"@monthly":  "0 0 1 * *",
	}
)

// Parse reads a cron expression.
func Parse(expr string) (Schedule, error) {
	expr = strings.TrimSpace(expr)
	if full, ok := shortcuts[strings.ToLower(expr)]; ok {
		expr = full
	}
	parts := strings.Fields(expr)
	if len(parts) != 5 {
		return Schedule{}, errors.New("a schedule has five fields: minute hour day-of-month month day-of-week")
	}
	var sets [5]uint64
	var stars [5]bool
	for i, part := range parts {
		set, star, err := parseField(part, fieldLimit[i])
		if err != nil {
			return Schedule{}, fmt.Errorf("%s: %w", fieldNames[i], err)
		}
		sets[i], stars[i] = set, star
	}
	if sets[4]&(1<<7) != 0 { // 7 is Sunday too
		sets[4] = sets[4]&^(1<<7) | 1
	}
	return Schedule{minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4], domStar: stars[2], dowStar: stars[4]}, nil
}

func parseField(field string, b bounds) (set uint64, star bool, err error) {
	for _, part := range strings.Split(field, ",") {
		if part == "" {
			return 0, false, errors.New("empty list entry")
		}
		spec, stepText, hasStep := strings.Cut(part, "/")
		step := 1
		if hasStep {
			step, err = parseNumber(stepText)
			if err != nil || step < 1 {
				return 0, false, fmt.Errorf("bad step %q", stepText)
			}
		}
		var lo, hi int
		switch {
		case spec == "*":
			lo, hi, star = b.min, b.max, true
		case strings.Contains(spec, "-"):
			from, to, _ := strings.Cut(spec, "-")
			if lo, err = parseValue(from, b); err != nil {
				return 0, false, err
			}
			if hi, err = parseValue(to, b); err != nil {
				return 0, false, err
			}
		default:
			if lo, err = parseValue(spec, b); err != nil {
				return 0, false, err
			}
			hi = lo
			if hasStep {
				hi = b.max
			}
		}
		if lo < b.min || hi > b.max || lo > hi {
			return 0, false, fmt.Errorf("%q is out of range %d-%d", part, b.min, b.max)
		}
		for v := lo; v <= hi; v += step {
			set |= 1 << uint(v)
		}
	}
	return set, star, nil
}

func parseValue(s string, b bounds) (int, error) {
	for i, name := range b.names {
		if strings.EqualFold(s, name) {
			return i + b.base, nil
		}
	}
	return parseNumber(s)
}

func parseNumber(s string) (int, error) {
	if s == "" || len(s) > 3 {
		return 0, fmt.Errorf("bad number %q", s)
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, fmt.Errorf("bad number %q", s)
		}
	}
	return strconv.Atoi(s)
}

func (s Schedule) dayMatches(t time.Time) bool {
	dom := s.dom&(1<<uint(t.Day())) != 0
	dow := s.dow&(1<<uint(t.Weekday())) != 0
	if s.domStar || s.dowStar {
		return dom && dow
	}
	return dom || dow
}

// Next returns the first matching minute strictly after the given time, in the
// time's own location. ok is false when no minute matches in the next eight
// years, such as February 30.
func (s Schedule) Next(after time.Time) (next time.Time, ok bool) {
	loc := after.Location()
	t := time.Date(after.Year(), after.Month(), after.Day(), after.Hour(), after.Minute(), 0, 0, loc).Add(time.Minute)
	limit := t.AddDate(8, 0, 0)
	for i := 0; i < 500000 && t.Before(limit); i++ {
		switch {
		case s.month&(1<<uint(t.Month())) == 0:
			t = time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, loc)
		case !s.dayMatches(t):
			t = time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, loc)
		case s.hour&(1<<uint(t.Hour())) == 0:
			t = time.Date(t.Year(), t.Month(), t.Day(), t.Hour()+1, 0, 0, 0, loc)
		case s.minute&(1<<uint(t.Minute())) == 0:
			t = t.Add(time.Minute)
		default:
			return t, true
		}
	}
	return time.Time{}, false
}

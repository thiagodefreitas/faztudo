package usage

import (
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func TestReadGrokSumsTurnsIntoWindows(t *testing.T) {
	home := copyTestdata(t, ".grok")
	res, err := ReadGrok(home, Options{Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	// 5h window (07:00-12:00): turns at 11:30 and 11:50. Grok counts cached
	// tokens inside inputTokens, so they are split out, not added twice.
	five := res.FiveHour
	if five.Entries != 2 || five.InputTokens != 1000 || five.CacheReadTokens != 1100 || five.CacheWriteTokens != 100 || five.OutputTokens != 220 {
		t.Fatalf("5h window: %+v", five)
	}
	if got := five.Total(); got != 2420 {
		t.Fatalf("5h total %d, want 2420 (input plus output, as Grok's totalTokens)", got)
	}
	// Last hour (11:00-12:00): the same two turns.
	if res.LastHour.Entries != 2 {
		t.Fatalf("last hour: %+v", res.LastHour)
	}
	// Day: 06:00, 11:30, 11:50; yesterday 23:00 and the future 13:00 are out.
	if res.Day.Entries != 3 || res.Day.Total() != 3740 {
		t.Fatalf("day: %+v total %d", res.Day, res.Day.Total())
	}
	if len(res.Windows) != 2 || res.Windows[0].Source != domain.SourceCLILog || res.Windows[0].UsedPct != nil {
		t.Fatalf("windows without a plan limit: %+v", res.Windows)
	}
	if tok := res.Windows[0].Tokens; tok == nil || *tok != 2420 {
		t.Fatalf("5h window tokens %v, want 2420", tok)
	}
	if tok := res.Windows[1].Tokens; tok == nil || *tok != 3740 {
		t.Fatalf("day window tokens %v, want 3740", tok)
	}
}

func TestReadGrokPlanLimitGivesPercentage(t *testing.T) {
	home := copyTestdata(t, ".grok")
	res, err := ReadGrok(home, Options{Now: testNow, PlanLimitTokens: 24200})
	if err != nil {
		t.Fatal(err)
	}
	if p := res.Windows[0].UsedPct; p == nil || *p != 10 {
		t.Fatalf("5h used pct %v, want 10", p)
	}
}

func TestReadGrokWithoutHome(t *testing.T) {
	res, err := ReadGrok(t.TempDir(), Options{Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	if res.Windows[0].Source != domain.SourceUnknown || res.Windows[0].Tokens != nil {
		t.Fatalf("no sessions should be unknown with no token count, got %+v", res.Windows[0])
	}
}

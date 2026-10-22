package usage

import "testing"

func TestEstimateUSD(t *testing.T) {
	if EstimateUSD(TokenUsage{InputTokens: 100}, 0, 0, 0) != nil {
		t.Fatal("unpriced lane must stay unknown")
	}
	if EstimateUSD(TokenUsage{TotalOnly: 17161}, 2, 8, 0.5) != nil {
		t.Fatal("a total without token kinds cannot be priced")
	}
	got := EstimateUSD(TokenUsage{InputTokens: 1000000, OutputTokens: 500000, CacheReadTokens: 500000, CacheWriteTokens: 250000}, 2, 8, 0.5)
	if got == nil || *got != 6.75 {
		t.Fatalf("estimate: %v", got)
	}
}

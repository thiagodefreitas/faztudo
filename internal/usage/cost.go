package usage

// EstimateUSD prices a local token count. It is an estimate, not billing.
// Cache writes use the input rate because no cache-write rate is configured.
func EstimateUSD(tokens TokenUsage, input, output, cached float64) *float64 {
	if input == 0 && output == 0 && cached == 0 {
		return nil
	}
	v := (float64(tokens.InputTokens+tokens.CacheWriteTokens)*input + float64(tokens.OutputTokens)*output + float64(tokens.CacheReadTokens)*cached) / 1000000
	return &v
}

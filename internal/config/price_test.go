package config

import (
	"math"
	"testing"
)

func TestPriceRejectsInvalidNumbers(t *testing.T) {
	for _, v := range []float64{-1, math.NaN(), math.Inf(1)} {
		if validPrice(v) {
			t.Fatalf("accepted %v", v)
		}
	}
	if !validPrice(0) || !validPrice(1.5) {
		t.Fatal("valid prices rejected")
	}
}

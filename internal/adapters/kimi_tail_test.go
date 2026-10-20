package adapters

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// A kimi run that thinks at length and then hits the 5-hour limit: the lane
// reason is the limit line, and the window bounds the reset.
func TestKimiFiveHourLimitAfterThinking(t *testing.T) {
	tail, err := os.ReadFile("testdata/kimi_5h_thinking.txt")
	if err != nil {
		t.Fatal(err)
	}
	class, signal, reason := (Kimi{}).Classify(1, string(tail))
	if class != domain.FailureSemantic || signal.Kind != SignalExhausted {
		t.Fatalf("class %q signal %+v", class, signal)
	}
	if signal.Until.IsZero() || time.Until(signal.Until) > 5*time.Hour+time.Minute {
		t.Fatalf("until %v", signal.Until)
	}
	if !strings.Contains(reason, "5-hour usage limit") || len(reason) > 200 {
		t.Fatalf("reason %q", reason)
	}
}

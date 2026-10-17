package usage

import (
	"fmt"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// TestLocalSmoke reads the real logs and probe of this machine and prints
// the resulting windows. It never prints message content. Skipped unless
// FAZTUDO_LOCAL_SMOKE=1.
func TestLocalSmoke(t *testing.T) {
	if os.Getenv("FAZTUDO_LOCAL_SMOKE") != "1" {
		t.Skip("set FAZTUDO_LOCAL_SMOKE=1 to read this machine's CLI logs")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	opts := Options{Now: time.Now()}

	claude, err := ReadClaude(home, opts)
	if err != nil {
		t.Errorf("ReadClaude: %v", err)
	}
	fmt.Printf("claude: 5h entries=%d total=%d | day entries=%d total=%d\n",
		claude.FiveHour.Entries, claude.FiveHour.Total(), claude.Day.Entries, claude.Day.Total())
	printWindows("claude", claude.Windows)

	codex, err := ReadCodex(home, opts)
	if err != nil {
		t.Errorf("ReadCodex: %v", err)
	}
	printWindows("codex", codex)

	if _, err := exec.LookPath("agy"); err == nil {
		agy, err := ProbeAGY("")
		if err != nil {
			t.Errorf("ProbeAGY: %v", err)
		} else {
			printWindows("agy", agy)
		}
	} else {
		fmt.Println("agy: not found in PATH, skipped")
	}
}

func printWindows(cli string, windows []domain.LaneWindow) {
	for _, w := range windows {
		pct := "unknown"
		if w.UsedPct != nil {
			pct = fmt.Sprintf("%.1f%%", *w.UsedPct)
		}
		reset := "-"
		if w.ResetsAt != nil {
			reset = w.ResetsAt.UTC().Format(time.RFC3339)
		}
		measured := "-"
		if w.MeasuredAt != nil {
			measured = w.MeasuredAt.UTC().Format(time.RFC3339)
		}
		fmt.Printf("%-7s %-5s used=%-8s resets=%s source=%-7s measured=%s\n",
			cli, w.Name, pct, reset, w.Source, measured)
	}
}

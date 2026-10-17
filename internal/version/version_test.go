package version

import (
	"strings"
	"testing"
)

func TestGetUsesLinkerValues(t *testing.T) {
	Version, Commit, Date = "v1.2.3", "0123456789abcdef0123", "2026-10-18T00:00:00Z"
	t.Cleanup(func() { Version, Commit, Date = "", "", "" })
	i := Get()
	if i.Version != "v1.2.3" || i.Commit != "0123456789abcdef0123" || i.Date != "2026-10-18T00:00:00Z" {
		t.Fatalf("got %+v", i)
	}
	s := i.String()
	if !strings.HasPrefix(s, "faztudo v1.2.3 (commit 0123456789ab") || !strings.Contains(s, "built 2026-10-18T00:00:00Z") {
		t.Fatalf("string %q", s)
	}
}

func TestGetDefaultsToDev(t *testing.T) {
	if v := Get().Version; v == "" {
		t.Fatal("empty version")
	}
}

package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAutoMemoryBytes(t *testing.T) {
	cases := []struct{ total, want int64 }{
		{0, 4 * gib},
		{4 * gib, 2 * gib},
		{16 * gib, 4 * gib},
		{31 * gib, 7*gib + gib*3/4},
		{128 * gib, 8 * gib},
	}
	for _, c := range cases {
		if got := AutoMemoryBytes(c.total); got != c.want {
			t.Errorf("total %d: got %d want %d", c.total, got, c.want)
		}
	}
}

func TestResolveMemoryMaxAndValidate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "meminfo")
	if err := os.WriteFile(path, []byte("MemTotal:       16777216 kB\nMemAvailable:    8000000 kB\n"), 0600); err != nil {
		t.Fatal(err)
	}
	old := MemInfoFile
	MemInfoFile = path
	t.Cleanup(func() { MemInfoFile = old })
	if got := ResolveMemoryMax("auto"); got != "4G" {
		t.Fatalf("auto: %s", got)
	}
	if got := ResolveMemoryMax("6G"); got != "6G" {
		t.Fatalf("explicit: %s", got)
	}
	if total, avail := MemInfo(); total != 16*gib || avail != 8000000*1024 {
		t.Fatalf("meminfo: %d %d", total, avail)
	}
	if n, ok := MemoryBytes("512M"); !ok || n != 512<<20 {
		t.Fatalf("bytes: %d %v", n, ok)
	}
	if _, ok := MemoryBytes("auto"); ok {
		t.Fatal("auto is not a size")
	}
	c := Defaults()
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.Runs.SandboxMemoryMax = "lots"
	if err := c.Validate(); err == nil {
		t.Fatal("accepted a bad size")
	}
}

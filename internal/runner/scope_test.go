package runner

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func TestScopedOOMClassificationAndPeak(t *testing.T) {
	report := filepath.Join(t.TempDir(), "scope.report")
	if err := os.WriteFile(report, []byte("oom_kill 1\npeak 3221225472\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, code := range []int{1, 137} {
		run := domain.Run{}
		ok, reason := scopeFailure(&run, code, &WriteOptions{MemoryMax: "4G", scopeUsed: true, scopeReport: report})
		if !ok || reason != "killed: out of memory (limit 4 GB)" || run.PeakMemoryBytes != 3221225472 {
			t.Fatalf("code %d: oom=%v reason=%q peak=%d", code, ok, reason, run.PeakMemoryBytes)
		}
	}
}

func TestScopeWrapperWritesReportBeforeExit(t *testing.T) {
	report := filepath.Join(t.TempDir(), "scope.report")
	cmd := exec.Command("sh", "-c", scopeReportScript, "scope-report", report, "/bin/sh", "-c", "exit 7")
	if err := cmd.Run(); err == nil || cmd.ProcessState.ExitCode() != 7 {
		t.Fatalf("wrapper exit: %v", err)
	}
	data, err := os.ReadFile(report)
	if err != nil || !strings.Contains(string(data), "oom_kill ") || !strings.Contains(string(data), "peak ") {
		t.Fatalf("scope report: %q, %v", data, err)
	}
}

func TestScopedExit137WithoutReportUsesMemoryLimit(t *testing.T) {
	run := domain.Run{}
	ok, reason := scopeFailure(&run, 137, &WriteOptions{MemoryMax: "2G", scopeUsed: true, scopeReport: filepath.Join(t.TempDir(), "missing")})
	if !ok || reason != "killed: out of memory (limit 2 GB)" {
		t.Fatalf("oom=%v reason=%q", ok, reason)
	}
	if ok, _ := scopeFailure(&run, 137, &WriteOptions{MemoryMax: "2G"}); ok {
		t.Fatal("unsandboxed run classified as scoped OOM")
	}
}

func TestScopedPeakWithoutOOMDoesNotChangeFailure(t *testing.T) {
	report := filepath.Join(t.TempDir(), "scope.report")
	if err := os.WriteFile(report, []byte("oom_kill 0\npeak 1073741824\n"), 0600); err != nil {
		t.Fatal(err)
	}
	run := domain.Run{}
	ok, reason := scopeFailure(&run, 1, &WriteOptions{MemoryMax: "4G", scopeUsed: true, scopeReport: report})
	if ok || reason != "" || run.PeakMemoryBytes != 1073741824 {
		t.Fatalf("oom=%v reason=%q peak=%d", ok, reason, run.PeakMemoryBytes)
	}
}

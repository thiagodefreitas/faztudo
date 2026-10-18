package adapters

import (
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// Synthetic copies of the failure lines the CLIs print when the login or the
// plan is the problem.
func TestAuthAndPlanFailuresMarkLaneUnavailable(t *testing.T) {
	for _, tc := range []struct {
		adapter Adapter
		tail    string
		reason  string
	}{
		{Kimi{}, "kimi version 2.1.1\nerror: failed to run prompt: provider.auth_error: 403 Your current subscription does not have access to Kimi Code right now. Upgrade your plan to keep coding with Kimi Code: https://example.test/pricing\nSee log: /tmp/kimi.log", "provider.auth_error: 403 Your current subscription"},
		{Claude{}, "Please log in: run claude /login", "Please log in"},
		{Claude{}, "API Error: 401 {\"type\":\"authentication_error\"}", "401"},
		{Codex{}, "ERROR: Not logged in. Run codex login.", "Not logged in"},
		{Codex{}, "unexpected status 401 Unauthorized: Missing bearer", "401 Unauthorized"},
		{Grok{}, "error: 403 Forbidden: your subscription does not include this model", "subscription"},
		{Agy{}, "Error: please login to continue", "please login"},
		{OpenCode{}, "AI_APICallError: Invalid API key", "Invalid API key"},
	} {
		class, signal, reason := tc.adapter.Classify(1, tc.tail)
		if class != domain.FailureSemantic || signal.Kind != SignalUnavailable {
			t.Fatalf("%s %q: %s %s", tc.adapter.Name(), tc.tail, class, signal.Kind)
		}
		if !strings.Contains(reason, tc.reason) || strings.Contains(reason, "\n") || len(reason) > 200 {
			t.Fatalf("%s: reason %q lacks %q", tc.adapter.Name(), reason, tc.reason)
		}
		if class, signal, _ := tc.adapter.Classify(0, tc.tail); class != "" || signal.Kind != SignalNone {
			t.Fatalf("%s: a zero exit must not classify: %s %s", tc.adapter.Name(), class, signal.Kind)
		}
	}
}

func TestPlanQuotaIsExhaustedWithReset(t *testing.T) {
	for _, a := range []Adapter{Claude{}, Codex{}, Grok{}, Kimi{}, OpenCode{}} {
		class, signal, _ := a.Classify(1, "You have reached your monthly limit. Resets in 3 days.")
		if class != domain.FailureSemantic || signal.Kind != SignalExhausted {
			t.Fatalf("%s: %s %s", a.Name(), class, signal.Kind)
		}
		if d := time.Until(signal.Until); d < 71*time.Hour || d > 73*time.Hour {
			t.Fatalf("%s: reset in %s", a.Name(), d)
		}
	}
}

func TestTransientAndSemanticFailuresAreNotAuth(t *testing.T) {
	for _, tc := range []struct {
		tail  string
		class domain.FailureClass
	}{
		{"HTTP 503 Service Unavailable", domain.FailureTransient},
		{"request timed out", domain.FailureTransient},
		{"HTTP 429 slow down", domain.FailureTransient},
		{"panic: index out of range [4013]", domain.FailureUnknown},
		{"tests failed in pkg/auth", domain.FailureUnknown},
		// A failed task whose output mentions HTTP status codes or plans is
		// still the task failing, not the agent's own login.
		{"--- FAIL: TestLoginRejects (0.01s)\n    lan_test.go:88: status 403, want 200", domain.FailureUnknown},
		{"--- FAIL: TestPairing\n    got 401 Unauthorized from the stub server", domain.FailureUnknown},
		{"docs: describe the subscription page", domain.FailureUnknown},
		// Quoted output of code the agent ran, with no test-runner markers.
		// Only a line the CLI prints as its own error counts.
		{"$ curl -i localhost:8080/admin\nstatus: 401 Unauthorized\nbody: denied", domain.FailureUnknown},
		{"the handler answers unauthorized when the token is missing", domain.FailureUnknown},
		{"  \"error\": \"not logged in\" (fixture from the user store)", domain.FailureUnknown},
	} {
		class, signal, _ := Claude{}.Classify(1, tc.tail)
		if class != tc.class || signal.Kind != SignalNone {
			t.Fatalf("%q: %s %s", tc.tail, class, signal.Kind)
		}
	}
}

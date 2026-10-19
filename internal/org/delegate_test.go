package org

import (
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func agent(handle string) domain.Member {
	return domain.Member{ID: handle, Kind: domain.MemberAgent, Handle: handle, DisplayName: handle, Agent: &domain.AgentInfo{Lanes: []string{"x"}}}
}

func TestCheckDelegationRoles(t *testing.T) {
	departments := []domain.Department{
		{Handle: "engineering", Lead: "architect", Members: []string{"architect", "coder", "reviewer"}},
		{Handle: "product", Lead: "writer", Members: []string{"writer"}},
	}
	human := domain.Member{ID: "ada", Kind: domain.MemberHuman, Handle: "ada"}
	for _, tc := range []struct {
		name           string
		caller, target domain.Member
		depth          int
		ok             bool
	}{
		{"chief to a lead", agent("chief"), agent("architect"), 0, true},
		{"chief to a specialist", agent("chief"), agent("coder"), 0, true},
		{"lead to its specialist", agent("architect"), agent("coder"), 1, true},
		{"lead to its specialist from a human request", agent("architect"), agent("coder"), 0, true},
		{"lead to another department", agent("architect"), agent("writer"), 1, false},
		{"specialist cannot delegate", agent("coder"), agent("reviewer"), 0, false},
		{"nobody delegates at the maximum depth", agent("chief"), agent("coder"), MaxDepth, false},
		{"a lead at the maximum depth", agent("architect"), agent("coder"), MaxDepth, false},
		{"not to itself", agent("chief"), agent("chief"), 0, false},
		{"not to the chief", agent("architect"), agent("chief"), 1, false},
		{"not to a human", agent("chief"), human, 0, false},
	} {
		err := CheckDelegation(tc.caller, tc.target, "chief", departments, tc.depth)
		if (err == nil) != tc.ok {
			t.Errorf("%s: err = %v, want ok = %v", tc.name, err, tc.ok)
		}
	}
	// With no Chief of Staff, an empty chief handle must not match anybody.
	if err := CheckDelegation(agent("coder"), agent("reviewer"), "", departments, 0); err == nil {
		t.Error("a specialist delegated when there is no chief of staff")
	}
}

func TestLedgerEnforcesBudgetAndExtension(t *testing.T) {
	l := NewLedger()
	lim := Limits{MaxRuns: 3, MaxPremium: 1}
	for i, premium := range []bool{false, true, false} {
		if !l.Reserve("req", premium, lim) {
			t.Fatalf("run %d refused inside the budget", i+1)
		}
	}
	if l.Reserve("req", false, lim) {
		t.Fatal("a fourth run passed a limit of three")
	}
	if runs, premium := l.Used("req"); runs != 3 || premium != 1 {
		t.Fatalf("used %d runs, %d premium", runs, premium)
	}
	// Another request has its own count.
	if !l.Reserve("other", true, lim) {
		t.Fatal("budgets leaked between requests")
	}
	// A second premium run is over its own limit even with total runs to spare.
	l.Allow("req", Limits{MaxRuns: 5, MaxPremium: 0})
	if l.Reserve("req", true, lim) {
		t.Fatal("a premium run passed the premium limit")
	}
	if !l.Reserve("req", false, lim) {
		t.Fatal("the Director's extra runs were not honored")
	}
	l.Allow("req", Limits{MaxRuns: 0, MaxPremium: 1})
	if !l.Reserve("req", true, lim) {
		t.Fatal("the Director's extra premium run was not honored")
	}
}

func TestLedgerRefusedRunIsNotCounted(t *testing.T) {
	l := NewLedger()
	lim := Limits{MaxRuns: 1, MaxPremium: 0}
	if l.Reserve("req", true, lim) {
		t.Fatal("premium run passed a premium limit of zero")
	}
	if runs, _ := l.Used("req"); runs != 0 {
		t.Fatalf("a refused run was counted: %d", runs)
	}
	if !l.Reserve("req", false, lim) {
		t.Fatal("the refused premium run used up the normal run")
	}
}

func TestLedgerReleaseAfterWriteFailure(t *testing.T) {
	l := NewLedger()
	lim := Limits{MaxRuns: 1, MaxPremium: 1}
	if !l.Reserve("req", true, lim) {
		t.Fatal("first reservation refused")
	}
	l.Release("req", true)
	if !l.Reserve("req", true, lim) {
		t.Fatal("failed event kept the budget")
	}
}

func TestLedgerKeepsCountsAndTheCard(t *testing.T) {
	l := NewLedger()
	l.SetCard("req", "card1")
	if l.Card("req") != "card1" {
		t.Fatal("card not kept")
	}
	l.Allow("req", Limits{MaxRuns: 2})
	if l.Card("req") != "" {
		t.Fatal("allowing more runs should close the card")
	}
	l.Reserve("req", false, Limits{MaxRuns: 1})
	if runs, _ := l.Used("req"); runs != 1 {
		t.Fatalf("a committed request was forgotten: %d runs", runs)
	}
}

func TestRosterListsWhatEachAgentIsFor(t *testing.T) {
	coder := agent("coder")
	coder.Agent.Role = "Implements changes"
	coder.Agent.Description = "Writes and fixes code in the repository."
	coder.Agent.Mode = domain.RunWrite
	architect := agent("architect")
	architect.DisplayName = "Architect"
	architect.Agent.Description = "Plans the design before code is written."
	human := domain.Member{ID: "ada", Kind: domain.MemberHuman, Handle: "ada"}
	members := []domain.Member{human, agent("chief"), coder, architect}
	departments := []domain.Department{{Handle: "engineering", DisplayName: "Engineering", Lead: "architect", Members: []string{"architect", "coder"}}}
	got := Roster(members, departments, "chief")
	if strings.Contains(got, "@chief") || strings.Contains(got, "@ada") {
		t.Fatalf("roster lists the chief or a human:\n%s", got)
	}
	for _, want := range []string{
		"- @architect: Plans the design before code is written. [leads Engineering]",
		"- @coder: Implements changes. Writes and fixes code in the repository. [can change files]",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("roster is missing %q:\n%s", want, got)
		}
	}
}

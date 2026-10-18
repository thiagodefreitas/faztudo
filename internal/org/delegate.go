package org

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// MaxDepth is how many handoffs deep a request goes. The Chief of Staff hands
// work to a lead (depth 1) and the lead hands pieces to its specialists
// (depth 2). Nobody at depth 2 hands anything on.
const MaxDepth = 2

// CheckDelegation says why caller may not hand work to target, or nil. depth
// is the depth of the work the caller is doing now: 0 for a request from a
// human, 1 for work somebody handed over. chief is the Chief of Staff's handle,
// empty when there is none.
//
// The Chief of Staff may hand work to any other agent. A department lead may
// hand work to the members of the departments it leads. Everyone else may not
// delegate.
func CheckDelegation(caller, target domain.Member, chief string, departments []domain.Department, depth int) error {
	if depth >= MaxDepth {
		return fmt.Errorf("delegation stops here: this work was already handed over %d times, so @%s must do it itself", depth, caller.Handle)
	}
	if target.Kind != domain.MemberAgent {
		return errors.New("work can only be handed to an agent")
	}
	if target.ID == caller.ID {
		return errors.New("an agent cannot hand work to itself")
	}
	if chief != "" && strings.EqualFold(target.Handle, chief) {
		return errors.New("work cannot be handed to the Chief of Staff")
	}
	if chief != "" && strings.EqualFold(caller.Handle, chief) {
		return nil
	}
	led := false
	for _, d := range departments {
		if !strings.EqualFold(d.Lead, caller.Handle) {
			continue
		}
		led = true
		if ContainsFold(d.Members, target.Handle) {
			return nil
		}
	}
	if !led {
		return errors.New("only the Chief of Staff and department leads can hand work to others")
	}
	return fmt.Errorf("@%s is not in a department that @%s leads", target.Handle, caller.Handle)
}

// Limits caps the runs one request may start by delegation.
type Limits struct{ MaxRuns, MaxPremium int }

// Ledger counts the runs each request has started by delegation. It lives in
// memory: a restart forgets the counts, which only lets a request that was
// already running go on for one more round.
type Ledger struct {
	mu      sync.Mutex
	now     func() time.Time
	entries map[string]*ledgerEntry
}

type ledgerEntry struct {
	runs, premium           int
	extraRuns, extraPremium int
	card                    string
	touched                 time.Time
}

// ledgerTTL is how long an idle request is remembered.
const ledgerTTL = 24 * time.Hour

func NewLedger() *Ledger {
	return &Ledger{now: time.Now, entries: map[string]*ledgerEntry{}}
}

func (l *Ledger) entry(request string) *ledgerEntry {
	now := l.now()
	for id, e := range l.entries {
		if now.Sub(e.touched) > ledgerTTL {
			delete(l.entries, id)
		}
	}
	e := l.entries[request]
	if e == nil {
		e = &ledgerEntry{}
		l.entries[request] = e
	}
	e.touched = now
	return e
}

// Reserve counts one delegated run against the request. It returns false and
// counts nothing when the run would pass the limits, together with whatever the
// Director allowed on top of them.
func (l *Ledger) Reserve(request string, premium bool, lim Limits) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.entry(request)
	if e.runs+1 > lim.MaxRuns+e.extraRuns {
		return false
	}
	if premium && e.premium+1 > lim.MaxPremium+e.extraPremium {
		return false
	}
	e.runs++
	if premium {
		e.premium++
	}
	return true
}

// Used returns the runs and premium runs counted for the request.
func (l *Ledger) Used(request string) (runs, premium int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.entry(request)
	return e.runs, e.premium
}

// Card is the id of the open question that asks the Director for more runs, or
// empty when none is open.
func (l *Ledger) Card(request string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.entry(request).card
}

// SetCard remembers the question that asks the Director for more runs.
func (l *Ledger) SetCard(request, id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entry(request).card = id
}

// Allow raises the limits of the request by one more round and closes the open
// question.
func (l *Ledger) Allow(request string, lim Limits) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.entry(request)
	e.extraRuns += lim.MaxRuns
	e.extraPremium += lim.MaxPremium
	e.card = ""
}

// Roster describes the agents the Chief of Staff or a lead can hand work to, so
// the agent can pick an owner by what each one is for. chief is left out.
func Roster(members []domain.Member, departments []domain.Department, chief string) string {
	leads := map[string][]string{}
	for _, d := range departments {
		name := d.DisplayName
		if name == "" {
			name = d.Handle
		}
		leads[strings.ToLower(d.Lead)] = append(leads[strings.ToLower(d.Lead)], name)
	}
	var lines []string
	for _, m := range members {
		if m.Kind != domain.MemberAgent || m.Agent == nil || strings.EqualFold(m.Handle, chief) {
			continue
		}
		line := "- @" + m.Handle
		if m.DisplayName != "" && !strings.EqualFold(m.DisplayName, m.Handle) {
			line += " (" + m.DisplayName + ")"
		}
		var about []string
		if m.Agent.Role != "" {
			about = append(about, m.Agent.Role)
		}
		if m.Agent.Description != "" {
			about = append(about, m.Agent.Description)
		}
		if len(about) > 0 {
			line += ": " + clip(strings.Join(about, ". "), 240)
		}
		if names := leads[strings.ToLower(m.Handle)]; len(names) > 0 {
			line += " [leads " + strings.Join(names, ", ") + "]"
		}
		if m.Agent.Mode == domain.RunWrite {
			line += " [can change files]"
		}
		lines = append(lines, line)
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return strings.TrimSpace(string(runes[:n])) + "..."
}

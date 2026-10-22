package config

import "testing"

func TestScoutRoutineNeedsAReadOnlyPersona(t *testing.T) {
	c := routineBase()
	c.Lanes.Routine = append(c.Lanes.Routine, Routine{Handle: "scout", Persona: "coder", Channel: "general", Schedule: "0 8 * * 1-5", Template: "scout"})
	if err := c.Validate(); err != nil {
		t.Fatalf("a scout needs no prompt and a read persona is fine: %v", err)
	}
	c.Lanes.Persona[1].Mode = "write"
	if err := c.Validate(); err == nil {
		t.Fatal("a writing persona should not be allowed to scout")
	}
}

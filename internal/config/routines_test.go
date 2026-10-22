package config

import "testing"

func routineBase() Config {
	c := Defaults()
	c.Lanes.Lane = []Lane{{ID: "codex/default", CLI: "codex", Capacity: 1}}
	c.Lanes.Persona = []Persona{
		{Handle: "chief", Lanes: []string{"codex/default"}, ChiefOfStaff: true, Channels: []string{"general"}},
		{Handle: "coder", Lanes: []string{"codex/default"}},
	}
	c.Lanes.Routine = []Routine{
		{Handle: "daily-debrief", Persona: "chief", Channel: "general", Schedule: "0 18 * * 1-5", Template: "debrief"},
		{Handle: "welcome", Persona: "coder", Channel: "general", Trigger: "message", Prompt: "Say hello."},
	}
	return c
}

func TestRoutinesAndChiefOfStaffValidate(t *testing.T) {
	if err := routineBase().Validate(); err != nil {
		t.Fatalf("valid routines rejected: %v", err)
	}
	for _, tc := range []struct {
		name   string
		mutate func(*Config)
	}{
		{"second chief of staff", func(c *Config) { c.Lanes.Persona[1].ChiefOfStaff = true }},
		{"channels without chief", func(c *Config) { c.Lanes.Persona[1].Channels = []string{"general"} }},
		{"blank chief channel", func(c *Config) { c.Lanes.Persona[0].Channels = []string{" "} }},
		{"routine handle spaces", func(c *Config) { c.Lanes.Routine[0].Handle = "daily debrief" }},
		{"routine handle twice", func(c *Config) { c.Lanes.Routine[1].Handle = "Daily-Debrief" }},
		{"routine persona", func(c *Config) { c.Lanes.Routine[0].Persona = "ghost" }},
		{"routine channel", func(c *Config) { c.Lanes.Routine[0].Channel = "" }},
		{"routine without prompt", func(c *Config) { c.Lanes.Routine[1].Prompt = "" }},
		{"routine template", func(c *Config) { c.Lanes.Routine[0].Template = "weekly" }},
		{"schedule and trigger", func(c *Config) { c.Lanes.Routine[0].Trigger = "message" }},
		{"neither", func(c *Config) { c.Lanes.Routine[1].Trigger = "" }},
		{"bad schedule", func(c *Config) { c.Lanes.Routine[0].Schedule = "every day" }},
		{"unknown trigger", func(c *Config) { c.Lanes.Routine[1].Trigger = "webhook" }},
		{"zero request runs", func(c *Config) { c.Runs.RequestMaxRuns = 0 }},
		{"negative premium", func(c *Config) { c.Runs.RequestMaxPremium = -1 }},
		{"zero routines per day", func(c *Config) { c.Routines.MaxPerDay = 0 }},
		{"unknown time zone", func(c *Config) { c.Routines.Timezone = "Mars/Olympus" }},
		{"short GitHub poll interval", func(c *Config) { c.Routines.PollInterval = "30s" }},
		{"bad GitHub poll interval", func(c *Config) { c.Routines.PollInterval = "soon" }},
	} {
		c := routineBase()
		tc.mutate(&c)
		if c.Validate() == nil {
			t.Errorf("%s: expected a validation error", tc.name)
		}
	}
	for _, trigger := range []string{"ci_failed", "issue_opened", "pr_opened"} {
		c := routineBase()
		c.Lanes.Routine[1].Trigger = trigger
		if err := c.Validate(); err != nil {
			t.Errorf("%s: %v", trigger, err)
		}
	}
}

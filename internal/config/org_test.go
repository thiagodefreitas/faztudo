package config

import (
	"os"
	"path/filepath"
	"testing"
)

const orgLanes = `
[[lane]]
id = "codex/default"
cli = "codex"
capacity = 1

[[persona]]
handle = "coder"
display_name = "Coder"
description = "Writes the change."
instructions = "Keep diffs small."
lanes = ["codex/default"]

[[department]]
handle = "engineering"
display_name = "Engineering"
lead = "coder"
members = ["coder"]

[[project]]
handle = "faztudo"
name = "Faztudo"
channels = ["faztudo-dev"]
departments = ["engineering"]
specialists = ["codex"]
`

func TestOrgConfigLoads(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("XDG_DATA_HOME", filepath.Join(dir, "data"))
	p := PathsFromEnv()
	if err := WriteDefaults(p); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.LanesFile, []byte(orgLanes), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	persona, dept, project := c.Lanes.Persona[0], c.Lanes.Department[0], c.Lanes.Project[0]
	if persona.Instructions != "Keep diffs small." || persona.Description != "Writes the change." {
		t.Fatalf("persona %+v", persona)
	}
	if dept.Lead != "coder" || len(dept.Members) != 1 || project.Departments[0] != "engineering" || project.Channels[0] != "faztudo-dev" {
		t.Fatalf("org %+v %+v", dept, project)
	}
}

func TestOrgValidation(t *testing.T) {
	base := func() Config {
		c := Defaults()
		c.Lanes.Lane = []Lane{{ID: "codex/default", CLI: "codex", Capacity: 1}}
		c.Lanes.Persona = []Persona{{Handle: "coder", Lanes: []string{"codex/default"}}}
		c.Lanes.Department = []Department{{Handle: "engineering", Lead: "coder", Members: []string{"coder"}}}
		c.Lanes.Project = []Project{{Handle: "faztudo", Departments: []string{"engineering"}}}
		return c
	}
	if err := base().Validate(); err != nil {
		t.Fatalf("valid org rejected: %v", err)
	}
	for name, mutate := range map[string]func(*Config){
		"department lead unknown":   func(c *Config) { c.Lanes.Department[0].Lead = "ghost" },
		"department member unknown": func(c *Config) { c.Lanes.Department[0].Members = []string{"ghost"} },
		"department handle empty":   func(c *Config) { c.Lanes.Department[0].Handle = "" },
		"department handle spaces":  func(c *Config) { c.Lanes.Department[0].Handle = "eng team" },
		"department is a persona":   func(c *Config) { c.Lanes.Department[0].Handle = "Coder" },
		"project is a department":   func(c *Config) { c.Lanes.Project[0].Handle = "engineering" },
		"project is a lane cli":     func(c *Config) { c.Lanes.Project[0].Handle = "codex" },
		"project lead unknown":      func(c *Config) { c.Lanes.Project[0].Lead = "ghost" },
		"project specialist":        func(c *Config) { c.Lanes.Project[0].Specialists = []string{"ghost"} },
		"project department":        func(c *Config) { c.Lanes.Project[0].Departments = []string{"ghost"} },
	} {
		c := base()
		mutate(&c)
		if c.Validate() == nil {
			t.Errorf("%s: expected a validation error", name)
		}
	}
}

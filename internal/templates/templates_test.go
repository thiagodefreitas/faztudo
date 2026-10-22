package templates

import (
	"slices"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/thiagodefreitas/faztudo/internal/config"
)

func load(t *testing.T, name string) config.Config {
	t.Helper()
	body, err := Get(name)
	if err != nil {
		t.Fatal(err)
	}
	var lanes config.LaneConfig
	meta, err := toml.Decode(body, &lanes)
	if err != nil {
		t.Fatalf("%s does not parse: %v", name, err)
	}
	if undecoded := meta.Undecoded(); len(undecoded) > 0 {
		t.Fatalf("%s has keys the program does not read: %v", name, undecoded)
	}
	c := config.Defaults()
	c.Lanes = lanes
	return c
}

func TestEveryTemplateParsesAndValidates(t *testing.T) {
	names := Names()
	if !slices.Equal(names, []string{"empty", "solo", "team"}) {
		t.Fatalf("templates %v", names)
	}
	for _, name := range names {
		if err := load(t, name).Validate(); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestSoloTemplate(t *testing.T) {
	c := load(t, "solo")
	handles := map[string]config.Persona{}
	for _, p := range c.Lanes.Persona {
		handles[p.Handle] = p
	}
	chief, ok := handles["chief"]
	if !ok || !chief.ChiefOfStaff || !slices.Equal(chief.Channels, []string{"general"}) {
		t.Fatalf("chief of staff %+v", chief)
	}
	if len(handles) != 3 || handles["coder"].Mode != "write" || handles["reviewer"].Mode != "read" {
		t.Fatalf("personas %v", handles)
	}
	if len(c.Lanes.Department) != 0 {
		t.Fatalf("solo has departments: %+v", c.Lanes.Department)
	}
}

func TestTeamTemplate(t *testing.T) {
	c := load(t, "team")
	if len(c.Lanes.Department) != 1 {
		t.Fatalf("departments %+v", c.Lanes.Department)
	}
	d := c.Lanes.Department[0]
	if d.Handle != "engineering" || d.Lead != "architect" || !slices.Equal(d.Members, []string{"architect", "coder", "reviewer", "tester"}) {
		t.Fatalf("department %+v", d)
	}
	var handles []string
	for _, p := range c.Lanes.Persona {
		handles = append(handles, p.Handle)
		if p.ChiefOfStaff {
			t.Errorf("team template makes %s the chief of staff", p.Handle)
		}
	}
	slices.Sort(handles)
	if !slices.Equal(handles, []string{"architect", "coder", "reviewer", "tester", "writer"}) {
		t.Fatalf("personas %v", handles)
	}
}

func TestTemplateRoutinesShipSwitchedOff(t *testing.T) {
	want := map[string][]string{"solo": {"debrief"}, "team": {"debrief", "scout"}}
	for name, templates := range want {
		c := load(t, name)
		if len(c.Lanes.Routine) != len(templates) {
			t.Fatalf("%s routines %+v", name, c.Lanes.Routine)
		}
		for i, r := range c.Lanes.Routine {
			if r.Template != templates[i] {
				t.Fatalf("%s routine %d is %q, want %q", name, i, r.Template, templates[i])
			}
			if r.Enabled == nil || *r.Enabled {
				t.Errorf("%s: the %s routine should ship switched off", name, r.Template)
			}
		}
	}
}

func TestTemplatesAreAsciiWithoutDashes(t *testing.T) {
	for _, name := range Names() {
		body, _ := Get(name)
		for i, r := range body {
			if r > 126 || (r < 32 && r != '\n') {
				t.Errorf("%s: byte %d is not plain ASCII: %q", name, i, r)
				break
			}
		}
		if strings.Contains(body, " -- ") {
			t.Errorf("%s uses a double dash as punctuation", name)
		}
	}
}

func TestUnknownTemplateListsTheKnownOnes(t *testing.T) {
	_, err := Get("../config")
	if err == nil || !strings.Contains(err.Error(), "solo") {
		t.Fatalf("error %v", err)
	}
	if _, err := Get("nope"); err == nil {
		t.Fatal("unknown template accepted")
	}
}

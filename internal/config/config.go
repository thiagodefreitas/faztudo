package config

import (
	"errors"
	"fmt"
	"math"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/thiagodefreitas/faztudo/internal/cron"
)

type Paths struct{ ConfigDir, DataDir, ConfigFile, LanesFile, SecretsFile, DBFile, WorktreesDir, RunsDir, TLSDir, FilesDir string }

var memoryLimitPattern = regexp.MustCompile(`^[1-9][0-9]*[KMGT]?$`)

func PathsFromEnv() Paths {
	home, _ := os.UserHomeDir()
	cfg := os.Getenv("XDG_CONFIG_HOME")
	if cfg == "" {
		cfg = filepath.Join(home, ".config")
	}
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" {
		data = filepath.Join(home, ".local", "share")
	}
	cfg = filepath.Join(cfg, "faztudo")
	data = filepath.Join(data, "faztudo")
	return Paths{
		ConfigDir:    cfg,
		DataDir:      data,
		ConfigFile:   filepath.Join(cfg, "config.toml"),
		LanesFile:    filepath.Join(cfg, "lanes.toml"),
		SecretsFile:  filepath.Join(cfg, "secrets"),
		DBFile:       filepath.Join(data, "faztudo.db"),
		WorktreesDir: filepath.Join(data, "worktrees"),
		RunsDir:      filepath.Join(data, "runs"),
		TLSDir:       filepath.Join(data, "tls"),
		FilesDir:     filepath.Join(data, "files"),
	}
}

type Server struct {
	Listen       string   `toml:"listen"`
	OpenBrowser  bool     `toml:"open_browser"`
	AllowedHosts []string `toml:"allowed_hosts"`
	// MaxUploadMB caps one attached file. Zero or less means the default, 25.
	MaxUploadMB int `toml:"max_upload_mb"`
}
type LAN struct {
	Enabled  bool   `toml:"enabled"`
	Listen   string `toml:"listen"`
	CAListen string `toml:"ca_listen"`
}
type Runs struct {
	DefaultTimeout     string `toml:"default_timeout"`
	ContextMessages    int    `toml:"context_messages"`
	Sandbox            string `toml:"sandbox"`
	SandboxMemoryMax   string `toml:"sandbox_memory_max"`
	SandboxTasksMax    int    `toml:"sandbox_tasks_max"`
	SummaryLane        string `toml:"summary_lane"`
	SummaryEvery       int    `toml:"summary_every"`
	ContextLimitTokens int    `toml:"context_limit_tokens"`
	// RequestMaxRuns and RequestMaxPremium cap the runs one request may start
	// by delegation, in total and on premium lanes. Going over asks the Director.
	RequestMaxRuns    int `toml:"request_max_runs"`
	RequestMaxPremium int `toml:"request_max_premium_runs"`
}

// Routines holds the settings that apply to every routine.
type Routines struct {
	// Timezone is an IANA name such as "Europe/Berlin". Empty means the
	// machine's local zone.
	Timezone string `toml:"timezone"`
	// MaxPerDay caps the runs routines start in one local day.
	MaxPerDay int `toml:"max_per_day"`
}
type Lane struct {
	ID                  string  `toml:"id"`
	CLI                 string  `toml:"cli"`
	Model               string  `toml:"model"`
	CostClass           string  `toml:"cost_class"`
	Capacity            int     `toml:"capacity"`
	ConserveAt          *int    `toml:"conserve_at"`
	PlanLimitTokens     int64   `toml:"plan_limit_tokens"`
	USDPerMillionInput  float64 `toml:"usd_per_million_input"`
	USDPerMillionOutput float64 `toml:"usd_per_million_output"`
	USDPerMillionCached float64 `toml:"usd_per_million_cached"`
	// AllowedTools lists tools a claude run may use without asking, passed
	// as --allowedTools. Unset keeps the write-run default; an empty list
	// allows none.
	AllowedTools   []string `toml:"allowed_tools"`
	SandboxNetwork *bool    `toml:"sandbox_network"`
}
type Persona struct {
	Handle      string   `toml:"handle"`
	DisplayName string   `toml:"display_name"`
	Role        string   `toml:"role"`
	Description string   `toml:"description"`
	Mode        string   `toml:"mode"`
	Lanes       []string `toml:"lanes"`
	// Instructions are standing instructions added to every run prompt.
	Instructions string `toml:"instructions"`
	// ChiefOfStaff makes this persona the one that receives messages nobody
	// is addressed in, in the channels named in Channels.
	ChiefOfStaff bool     `toml:"chief_of_staff"`
	Channels     []string `toml:"channels"`
}

// Routine is a prompt that runs on a schedule or when a human posts in the
// channel. Exactly one of Schedule (a cron expression) and Trigger ("message")
// is set. Template "debrief" adds facts about the last day to the prompt.
type Routine struct {
	Handle   string `toml:"handle"`
	Name     string `toml:"name"`
	Prompt   string `toml:"prompt"`
	Persona  string `toml:"persona"`
	Channel  string `toml:"channel"`
	Schedule string `toml:"schedule"`
	Trigger  string `toml:"trigger"`
	Template string `toml:"template"`
	Enabled  *bool  `toml:"enabled"`
}

// Department is a team of personas with a lead. Lead and Members are persona
// handles.
type Department struct {
	Handle      string   `toml:"handle"`
	DisplayName string   `toml:"display_name"`
	Lead        string   `toml:"lead"`
	Members     []string `toml:"members"`
}

// Project groups channels (by name) and a repository. Departments and
// Specialists are the initial assignments; the Director changes them later in
// the app. Lead is the handle that @<project> goes to.
type Project struct {
	Handle      string   `toml:"handle"`
	Name        string   `toml:"name"`
	RepoPath    string   `toml:"repo_path"`
	Lead        string   `toml:"lead"`
	Channels    []string `toml:"channels"`
	Departments []string `toml:"departments"`
	Specialists []string `toml:"specialists"`
}
type LaneConfig struct {
	Lane       []Lane       `toml:"lane"`
	Persona    []Persona    `toml:"persona"`
	Department []Department `toml:"department"`
	Project    []Project    `toml:"project"`
	Routine    []Routine    `toml:"routine"`
}
type Config struct {
	Server   Server     `toml:"server"`
	LAN      LAN        `toml:"lan"`
	Runs     Runs       `toml:"runs"`
	Routines Routines   `toml:"routines"`
	Lanes    LaneConfig `toml:"-"`
}

func Defaults() Config {
	return Config{
		Server:   Server{Listen: "127.0.0.1:7457", OpenBrowser: true, MaxUploadMB: 25},
		LAN:      LAN{Enabled: false, Listen: "0.0.0.0:7458", CAListen: "0.0.0.0:7459"},
		Runs:     Runs{DefaultTimeout: "30m", ContextMessages: 40, Sandbox: "off", SandboxMemoryMax: "4G", SandboxTasksMax: 512, SummaryEvery: 20, ContextLimitTokens: 128000, RequestMaxRuns: 6, RequestMaxPremium: 2},
		Routines: Routines{MaxPerDay: 20},
	}
}
func Load(p Paths) (Config, error) {
	c := Defaults()
	if _, err := toml.DecodeFile(p.ConfigFile, &c); err != nil && !errors.Is(err, os.ErrNotExist) {
		return c, fmt.Errorf("config.toml: %w", err)
	}
	if _, err := toml.DecodeFile(p.LanesFile, &c.Lanes); err != nil && !errors.Is(err, os.ErrNotExist) {
		return c, fmt.Errorf("lanes.toml: %w", err)
	}
	if err := c.Validate(); err != nil {
		return c, err
	}
	return c, nil
}
func (c Config) Validate() error {
	if _, _, err := net.SplitHostPort(c.Server.Listen); err != nil {
		return fmt.Errorf("server.listen: %w", err)
	}
	if c.LAN.Enabled || c.LAN.Listen != "" {
		if _, _, err := net.SplitHostPort(c.LAN.Listen); err != nil {
			return fmt.Errorf("lan.listen: %w", err)
		}
	}
	if c.LAN.CAListen != "" {
		if _, _, err := net.SplitHostPort(c.LAN.CAListen); err != nil {
			return fmt.Errorf("lan.ca_listen: %w", err)
		}
	}
	if _, err := time.ParseDuration(c.Runs.DefaultTimeout); err != nil {
		return fmt.Errorf("runs.default_timeout: %w", err)
	}
	if c.Runs.ContextMessages < 1 {
		return errors.New("runs.context_messages: must be positive")
	}
	if c.Runs.SummaryEvery < 1 || c.Runs.ContextLimitTokens < 1 {
		return errors.New("runs.summary_every and runs.context_limit_tokens: must be positive")
	}
	if c.Runs.Sandbox != "auto" && c.Runs.Sandbox != "off" && c.Runs.Sandbox != "required" {
		return errors.New("runs.sandbox: must be auto, off or required")
	}
	if !memoryLimitPattern.MatchString(c.Runs.SandboxMemoryMax) {
		return errors.New("runs.sandbox_memory_max: use a positive size such as 4G")
	}
	if c.Runs.SandboxTasksMax < 1 {
		return errors.New("runs.sandbox_tasks_max: must be positive")
	}
	if c.Runs.RequestMaxRuns < 1 {
		return errors.New("runs.request_max_runs: must be positive")
	}
	if c.Runs.RequestMaxPremium < 0 {
		return errors.New("runs.request_max_premium_runs: must not be negative")
	}
	if c.Routines.MaxPerDay < 1 {
		return errors.New("routines.max_per_day: must be positive")
	}
	if c.Routines.Timezone != "" {
		if _, err := time.LoadLocation(c.Routines.Timezone); err != nil {
			return fmt.Errorf("routines.timezone: %w", err)
		}
	}
	seen := map[string]bool{}
	for i, l := range c.Lanes.Lane {
		if l.ID == "" {
			return fmt.Errorf("lane[%d].id: required", i)
		}
		if l.CLI == "" {
			return fmt.Errorf("lane[%d].cli: required", i)
		}
		if l.Capacity < 1 {
			return fmt.Errorf("lane[%d].capacity: must be positive", i)
		}
		if l.ConserveAt != nil && (*l.ConserveAt < 1 || *l.ConserveAt > 100) {
			return fmt.Errorf("lane[%d].conserve_at: must be between 1 and 100", i)
		}
		if l.PlanLimitTokens < 0 {
			return fmt.Errorf("lane[%d].plan_limit_tokens: must be nonnegative", i)
		}
		if !validPrice(l.USDPerMillionInput) || !validPrice(l.USDPerMillionOutput) || !validPrice(l.USDPerMillionCached) {
			return fmt.Errorf("lane[%d] prices: must be nonnegative", i)
		}
		for j, t := range l.AllowedTools {
			if strings.TrimSpace(t) == "" {
				return fmt.Errorf("lane[%d].allowed_tools[%d]: must not be empty", i, j)
			}
		}
		if seen[l.ID] {
			return fmt.Errorf("lane[%d].id: duplicate", i)
		}
		seen[l.ID] = true
	}
	// Agents that can be named in departments and projects: personas and the
	// CLIs of configured lanes. Every handle that follows an @ is unique.
	agents := map[string]bool{}
	handles := map[string]string{}
	claim := func(kind, handle string) error {
		if prev, dup := handles[strings.ToLower(handle)]; dup {
			return fmt.Errorf("%s %q: handle already used by a %s", kind, handle, prev)
		}
		handles[strings.ToLower(handle)] = kind
		return nil
	}
	for _, l := range c.Lanes.Lane {
		agents[l.CLI] = true
		handles[strings.ToLower(l.CLI)] = "agent"
	}
	for i, p := range c.Lanes.Persona {
		if p.Handle == "" {
			return fmt.Errorf("persona[%d].handle: required", i)
		}
		for _, id := range p.Lanes {
			if !seen[id] {
				return fmt.Errorf("persona[%d].lanes: unknown lane %s", i, id)
			}
		}
		agents[p.Handle] = true
		handles[strings.ToLower(p.Handle)] = "persona"
	}
	for i, d := range c.Lanes.Department {
		if !handleName.MatchString(d.Handle) {
			return fmt.Errorf("department[%d].handle: use letters, digits, - and _", i)
		}
		if err := claim("department", d.Handle); err != nil {
			return fmt.Errorf("department[%d]: %w", i, err)
		}
		for _, h := range append([]string{d.Lead}, d.Members...) {
			if h != "" && !agents[h] {
				return fmt.Errorf("department[%d]: unknown agent %s", i, h)
			}
		}
	}
	departments := map[string]bool{}
	for _, d := range c.Lanes.Department {
		departments[d.Handle] = true
	}
	channelOwner := map[string]string{}
	for i, p := range c.Lanes.Project {
		if !handleName.MatchString(p.Handle) {
			return fmt.Errorf("project[%d].handle: use letters, digits, - and _", i)
		}
		if err := claim("project", p.Handle); err != nil {
			return fmt.Errorf("project[%d]: %w", i, err)
		}
		for _, h := range append([]string{p.Lead}, p.Specialists...) {
			if h != "" && !agents[h] {
				return fmt.Errorf("project[%d]: unknown agent %s", i, h)
			}
		}
		for _, h := range p.Departments {
			if !departments[h] {
				return fmt.Errorf("project[%d]: unknown department %s", i, h)
			}
		}
		for _, ch := range p.Channels {
			key := strings.ToLower(ch)
			if other, ok := channelOwner[key]; ok && other != p.Handle {
				return fmt.Errorf("project[%d]: channel %s is already listed under project %s and project %s; a channel belongs to one project", i, ch, other, p.Handle)
			}
			channelOwner[key] = p.Handle
		}
	}
	return c.validateRoutines(agents)
}

// validateRoutines checks the Chief of Staff and the routines. agents are the
// handles a routine may run as.
func (c Config) validateRoutines(agents map[string]bool) error {
	chiefs := 0
	for i, p := range c.Lanes.Persona {
		if !p.ChiefOfStaff {
			if len(p.Channels) > 0 {
				return fmt.Errorf("persona[%d].channels: only the chief_of_staff persona takes channels", i)
			}
			continue
		}
		if chiefs++; chiefs > 1 {
			return fmt.Errorf("persona[%d].chief_of_staff: only one persona can be the chief of staff", i)
		}
		for j, ch := range p.Channels {
			if strings.TrimSpace(ch) == "" {
				return fmt.Errorf("persona[%d].channels[%d]: must not be empty", i, j)
			}
		}
	}
	routines := map[string]bool{}
	for i, r := range c.Lanes.Routine {
		if !handleName.MatchString(r.Handle) {
			return fmt.Errorf("routine[%d].handle: use letters, digits, - and _", i)
		}
		if routines[strings.ToLower(r.Handle)] {
			return fmt.Errorf("routine[%d].handle: duplicate", i)
		}
		routines[strings.ToLower(r.Handle)] = true
		if !agents[r.Persona] {
			return fmt.Errorf("routine[%d].persona: unknown agent %q", i, r.Persona)
		}
		if strings.TrimSpace(r.Channel) == "" {
			return fmt.Errorf("routine[%d].channel: required", i)
		}
		if strings.TrimSpace(r.Prompt) == "" && r.Template == "" {
			return fmt.Errorf("routine[%d].prompt: required unless a template is set", i)
		}
		if r.Template != "" && r.Template != "debrief" {
			return fmt.Errorf("routine[%d].template: unknown template %q (use debrief)", i, r.Template)
		}
		switch {
		case r.Schedule != "" && r.Trigger != "":
			return fmt.Errorf("routine[%d]: set schedule or trigger, not both", i)
		case r.Schedule != "":
			if _, err := cron.Parse(r.Schedule); err != nil {
				return fmt.Errorf("routine[%d].schedule: %w", i, err)
			}
		case r.Trigger == "message":
		case r.Trigger != "":
			return fmt.Errorf("routine[%d].trigger: unknown trigger %q (use message)", i, r.Trigger)
		default:
			return fmt.Errorf("routine[%d]: set a schedule or a trigger", i)
		}
	}
	return nil
}

func validPrice(v float64) bool { return v >= 0 && !math.IsNaN(v) && !math.IsInf(v, 0) }

var handleName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

// IsStaleDefaultLane reports whether a stored lane is a detected-only
// default (cli/default) left over from before lanes.toml configured a lane
// for the same CLI. Such a lane is not listed or used.
func (c Config) IsStaleDefaultLane(id, cli string) bool {
	if id != cli+"/default" {
		return false
	}
	configuredCLI := false
	for _, l := range c.Lanes.Lane {
		if l.ID == id {
			return false
		}
		if l.CLI == cli {
			configuredCLI = true
		}
	}
	return configuredCLI
}

func WriteDefaults(p Paths) error {
	for _, d := range []string{p.ConfigDir, p.DataDir, p.WorktreesDir, p.RunsDir} {
		if err := os.MkdirAll(d, 0700); err != nil {
			return err
		}
	}
	for _, f := range []struct{ path, body string }{{p.ConfigFile, "# Local server settings\n[server]\nlisten = \"127.0.0.1:7457\"\nopen_browser = true\n\n[lan]\nenabled = false\nlisten = \"0.0.0.0:7458\"\nca_listen = \"0.0.0.0:7459\"\n\n[runs]\ndefault_timeout = \"30m\"\ncontext_messages = 40\nsandbox = \"off\"\nsandbox_memory_max = \"4G\"\nsandbox_tasks_max = 512\n"}, {p.LanesFile, "# Agent lanes and personas. Run 'faztudo agents detect' to find local CLIs.\n# [[lane]]\n# id = \"codex/default\"\n# cli = \"codex\"\n# cost_class = \"standard\"\n# capacity = 1\n# conserve_at = 80\n# sandbox_network = true\n#\n# [[persona]]\n# handle = \"coder\"\n# display_name = \"Coder\"\n# lanes = [\"codex/default\"]\n# mode = \"write\"\n"}} {
		h, err := os.OpenFile(f.path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return err
		}
		if _, err = h.WriteString(f.body); err != nil {
			h.Close()
			return err
		}
		if err = h.Close(); err != nil {
			return err
		}
	}
	return nil
}
func IsLoopbackListen(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

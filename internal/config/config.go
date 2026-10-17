package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

type Paths struct{ ConfigDir, DataDir, ConfigFile, LanesFile, SecretsFile, DBFile, WorktreesDir, RunsDir string }

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
	return Paths{cfg, data, filepath.Join(cfg, "config.toml"), filepath.Join(cfg, "lanes.toml"), filepath.Join(cfg, "secrets"), filepath.Join(data, "faztudo.db"), filepath.Join(data, "worktrees"), filepath.Join(data, "runs")}
}

type Server struct {
	Listen      string `toml:"listen"`
	OpenBrowser bool   `toml:"open_browser"`
}
type LAN struct {
	Enabled bool `toml:"enabled"`
}
type Runs struct {
	DefaultTimeout  string `toml:"default_timeout"`
	ContextMessages int    `toml:"context_messages"`
}
type Lane struct {
	ID        string `toml:"id"`
	CLI       string `toml:"cli"`
	Model     string `toml:"model"`
	CostClass string `toml:"cost_class"`
	Capacity  int    `toml:"capacity"`
}
type Persona struct {
	Handle      string   `toml:"handle"`
	DisplayName string   `toml:"display_name"`
	Role        string   `toml:"role"`
	Mode        string   `toml:"mode"`
	Lanes       []string `toml:"lanes"`
}
type LaneConfig struct {
	Lane    []Lane    `toml:"lane"`
	Persona []Persona `toml:"persona"`
}
type Config struct {
	Server Server     `toml:"server"`
	LAN    LAN        `toml:"lan"`
	Runs   Runs       `toml:"runs"`
	Lanes  LaneConfig `toml:"-"`
}

func Defaults() Config {
	return Config{Server: Server{Listen: "127.0.0.1:7457", OpenBrowser: true}, Runs: Runs{DefaultTimeout: "30m", ContextMessages: 40}}
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
	if c.LAN.Enabled {
		return errors.New("lan.enabled: LAN authentication is not available yet")
	}
	if _, err := time.ParseDuration(c.Runs.DefaultTimeout); err != nil {
		return fmt.Errorf("runs.default_timeout: %w", err)
	}
	if c.Runs.ContextMessages < 1 {
		return errors.New("runs.context_messages: must be positive")
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
		if seen[l.ID] {
			return fmt.Errorf("lane[%d].id: duplicate", i)
		}
		seen[l.ID] = true
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
	}
	return nil
}
func WriteDefaults(p Paths) error {
	for _, d := range []string{p.ConfigDir, p.DataDir, p.WorktreesDir, p.RunsDir} {
		if err := os.MkdirAll(d, 0700); err != nil {
			return err
		}
	}
	for _, f := range []struct{ path, body string }{{p.ConfigFile, "# Local server settings\n[server]\nlisten = \"127.0.0.1:7457\"\nopen_browser = true\n\n[lan]\nenabled = false\n\n[runs]\ndefault_timeout = \"30m\"\ncontext_messages = 40\n"}, {p.LanesFile, "# Agent lanes and personas. Run 'faztudo agents detect' to find local CLIs.\n# [[lane]]\n# id = \"codex/default\"\n# cli = \"codex\"\n# cost_class = \"standard\"\n# capacity = 1\n#\n# [[persona]]\n# handle = \"coder\"\n# display_name = \"Coder\"\n# lanes = [\"codex/default\"]\n# mode = \"write\"\n"}} {
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

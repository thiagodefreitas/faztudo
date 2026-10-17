package agentsdetect

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Agent struct {
	Name         string   `json:"name"`
	Path         string   `json:"path,omitempty"`
	ConfigDirs   []string `json:"config_dirs"`
	Version      string   `json:"version,omitempty"`
	VersionError string   `json:"version_error,omitempty"`
}

var names = []string{"claude", "codex", "grok", "kimi", "agy", "opencode"}

func Detect(path, home string) []Agent {
	out := make([]Agent, 0, len(names))
	for _, name := range names {
		a := Agent{Name: name, ConfigDirs: []string{}}
		for _, dir := range strings.Split(path, string(os.PathListSeparator)) {
			if dir == "" {
				continue
			}
			p := filepath.Join(dir, name)
			if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0111 != 0 {
				a.Path = p
				break
			}
		}
		var patterns []string
		switch name {
		case "claude":
			patterns = []string{".claude"}
		case "codex":
			patterns = []string{".codex"}
		case "grok":
			patterns = []string{".grok"}
		case "kimi":
			patterns = []string{".kimi*"}
		case "agy":
			patterns = []string{".gemini/antigravity*"}
		case "opencode":
			patterns = []string{".config/opencode"}
		}
		for _, pat := range patterns {
			matches, _ := filepath.Glob(filepath.Join(home, pat))
			for _, m := range matches {
				if fi, err := os.Stat(m); err == nil && fi.IsDir() {
					a.ConfigDirs = append(a.ConfigDirs, m)
				}
			}
		}
		out = append(out, a)
	}
	return out
}
func Local() []Agent { home, _ := os.UserHomeDir(); return Detect(os.Getenv("PATH"), home) }
func Versions(ctx context.Context, agents []Agent) []Agent {
	for i := range agents {
		if agents[i].Path == "" {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		b, err := exec.CommandContext(cctx, agents[i].Path, "--version").CombinedOutput()
		cancel()
		if err != nil {
			agents[i].VersionError = err.Error()
		} else {
			agents[i].Version = strings.TrimSpace(string(b))
		}
	}
	return agents
}

// Package version reports which build of faztudo is running.
//
// Release builds set Version, Commit and Date with -ldflags (see the
// Makefile and .goreleaser.yaml). Plain `go build` and `go install` builds
// fall back to the VCS information the Go toolchain embeds, so every binary
// can say which commit it came from.
package version

import (
	"fmt"
	"runtime"
	"runtime/debug"
)

// Set at build time with -ldflags "-X github.com/thiagodefreitas/faztudo/internal/version.Version=...".
var (
	Version = ""
	Commit  = ""
	Date    = ""
)

// Info describes the running build.
type Info struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	Date      string `json:"date,omitempty"`
	Modified  bool   `json:"modified,omitempty"`
	GoVersion string `json:"go_version"`
}

// Get returns the build information, filling gaps from the embedded VCS
// data. A build that is not a release reports version "dev".
func Get() Info {
	i := Info{Version: Version, Commit: Commit, Date: Date, GoVersion: runtime.Version()}
	if bi, ok := debug.ReadBuildInfo(); ok {
		if i.Version == "" && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
			i.Version = bi.Main.Version
		}
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				if i.Commit == "" {
					i.Commit = s.Value
				}
			case "vcs.time":
				if i.Date == "" {
					i.Date = s.Value
				}
			case "vcs.modified":
				i.Modified = s.Value == "true"
			}
		}
	}
	if i.Version == "" {
		i.Version = "dev"
	}
	return i
}

// String is the one-line form printed by `faztudo version`.
func (i Info) String() string {
	commit := i.Commit
	if len(commit) > 12 {
		commit = commit[:12]
	}
	if commit == "" {
		commit = "unknown"
	}
	if i.Modified {
		commit += "-modified"
	}
	s := fmt.Sprintf("faztudo %s (commit %s", i.Version, commit)
	if i.Date != "" {
		s += ", built " + i.Date
	}
	return s + ", " + i.GoVersion + ")"
}

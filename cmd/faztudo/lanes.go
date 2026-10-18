package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/agentsdetect"
	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/usage"
)

func printLanes(p config.Paths) error {
	var lanes []domain.Lane
	c, err := config.Load(p)
	if err != nil {
		return err
	}
	if remote, connected, err := lanesFromAPI(p, c.Server.Listen); err != nil {
		return err
	} else if connected {
		lanes = remote
	} else if _, err := os.Stat(p.DBFile); err == nil {
		s, err := store.Open(p.DBFile)
		if err != nil {
			return err
		}
		defer s.Close()
		all, err := s.Lanes(context.Background())
		if err != nil {
			return err
		}
		for _, l := range all {
			if !c.IsStaleDefaultLane(l.ID, l.CLI) {
				lanes = append(lanes, l)
			}
		}
	} else if os.IsNotExist(err) {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, cfg := range c.Lanes.Lane {
			seen[cfg.CLI] = true
			l := domain.Lane{ID: cfg.ID, CLI: cfg.CLI, Capacity: cfg.Capacity, Health: domain.LaneUnknown}
			switch cfg.CLI {
			case "codex":
				l.Windows, err = usage.ReadCodex(home, usage.Options{})
			case "claude":
				var result usage.ClaudeResult
				result, err = usage.ReadClaude(home, usage.Options{})
				l.Windows = result.Windows
			case "grok":
				var result usage.TokenResult
				result, err = usage.ReadGrok(home, usage.Options{})
				l.Windows = result.Windows
			}
			if err != nil {
				return err
			}
			lanes = append(lanes, l)
		}
		for _, detected := range agentsdetect.Local() {
			if seen[detected.Name] || detected.Path == "" {
				continue
			}
			l := domain.Lane{ID: detected.Name + "/default", CLI: detected.Name, Capacity: 1, Health: domain.LaneUnknown}
			switch detected.Name {
			case "codex":
				l.Windows, err = usage.ReadCodex(home, usage.Options{})
			case "claude":
				var result usage.ClaudeResult
				result, err = usage.ReadClaude(home, usage.Options{})
				l.Windows = result.Windows
			case "grok":
				var result usage.TokenResult
				result, err = usage.ReadGrok(home, usage.Options{})
				l.Windows = result.Windows
			}
			if err != nil {
				return err
			}
			lanes = append(lanes, l)
		}
	} else {
		return err
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "LANE\tHEALTH\tWINDOWS (USED, SOURCE, AGE)\tCAPACITY\tRUNNING")
	for _, l := range lanes {
		var windows []string
		for _, win := range l.Windows {
			used := "unknown"
			if win.UsedPct != nil {
				used = fmt.Sprintf("%.1f%%", *win.UsedPct)
			} else if win.Tokens != nil {
				used = compactTokens(*win.Tokens) + " tokens"
			}
			age := "unknown"
			if win.MeasuredAt != nil {
				age = time.Since(*win.MeasuredAt).Round(time.Second).String()
			}
			windows = append(windows, fmt.Sprintf("%s: %s %s %s", win.Name, used, win.Source, age))
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%d\t%d\n", l.ID, l.Health, strings.Join(windows, "; "), l.Capacity, l.Running)
	}
	return w.Flush()
}

func lanesFromAPI(p config.Paths, listen string) ([]domain.Lane, bool, error) {
	token, err := auth.ReadLocalToken(auth.LocalTokenPath(p.DataDir))
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	req, err := http.NewRequest("GET", "http://"+listen+"/api/v1/lanes", nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 2 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		var op *net.OpError
		if errors.As(err, &op) && errors.Is(op.Err, syscall.ECONNREFUSED) {
			return nil, false, nil
		}
		return nil, false, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, true, fmt.Errorf("lanes API returned %s", res.Status)
	}
	var lanes []domain.Lane
	if err := json.NewDecoder(res.Body).Decode(&lanes); err != nil {
		return nil, true, err
	}
	return lanes, true, nil
}

// compactTokens writes a token count the way people read it: 950, 12k, 1.2M.
func compactTokens(n int64) string {
	switch {
	case n >= 1_000_000:
		return strconv.FormatFloat(float64(n)/1e6, 'f', 1, 64) + "M"
	case n >= 10_000:
		return strconv.FormatInt(n/1000, 10) + "k"
	case n >= 1000:
		return strconv.FormatFloat(float64(n)/1e3, 'f', 1, 64) + "k"
	}
	return strconv.FormatInt(n, 10)
}

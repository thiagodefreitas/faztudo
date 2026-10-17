// Command faztudo runs the faztudo daemon and its command line tools.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"strings"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/agentsdetect"
	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "faztudo:", err)
		os.Exit(1)
	}
}
func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: faztudo serve|init|doctor|agents detect|lanes|version")
	}
	p := config.PathsFromEnv()
	switch args[0] {
	case "version", "--version":
		fmt.Println("faztudo", version)
		return nil
	case "init":
		return config.WriteDefaults(p)
	case "agents":
		if len(args) < 2 || args[1] != "detect" {
			return fmt.Errorf("usage: faztudo agents detect")
		}
		return json.NewEncoder(os.Stdout).Encode(agentsdetect.Local())
	case "doctor":
		return doctor(p)
	case "lanes":
		fmt.Println("lanes: not wired yet")
		return nil
	case "serve":
		fs := flag.NewFlagSet("serve", flag.ContinueOnError)
		listen := fs.String("listen", "", "listen address override")
		if err := fs.Parse(args[1:]); err != nil {
			if err == flag.ErrHelp {
				return nil
			}
			return err
		}
		if fs.NArg() != 0 {
			return fmt.Errorf("unexpected serve arguments")
		}
		if err := config.WriteDefaults(p); err != nil {
			return err
		}
		c, err := config.Load(p)
		if err != nil {
			return err
		}
		if *listen != "" {
			c.Server.Listen = *listen
		}
		if !config.IsLoopbackListen(c.Server.Listen) {
			return fmt.Errorf("server.listen: M1 serves loopback only")
		}
		s, err := store.Open(p.DBFile)
		if err != nil {
			return err
		}
		defer s.Close()
		humanID, err := seed(context.Background(), s, c)
		if err != nil {
			return err
		}
		logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
		server := &http.Server{Addr: c.Server.Listen, Handler: api.New(s, humanID, version), ReadHeaderTimeout: 5 * time.Second}
		logger.Info("serving", "listen", c.Server.Listen)
		return server.ListenAndServe()
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}
func seed(ctx context.Context, s *store.Store, c config.Config) (string, error) {
	members, err := s.Members(ctx)
	if err != nil {
		return "", err
	}
	for _, m := range members {
		if m.Kind == domain.MemberHuman {
			return m.ID, nil
		}
	}
	handle := os.Getenv("USER")
	if handle == "" {
		u, e := user.Current()
		if e == nil {
			handle = u.Username
		}
	}
	if handle == "" {
		handle = "local"
	}
	h := domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: handle, DisplayName: handle, Presence: domain.PresenceOnline}
	if _, err = s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: h}); err != nil {
		return "", err
	}
	for _, det := range agentsdetect.Local() {
		if det.Path == "" && len(det.ConfigDirs) == 0 {
			continue
		}
		lane := domain.Lane{ID: det.Name + "/default", CLI: det.Name, CostClass: domain.CostStandard, Capacity: 1, Health: domain.LaneUnknown, Windows: []domain.LaneWindow{}}
		for _, configured := range c.Lanes.Lane {
			if configured.CLI == det.Name {
				lane.ID = configured.ID
				lane.Model = configured.Model
				lane.Capacity = configured.Capacity
				if configured.CostClass != "" {
					lane.CostClass = domain.CostClass(configured.CostClass)
				}
			}
		}
		m := domain.Member{ID: store.NewID(), Kind: domain.MemberAgent, Handle: det.Name, DisplayName: strings.ToUpper(det.Name[:1]) + det.Name[1:], Presence: domain.PresenceOffline, Agent: &domain.AgentInfo{Lanes: []string{lane.ID}}}
		if _, err = s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: m}); err != nil {
			return "", err
		}
		if _, err = s.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: lane}); err != nil {
			return "", err
		}
	}
	for _, persona := range c.Lanes.Persona {
		if _, err := s.MemberByHandle(ctx, persona.Handle); err == nil {
			continue
		}
		m := domain.Member{ID: store.NewID(), Kind: domain.MemberAgent, Handle: persona.Handle, DisplayName: persona.DisplayName, Presence: domain.PresenceOffline, Agent: &domain.AgentInfo{Lanes: persona.Lanes, Role: persona.Role, Mode: domain.RunMode(persona.Mode)}}
		if m.DisplayName == "" {
			m.DisplayName = persona.Handle
		}
		if _, err = s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: m}); err != nil {
			return "", err
		}
	}
	ch := domain.Channel{ID: store.NewID(), Name: "general", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic, MemberIDs: []string{h.ID}}
	if _, err = s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: ch.ID, Payload: ch}); err != nil {
		return "", err
	}
	return h.ID, nil
}
func doctor(p config.Paths) error {
	c, err := config.Load(p)
	if err != nil {
		fmt.Println("config:", err)
	} else {
		fmt.Println("config: ok, listen", c.Server.Listen)
	}
	if fi, e := os.Stat(p.DataDir); e == nil {
		if fi.Mode().Perm()&0077 != 0 {
			fmt.Printf("data dir: %s mode %04o (unsafe)\n", p.DataDir, fi.Mode().Perm())
		} else {
			fmt.Printf("data dir: %s mode %04o (private)\n", p.DataDir, fi.Mode().Perm())
		}
	} else {
		fmt.Println("data dir:", e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if out, e := exec.CommandContext(ctx, "git", "--version").Output(); e == nil {
		fmt.Print(string(out))
	} else {
		fmt.Println("git:", e)
	}
	for _, a := range agentsdetect.Versions(context.Background(), agentsdetect.Local()) {
		if a.Path == "" {
			fmt.Println(a.Name + ": not detected")
		} else {
			fmt.Printf("%s: %s (config dirs: %d; sign-in not verified, check in CLI)\n", a.Name, a.Version, len(a.ConfigDirs))
		}
	}
	if err == nil {
		l, e := net.Listen("tcp", c.Server.Listen)
		if e != nil {
			fmt.Println("port:", e)
		} else {
			fmt.Println("port: available")
			l.Close()
		}
	}
	return nil
}

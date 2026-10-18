// Command faztudo runs the faztudo daemon and its command line tools.
package main

import (
	"context"
	"encoding/json"
	"errors"
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

	"github.com/mattn/go-isatty"
	"github.com/thiagodefreitas/faztudo/internal/agentsdetect"
	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/app"
	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/sandbox"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/version"
	"github.com/thiagodefreitas/faztudo/internal/webui"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "faztudo:", err)
		os.Exit(1)
	}
}
func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: faztudo serve|open|token --rotate|init|doctor|agents detect|lanes|passwd|version")
	}
	p := config.PathsFromEnv()
	switch args[0] {
	case "version", "--version", "-v":
		if len(args) > 1 && args[1] == "--json" {
			return json.NewEncoder(os.Stdout).Encode(version.Get())
		}
		fmt.Println(version.Get())
		return nil
	case "init":
		return config.WriteDefaults(p)
	case "passwd":
		return runPasswd(p, os.Stdin, os.Stderr)
	case "agents":
		if len(args) < 2 || args[1] != "detect" {
			return fmt.Errorf("usage: faztudo agents detect")
		}
		return json.NewEncoder(os.Stdout).Encode(agentsdetect.Local())
	case "doctor":
		return doctor(p)
	case "token":
		if len(args) != 2 || args[1] != "--rotate" {
			return fmt.Errorf("usage: faztudo token --rotate")
		}
		if _, err := auth.RotateLocalToken(auth.LocalTokenPath(p.DataDir)); err != nil {
			return err
		}
		fmt.Println("local token rotated; open browsers again with faztudo open")
		return nil
	case "open":
		if len(args) != 1 {
			return fmt.Errorf("usage: faztudo open")
		}
		c, err := config.Load(p)
		if err != nil {
			return err
		}
		return openLocalBrowser(c.Server.Listen, auth.LocalTokenPath(p.DataDir))
	case "lanes":
		return printLanes(p)
	case "serve":
		fs := flag.NewFlagSet("serve", flag.ContinueOnError)
		listen := fs.String("listen", "", "listen address override")
		noOpen := fs.Bool("no-open", false, "do not open the browser")
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
		localTokenPath := auth.LocalTokenPath(p.DataDir)
		if _, err := auth.EnsureLocalToken(localTokenPath); err != nil {
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
			return fmt.Errorf("server.listen: must be a loopback address")
		}
		s, err := store.Open(p.DBFile)
		if err != nil {
			return err
		}
		defer s.Close()
		if c.LAN.Enabled {
			if err := checkLANAuthReady(context.Background(), s, time.Now().UTC()); err != nil {
				return err
			}
		}
		humanID, err := seed(context.Background(), s, c)
		if err != nil {
			return err
		}
		logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
		application, err := app.New(context.Background(), s, c, p)
		if err != nil {
			return err
		}
		if err := application.Start(context.Background()); err != nil {
			return err
		}
		handler := api.New(s, humanID, version.Get().Version)
		handler.AllowedHosts = c.Server.AllowedHosts
		handler.LocalTokenPath = localTokenPath
		application.Bind(handler)
		listener, err := net.Listen("tcp", c.Server.Listen)
		if err != nil {
			return err
		}
		application.MCPBase = "http://" + listener.Addr().String()
		server := &http.Server{Addr: c.Server.Listen, Handler: handler.LocalWeb(webui.WithMCP(webui.Mount(handler), application.MCP)), ReadHeaderTimeout: 5 * time.Second}
		if c.LAN.Enabled {
			lanSrv, err := startLAN(context.Background(), s, c, p, handler, logger, os.Stdout)
			if err != nil {
				_ = listener.Close()
				return err
			}
			defer lanSrv.Close()
		}
		url := "http://" + listener.Addr().String()
		logger.Info("serving", "listen", listener.Addr().String(), "url", url)
		if shouldOpenBrowser(c.Server.OpenBrowser, *noOpen, isatty.IsTerminal(os.Stdout.Fd()), os.Getenv("DISPLAY"), os.Getenv("WAYLAND_DISPLAY")) {
			go func() {
				if err := openLocalBrowser(listener.Addr().String(), localTokenPath); err != nil {
					logger.Debug("could not open browser", "error", err)
				}
			}()
		}
		return server.Serve(listener)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func openLocalBrowser(listen, tokenPath string) error {
	token, err := auth.ReadLocalToken(tokenPath)
	if err != nil {
		return fmt.Errorf("read local token: %w", err)
	}
	return exec.Command("xdg-open", "http://"+listen+"/auth/local#"+token).Run()
}

func shouldOpenBrowser(configured, noOpen, terminal bool, display, wayland string) bool {
	return configured && !noOpen && terminal && (display != "" || wayland != "")
}

func seed(ctx context.Context, s *store.Store, c config.Config) (string, error) {
	members, err := s.Members(ctx)
	if err != nil {
		return "", err
	}
	byHandle := map[string]domain.Member{}
	humanID := ""
	for _, m := range members {
		byHandle[m.Handle] = m
		if m.Kind == domain.MemberHuman {
			humanID = m.ID
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
	if humanID == "" {
		h := domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: handle, DisplayName: handle, Presence: domain.PresenceOnline}
		if _, err = s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: h}); err != nil {
			return "", err
		}
		humanID = h.ID
	}
	configured := map[string][]string{}
	for _, l := range c.Lanes.Lane {
		configured[l.CLI] = append(configured[l.CLI], l.ID)
		lane := domain.Lane{ID: l.ID, CLI: l.CLI, Model: l.Model, CostClass: domain.CostClass(l.CostClass), Capacity: l.Capacity, Health: domain.LaneUnknown, Windows: []domain.LaneWindow{}}
		if lane.CostClass == "" {
			lane.CostClass = domain.CostStandard
		}
		if existing, getErr := s.Lane(ctx, l.ID); getErr == nil {
			lane.Health = existing.Health
			lane.HealthReason = existing.HealthReason
			lane.Windows = existing.Windows
			lane.LastError = existing.LastError
			lane.RunsToday, lane.RunsDate, lane.TokensLastHour = existing.RunsToday, existing.RunsDate, existing.TokensLastHour
		} else if !errors.Is(getErr, store.ErrNotFound) {
			return "", getErr
		}
		if _, err = s.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: lane}); err != nil {
			return "", err
		}
	}
	for _, det := range agentsdetect.Local() {
		if det.Path == "" && len(det.ConfigDirs) == 0 && len(configured[det.Name]) == 0 {
			continue
		}
		if len(configured[det.Name]) == 0 {
			id := det.Name + "/default"
			configured[det.Name] = []string{id}
			if _, getErr := s.Lane(ctx, id); errors.Is(getErr, store.ErrNotFound) {
				lane := domain.Lane{ID: id, CLI: det.Name, CostClass: domain.CostStandard, Capacity: 1, Health: domain.LaneUnknown, Windows: []domain.LaneWindow{}}
				if _, err = s.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: lane}); err != nil {
					return "", err
				}
			} else if getErr != nil {
				return "", getErr
			}
		}
	}
	for cli, ids := range configured {
		m := domain.Member{ID: store.NewID(), Kind: domain.MemberAgent, Handle: cli, DisplayName: strings.ToUpper(cli[:1]) + cli[1:], Presence: domain.PresenceOffline, Agent: &domain.AgentInfo{Lanes: ids}}
		if existing, exists := byHandle[cli]; exists {
			m.ID = existing.ID
		}
		if _, err = s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: m}); err != nil {
			return "", err
		}
		byHandle[cli] = m
	}
	for _, persona := range c.Lanes.Persona {
		m := domain.Member{ID: store.NewID(), Kind: domain.MemberAgent, Handle: persona.Handle, DisplayName: persona.DisplayName, Presence: domain.PresenceOffline, Agent: &domain.AgentInfo{Lanes: persona.Lanes, Role: persona.Role, Description: persona.Description, Mode: domain.RunMode(persona.Mode)}}
		if existing, ok := byHandle[persona.Handle]; ok {
			m.ID = existing.ID
		}
		if m.DisplayName == "" {
			m.DisplayName = persona.Handle
		}
		if _, err = s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: m}); err != nil {
			return "", err
		}
	}
	if err = seedOrg(ctx, s, c); err != nil {
		return "", err
	}
	channels, err := s.Channels(ctx)
	if err != nil {
		return "", err
	}
	if len(channels) == 0 {
		ch := domain.Channel{ID: store.NewID(), Name: "general", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic, MemberIDs: []string{humanID}}
		if _, err = s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: ch.ID, Payload: ch}); err != nil {
			return "", err
		}
	}
	return humanID, nil
}

// seedOrg records the departments and projects from lanes.toml. Departments
// follow the file. For a project that already exists, the file sets its name,
// repository, lead and channels, while the assignments the Director made in
// the app stay.
func seedOrg(ctx context.Context, s *store.Store, c config.Config) error {
	for _, d := range c.Lanes.Department {
		dept := domain.Department{Handle: d.Handle, DisplayName: d.DisplayName, Lead: d.Lead, Members: orEmpty(d.Members)}
		if dept.DisplayName == "" {
			dept.DisplayName = d.Handle
		}
		if _, err := s.Append(ctx, events.Draft{Type: events.DepartmentUpdated, Actor: events.System, Payload: dept}); err != nil {
			return err
		}
	}
	for _, p := range c.Lanes.Project {
		proj := domain.Project{Handle: p.Handle, Name: p.Name, RepoPath: p.RepoPath, Lead: p.Lead, Channels: orEmpty(p.Channels), Departments: orEmpty(p.Departments), Specialists: orEmpty(p.Specialists)}
		if proj.Name == "" {
			proj.Name = p.Handle
		}
		if cur, err := s.Project(ctx, p.Handle); err == nil {
			proj.Departments, proj.Specialists = cur.Departments, cur.Specialists
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if _, err := s.Append(ctx, events.Draft{Type: events.ProjectUpdated, Actor: events.System, Payload: proj}); err != nil {
			return err
		}
	}
	return nil
}

func orEmpty(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
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
	if path, e := exec.LookPath("bwrap"); e == nil {
		fmt.Println("bubblewrap:", path)
	} else {
		fmt.Println("bubblewrap: unavailable")
	}
	if e := sandbox.Probe(ctx, true); e == nil {
		fmt.Println("unprivileged user namespaces: available")
	} else {
		fmt.Println("unprivileged user namespaces:", e)
	}
	limits := config.Defaults().Runs
	if err == nil {
		limits = c.Runs
	}
	if sandbox.ScopeAvailable(ctx, limits.SandboxMemoryMax, limits.SandboxTasksMax) {
		fmt.Println("systemd user scopes: available")
	} else {
		fmt.Println("systemd user scopes: unavailable")
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

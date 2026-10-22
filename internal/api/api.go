package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/org"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

type RunTrigger interface {
	OnMessage(context.Context, domain.Message, []domain.Member)
}
type noopTrigger struct{}

func (noopTrigger) OnMessage(context.Context, domain.Message, []domain.Member) {}

type API struct {
	Store            *store.Store
	HumanID, Version string
	// AllowedHosts are extra host names (no port) accepted in the Host
	// header of loopback requests, for a local reverse proxy such as
	// tailscale serve. With LAN mode on, such requests need a session.
	AllowedHosts []string
	// LocalTokenPath is the persistent token file. Serve fails closed if unset.
	LocalTokenPath string
	// FilesDir holds uploaded attachments by content hash; empty disables
	// uploads. MaxUploadBytes caps one file (zero means 25 MB).
	FilesDir        string
	MaxUploadBytes  int64
	LocalLimiter    *auth.LoginRateLimiter
	localAuthBypass bool // used only by legacy in-package tests
	Trigger         RunTrigger
	// Chief reports the handle of the Chief of Staff for a channel name, when
	// that channel opted in. Nil means no channel has one.
	Chief func(channel string) (handle string, ok bool)
	// Routines runs and switches the routines. Nil means there are none.
	Routines RoutineControl
	// Tasks lists, starts and cancels task directives. OnApproval is called
	// after a human decided an approval, so a task can follow it.
	Tasks             TaskControl
	suggestionMu      sync.Mutex // one accept or dismiss at a time
	OnApproval        func(context.Context, domain.Approval)
	ResolveApproval   func(ctx context.Context, approval domain.Approval, option, commitMessage string) (string, error)
	ReadDiff          func(string) ([]byte, error)
	CancelRun         func(context.Context, string) error
	RetryRun          func(context.Context, string, string) error
	ProbeLane         func(context.Context, string) (domain.Lane, error)
	RegenerateSummary func(context.Context, string) (store.ChannelSummary, error)
	Compare           CompareControl
	// HideLane drops lanes that must not be listed, such as a detected-only
	// default once lanes.toml configures the CLI.
	HideLane      func(domain.Lane) bool
	MCP           http.Handler
	LANEnabled    bool
	LANListen     string
	CACertPEM     []byte
	CAFingerprint string
	CAHTTPURL     string
	LANURLs       []string
	// CurrentLANURLs, when set, reports the LAN URLs from the machine's
	// addresses at call time and wins over LANURLs. faztudo can start before
	// the network is up, so a list taken at startup goes stale.
	CurrentLANURLs func() []string
	// CAPort is the CA helper's port, joined to the current LAN address.
	CAPort  string
	Limiter *auth.LoginRateLimiter
	// SessionRecheck is how often an open stream re-reads its session row.
	// Zero means 10 seconds.
	SessionRecheck  time.Duration
	Now             func() time.Time
	actorForRequest func(*http.Request) (domain.Member, error)
	resolveMu       sync.Mutex
	orgMu           sync.Mutex
	codesMu         sync.Mutex
	codes           map[string]time.Time // one-time local sign-in codes and their expiry
	streamsMu       sync.Mutex
	streams         map[string]map[*streamHandle]struct{}
}
type actorKey struct{}

func New(s *store.Store, humanID, version string) *API {
	return &API{
		Store:        s,
		HumanID:      humanID,
		Version:      version,
		Trigger:      noopTrigger{},
		Routines:     noRoutines{},
		Tasks:        noTasks{},
		Limiter:      auth.NewLoginRateLimiter(),
		LocalLimiter: auth.NewLoginRateLimiter(),
		Now:          time.Now,
		streams:      map[string]map[*streamHandle]struct{}{},
	}
}
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	mux := http.NewServeMux()
	a.routes(mux)
	mux.ServeHTTP(w, r)
}
func (a *API) routes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		if a.isLANRequest(r) {
			// The LAN listener is reachable by anyone on the network: no version string.
			respond(w, 200, map[string]any{"ok": true})
			return
		}
		respond(w, 200, map[string]any{"ok": true, "version": a.Version, "api": "v1"})
	})
	m.HandleFunc("GET /ca.crt", a.serveCACert)
	m.HandleFunc("/mcp", a.serveMCP)
	m.HandleFunc("/mcp/", a.serveMCP)
	m.HandleFunc("POST /api/v1/auth/login", a.publicPost(a.login))
	m.HandleFunc("POST /api/v1/auth/pair", a.publicPost(a.pair))
	m.HandleFunc("POST /api/v1/auth/pairings/redeem", a.publicPost(a.pair))
	m.HandleFunc("POST /api/v1/auth/local", a.localPost)
	m.HandleFunc("GET /auth/local", a.localPage)
	m.Handle("/api/v1/", a.authenticated())
}
func (a *API) authenticated() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("POST /api/v1/auth/logout", a.logout)
	m.HandleFunc("GET /api/v1/auth/devices", a.devices)
	m.HandleFunc("DELETE /api/v1/auth/devices/{id}", a.revokeDevice)
	m.HandleFunc("POST /api/v1/auth/pairings", a.createPairing)
	m.HandleFunc("GET /api/v1/auth/ca", a.caInfo)
	m.HandleFunc("GET /api/v1/me", a.me)
	m.HandleFunc("POST /api/v1/auth/local/code", a.localCode)
	m.HandleFunc("GET /api/v1/members", a.members)
	m.HandleFunc("GET /api/v1/lessons", a.lessons)
	m.HandleFunc("POST /api/v1/lessons", a.createLesson)
	m.HandleFunc("PATCH /api/v1/lessons/{id}", a.patchLesson)
	m.HandleFunc("DELETE /api/v1/lessons/{id}", a.deleteLesson)
	m.HandleFunc("GET /api/v1/org", a.org)
	m.HandleFunc("POST /api/v1/projects", a.createProject)
	m.HandleFunc("PATCH /api/v1/projects/{project}", a.patchProject)
	m.HandleFunc("POST /api/v1/projects/{project}/assignments", a.assign)
	m.HandleFunc("DELETE /api/v1/projects/{project}/assignments/{kind}/{handle}", a.unassign)
	m.HandleFunc("GET /api/v1/routines", a.routines)
	m.HandleFunc("POST /api/v1/routines", a.createRoutine)
	m.HandleFunc("PATCH /api/v1/routines/{handle}", a.patchRoutine)
	m.HandleFunc("DELETE /api/v1/routines/{handle}", a.deleteRoutine)
	m.HandleFunc("POST /api/v1/routines/{handle}/run", a.runRoutine)
	m.HandleFunc("GET /api/v1/tasks", a.listTasks)
	m.HandleFunc("POST /api/v1/tasks", a.createTask)
	m.HandleFunc("GET /api/v1/tasks/{id}", a.getTask)
	m.HandleFunc("PATCH /api/v1/tasks/{id}", a.patchTask)
	m.HandleFunc("POST /api/v1/tasks/{id}/start", a.taskAction(true))
	m.HandleFunc("POST /api/v1/tasks/{id}/cancel", a.taskAction(false))
	m.HandleFunc("GET /api/v1/channels", a.channels)
	m.HandleFunc("POST /api/v1/channels", a.createChannel)
	m.HandleFunc("PATCH /api/v1/channels/{id}", a.patchChannel)
	m.HandleFunc("GET /api/v1/channels/{id}/messages", a.messages)
	m.HandleFunc("POST /api/v1/channels/{id}/messages", a.postMessage)
	m.HandleFunc("POST /api/v1/channels/{id}/read", a.read)
	m.HandleFunc("GET /api/v1/messages/{id}/thread", a.thread)
	m.HandleFunc("POST /api/v1/messages/{id}/pin", a.setPin(true))
	m.HandleFunc("DELETE /api/v1/messages/{id}/pin", a.setPin(false))
	m.HandleFunc("GET /api/v1/channels/{id}/pins", a.pins)
	m.HandleFunc("GET /api/v1/search", a.search)
	m.HandleFunc("POST /api/v1/files", a.upload)
	m.HandleFunc("GET /api/v1/files/{id}", a.serveFile)
	m.HandleFunc("GET /api/v1/runs", a.runs)
	m.HandleFunc("GET /api/v1/runs/{id}", a.run)
	m.HandleFunc("GET /api/v1/runs/{id}/output", a.output)
	m.HandleFunc("GET /api/v1/runs/{id}/prompt", a.runPrompt)
	m.HandleFunc("GET /api/v1/runs/{id}/diff", a.diff)
	m.HandleFunc("POST /api/v1/runs/{id}/cancel", a.cancel)
	m.HandleFunc("POST /api/v1/runs/{id}/retry", a.retry)
	m.HandleFunc("GET /api/v1/approvals", a.approvals)
	m.HandleFunc("POST /api/v1/approvals/{id}/resolve", a.resolve)
	m.HandleFunc("GET /api/v1/approval-rules", a.listApprovalRules)
	m.HandleFunc("POST /api/v1/approval-rules", a.createApprovalRule)
	m.HandleFunc("DELETE /api/v1/approval-rules/{id}", a.deleteApprovalRule)
	m.HandleFunc("GET /api/v1/suggestions", a.listSuggestions)
	m.HandleFunc("POST /api/v1/suggestions/{id}/accept", a.acceptSuggestion)
	m.HandleFunc("POST /api/v1/suggestions/{id}/dismiss", a.dismissSuggestion)
	m.HandleFunc("GET /api/v1/channels/{id}/compares", a.compares)
	m.HandleFunc("POST /api/v1/channels/{id}/compares/{compare}/decide", a.decideCompare)
	m.HandleFunc("GET /api/v1/lanes", a.lanes)
	m.HandleFunc("GET /api/v1/lanes/channel-summary/{channel_id}", a.getChannelSummary)
	m.HandleFunc("POST /api/v1/lanes/channel-summary/{channel_id}/regenerate", a.regenerateChannelSummary)
	m.HandleFunc("GET /api/v1/lanes/{id...}", a.laneHistory)
	m.HandleFunc("PATCH /api/v1/lanes/{id...}", a.patchLane)
	m.HandleFunc("POST /api/v1/lanes/{id...}", a.probe)
	m.HandleFunc("GET /api/v1/stream/head", a.streamHead)
	m.HandleFunc("GET /api/v1/stream", a.stream)
	m.HandleFunc("/api/v1/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "not_found", "endpoint not found") })
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.isLANRequest(r) {
			if r.Method != "GET" && r.Method != "HEAD" {
				if !validLANOrigin(r) {
					fail(w, 403, "forbidden", "invalid origin")
					return
				}
			}
			cookie, err := r.Cookie(sessionCookieName)
			if err != nil || cookie.Value == "" {
				fail(w, 401, "unauthorized", "authentication required")
				return
			}
			now := a.now()
			expires := now.Add(sessionTTL)
			dev, err := a.Store.SessionByTokenHash(r.Context(), auth.HashToken(cookie.Value), now, expires)
			if err != nil {
				fail(w, 401, "unauthorized", "invalid or expired session")
				return
			}
			setSessionCookie(w, cookie.Value, expires)
			var member domain.Member
			if a.actorForRequest != nil {
				member, err = a.actorForRequest(r)
			} else {
				member, err = a.Store.Member(r.Context(), dev.MemberID)
			}
			if err != nil {
				fail(w, 401, "unauthorized", "member not found")
				return
			}
			ctx := context.WithValue(r.Context(), actorKey{}, member)
			ctx = context.WithValue(ctx, sessionKey{}, dev.ID)
			ctx = context.WithValue(ctx, lanConnKey{}, true)
			m.ServeHTTP(w, r.WithContext(ctx))
			return
		}
		if !isLoopbackAddr(r.RemoteAddr) {
			fail(w, 403, "forbidden", "local requests only")
			return
		}
		if !a.hostAllowed(r.Host) {
			fail(w, 403, "forbidden", "invalid host")
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if !validLoopbackOrigin(r) {
				fail(w, 403, "forbidden", "invalid origin")
				return
			}
		}
		authed, limited := a.localAuthenticated(r)
		if !authed {
			if limited {
				fail(w, 429, "rate_limited", "too many failed token attempts")
			} else {
				fail(w, 401, "unauthorized", "local token required; run faztudo open")
			}
			return
		}
		var (
			member domain.Member
			err    error
		)
		if a.actorForRequest != nil {
			member, err = a.actorForRequest(r)
		} else {
			member, err = a.Store.Member(r.Context(), a.HumanID)
		}
		if err != nil {
			failErr(w, err)
			return
		}
		ctx := context.WithValue(r.Context(), actorKey{}, member)
		if cookie, cerr := r.Cookie(sessionCookieName); cerr == nil && cookie.Value != "" {
			now := a.now()
			if dev, serr := a.Store.SessionByTokenHash(r.Context(), auth.HashToken(cookie.Value), now, now.Add(sessionTTL)); serr == nil {
				ctx = context.WithValue(ctx, sessionKey{}, dev.ID)
			}
		}
		m.ServeHTTP(w, r.WithContext(ctx))
	})
}
func (a *API) hostAllowed(addr string) bool {
	if loopbackHost(addr) {
		return true
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	for _, h := range a.AllowedHosts {
		if strings.EqualFold(strings.TrimSuffix(host, "."), strings.TrimSuffix(h, ".")) {
			return true
		}
	}
	return false
}

// proxyHost reports whether addr is one of the configured allowed_hosts.
func (a *API) proxyHost(addr string) bool {
	return !loopbackHost(addr) && a.hostAllowed(addr)
}

func loopbackHost(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	host = strings.Trim(host, "[]")
	return host == "localhost" || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
}
func current(r *http.Request) domain.Member { return r.Context().Value(actorKey{}).(domain.Member) }

// humanOnly answers 403 and returns false unless the caller is a human.
func humanOnly(w http.ResponseWriter, r *http.Request, what string) bool {
	if current(r).Kind != domain.MemberHuman {
		fail(w, 403, "forbidden", "only a human can "+what)
		return false
	}
	return true
}

// canSee reports whether the member may read the channel. An unknown channel
// is treated as not visible.
func (a *API) canSee(ctx context.Context, memberID, channelID string) bool {
	c, err := a.Store.Channel(ctx, channelID)
	return err == nil && visible(c, memberID)
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, code, msg string) {
	respond(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}
func failErr(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		fail(w, 404, "not_found", "resource not found")
	} else if errors.Is(err, store.ErrConflict) {
		fail(w, 409, "conflict", "resource conflict")
	} else {
		// The client sees a generic error; the cause goes to the log.
		slog.Error("request failed", "err", err)
		fail(w, 500, "internal", "internal error")
	}
}

// MaxMessageBytes caps a JSON request body, and so a message body. Bridges
// apply the same limit to inbound text.
const MaxMessageBytes = 1 << 20

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		fail(w, 400, "bad_request", "application/json required")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxMessageBytes)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return false
	}
	return true
}
func (a *API) append(w http.ResponseWriter, r *http.Request, actor events.Actor, typ events.Type, channel, key string, v any) (events.Event, bool) {
	e, err := a.Store.Append(r.Context(), events.Draft{Type: typ, Actor: actor, ChannelID: channel, IdempotencyKey: key, Payload: v})
	if err != nil {
		failErr(w, err)
		return e, false
	}
	return e, true
}
func (a *API) me(w http.ResponseWriter, r *http.Request) { respond(w, 200, current(r)) }
func (a *API) members(w http.ResponseWriter, r *http.Request) {
	v, e := a.Store.Members(r.Context())
	if e != nil {
		failErr(w, e)
		return
	}
	respond(w, 200, v)
}
func (a *API) channels(w http.ResponseWriter, r *http.Request) {
	v, e := a.Store.Channels(r.Context())
	if e != nil {
		failErr(w, e)
		return
	}
	out := v[:0]
	for _, c := range v {
		if !visible(c, current(r).ID) {
			continue
		}
		c.Unread, _ = a.Store.Unread(r.Context(), c.ID, current(r).ID)
		out = append(out, c)
	}
	respond(w, 200, out)
}

var channelName = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func validChannel(c domain.Channel) bool {
	return channelName.MatchString(c.Name) && (c.Kind == domain.ChannelTeam || c.Kind == domain.ChannelDepartment || c.Kind == domain.ChannelProject || c.Kind == domain.ChannelAgent || c.Kind == domain.ChannelDirect) && (c.Visibility == domain.VisibilityPublic || c.Visibility == domain.VisibilityPrivate || c.Visibility == domain.VisibilityDirect)
}
func (a *API) createChannel(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "create channels") {
		return
	}
	var v struct {
		Name        string             `json:"name"`
		Kind        domain.ChannelKind `json:"kind"`
		Visibility  domain.Visibility  `json:"visibility"`
		Topic       string             `json:"topic"`
		RepoPath    string             `json:"repo_path"`
		TestCommand string             `json:"test_command"`
		MemberIDs   []string           `json:"member_ids"`
	}
	if !decode(w, r, &v) {
		return
	}
	if v.Name == "" {
		fail(w, 400, "bad_request", "name required")
		return
	}
	c := domain.Channel{ID: store.NewID(), Name: v.Name, Kind: v.Kind, Visibility: v.Visibility, Topic: v.Topic, RepoPath: v.RepoPath, TestCommand: v.TestCommand, MemberIDs: v.MemberIDs}
	if c.Kind == "" {
		c.Kind = domain.ChannelTeam
	}
	if c.Visibility == "" {
		c.Visibility = domain.VisibilityPublic
	}
	if len(c.MemberIDs) == 0 {
		c.MemberIDs = []string{current(r).ID}
	}
	if !validChannel(c) {
		fail(w, 400, "bad_request", "invalid channel name, kind or visibility")
		return
	}
	if err := validateRepo(r.Context(), c.RepoPath); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	if _, ok := a.append(w, r, events.Human(current(r).ID), events.ChannelCreated, c.ID, "", c); ok {
		respond(w, 201, c)
	}
}
func (a *API) patchChannel(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "change channel settings") {
		return
	}
	c, e := a.Store.Channel(r.Context(), r.PathValue("id"))
	if e != nil || !visible(c, current(r).ID) {
		fail(w, 404, "not_found", "resource not found")
		return
	}
	var v struct {
		Name         *string   `json:"name"`
		Topic        *string   `json:"topic"`
		RepoPath     *string   `json:"repo_path"`
		TestCommand  *string   `json:"test_command"`
		DefaultAgent *string   `json:"default_agent_id"`
		MemberIDs    *[]string `json:"member_ids"`
		// LaneOverrides replaces the channel's persona-to-lane preferences.
		LaneOverrides *map[string]string `json:"lane_overrides"`
	}
	if !decode(w, r, &v) {
		return
	}
	if v.Name != nil {
		c.Name = *v.Name
	}
	if v.Topic != nil {
		c.Topic = *v.Topic
	}
	if v.RepoPath != nil {
		c.RepoPath = *v.RepoPath
	}
	if v.TestCommand != nil {
		c.TestCommand = *v.TestCommand
	}
	if v.DefaultAgent != nil {
		c.DefaultAgentID = *v.DefaultAgent
	}
	if v.MemberIDs != nil {
		c.MemberIDs = *v.MemberIDs
	}
	if !validChannel(c) {
		fail(w, 400, "bad_request", "invalid channel name, kind or visibility")
		return
	}
	if c.DefaultAgentID != "" {
		members, err := a.Store.Members(r.Context())
		if err != nil {
			failErr(w, err)
			return
		}
		if _, ok := channelAgent(c, c.DefaultAgentID, members); !ok {
			fail(w, 400, "bad_request", "default_agent_id must be an agent member of the channel")
			return
		}
	}
	if v.LaneOverrides != nil {
		members, err := a.Store.Members(r.Context())
		if err != nil {
			failErr(w, err)
			return
		}
		overrides := map[string]string{}
		for handle, lane := range *v.LaneOverrides {
			if err := checkLaneOverride(members, handle, lane); err != nil {
				fail(w, 400, "bad_request", "lane_overrides: "+err.Error())
				return
			}
			overrides[strings.ToLower(handle)] = lane
		}
		c.LaneOverrides = overrides
		if len(overrides) == 0 {
			c.LaneOverrides = nil
		}
	}
	if err := validateRepo(r.Context(), c.RepoPath); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	if _, ok := a.append(w, r, events.Human(current(r).ID), events.ChannelUpdated, c.ID, "", c); ok {
		respond(w, 200, c)
	}
}
func validateRepo(ctx context.Context, path string) error {
	if path == "" {
		return nil
	}
	cmd := exec.CommandContext(ctx, "git", "-C", path, "rev-parse", "--is-inside-work-tree")
	out, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(out)) != "true" {
		return errors.New("repo_path must be an existing git work tree")
	}
	return nil
}
func (a *API) messages(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !a.canSee(r.Context(), current(r).ID, id) {
		fail(w, 404, "not_found", "resource not found")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	v, e := a.Store.RootMessages(r.Context(), id, r.URL.Query().Get("before"), limit)
	if e != nil {
		failErr(w, e)
		return
	}
	respond(w, 200, v)
}
func (a *API) thread(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m, e := a.Store.Message(r.Context(), id)
	if e != nil {
		failErr(w, e)
		return
	}
	if !a.canSee(r.Context(), current(r).ID, m.ChannelID) {
		fail(w, 404, "not_found", "resource not found")
		return
	}
	v, e := a.Store.Thread(r.Context(), id)
	if e != nil {
		failErr(w, e)
		return
	}
	respond(w, 200, v)
}

// mentionHandles lists the lowercased @handles in a message body, in order.
// Code spans, fenced blocks and quoted lines do not count.
func mentionHandles(body string) []string { return domain.MentionHandles(body) }

func mentioned(body string, members []domain.Member) ([]string, []domain.Member) {
	byHandle := map[string]domain.Member{}
	for _, m := range members {
		byHandle[strings.ToLower(m.Handle)] = m
	}
	ids := []string{}
	agents := []domain.Member{}
	seen := map[string]bool{}
	for _, h := range mentionHandles(body) {
		if m, ok := byHandle[h]; ok && !seen[m.ID] {
			seen[m.ID] = true
			ids = append(ids, m.ID)
			if m.Kind == domain.MemberAgent {
				agents = append(agents, m)
			}
		}
	}
	return ids, agents
}

// PostInput is shared by the HTTP API, MCP, and local bridges. Callers supply
// a server-derived actor and author; neither is accepted from wire data.
type PostInput struct {
	ChannelID      string
	Body           string
	ThreadID       string
	IdempotencyKey string
	Attachments    []domain.Attachment
	Options        []string
	RunID          string
	Handoff        *domain.Handoff
	AgentMessage   bool
	Fanout         bool
	AfterStored    func(domain.Message) // HTTP writes its 201 before routing work
}

type PostError struct {
	Code    string
	Message string
}

func (e PostError) Error() string { return e.Message }

// PostAs applies the same mention, project, thread, and idempotency rules to
// posts from every trusted transport. The returned bool is false on redelivery.
func (a *API) PostAs(ctx context.Context, actor events.Actor, author domain.Member, in PostInput) (domain.Message, bool, error) {
	c, err := a.Store.Channel(ctx, in.ChannelID)
	if err != nil {
		return domain.Message{}, false, err
	}
	if strings.TrimSpace(in.Body) == "" && len(in.Attachments) == 0 {
		return domain.Message{}, false, PostError{"bad_request", "body required"}
	}
	if in.ThreadID != "" {
		root, err := a.Store.Message(ctx, in.ThreadID)
		if err != nil || root.ChannelID != c.ID {
			return domain.Message{}, false, PostError{"bad_request", "invalid thread_id"}
		}
		if root.ThreadID != "" {
			in.ThreadID = root.ThreadID
		}
	}
	members, err := a.Store.Members(ctx)
	if err != nil {
		return domain.Message{}, false, err
	}
	ids, agents := mentioned(in.Body, members)
	departments, projects, err := a.orgData(ctx)
	if err != nil {
		return domain.Message{}, false, err
	}
	var notices []events.NoticePayload
	if in.AgentMessage {
		if !in.Fanout {
			agents = nil
		}
	} else {
		leads, problems := groupLeads(in.Body, departments, projects, members)
		for _, lead := range leads {
			if !slices.Contains(ids, lead.ID) {
				ids = append(ids, lead.ID)
				agents = append(agents, lead)
			}
		}
		if len(agents) == 0 {
			agents = directAgent(c, members)
		}
		if isCommand(in.Body, "/lane") {
			agents = nil
		}
		if len(agents) == 0 && len(ids) == 0 && len(problems) == 0 && in.ThreadID == "" && author.Kind == domain.MemberHuman && !strings.HasPrefix(strings.TrimSpace(in.Body), "/") {
			if m, ok := a.chiefOfStaff(c, members); ok {
				agents = []domain.Member{m}
			}
		}
		if len(agents) == 0 && len(ids) == 0 && len(problems) == 0 && !strings.HasPrefix(strings.TrimSpace(in.Body), "/") {
			if m, ok := channelAgent(c, c.DefaultAgentID, members); ok {
				agents = []domain.Member{m}
			}
		}
		for _, p := range problems {
			notices = append(notices, events.NoticePayload{Level: "warn", Text: p})
		}
	}
	agents, refusals := org.Gate(projects, departments, c.Name, agents)
	notices = append(notices, refusals...)
	if in.AgentMessage {
		filtered := agents[:0]
		for _, agent := range agents {
			if agent.ID != author.ID {
				filtered = append(filtered, agent)
			}
		}
		agents = filtered
	}
	m := domain.Message{ID: store.NewID(), ChannelID: c.ID, ThreadID: in.ThreadID, AuthorID: author.ID, Body: in.Body, Mentions: ids, Options: in.Options, Attachments: in.Attachments, RunID: in.RunID, Handoff: in.Handoff, CreatedAt: time.Now().UTC()}
	freshID := m.ID
	evt, err := a.Store.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: actor, ChannelID: c.ID, IdempotencyKey: in.IdempotencyKey, Payload: m})
	if err != nil {
		return domain.Message{}, false, err
	}
	if evt.ChannelID != c.ID {
		return domain.Message{}, false, store.ErrConflict
	}
	if err := json.Unmarshal(evt.Payload, &m); err != nil {
		return domain.Message{}, false, err
	}
	fresh := freshID == m.ID
	if in.AfterStored != nil {
		in.AfterStored(m)
	}
	if fresh && len(agents) > 0 {
		a.Trigger.OnMessage(ctx, m, agents)
	}
	if fresh && !in.AgentMessage && isCommand(m.Body, "/lane") {
		a.laneCommand(ctx, c, members, m.Body)
	}
	if fresh {
		for _, n := range notices {
			_, _ = a.Store.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, ChannelID: c.ID, Payload: n})
		}
		if !in.AgentMessage && isCommand(m.Body, "/status") {
			if text, err := a.statusText(ctx, c.ID); err == nil {
				_, _ = a.Store.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, ChannelID: c.ID, Payload: events.NoticePayload{Level: "info", Text: text}})
			}
		}
	}
	return m, fresh, nil
}

func (a *API) postMessage(w http.ResponseWriter, r *http.Request) {
	if _, err := a.Store.Channel(r.Context(), r.PathValue("id")); err != nil {
		failErr(w, err)
		return
	}
	var v struct {
		Body           string         `json:"body"`
		ThreadID       string         `json:"thread_id"`
		IdempotencyKey string         `json:"idempotency_key"`
		Attachments    []attachmentIn `json:"attachments"`
	}
	if !decode(w, r, &v) {
		return
	}
	if strings.TrimSpace(v.Body) == "" && len(v.Attachments) == 0 {
		fail(w, 400, "bad_request", "body required")
		return
	}
	attachments, err := a.attachmentsFor(v.Attachments)
	if err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	_, _, err = a.PostAs(r.Context(), events.Human(current(r).ID), current(r), PostInput{ChannelID: r.PathValue("id"), Body: v.Body, ThreadID: v.ThreadID, IdempotencyKey: v.IdempotencyKey, Attachments: attachments, Fanout: true, AfterStored: func(m domain.Message) { respond(w, 201, m) }})
	if err != nil {
		var postErr PostError
		if errors.As(err, &postErr) {
			fail(w, 400, postErr.Code, postErr.Message)
		} else {
			failErr(w, err)
		}
		return
	}
}

func isCommand(body, name string) bool {
	f := strings.Fields(body)
	return len(f) > 0 && strings.EqualFold(f[0], name)
}

// statusText answers /status without an agent: active runs in the channel,
// pending approvals in the channel, and every lane's health. It costs no
// agent quota, so it is safe to ask from a phone at any time.
func (a *API) statusText(ctx context.Context, channelID string) (string, error) {
	runs, err := a.Store.Runs(ctx, channelID, "")
	if err != nil {
		return "", err
	}
	approvals, err := a.Store.Approvals(ctx, string(domain.ApprovalPending))
	if err != nil {
		return "", err
	}
	lanes, err := a.listLanes(ctx)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	active := 0
	for _, run := range runs {
		if run.State.Terminal() {
			continue
		}
		active++
		fmt.Fprintf(&b, "\n- run %s on %s: %s", shortID(run.ID), run.LaneID, run.State)
	}
	head := fmt.Sprintf("Status: %d active run(s) here", active)
	pending := 0
	for _, ap := range approvals {
		if ap.ChannelID == channelID {
			pending++
			fmt.Fprintf(&b, "\n- waiting for you: %s", ap.Title)
		}
	}
	head += fmt.Sprintf(", %d approval(s) waiting.", pending)
	b.WriteString("\nLanes:")
	for _, l := range lanes {
		fmt.Fprintf(&b, "\n- %s: %s, %d/%d running", l.ID, l.Health, l.Running, l.Capacity)
		if (l.Health == domain.LaneUnavailable || l.Health == domain.LaneExhausted) && l.HealthReason != "" {
			fmt.Fprintf(&b, " (%s)", l.HealthReason)
		}
		for _, w := range l.Windows {
			if w.UsedPct != nil {
				fmt.Fprintf(&b, ", %s %.0f%%", w.Name, *w.UsedPct)
			}
		}
	}
	return head + b.String(), nil
}

func shortID(id string) string {
	if len(id) > 6 {
		return id[len(id)-6:]
	}
	return id
}

// channelAgent finds the agent with the given id among the channel's members.
func channelAgent(c domain.Channel, id string, members []domain.Member) (domain.Member, bool) {
	if id == "" || !slices.Contains(c.MemberIDs, id) {
		return domain.Member{}, false
	}
	for _, m := range members {
		if m.ID == id && m.Kind == domain.MemberAgent {
			return m, true
		}
	}
	return domain.Member{}, false
}

// directAgent returns the sole agent of a direct channel, so a human message
// there needs no @mention. Other channels, and DMs with several agents, need
// an explicit mention.
func directAgent(c domain.Channel, members []domain.Member) []domain.Member {
	if c.Kind != domain.ChannelDirect && c.Visibility != domain.VisibilityDirect {
		return nil
	}
	in := map[string]bool{}
	for _, id := range c.MemberIDs {
		in[id] = true
	}
	var found []domain.Member
	for _, m := range members {
		if in[m.ID] && m.Kind == domain.MemberAgent {
			found = append(found, m)
		}
	}
	if len(found) != 1 {
		return nil
	}
	return found
}
func (a *API) read(w http.ResponseWriter, r *http.Request) {
	c, e := a.Store.Channel(r.Context(), r.PathValue("id"))
	if e != nil {
		failErr(w, e)
		return
	}
	var v struct {
		Seq     int64  `json:"seq"`
		EventID string `json:"event_id"`
	}
	if !decode(w, r, &v) {
		return
	}
	// seq is the cursor clients already hold (Channel.last_seq); event_id
	// is accepted for older clients.
	seq := v.Seq
	if seq <= 0 {
		evt, e := a.Store.Event(r.Context(), v.EventID)
		if e != nil || evt.ChannelID != c.ID {
			fail(w, 404, "not_found", "event not found")
			return
		}
		seq = evt.Seq
	}
	if e = a.Store.Read(r.Context(), c.ID, current(r).ID, seq); e != nil {
		failErr(w, e)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

// visibleRun loads the run named in the path. A run in a channel the caller
// cannot see answers 404, like the channel's messages: its output, diff and
// stored prompt carry that channel's text.
func (a *API) visibleRun(w http.ResponseWriter, r *http.Request) (domain.Run, bool) {
	run, err := a.Store.Run(r.Context(), r.PathValue("id"))
	if err != nil {
		failErr(w, err)
		return domain.Run{}, false
	}
	if !a.canSee(r.Context(), current(r).ID, run.ChannelID) {
		fail(w, 404, "not_found", "resource not found")
		return domain.Run{}, false
	}
	return run, true
}
func (a *API) runs(w http.ResponseWriter, r *http.Request) {
	v, e := a.Store.Runs(r.Context(), r.URL.Query().Get("channel_id"), r.URL.Query().Get("state"))
	if e != nil {
		failErr(w, e)
		return
	}
	me := current(r).ID
	seen := map[string]bool{}
	kept := v[:0]
	for _, run := range v {
		ok, known := seen[run.ChannelID]
		if !known {
			ok = a.canSee(r.Context(), me, run.ChannelID)
			seen[run.ChannelID] = ok
		}
		if ok {
			kept = append(kept, run)
		}
	}
	respond(w, 200, kept)
}
func (a *API) run(w http.ResponseWriter, r *http.Request) {
	v, ok := a.visibleRun(w, r)
	if !ok {
		return
	}
	respond(w, 200, v)
}
func (a *API) output(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := a.visibleRun(w, r); !ok {
		return
	}
	after, _ := strconv.Atoi(r.URL.Query().Get("after"))
	v, e := a.Store.RunOutput(r.Context(), id, after)
	if e != nil {
		failErr(w, e)
		return
	}
	respond(w, 200, v)
}
func (a *API) runPrompt(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := a.visibleRun(w, r); !ok {
		return
	}
	prompt, err := a.Store.RunPrompt(r.Context(), id)
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, prompt)
}
func (a *API) diff(w http.ResponseWriter, r *http.Request) {
	v, ok := a.visibleRun(w, r)
	if !ok {
		return
	}
	if v.Worktree == "" {
		fail(w, 409, "conflict", "run has no worktree")
		return
	}
	if a.ReadDiff != nil {
		b, err := a.ReadDiff(v.ID)
		if err != nil {
			fail(w, 500, "internal", "diff unavailable")
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write(b)
		return
	}
	if v.BaseCommit == "" {
		fail(w, 409, "conflict", "run has no base commit")
		return
	}
	ch, e := a.Store.Channel(r.Context(), v.ChannelID)
	if e != nil {
		failErr(w, e)
		return
	}
	wm := worktree.Manager{}
	wt, e := wm.Open(r.Context(), ch.RepoPath, v.Worktree, "fz/"+v.ID, v.BaseCommit)
	if e != nil {
		fail(w, 500, "internal", "diff unavailable")
		return
	}
	_, diff, e := wm.Diff(r.Context(), wt)
	if e != nil {
		fail(w, 500, "internal", "diff unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(diff))
}
func (a *API) cancel(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "cancel runs") {
		return
	}
	run, ok := a.visibleRun(w, r)
	if !ok {
		return
	}
	if run.State.Terminal() || a.CancelRun == nil {
		fail(w, 409, "conflict", "run cannot be cancelled")
		return
	}
	if err := a.CancelRun(r.Context(), run.ID); err != nil {
		fail(w, 409, "conflict", "run cannot be cancelled")
		return
	}
	respond(w, 202, map[string]bool{"ok": true})
}
func (a *API) retry(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "retry runs") {
		return
	}
	run, ok := a.visibleRun(w, r)
	if !ok {
		return
	}
	if !run.State.Terminal() || a.RetryRun == nil {
		fail(w, 409, "conflict", "run cannot be retried")
		return
	}
	var req struct {
		LaneID string `json:"lane_id"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := a.RetryRun(r.Context(), run.ID, req.LaneID); err != nil {
		fail(w, 409, "conflict", "run cannot be retried on that lane")
		return
	}
	respond(w, 202, map[string]bool{"ok": true})
}
func (a *API) approvals(w http.ResponseWriter, r *http.Request) {
	v, e := a.Store.Approvals(r.Context(), r.URL.Query().Get("state"))
	if e != nil {
		failErr(w, e)
		return
	}
	respond(w, 200, v)
}

// applyError marks a failure of the change behind an approval, such as a
// merge that could not be done. It answers 409; any other unexpected error,
// a store failure for example, stays a 500.
type applyError struct{ error }

func (e applyError) Unwrap() error { return e.error }

// ResolveAs is the approval path shared by HTTP and trusted local bridges.
func (a *API) ResolveAs(ctx context.Context, human domain.Member, approvalID, option, commitMessage string) (domain.Approval, error) {
	return a.resolveAs(ctx, human, approvalID, option, commitMessage, false)
}

// ResolveBridgeAs enforces the Signal policy even if its process forwards a
// merge request. Signal transport and reply parsing arrive in a later step.
func (a *API) ResolveBridgeAs(ctx context.Context, human domain.Member, approvalID, option string) (domain.Approval, error) {
	return a.resolveAs(ctx, human, approvalID, option, "", true)
}

func (a *API) resolveAs(ctx context.Context, human domain.Member, approvalID, option, commitMessage string, bridge bool) (domain.Approval, error) {
	a.resolveMu.Lock()
	defer a.resolveMu.Unlock()
	if human.Kind != domain.MemberHuman {
		return domain.Approval{}, PostError{"forbidden", "human approval required"}
	}
	if bridge && option != "keep" && option != "discard" {
		return domain.Approval{}, PostError{"forbidden", "Signal may only keep or discard"}
	}
	v, err := a.Store.Approval(ctx, approvalID)
	if err != nil {
		return domain.Approval{}, err
	}
	if v.State != domain.ApprovalPending {
		return domain.Approval{}, store.ErrConflict
	}
	valid := false
	for _, o := range v.Options {
		if o.Key == option {
			valid = true
		}
	}
	if !valid {
		return domain.Approval{}, store.ErrInvalidOption
	}
	note := ""
	// A crash between the change and the resolution leaves the run done with
	// its outcome while the approval is still pending. Finish the approval with
	// what was really applied, even when this request asks for another option,
	// so a late Discard cannot contradict a merge that already happened.
	applied := false
	if v.RunID != "" {
		if run, rerr := a.Store.Run(ctx, v.RunID); rerr == nil && run.State == domain.RunDone && run.ApprovalOutcome != "" {
			for _, o := range v.Options {
				if o.Key == run.ApprovalOption {
					option, note, applied = run.ApprovalOption, run.ApprovalOutcome, true
				}
			}
		}
	}
	if !applied && a.ResolveApproval != nil && v.RunID != "" {
		note, err = a.ResolveApproval(ctx, v, option, commitMessage)
		if err != nil {
			var userErr domain.UserError
			if errors.As(err, &userErr) {
				return domain.Approval{}, err
			}
			return domain.Approval{}, applyError{err}
		}
	}
	v, err = a.Store.ResolveApproval(ctx, v.ID, option, note, human.ID)
	if err != nil {
		return domain.Approval{}, err
	}
	if a.OnApproval != nil {
		a.OnApproval(ctx, v)
	}
	return v, nil
}

func (a *API) resolve(w http.ResponseWriter, r *http.Request) {
	if current(r).Kind != domain.MemberHuman {
		fail(w, 403, "forbidden", "human approval required")
		return
	}
	var req struct {
		Option        string `json:"option"`
		Note          string `json:"note"`
		CommitMessage string `json:"commit_message"`
	}
	if !decode(w, r, &req) {
		return
	}
	v, err := a.ResolveAs(r.Context(), current(r), r.PathValue("id"), req.Option, req.CommitMessage)
	if err != nil {
		var postErr PostError
		var userErr domain.UserError
		switch {
		case errors.As(err, &postErr):
			fail(w, 403, postErr.Code, postErr.Message)
		case errors.Is(err, store.ErrNotFound):
			fail(w, 404, "not_found", "approval not found")
		case errors.Is(err, store.ErrConflict):
			fail(w, 409, "conflict", "approval is not pending")
		case errors.Is(err, store.ErrInvalidOption):
			fail(w, 400, "bad_request", "invalid option")
		case errors.As(err, &userErr):
			fail(w, 409, "conflict", userErr.Message)
		default:
			slog.Error("resolve approval", "approval", r.PathValue("id"), "err", err)
			var applyErr applyError
			if errors.As(err, &applyErr) {
				fail(w, 409, "conflict", "approval could not be applied; see the daemon log")
			} else {
				failErr(w, err)
			}
		}
		return
	}
	respond(w, 200, v)
}

func (a *API) listLanes(ctx context.Context) ([]domain.Lane, error) {
	all, err := a.Store.Lanes(ctx)
	if err != nil || a.HideLane == nil {
		return all, err
	}
	kept := all[:0:0]
	for _, l := range all {
		if !a.HideLane(l) {
			kept = append(kept, l)
		}
	}
	return kept, nil
}
func (a *API) lanes(w http.ResponseWriter, r *http.Request) {
	v, e := a.listLanes(r.Context())
	if e != nil {
		failErr(w, e)
		return
	}
	respond(w, 200, v)
}
func (a *API) getChannelSummary(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("channel_id")
	if _, err := a.Store.Channel(r.Context(), id); err != nil {
		failErr(w, err)
		return
	}
	summary, err := a.Store.ChannelSummary(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		respond(w, 200, store.ChannelSummary{ChannelID: id})
		return
	}
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, summary)
}
func (a *API) regenerateChannelSummary(w http.ResponseWriter, r *http.Request) {
	if current(r).Kind != domain.MemberHuman {
		fail(w, 403, "forbidden", "only a human can regenerate a summary")
		return
	}
	if a.RegenerateSummary == nil {
		fail(w, 409, "conflict", "summary generation unavailable")
		return
	}
	summary, err := a.RegenerateSummary(r.Context(), r.PathValue("channel_id"))
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, summary)
}
func (a *API) laneHistory(w http.ResponseWriter, r *http.Request) {
	path := r.PathValue("id")
	if !strings.HasSuffix(path, "/history") {
		fail(w, 404, "not_found", "endpoint not found")
		return
	}
	id := strings.TrimSuffix(path, "/history")
	if _, err := a.Store.Lane(r.Context(), id); err != nil {
		failErr(w, err)
		return
	}
	window := r.URL.Query().Get("window")
	if window != "" && window != "5h" && window != "day" && window != "week" && window != "month" {
		fail(w, 400, "bad_request", "invalid window")
		return
	}
	since := time.Now().UTC().Add(-7 * 24 * time.Hour)
	if raw := r.URL.Query().Get("since"); raw != "" {
		var err error
		since, err = time.Parse(time.RFC3339, raw)
		if err != nil {
			fail(w, 400, "bad_request", "since must be RFC3339")
			return
		}
	}
	if since.Before(time.Now().Add(-31 * 24 * time.Hour)) {
		fail(w, 400, "bad_request", "history is limited to 31 days")
		return
	}
	readings, err := a.Store.LaneHistory(r.Context(), id, window, since)
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, readings)
}
func laneID(r *http.Request) string { return strings.TrimSuffix(r.PathValue("id"), "/probe") }
func (a *API) patchLane(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "change lanes") {
		return
	}
	if strings.HasSuffix(r.PathValue("id"), "/probe") {
		fail(w, 404, "not_found", "endpoint not found")
		return
	}
	v, e := a.Store.Lane(r.Context(), r.PathValue("id"))
	if e != nil {
		failErr(w, e)
		return
	}
	var req struct {
		Capacity       *int               `json:"capacity"`
		HealthOverride *domain.LaneHealth `json:"health_override"`
		ManualWindow   *domain.LaneWindow `json:"manual_window"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Capacity != nil {
		if *req.Capacity < 1 {
			fail(w, 400, "bad_request", "capacity must be positive")
			return
		}
		v.Capacity = *req.Capacity
	}
	if req.HealthOverride != nil {
		v.Health = *req.HealthOverride
		v.HealthReason = "manual override"
	}
	if req.ManualWindow != nil {
		now := time.Now().UTC()
		if req.ManualWindow.MeasuredAt == nil {
			req.ManualWindow.MeasuredAt = &now
		}
		req.ManualWindow.Source = domain.SourceManual
		v.Windows = append(v.Windows, *req.ManualWindow)
	}
	if _, ok := a.append(w, r, events.Human(current(r).ID), events.LaneUpdated, "", "", v); ok {
		if req.ManualWindow != nil {
			_, err := a.Store.Append(r.Context(), events.Draft{Type: events.LaneUsageRead, Actor: events.Human(current(r).ID), Payload: store.LaneUsageReading{LaneID: v.ID, Window: *req.ManualWindow, ReadAt: time.Now().UTC()}})
			if err != nil {
				failErr(w, err)
				return
			}
		}
		respond(w, 200, v)
	}
}
func (a *API) probe(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "probe lanes") {
		return
	}
	if !strings.HasSuffix(r.PathValue("id"), "/probe") {
		fail(w, 404, "not_found", "endpoint not found")
		return
	}
	if _, err := a.Store.Lane(r.Context(), laneID(r)); err != nil {
		failErr(w, err)
		return
	}
	if a.ProbeLane == nil {
		fail(w, 409, "conflict", "lane probe is unavailable")
		return
	}
	lane, err := a.ProbeLane(r.Context(), laneID(r))
	if err != nil {
		var userErr domain.UserError
		if errors.As(err, &userErr) {
			fail(w, 400, "bad_request", userErr.Message)
			return
		}
		failErr(w, err)
		return
	}
	respond(w, 200, lane)
}
func (a *API) watchSession(ctx context.Context, cancel context.CancelFunc, sessionID string) {
	every := a.SessionRecheck
	if every <= 0 {
		every = 10 * time.Second
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			ok, err := a.Store.SessionActive(ctx, sessionID, a.now())
			if err == nil && !ok {
				cancel()
				return
			}
		}
	}
}

// streamHead tells a client where the event log ends, so it can subscribe
// from there instead of replaying everything.
func (a *API) streamHead(w http.ResponseWriter, r *http.Request) {
	seq, err := a.Store.LastSeq(r.Context())
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, map[string]int64{"seq": seq})
}

// Event stream liveness: a ping every streamPingEvery, and a client that sends
// nothing (not even a pong) for streamReadWait is dropped. Atomic so tests
// can shorten them while old handlers are still winding down.
var streamPingEvery, streamReadWait atomic.Int64

func init() {
	streamPingEvery.Store(int64(30 * time.Second))
	streamReadWait.Store(int64(75 * time.Second))
}

func (a *API) stream(w http.ResponseWriter, r *http.Request) {
	if a.isLANRequest(r) {
		if !validLANOrigin(r) {
			fail(w, 403, "forbidden", "invalid origin")
			return
		}
	} else {
		origin := r.Header.Get("Origin")
		if origin != "" {
			u := strings.TrimPrefix(strings.TrimPrefix(origin, "http://"), "https://")
			host := strings.Split(u, "/")[0]
			// Exact origin only. Cookies ignore ports, so a page on another
			// loopback port must not be able to read the stream.
			if host != r.Host && !a.proxyHost(host) {
				fail(w, 403, "forbidden", "invalid origin")
				return
			}
		}
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	streamCtx, cancel := context.WithCancel(r.Context())
	defer cancel()
	sessID := currentSessionID(r)
	handle := &streamHandle{conn: conn, cancel: cancel}
	a.registerStream(sessID, handle)
	defer a.unregisterStream(sessID, handle)
	if sessID != "" {
		devs, err := a.Store.Devices(streamCtx, a.Now())
		if err != nil {
			return
		}
		found := false
		for _, d := range devs {
			if d.ID == sessID {
				found = true
				break
			}
		}
		if !found {
			return
		}
	}
	if err = conn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return
	}
	_, b, err := conn.ReadMessage()
	if err != nil {
		return
	}
	var sub struct {
		Op       string `json:"op"`
		AfterSeq int64  `json:"after_seq"`
	}
	if json.Unmarshal(b, &sub) != nil || sub.Op != "subscribe" || sub.AfterSeq < 0 {
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "invalid subscribe"), time.Now().Add(time.Second))
		return
	}
	ch, err := a.Store.Subscribe(streamCtx, sub.AfterSeq)
	if err != nil {
		return
	}
	if sessID != "" {
		// A password change or a deleted row from another process never reaches
		// closeDeviceStreams, so re-read the session row on a timer.
		go a.watchSession(streamCtx, cancel, sessID)
	}
	// Nothing else reads the socket, so without this loop a client that went
	// away is only noticed on the next write. The reader ends the stream on any
	// error or close; pings keep the read deadline moving while the client lives.
	readWait, pingEvery := time.Duration(streamReadWait.Load()), time.Duration(streamPingEvery.Load())
	_ = conn.SetReadDeadline(time.Now().Add(readWait))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(readWait)) })
	go func() {
		defer cancel()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
			_ = conn.SetReadDeadline(time.Now().Add(readWait))
		}
	}()
	go func() {
		t := time.NewTicker(pingEvery)
		defer t.Stop()
		for {
			select {
			case <-streamCtx.Done():
				return
			case <-t.C:
				if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)) != nil {
					cancel()
					return
				}
			}
		}
	}()
	me := current(r).ID
	for evt := range ch {
		// Events of a channel the caller cannot read never reach this stream.
		if evt.ChannelID != "" && !a.canSee(streamCtx, me, evt.ChannelID) {
			continue
		}
		// A stored prompt can be 120 KB and no client renders it from the
		// stream; the Context tab fetches it when opened.
		if evt.Type == events.RunPrompt {
			continue
		}
		b, _ := json.Marshal(evt)
		if err = conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
			return
		}
		if err = conn.WriteMessage(websocket.TextMessage, b); err != nil {
			return
		}
	}
}

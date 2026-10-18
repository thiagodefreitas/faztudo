package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/http"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/gorilla/websocket"
	"github.com/thiagodefreitas/faztudo/internal/auth"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
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
	AllowedHosts    []string
	Trigger         RunTrigger
	ResolveApproval func(ctx context.Context, approval domain.Approval, option, commitMessage string) (string, error)
	ReadDiff        func(string) ([]byte, error)
	CancelRun       func(context.Context, string) error
	RetryRun        func(context.Context, string, string) error
	ProbeLane       func(context.Context, string) (domain.Lane, error)
	// HideLane drops lanes that must not be listed, such as a detected-only
	// default once lanes.toml configures the CLI.
	HideLane        func(domain.Lane) bool
	MCP             http.Handler
	LANEnabled      bool
	LANListen       string
	CACertPEM       []byte
	CAFingerprint   string
	CAHTTPURL       string
	LANURLs         []string
	Limiter         *auth.LoginRateLimiter
	Now             func() time.Time
	actorForRequest func(*http.Request) (domain.Member, error)
	resolveMu       sync.Mutex
	streamsMu       sync.Mutex
	streams         map[string]map[*streamHandle]struct{}
}
type actorKey struct{}

func New(s *store.Store, humanID, version string) *API {
	return &API{
		Store:   s,
		HumanID: humanID,
		Version: version,
		Trigger: noopTrigger{},
		Limiter: auth.NewLoginRateLimiter(),
		Now:     time.Now,
		streams: map[string]map[*streamHandle]struct{}{},
	}
}
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	mux := http.NewServeMux()
	a.routes(mux)
	mux.ServeHTTP(w, r)
}
func (a *API) routes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"ok": true, "version": a.Version, "api": "v1"})
	})
	m.HandleFunc("GET /ca.crt", a.serveCACert)
	m.HandleFunc("/mcp", a.serveMCP)
	m.HandleFunc("/mcp/", a.serveMCP)
	m.HandleFunc("POST /api/v1/auth/login", a.publicPost(a.login))
	m.HandleFunc("POST /api/v1/auth/pair", a.publicPost(a.pair))
	m.HandleFunc("POST /api/v1/auth/pairings/redeem", a.publicPost(a.pair))
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
	m.HandleFunc("GET /api/v1/members", a.members)
	m.HandleFunc("GET /api/v1/channels", a.channels)
	m.HandleFunc("POST /api/v1/channels", a.createChannel)
	m.HandleFunc("PATCH /api/v1/channels/{id}", a.patchChannel)
	m.HandleFunc("GET /api/v1/channels/{id}/messages", a.messages)
	m.HandleFunc("POST /api/v1/channels/{id}/messages", a.postMessage)
	m.HandleFunc("POST /api/v1/channels/{id}/read", a.read)
	m.HandleFunc("GET /api/v1/messages/{id}/thread", a.thread)
	m.HandleFunc("GET /api/v1/runs", a.runs)
	m.HandleFunc("GET /api/v1/runs/{id}", a.run)
	m.HandleFunc("GET /api/v1/runs/{id}/output", a.output)
	m.HandleFunc("GET /api/v1/runs/{id}/diff", a.diff)
	m.HandleFunc("POST /api/v1/runs/{id}/cancel", a.cancel)
	m.HandleFunc("POST /api/v1/runs/{id}/retry", a.retry)
	m.HandleFunc("GET /api/v1/approvals", a.approvals)
	m.HandleFunc("POST /api/v1/approvals/{id}/resolve", a.resolve)
	m.HandleFunc("GET /api/v1/lanes", a.lanes)
	m.HandleFunc("PATCH /api/v1/lanes/{id...}", a.patchLane)
	m.HandleFunc("POST /api/v1/lanes/{id...}", a.probe)
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

func loopbackHost(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	host = strings.Trim(host, "[]")
	return host == "localhost" || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
}
func current(r *http.Request) domain.Member { return r.Context().Value(actorKey{}).(domain.Member) }
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
		fail(w, 500, "internal", "internal error")
	}
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		fail(w, 400, "bad_request", "application/json required")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return false
	}
	return true
}
func (a *API) append(w http.ResponseWriter, r *http.Request, typ events.Type, channel, key string, v any) (events.Event, bool) {
	e, err := a.Store.Append(r.Context(), events.Draft{Type: typ, Actor: events.Human(current(r).ID), ChannelID: channel, IdempotencyKey: key, Payload: v})
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
	for i := range v {
		v[i].Unread, _ = a.Store.Unread(r.Context(), v[i].ID, current(r).ID)
	}
	respond(w, 200, v)
}

var channelName = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func validChannel(c domain.Channel) bool {
	return channelName.MatchString(c.Name) && (c.Kind == domain.ChannelTeam || c.Kind == domain.ChannelDepartment || c.Kind == domain.ChannelProject || c.Kind == domain.ChannelAgent || c.Kind == domain.ChannelDirect) && (c.Visibility == domain.VisibilityPublic || c.Visibility == domain.VisibilityPrivate || c.Visibility == domain.VisibilityDirect)
}
func (a *API) createChannel(w http.ResponseWriter, r *http.Request) {
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
	if _, ok := a.append(w, r, events.ChannelCreated, c.ID, "", c); ok {
		respond(w, 201, c)
	}
}
func (a *API) patchChannel(w http.ResponseWriter, r *http.Request) {
	c, e := a.Store.Channel(r.Context(), r.PathValue("id"))
	if e != nil {
		failErr(w, e)
		return
	}
	var v struct {
		Name         *string   `json:"name"`
		Topic        *string   `json:"topic"`
		RepoPath     *string   `json:"repo_path"`
		TestCommand  *string   `json:"test_command"`
		DefaultAgent *string   `json:"default_agent_id"`
		MemberIDs    *[]string `json:"member_ids"`
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
	if err := validateRepo(r.Context(), c.RepoPath); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	if _, ok := a.append(w, r, events.ChannelUpdated, c.ID, "", c); ok {
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
	if _, e := a.Store.Channel(r.Context(), id); e != nil {
		failErr(w, e)
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
	if _, e := a.Store.Message(r.Context(), id); e != nil {
		failErr(w, e)
		return
	}
	v, e := a.Store.Thread(r.Context(), id)
	if e != nil {
		failErr(w, e)
		return
	}
	respond(w, 200, v)
}
func mentioned(body string, members []domain.Member) ([]string, []domain.Member) {
	byHandle := map[string]domain.Member{}
	for _, m := range members {
		byHandle[strings.ToLower(m.Handle)] = m
	}
	ids := []string{}
	agents := []domain.Member{}
	seen := map[string]bool{}
	for i := 0; i < len(body); i++ {
		if body[i] != '@' || (i > 0 && (unicode.IsLetter(rune(body[i-1])) || unicode.IsDigit(rune(body[i-1])))) {
			continue
		}
		j := i + 1
		for j < len(body) {
			c := body[j]
			if c == '-' || c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
				j++
			} else {
				break
			}
		}
		if m, ok := byHandle[strings.ToLower(body[i+1:j])]; ok && !seen[m.ID] {
			seen[m.ID] = true
			ids = append(ids, m.ID)
			if m.Kind == domain.MemberAgent {
				agents = append(agents, m)
			}
		}
		i = j - 1
	}
	return ids, agents
}
func (a *API) postMessage(w http.ResponseWriter, r *http.Request) {
	c, e := a.Store.Channel(r.Context(), r.PathValue("id"))
	if e != nil {
		failErr(w, e)
		return
	}
	var v struct {
		Body           string `json:"body"`
		ThreadID       string `json:"thread_id"`
		IdempotencyKey string `json:"idempotency_key"`
	}
	if !decode(w, r, &v) {
		return
	}
	if strings.TrimSpace(v.Body) == "" {
		fail(w, 400, "bad_request", "body required")
		return
	}
	if v.ThreadID != "" {
		root, e := a.Store.Message(r.Context(), v.ThreadID)
		if e != nil || root.ChannelID != c.ID {
			fail(w, 400, "bad_request", "invalid thread_id")
			return
		}
		if root.ThreadID != "" {
			v.ThreadID = root.ThreadID // replies attach to the root, one level deep
		}
	}
	members, e := a.Store.Members(r.Context())
	if e != nil {
		failErr(w, e)
		return
	}
	ids, agents := mentioned(v.Body, members)
	if len(agents) == 0 {
		agents = directAgent(c, members)
	}
	if len(agents) == 0 && len(ids) == 0 && !strings.HasPrefix(strings.TrimSpace(v.Body), "/") {
		if m, ok := channelAgent(c, c.DefaultAgentID, members); ok {
			agents = []domain.Member{m}
		}
	}
	m := domain.Message{ID: store.NewID(), ChannelID: c.ID, ThreadID: v.ThreadID, AuthorID: current(r).ID, Body: v.Body, Mentions: ids, CreatedAt: time.Now().UTC()}
	newMessageID := m.ID
	evt, ok := a.append(w, r, events.MessagePosted, c.ID, v.IdempotencyKey, m)
	if !ok {
		return
	}
	if evt.ChannelID != c.ID {
		fail(w, 409, "conflict", "idempotency key belongs to another channel")
		return
	}
	_ = json.Unmarshal(evt.Payload, &m)
	respond(w, 201, m)
	if newMessageID == m.ID && len(agents) > 0 {
		a.Trigger.OnMessage(r.Context(), m, agents)
	}
	if newMessageID == m.ID && isCommand(m.Body, "/status") {
		if text, err := a.statusText(r.Context(), c.ID); err == nil {
			_, _ = a.Store.Append(r.Context(), events.Draft{Type: events.Notice, Actor: events.System, ChannelID: c.ID, Payload: events.NoticePayload{Level: "info", Text: text}})
		}
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
func (a *API) runs(w http.ResponseWriter, r *http.Request) {
	v, e := a.Store.Runs(r.Context(), r.URL.Query().Get("channel_id"), r.URL.Query().Get("state"))
	if e != nil {
		failErr(w, e)
		return
	}
	respond(w, 200, v)
}
func (a *API) run(w http.ResponseWriter, r *http.Request) {
	v, e := a.Store.Run(r.Context(), r.PathValue("id"))
	if e != nil {
		failErr(w, e)
		return
	}
	respond(w, 200, v)
}
func (a *API) output(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, e := a.Store.Run(r.Context(), id); e != nil {
		failErr(w, e)
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
func (a *API) diff(w http.ResponseWriter, r *http.Request) {
	v, e := a.Store.Run(r.Context(), r.PathValue("id"))
	if e != nil {
		failErr(w, e)
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
	_, diff, e := (worktree.Manager{}).Diff(r.Context(), worktree.Worktree{Path: v.Worktree, BaseCommit: v.BaseCommit})
	if e != nil {
		fail(w, 500, "internal", "diff unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(diff))
}
func (a *API) cancel(w http.ResponseWriter, r *http.Request) {
	run, err := a.Store.Run(r.Context(), r.PathValue("id"))
	if err != nil {
		failErr(w, err)
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
	run, err := a.Store.Run(r.Context(), r.PathValue("id"))
	if err != nil {
		failErr(w, err)
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
func (a *API) resolve(w http.ResponseWriter, r *http.Request) {
	a.resolveMu.Lock()
	defer a.resolveMu.Unlock()
	if current(r).Kind != domain.MemberHuman {
		fail(w, 403, "forbidden", "human approval required")
		return
	}
	v, e := a.Store.Approval(r.Context(), r.PathValue("id"))
	if e != nil {
		failErr(w, e)
		return
	}
	if v.State != domain.ApprovalPending {
		fail(w, 409, "conflict", "approval is not pending")
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
	valid := false
	for _, o := range v.Options {
		if o.Key == req.Option {
			valid = true
		}
	}
	if !valid {
		fail(w, 400, "bad_request", "invalid option")
		return
	}
	if a.ResolveApproval != nil && v.RunID != "" {
		outcome, err := a.ResolveApproval(r.Context(), v, req.Option, req.CommitMessage)
		if err != nil {
			fail(w, 409, "conflict", err.Error())
			return
		}
		req.Note = outcome
	}
	v, e = a.Store.ResolveApproval(r.Context(), v.ID, req.Option, req.Note, current(r).ID)
	if e != nil {
		if errors.Is(e, store.ErrConflict) {
			fail(w, 409, "conflict", "approval is not pending")
		} else if errors.Is(e, store.ErrInvalidOption) {
			fail(w, 400, "bad_request", "invalid option")
		} else {
			failErr(w, e)
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
func laneID(r *http.Request) string { return strings.TrimSuffix(r.PathValue("id"), "/probe") }
func (a *API) patchLane(w http.ResponseWriter, r *http.Request) {
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
		v.Windows = append(v.Windows, *req.ManualWindow)
	}
	if _, ok := a.append(w, r, events.LaneUpdated, "", "", v); ok {
		respond(w, 200, v)
	}
}
func (a *API) probe(w http.ResponseWriter, r *http.Request) {
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
		failErr(w, err)
		return
	}
	respond(w, 200, lane)
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
			if host != r.Host && !a.hostAllowed(host) {
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
	for evt := range ch {
		b, _ := json.Marshal(evt)
		if err = conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
			return
		}
		if err = conn.WriteMessage(websocket.TextMessage, b); err != nil {
			return
		}
	}
}

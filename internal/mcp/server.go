// Package mcp is the faztudo MCP server mounted at /mcp.
//
// Each run gets a random token kept in memory. The token is bound to that
// run, its agent and its channel. Tools act as that agent in that channel.
// Nothing in this package resolves an approval.
package mcp

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/org"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

// Trigger starts work when an agent posts a message that mentions other
// agents. ask_human does not use it.
type Trigger interface {
	OnMessage(context.Context, domain.Message, []domain.Member)
}

// Handler serves streamable HTTP MCP. It accepts loopback clients only.
type Handler struct {
	PostAs       func(context.Context, events.Actor, domain.Member, api.PostInput) (domain.Message, bool, error)
	store        *store.Store
	tokens       *tokens
	trigger      Trigger
	http         http.Handler
	ledger       *org.Ledger
	budgetMu     sync.Mutex
	budgetLoaded bool
	// FilesDir is where uploads live. read_context returns small text
	// attachments of the run's trigger message from here.
	FilesDir string
	// Policy is set by the app before the first request.
	Policy Policy
}

// Policy is what the delegate tool takes from the configuration.
type Policy struct {
	// ChiefOfStaff is the handle of the Chief of Staff, empty when there is none.
	ChiefOfStaff string
	// Limits caps the runs one request may start by delegation. A zero value
	// means the defaults (6 runs, 2 of them premium).
	Limits org.Limits
}

type grantKey struct{}

func New(s *store.Store, trigger Trigger) *Handler {
	h := &Handler{store: s, tokens: newTokens(), trigger: trigger, ledger: org.NewLedger()}
	// Stateless: every POST is authorized by the bearer token on that
	// request. A session id cannot be reused with a different run's token.
	h.http = sdkmcp.NewStreamableHTTPHandler(h.serverFor, &sdkmcp.StreamableHTTPOptions{
		Stateless:    true,
		JSONResponse: true,
		Logger:       slog.New(slog.DiscardHandler),
	})
	return h
}

func (h *Handler) Issue(runID, agentID, channelID string) (string, error) {
	return h.tokens.issue(runID, agentID, channelID)
}

func (h *Handler) RevokeRun(runID string) { h.tokens.revokeRun(runID) }

// LiveRuns reports how many run tokens are currently accepted.
func (h *Handler) LiveRuns() int { return h.tokens.len() }

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !loopbackRequest(r) {
		writeStatus(w, http.StatusForbidden, "local requests only")
		return
	}
	grant, ok := h.tokens.lookup(bearerToken(r))
	if !ok {
		writeStatus(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	h.http.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), grantKey{}, grant)))
}

func (h *Handler) serverFor(r *http.Request) *sdkmcp.Server {
	grant, ok := r.Context().Value(grantKey{}).(Grant)
	if !ok {
		return nil
	}
	server := sdkmcp.NewServer(&sdkmcp.Implementation{Name: "faztudo", Version: "0"}, &sdkmcp.ServerOptions{
		Instructions: "Tools act only in this run's channel, as this run's agent. request_approval creates a pending request. delegate hands work to another agent and works only for the Chief of Staff and department leads. No tool resolves an approval.",
		Logger:       slog.New(slog.DiscardHandler),
	})
	h.addTools(server, grant)
	return server
}

func bearerToken(r *http.Request) string {
	value := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(value) < len(prefix) || !strings.EqualFold(value[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(value[len(prefix):])
}

func loopbackRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return false
	}
	if !loopbackHost(r.Host) {
		return false
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		origin := r.Header.Get("Origin")
		if origin != "" && origin != "http://"+r.Host && origin != "https://"+r.Host {
			return false
		}
	}
	return true
}

func loopbackHost(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	host = strings.Trim(host, "[]")
	return host == "localhost" || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
}

func writeStatus(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

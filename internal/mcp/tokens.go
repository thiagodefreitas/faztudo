package mcp

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"sync"
)

// Grant is the run a token may act as. It is not read from the request body.
type Grant struct {
	RunID     string
	AgentID   string
	ChannelID string
}

type tokens struct {
	mu      sync.Mutex
	byToken map[string]Grant
	byRun   map[string]string
}

func newTokens() *tokens {
	return &tokens{byToken: map[string]Grant{}, byRun: map[string]string{}}
}

func (t *tokens) issue(runID, agentID, channelID string) (string, error) {
	if runID == "" || agentID == "" || channelID == "" {
		return "", errors.New("run, agent and channel required")
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)
	t.mu.Lock()
	defer t.mu.Unlock()
	if old, ok := t.byRun[runID]; ok {
		delete(t.byToken, old)
	}
	t.byToken[token] = Grant{RunID: runID, AgentID: agentID, ChannelID: channelID}
	t.byRun[runID] = token
	return token, nil
}

func (t *tokens) revokeRun(runID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if token, ok := t.byRun[runID]; ok {
		delete(t.byToken, token)
		delete(t.byRun, runID)
	}
}

// lookup compares the presented token with every live token. A miss does not
// reveal which one was wrong.
func (t *tokens) lookup(token string) (Grant, bool) {
	if token == "" {
		return Grant{}, false
	}
	presented := []byte(token)
	t.mu.Lock()
	defer t.mu.Unlock()
	var found Grant
	ok := false
	for candidate, grant := range t.byToken {
		if subtle.ConstantTimeCompare([]byte(candidate), presented) == 1 {
			found = grant
			ok = true
		}
	}
	return found, ok
}

func (t *tokens) len() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.byRun)
}

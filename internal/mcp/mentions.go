package mcp

import (
	"strings"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// mentioned parses @handles the same way the HTTP API does. The handle is
// taken from the member list; a caller cannot name an author.
func mentioned(body string, members []domain.Member) ([]string, []domain.Member) {
	byHandle := map[string]domain.Member{}
	for _, m := range members {
		byHandle[strings.ToLower(m.Handle)] = m
	}
	ids := []string{}
	agents := []domain.Member{}
	seen := map[string]bool{}
	for _, h := range domain.MentionHandles(body) {
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

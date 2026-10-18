package mcp

import (
	"strings"
	"unicode"

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

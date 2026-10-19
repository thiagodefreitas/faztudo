package domain

import (
	"strings"
	"unicode"
)

// MentionHandles lists the lowercased @handles in a message body, in order.
// A mention inside inline code, a fenced code block or a quoted line (one
// starting with ">") is only text and is skipped. An @ inside a word, such as
// an email address, is not a mention.
func MentionHandles(body string) []string {
	var out []string
	fence := ""
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimLeft(line, " \t")
		if fence != "" {
			if strings.HasPrefix(trimmed, fence) && strings.Trim(trimmed, fence[:1]+" \t\r") == "" {
				fence = ""
			}
			continue
		}
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			c := trimmed[:1]
			n := len(trimmed) - len(strings.TrimLeft(trimmed, c))
			fence = strings.Repeat(c, n)
			continue
		}
		if strings.HasPrefix(trimmed, ">") {
			continue
		}
		out = append(out, lineMentions(stripInlineCode(line))...)
	}
	return out
}

// stripInlineCode blanks out backtick spans. A run of n backticks opens a
// span that ends at the next run of exactly n; an unclosed run is plain text.
func stripInlineCode(line string) string {
	if !strings.Contains(line, "`") {
		return line
	}
	b := []byte(line)
	for i := 0; i < len(b); {
		if b[i] != '`' {
			i++
			continue
		}
		start := i
		for i < len(b) && b[i] == '`' {
			i++
		}
		n := i - start
		end := -1
		for j := i; j < len(b); {
			if b[j] != '`' {
				j++
				continue
			}
			k := j
			for j < len(b) && b[j] == '`' {
				j++
			}
			if j-k == n {
				end = j
				break
			}
		}
		if end < 0 {
			continue
		}
		for k := start; k < end; k++ {
			b[k] = ' '
		}
		i = end
	}
	return string(b)
}

func lineMentions(body string) []string {
	var out []string
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
		out = append(out, strings.ToLower(body[i+1:j]))
		i = j - 1
	}
	return out
}

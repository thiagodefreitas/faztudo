package domain

import (
	"reflect"
	"testing"
)

func TestMentionHandles(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []string
	}{
		{"plain", "hi @Coder please", []string{"coder"}},
		{"two", "@a and @b", []string{"a", "b"}},
		{"email", "mail me at joe@example.com", nil},
		{"inside word", "foo@coder", nil},
		{"inline code", "use `@coder` here", nil},
		{"double backtick", "use ``a ` @coder`` here", nil},
		{"after closing backtick", "`x`@coder go", []string{"coder"}},
		{"mention then code", "@coder run `@writer`", []string{"coder"}},
		{"unclosed backtick", "a ` @coder", []string{"coder"}},
		{"fence no lang", "```\n@coder\n```\n@writer", []string{"writer"}},
		{"fence with lang", "```go\n@coder\n```", nil},
		{"tilde fence", "~~~\n@coder\n~~~\n@writer", []string{"writer"}},
		{"unclosed fence", "```\n@coder", nil},
		{"long fence", "````\n```\n@coder\n````\n@writer", []string{"writer"}},
		{"quote", "> @coder said\n@writer", []string{"writer"}},
		{"nested quote", "> > @coder\n>> @coder", nil},
		{"indented quote", "  > @coder", nil},
		{"mention before fence", "@coder\n```\n@writer\n```", []string{"coder"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := MentionHandles(c.body); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %v want %v", got, c.want)
			}
		})
	}
}

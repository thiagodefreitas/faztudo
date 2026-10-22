package app

import (
	"context"
	"strings"
)

const lessonsHeader = "Lessons the Director taught you. Follow them unless the request says otherwise:\n"

func (a *App) lessonsPrompt(ctx context.Context, persona, channelID string) (string, error) {
	v, err := a.Store.Lessons(ctx, persona)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	count := 0
	for _, lesson := range v {
		if lesson.ChannelID != "" && lesson.ChannelID != channelID {
			continue
		}
		oneLine := strings.Map(func(r rune) rune {
			if r == '\n' || r == '\r' || r == '\u2028' || r == '\u2029' {
				return ' '
			}
			return r
		}, lesson.Text)
		line := "- " + oneLine + "\n"
		if len(lessonsHeader)+b.Len()+len(line)+1 > 4096 || count == 20 {
			break
		}
		b.WriteString(line)
		count++
	}
	if b.Len() == 0 {
		return "", nil
	}
	return lessonsHeader + b.String() + "\n", nil
}

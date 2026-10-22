package app

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestLessonsPromptFilteringCapsAndSpan(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, d := range []events.Draft{
		{Type: events.ChannelCreated, ChannelID: "ch", Payload: domain.Channel{ID: "ch", Name: "work"}},
		{Type: events.MemberUpdated, Payload: domain.Member{ID: "agent", Handle: "coder", Kind: domain.MemberAgent}},
	} {
		d.Actor = events.System
		if _, err := s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	a := App{Store: s, Config: config.Defaults()}
	m := domain.Message{ID: "request", ChannelID: "ch", Body: "do work"}
	prompt, sections, err := a.promptPartsForRun(ctx, m, "", domain.RunRead, "")
	if err != nil || strings.Contains(prompt, lessonsHeader) {
		t.Fatalf("empty persona: %v %q", err, prompt)
	}
	for _, section := range sections {
		if section.Name == "lessons" {
			t.Fatal("empty persona has lessons section")
		}
	}
	now := time.Now().UTC()
	add := func(id, persona, channel, value string, offset time.Duration) {
		t.Helper()
		v := domain.Lesson{ID: id, Persona: persona, ChannelID: channel, Text: value, CreatedBy: "human", CreatedAt: now.Add(offset), UpdatedAt: now.Add(offset)}
		if _, err := s.Append(ctx, events.Draft{Type: events.LessonAdded, Actor: events.Human("human"), ChannelID: channel, Payload: v}); err != nil {
			t.Fatal(err)
		}
	}
	add("other", "reviewer", "", "wrong persona", time.Second)
	add("channel", "coder", "elsewhere", "wrong channel", time.Second)
	for i := 0; i < 25; i++ {
		add(fmt.Sprintf("lesson-%02d", i), "coder", "", fmt.Sprintf("rule %02d", i), time.Duration(i)*time.Second)
	}
	add("newest", "coder", "ch", "newest  rule\nsecond line", time.Hour)
	prompt, sections, err = a.promptPartsForRun(ctx, m, "", domain.RunRead, "coder")
	if err != nil {
		t.Fatal(err)
	}
	var section *events.PromptSection
	for i := range sections {
		if sections[i].Name == "lessons" {
			section = &sections[i]
		}
	}
	if section == nil || len(section.Spans) != 1 {
		t.Fatalf("no lessons section: %+v", sections)
	}
	span := section.Spans[0]
	part := prompt[span.Offset : span.Offset+span.Bytes]
	if !strings.HasPrefix(part, lessonsHeader+"- newest  rule second line\n") || strings.Count(part, "- ") != 20 || strings.Contains(part, "wrong") || strings.Contains(part, "rule 00") {
		t.Fatalf("filtered lessons: %q", part)
	}
	if section.Bytes != len(part) || section.Bytes > 4096 || strings.Index(prompt, part) > strings.Index(prompt, "Recent channel messages") {
		t.Fatalf("span or order: %+v", section)
	}
	m.CollectForRunID = "parent"
	prompt, _, err = a.promptPartsForRun(ctx, m, "", domain.RunRead, "coder")
	if err != nil || strings.Contains(prompt, lessonsHeader) {
		t.Fatalf("collect has lessons: %v %q", err, prompt)
	}
	for i := 0; i < 20; i++ {
		add(fmt.Sprintf("long-%02d", i), "coder", "ch", strings.Repeat("é", 400), 2*time.Hour+time.Duration(i)*time.Second)
	}
	part, err = a.lessonsPrompt(ctx, "coder", "ch")
	if err != nil || len(part) > 4096 || strings.Count(part, "- ") >= 20 {
		t.Fatalf("byte cap: %d bytes, %d lessons, %v", len(part), strings.Count(part, "- "), err)
	}
}

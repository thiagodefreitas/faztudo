package api

import (
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func TestDefaultAgentAnswersPlainMessages(t *testing.T) {
	f := newThreadFixture(t)
	path := "/api/v1/channels/" + f.team.ID
	post := func(body string) {
		f.do(t, "POST", path+"/messages", `{"body":"`+body+`"}`, 201, nil)
	}
	post("before any default")
	if f.trigger.count != 0 {
		t.Fatalf("no default agent, triggered %d", f.trigger.count)
	}
	var got domain.Channel
	f.do(t, "PATCH", path, `{"default_agent_id":"`+f.coder.ID+`"}`, 200, &got)
	if got.DefaultAgentID != f.coder.ID {
		t.Fatalf("default agent %q", got.DefaultAgentID)
	}
	post("plain message")
	if f.trigger.count != 1 {
		t.Fatalf("default agent not triggered: %d", f.trigger.count)
	}
	post("/status")
	post("/anything else")
	post("@user take a look")
	if f.trigger.count != 1 {
		t.Fatalf("command or mention triggered the default agent: %d", f.trigger.count)
	}
	post("@coder explicit mention")
	if f.trigger.count != 2 {
		t.Fatalf("explicit mention: %d", f.trigger.count)
	}
	got = domain.Channel{} // the cleared field is omitted from JSON, so decode into a fresh value
	f.do(t, "PATCH", path, `{"default_agent_id":""}`, 200, &got)
	post("after clearing")
	if got.DefaultAgentID != "" || f.trigger.count != 2 {
		t.Fatalf("cleared default still triggers: %+v, %d", got, f.trigger.count)
	}
}

func TestDefaultAgentMustBeAnAgentMember(t *testing.T) {
	f := newThreadFixture(t)
	path := "/api/v1/channels/" + f.team.ID
	// a human, an agent outside the channel, and an unknown id
	for _, id := range []string{f.human.ID, f.review.ID, "missing"} {
		f.do(t, "PATCH", path, `{"default_agent_id":"`+id+`"}`, 400, nil)
	}
}

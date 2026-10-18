package api

import (
	"context"
	"net/http"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

type compareControlFake struct{ decisions int }

func (f *compareControlFake) CompareList(context.Context, string) ([]CompareGroup, error) {
	return []CompareGroup{{ID: "compare", ChannelID: "team"}}, nil
}

func (f *compareControlFake) CompareDecide(_ context.Context, _, _, _, _ string) (CompareGroup, error) {
	f.decisions++
	return CompareGroup{ID: "compare", Decision: "discard_both"}, nil
}

func TestCompareDecisionIsHumanOnly(t *testing.T) {
	f := newThreadFixture(t)
	control := &compareControlFake{}
	f.h.Compare = control
	f.h.actorForRequest = func(*http.Request) (domain.Member, error) { return f.coder, nil }
	f.do(t, "POST", "/api/v1/channels/"+f.team.ID+"/compares/compare/decide", `{"decision":"discard_both"}`, 403, nil)
	if control.decisions != 0 {
		t.Fatal("agent reached compare decision")
	}
	f.h.actorForRequest = nil
	f.do(t, "POST", "/api/v1/channels/"+f.team.ID+"/compares/compare/decide", `{"decision":"discard_both"}`, 200, nil)
	if control.decisions != 1 {
		t.Fatal("human decision did not reach app")
	}
}

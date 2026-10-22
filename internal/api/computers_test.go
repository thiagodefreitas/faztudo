package api

import (
	"context"
	"net/http"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/computers"
	"github.com/thiagodefreitas/faztudo/internal/domain"
)

type fakeComputers struct{ resets int }

func (*fakeComputers) ListComputers(context.Context) ([]computers.Status, error) {
	return []computers.Status{{ID: "coder", State: "idle"}}, nil
}
func (f *fakeComputers) ResetComputer(_ context.Context, id string) (computers.Status, error) {
	f.resets++
	return computers.Status{ID: id, State: "idle"}, nil
}

func TestComputerAPIHumanOnly(t *testing.T) {
	f := newThreadFixture(t)
	control := &fakeComputers{}
	f.h.Computers = control
	f.h.actorForRequest = func(*http.Request) (domain.Member, error) { return f.coder, nil }
	f.do(t, "GET", "/api/v1/computers", "", 403, nil)
	f.do(t, "POST", "/api/v1/computers/coder/reset", "", 403, nil)
	if control.resets != 0 {
		t.Fatal("agent reset a computer")
	}
	f.h.actorForRequest = nil
	var list []computers.Status
	f.do(t, "GET", "/api/v1/computers", "", 200, &list)
	if len(list) != 1 || list[0].ID != "coder" {
		t.Fatalf("list: %+v", list)
	}
	f.do(t, "POST", "/api/v1/computers/coder/reset", "", 200, nil)
	if control.resets != 1 {
		t.Fatalf("resets = %d", control.resets)
	}
}

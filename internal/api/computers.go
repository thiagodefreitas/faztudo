package api

import (
	"errors"
	"net/http"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func (a *API) listComputers(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "view computers") {
		return
	}
	if a.Computers == nil {
		respond(w, 200, []any{})
		return
	}
	status, err := a.Computers.ListComputers(r.Context())
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, status)
}

func (a *API) resetComputer(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "reset computers") {
		return
	}
	if a.Computers == nil {
		fail(w, 404, "not_found", "computers are unavailable")
		return
	}
	status, err := a.Computers.ResetComputer(r.Context(), r.PathValue("id"))
	if err != nil {
		var user domain.UserError
		if errors.As(err, &user) {
			fail(w, 409, "conflict", user.Error())
			return
		}
		failErr(w, err)
		return
	}
	respond(w, 200, status)
}

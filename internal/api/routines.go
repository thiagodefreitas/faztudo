package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

// RoutineControl lists, switches and runs routines. The app implements it.
type RoutineControl interface {
	List(ctx context.Context) ([]domain.Routine, error)
	// SetEnabled turns a routine on or off. by is the human who did it.
	SetEnabled(ctx context.Context, handle string, enabled bool, by string) (domain.Routine, error)
	// RunNow starts the routine at once. It returns when the routine has been
	// started or refused, not when it ends.
	RunNow(ctx context.Context, handle string) error
}

type noRoutines struct{}

func (noRoutines) List(context.Context) ([]domain.Routine, error) { return []domain.Routine{}, nil }
func (noRoutines) SetEnabled(context.Context, string, bool, string) (domain.Routine, error) {
	return domain.Routine{}, store.ErrNotFound
}
func (noRoutines) RunNow(context.Context, string) error { return store.ErrNotFound }

func (a *API) routines(w http.ResponseWriter, r *http.Request) {
	list, err := a.Routines.List(r.Context())
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, list)
}

func (a *API) patchRoutine(w http.ResponseWriter, r *http.Request) {
	if current(r).Kind != domain.MemberHuman {
		fail(w, 403, "forbidden", "only a human can change routines")
		return
	}
	var v struct {
		Enabled *bool `json:"enabled"`
	}
	if !decode(w, r, &v) {
		return
	}
	if v.Enabled == nil {
		fail(w, 400, "bad_request", "enabled required")
		return
	}
	routine, err := a.Routines.SetEnabled(r.Context(), r.PathValue("handle"), *v.Enabled, current(r).ID)
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, routine)
}

func (a *API) runRoutine(w http.ResponseWriter, r *http.Request) {
	if current(r).Kind != domain.MemberHuman {
		fail(w, 403, "forbidden", "only a human can run a routine")
		return
	}
	err := a.Routines.RunNow(r.Context(), r.PathValue("handle"))
	var user domain.UserError
	switch {
	case err == nil:
		respond(w, 202, map[string]string{"status": "started"})
	case errors.As(err, &user):
		fail(w, 409, "conflict", user.Message)
	default:
		failErr(w, err)
	}
}

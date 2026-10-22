package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

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
	// Create makes a routine in the app. It returns a domain.UserError for
	// input it refuses and an error matching store.ErrConflict for a handle
	// that lanes.toml uses.
	Create(ctx context.Context, in domain.RoutineInput, by string) (domain.Routine, error)
	// Delete removes a routine made in the app. A routine from lanes.toml
	// gives an error matching store.ErrConflict.
	Delete(ctx context.Context, handle, by string) error
}

type noRoutines struct{}

func (noRoutines) List(context.Context) ([]domain.Routine, error) { return []domain.Routine{}, nil }
func (noRoutines) SetEnabled(context.Context, string, bool, string) (domain.Routine, error) {
	return domain.Routine{}, store.ErrNotFound
}
func (noRoutines) RunNow(context.Context, string) error { return store.ErrNotFound }
func (noRoutines) Create(context.Context, domain.RoutineInput, string) (domain.Routine, error) {
	return domain.Routine{}, domain.UserError{Message: "routines are not available"}
}
func (noRoutines) Delete(context.Context, string, string) error { return store.ErrNotFound }

func (a *API) routines(w http.ResponseWriter, r *http.Request) {
	// Routines carry prompts, channels and repositories, private ones too.
	if !humanOnly(w, r, "read routines") {
		return
	}
	list, err := a.Routines.List(r.Context())
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, list)
}

// createRoutine answers POST /api/v1/routines. The channel must be one the
// caller can see, and a name that lanes.toml already uses answers 409.
func (a *API) createRoutine(w http.ResponseWriter, r *http.Request) {
	if current(r).Kind != domain.MemberHuman {
		fail(w, 403, "forbidden", "only a human can create routines")
		return
	}
	var in domain.RoutineInput
	if !decode(w, r, &in) {
		return
	}
	channels, err := a.Store.Channels(r.Context())
	if err != nil {
		failErr(w, err)
		return
	}
	name := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(in.Channel), "#"))
	known := false
	for _, c := range channels {
		if strings.ToLower(c.Name) == name && visible(c, current(r).ID) {
			known = true
			break
		}
	}
	if !known {
		fail(w, 400, "bad_request", "channel #"+name+" does not exist")
		return
	}
	routine, err := a.Routines.Create(r.Context(), in, current(r).ID)
	if err != nil {
		routineFailure(w, err)
		return
	}
	respond(w, 201, routine)
}

// deleteRoutine answers DELETE /api/v1/routines/{handle}. Only routines made
// in the app can go; the ones in lanes.toml answer 409.
func (a *API) deleteRoutine(w http.ResponseWriter, r *http.Request) {
	if current(r).Kind != domain.MemberHuman {
		fail(w, 403, "forbidden", "only a human can delete routines")
		return
	}
	if err := a.Routines.Delete(r.Context(), r.PathValue("handle"), current(r).ID); err != nil {
		routineFailure(w, err)
		return
	}
	w.WriteHeader(204)
}

// routineFailure writes why a routine could not be created or deleted.
func routineFailure(w http.ResponseWriter, err error) {
	var user domain.UserError
	switch {
	case errors.As(err, &user):
		fail(w, 400, "bad_request", user.Message)
	case errors.Is(err, store.ErrConflict):
		fail(w, 409, "conflict", err.Error())
	default:
		failErr(w, err)
	}
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

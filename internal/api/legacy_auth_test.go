package api

import "github.com/thiagodefreitas/faztudo/internal/store"

// Existing API tests cover behavior unrelated to local authentication. New
// authentication tests use New directly and exercise the real token file.
func newTestAPI(s *store.Store, humanID, version string) *API {
	a := New(s, humanID, version)
	a.localAuthBypass = true
	return a
}

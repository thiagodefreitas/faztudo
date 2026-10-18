package webui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMountRoutesAPIAndUI(t *testing.T) {
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("api")) })
	h := Mount(api)
	for _, tc := range []struct{ path, want string }{
		{"/api/v1/health", "api"},
		{"/", "faztudo"},
		{"/channels/abc", "faztudo"},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", tc.path, nil))
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), tc.want) {
			t.Fatalf("%s: %d %q", tc.path, rec.Code, rec.Body.String())
		}
	}
}

func TestWithMCPRoutesMCPOnly(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("next")) })
	mcp := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("mcp")) })
	h := WithMCP(Mount(next), mcp)
	for _, tc := range []struct{ path, want string }{
		{"/mcp", "mcp"},
		{"/mcp/", "mcp"},
		{"/api/v1/health", "next"},
		{"/", "faztudo"},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), tc.want) {
			t.Fatalf("%s: %d %q", tc.path, rec.Code, rec.Body.String())
		}
	}
}

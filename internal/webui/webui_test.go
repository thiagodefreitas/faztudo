package webui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestMountRoutesAPIAndUI(t *testing.T) {
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("api")) })
	h := Mount(api)
	for _, tc := range []struct{ path, want string }{
		{"/api/v1/health", "api"},
		{"/ca.crt", "api"},
		{"/mcp", "api"},
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

func TestMissingAssetIs404AndWorkerFilesRevalidate(t *testing.T) {
	root := fstest.MapFS{
		"index.html":           &fstest.MapFile{Data: []byte("<html>faztudo</html>")},
		"assets/app-1.js":      &fstest.MapFile{Data: []byte("x")},
		"sw.js":                &fstest.MapFile{Data: []byte("sw")},
		"precache-manifest.js": &fstest.MapFile{Data: []byte("m")},
	}
	h := handlerFor(root)
	get := func(p string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		return rec
	}
	if rec := get("/assets/lanes-OLD.js"); rec.Code != 404 || strings.Contains(rec.Body.String(), "faztudo") {
		t.Fatalf("missing asset: %d %q", rec.Code, rec.Body.String())
	}
	if rec := get("/channels/abc"); rec.Code != 200 || !strings.Contains(rec.Body.String(), "faztudo") {
		t.Fatalf("route fallback: %d", rec.Code)
	}
	if rec := get("/assets/app-1.js"); rec.Code != 200 || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("asset: %d %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
	for _, p := range []string{"/sw.js", "/precache-manifest.js"} {
		if rec := get(p); rec.Code != 200 || rec.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("%s: %d %q", p, rec.Code, rec.Header().Get("Cache-Control"))
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

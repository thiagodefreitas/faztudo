// Package webui serves the built web app embedded in the binary.
//
// `make web` builds web/ and copies the result into dist/. A binary built
// without that step still works: it serves a short page that says how to
// build the UI, and the API is unaffected.
package webui

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var dist embed.FS

const notBuilt = `<!doctype html><meta charset="utf-8"><title>faztudo</title>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>faztudo</h1><p>The API is running, but this binary was built without the
web app. Build it with <code>make build</code> (which runs <code>make web</code>
first), or use <code>npm run dev</code> in <code>web/</code> during development.</p>`

// Handler serves static files from the embedded build. Paths that do not
// name a file get index.html, so client-side routes work on reload.
func Handler() http.Handler {
	root, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	files := http.FileServerFS(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := fs.Stat(root, "index.html"); err != nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(notBuilt))
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" || name == "." {
			name = "index.html"
		}
		if st, err := fs.Stat(root, name); err != nil || st.IsDir() {
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		} else if strings.HasSuffix(name, ".woff2") {
			// Not in Go's built-in type table; /etc/mime.types may lack it too.
			w.Header().Set("Content-Type", "font/woff2")
		} else if strings.HasPrefix(name, "assets/") {
			// Vite puts a content hash in asset names, so they never change.
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		files.ServeHTTP(w, r)
	})
}

// WithMCP sends /mcp to mcp and every other path to next.
func WithMCP(next, mcp http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/mcp" || strings.HasPrefix(r.URL.Path, "/mcp/") {
			mcp.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Mount returns a handler that sends /api/, /ca.crt, and /mcp to api and
// everything else to the web app.
func Mount(api http.Handler) http.Handler {
	ui := Handler()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p == "/api" || strings.HasPrefix(p, "/api/") || p == "/auth/local" || p == "/ca.crt" || p == "/mcp" || strings.HasPrefix(p, "/mcp/") {
			api.ServeHTTP(w, r)
			return
		}
		ui.ServeHTTP(w, r)
	})
}

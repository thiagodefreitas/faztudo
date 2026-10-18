package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// runConnect signs a local client in without a browser. The desktop shell
// calls it with --json and loads the returned url and code; the token never
// leaves this process.
func runConnect(listen, tokenPath string, args []string, out io.Writer) error {
	asJSON := false
	switch {
	case len(args) == 0:
	case len(args) == 1 && args[0] == "--json":
		asJSON = true
	default:
		return fmt.Errorf("usage: faztudo connect [--json]")
	}
	code, err := requestLocalCode(listen, tokenPath)
	if err != nil {
		return err
	}
	base := "http://" + listen
	if asJSON {
		return json.NewEncoder(out).Encode(map[string]string{
			"url": base, "code": code, "version": daemonVersion(base),
		})
	}
	_, err = fmt.Fprintf(out, "Sign in at %s/auth/local#%s\nThe link works once and expires within a minute.\n", base, code)
	return err
}

// daemonVersion reads the version from the public health endpoint. An
// unreadable answer gives an empty string; the code was already issued.
func daemonVersion(base string) string {
	client := &http.Client{Timeout: 5 * time.Second}
	res, err := client.Get(base + "/api/v1/health")
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	var h struct {
		Version string `json:"version"`
	}
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&h) != nil {
		return ""
	}
	return h.Version
}

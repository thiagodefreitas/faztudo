// Package templates holds the starting organizations that
// 'faztudo init --template' writes as lanes.toml. They are plain TOML files, so
// people can read them, copy them and share their own.
package templates

import (
	"embed"
	"fmt"
	"sort"
	"strings"
)

//go:embed *.toml
var files embed.FS

// Names lists the templates, sorted.
func Names() []string {
	entries, err := files.ReadDir(".")
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, strings.TrimSuffix(e.Name(), ".toml"))
	}
	sort.Strings(names)
	return names
}

// Get returns the lanes.toml text of a template.
func Get(name string) (string, error) {
	b, err := files.ReadFile(name + ".toml")
	if err != nil {
		return "", fmt.Errorf("unknown template %q (use %s)", name, strings.Join(Names(), ", "))
	}
	return string(b), nil
}

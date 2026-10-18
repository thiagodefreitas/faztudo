// Command mcpcheck is a stand-in for claude and codex. It checks that the
// MCP token is only where that CLI's config is allowed to put it.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

func main() {
	args := os.Args[1:]
	var err error
	if flagIndex(args, "--mcp-config") >= 0 {
		err = checkClaude(args)
	} else {
		err = checkCodex(args)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "mcp check failed:", err.Error())
		os.Exit(1)
	}
	fmt.Println("mcp-ok")
}

func flagIndex(args []string, name string) int {
	for i, arg := range args {
		if arg == name {
			return i
		}
	}
	return -1
}

func checkClaude(args []string) error {
	if flagIndex(args, "--strict-mcp-config") < 0 {
		return fmt.Errorf("missing strict flag")
	}
	i := flagIndex(args, "--mcp-config")
	if i < 0 || i+1 >= len(args) {
		return fmt.Errorf("missing config flag")
	}
	info, err := os.Stat(args[i+1])
	if err != nil {
		return fmt.Errorf("config missing")
	}
	if info.Mode().Perm() != 0o600 {
		return fmt.Errorf("config mode %o", info.Mode().Perm())
	}
	raw, err := os.ReadFile(args[i+1])
	if err != nil {
		return fmt.Errorf("config unreadable")
	}
	var doc struct {
		McpServers map[string]struct {
			Headers map[string]string `json:"headers"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("config json")
	}
	token, ok := strings.CutPrefix(doc.McpServers["faztudo"].Headers["Authorization"], "Bearer ")
	if !ok || token == "" {
		return fmt.Errorf("missing bearer")
	}
	if err := notInEnv(token); err != nil {
		return err
	}
	for _, arg := range args {
		if strings.Contains(arg, token) {
			return fmt.Errorf("token in argv")
		}
	}
	if !strings.Contains(strings.Join(args, "\n"), "ask_human returns immediately") {
		return fmt.Errorf("prompt note missing")
	}
	return nil
}

func checkCodex(args []string) error {
	var header string
	sawURL := false
	for _, arg := range args {
		if strings.Contains(arg, "mcp_servers.faztudo.url=") {
			sawURL = true
		}
		if strings.Contains(arg, "mcp_servers.faztudo.http_headers=") {
			header = arg
		}
	}
	if !sawURL {
		return fmt.Errorf("missing url key")
	}
	if header == "" {
		return fmt.Errorf("missing header key")
	}
	const marker = `Authorization="Bearer `
	i := strings.Index(header, marker)
	if i < 0 {
		return fmt.Errorf("missing bearer")
	}
	rest := header[i+len(marker):]
	end := strings.IndexByte(rest, '"')
	if end <= 0 {
		return fmt.Errorf("missing bearer")
	}
	token := rest[:end]
	if err := notInEnv(token); err != nil {
		return err
	}
	for _, arg := range args {
		if strings.Contains(arg, "http_headers=") {
			continue
		}
		if strings.Contains(arg, token) {
			return fmt.Errorf("token in argv")
		}
	}
	if !strings.Contains(strings.Join(args, "\n"), "ask_human returns immediately") {
		return fmt.Errorf("prompt note missing")
	}
	return nil
}

func notInEnv(token string) error {
	for _, entry := range os.Environ() {
		_, value, _ := strings.Cut(entry, "=")
		if strings.Contains(value, token) {
			return fmt.Errorf("token in environment")
		}
	}
	return nil
}

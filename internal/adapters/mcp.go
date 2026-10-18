package adapters

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// MCP is the per-run faztudo endpoint. The token stays in the CLI's own
// config and is never added to the environment.
type MCP struct {
	URL   string
	Token string
	Dir   string
}

const allowedMCPTools = "mcp__faztudo__post_message,mcp__faztudo__ask_human,mcp__faztudo__request_approval,mcp__faztudo__read_context,mcp__faztudo__list_members"

func (m *MCP) valid() error {
	if m == nil {
		return nil
	}
	if m.URL == "" || m.Token == "" {
		return errors.New("mcp url and token required")
	}
	if strings.ContainsAny(m.URL, "\"\\\n\r") || strings.ContainsAny(m.Token, "\"\\\n\r ") {
		return errors.New("mcp url or token has an unsupported character")
	}
	return nil
}

func claudeMCP(r Request, args []string) (Cmd, error) {
	cmd := Cmd{Path: "claude", Args: args, Dir: r.Workdir, EnvAllow: []string{"CLAUDE_CONFIG_DIR"}}
	if r.MCP == nil {
		return cmd, nil
	}
	if err := r.MCP.valid(); err != nil {
		return Cmd{}, err
	}
	if r.MCP.Dir == "" {
		return Cmd{}, errors.New("mcp config dir required")
	}
	if err := os.MkdirAll(r.MCP.Dir, 0700); err != nil {
		return Cmd{}, err
	}
	path := filepath.Join(r.MCP.Dir, "mcp.json")
	body, err := json.Marshal(map[string]any{
		"mcpServers": map[string]any{
			"faztudo": map[string]any{
				"type": "http",
				"url":  r.MCP.URL,
				"headers": map[string]string{
					"Authorization": "Bearer " + r.MCP.Token,
				},
			},
		},
	})
	if err != nil {
		return Cmd{}, err
	}
	if err := os.WriteFile(path, body, 0600); err != nil {
		return Cmd{}, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		_ = os.Remove(path)
		return Cmd{}, err
	}
	// Tool search hides MCP tools until the model loads them. These five are
	// small, so load them with the session. Plan mode stays in place.
	cmd.Args = append(cmd.Args, "--mcp-config", path, "--strict-mcp-config", "--allowedTools", allowedMCPTools, "--settings", `{"enable_tool_search":false}`)
	cmd.Remove = []string{path}
	return cmd, nil
}

func withCodexMCP(args []string, m *MCP) ([]string, error) {
	if m == nil {
		return args, nil
	}
	if err := m.valid(); err != nil {
		return nil, err
	}
	return append(args,
		"-c", fmt.Sprintf("mcp_servers.faztudo.url=%q", m.URL),
		"-c", fmt.Sprintf("mcp_servers.faztudo.http_headers={Authorization=%q}", "Bearer "+m.Token),
	), nil
}

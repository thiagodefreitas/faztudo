package adapters

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func TestClaudeAndCodexMCPConfig(t *testing.T) {
	dir := t.TempDir()
	token := strings.Repeat("ab", 32)
	mcp := &MCP{URL: "http://127.0.0.1:9/mcp", Token: token, Dir: filepath.Join(dir, "run1")}
	cmd, err := (Claude{}).Command(Request{Prompt: "hello", Mode: domain.RunRead, Workdir: dir, MCP: mcp})
	if err != nil {
		t.Fatal(err)
	}
	if containsToken(cmd, token) {
		t.Fatal("claude copied the mcp token into argv or the environment")
	}
	joined := strings.Join(cmd.Args, "\n")
	for _, want := range []string{"--mcp-config", "--strict-mcp-config", "--allowedTools", "mcp__faztudo__post_message", "mcp__faztudo__list_members", `{"enable_tool_search":false}`} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %s", want)
		}
	}
	if len(cmd.Remove) != 1 {
		t.Fatal("claude did not schedule config removal")
	}
	info, err := os.Stat(cmd.Remove[0])
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("config mode %o", info.Mode().Perm())
	}
	raw, err := os.ReadFile(cmd.Remove[0])
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		McpServers map[string]struct {
			Type    string            `json:"type"`
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	got := doc.McpServers["faztudo"]
	if got.Type != "http" || got.URL != mcp.URL || got.Headers["Authorization"] != "Bearer "+token {
		t.Fatal("claude mcp config shape")
	}
	if len(cmd.EnvAllow) != 1 || cmd.EnvAllow[0] != "CLAUDE_CONFIG_DIR" || len(cmd.EnvAdd) != 0 {
		t.Fatal("claude environment changed")
	}

	codex, err := (Codex{}).Command(Request{Prompt: "hello", Mode: domain.RunRead, Workdir: dir, MCP: mcp})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(codex.Args, "\n"), token) {
		t.Fatal("codex MCP token appears in process arguments")
	}
	sawURL, sawHeader := false, false
	for _, arg := range codex.Args {
		if strings.Contains(arg, "mcp_servers.faztudo.url=") {
			sawURL = strings.Contains(arg, mcp.URL)
		}
		if strings.Contains(arg, "mcp_servers.faztudo.bearer_token_env_var=") {
			sawHeader = strings.Contains(arg, "FAZTUDO_MCP_TOKEN")
		}
	}
	if !sawURL || !sawHeader || codex.Args[len(codex.Args)-1] != "hello" {
		t.Fatal("codex mcp flags")
	}
	if len(codex.EnvAllow) != 2 || codex.EnvAllow[0] != "CODEX_HOME" || codex.EnvAllow[1] != "FAZTUDO_MCP_TOKEN" || codex.EnvAdd["FAZTUDO_MCP_TOKEN"] != token || len(codex.Remove) != 0 {
		t.Fatal("codex environment changed")
	}
}

func TestOtherAdaptersDoNotReceiveMCP(t *testing.T) {
	dir := t.TempDir()
	token := strings.Repeat("cd", 32)
	mcp := &MCP{URL: "http://127.0.0.1:9/mcp", Token: token, Dir: dir}
	for _, adapter := range []Adapter{Grok{}, Kimi{}, Agy{}, OpenCode{}} {
		req := Request{Prompt: "hello", Mode: domain.RunWrite, Workdir: dir, Timeout: time.Second, MCP: mcp}
		if adapter.Name() == "grok" {
			req.Mode = domain.RunRead
		}
		cmd, err := adapter.Command(req)
		if err != nil {
			t.Fatal(adapter.Name(), err)
		}
		if containsToken(cmd, token) {
			t.Fatalf("%s copied the mcp token", adapter.Name())
		}
	}
}

func containsToken(cmd Cmd, token string) bool {
	if strings.Contains(strings.Join(cmd.Args, "\n"), token) && !strings.Contains(strings.Join(cmd.Args, "\n"), "http_headers=") {
		return true
	}
	for _, arg := range cmd.Args {
		if strings.Contains(arg, "http_headers=") {
			continue
		}
		if strings.Contains(arg, token) {
			return true
		}
	}
	if strings.Contains(strings.Join(cmd.EnvAllow, "\n"), token) || strings.Contains(strings.Join(cmd.EnvRemove, "\n"), token) {
		return true
	}
	for key, value := range cmd.EnvAdd {
		if strings.Contains(key, token) || strings.Contains(value, token) {
			return true
		}
	}
	for _, path := range cmd.Remove {
		if strings.Contains(path, token) {
			return true
		}
	}
	return false
}

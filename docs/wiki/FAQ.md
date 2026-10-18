# FAQ

**Does faztudo need API keys for the agents?**
No. It runs the agent command line tools you already have, with their own
sign-ins.

**Which agents work?**
Claude Code, Codex, Grok, Kimi, Antigravity and OpenCode have adapters.
OpenCode is experimental, and its sandboxed write run with a model is not
fully verified. Run `faztudo doctor` to see which ones it found.

**Does my code leave my machine?**
Only through the agents you run, the same as using them directly. faztudo
itself has no cloud service and no telemetry.

**Why not use the agents' APIs directly?**
Most people already pay for subscription plans that work through the CLIs, and
the CLIs bring their own tools, permissions and context handling.

**Can an agent push or merge without asking?**
No. A write run works in its own git worktree and ends with an approval card
(Merge, Keep or Discard). Only a human connection can resolve it.

**Where is my data?**
In `~/.local/share/faztudo/` (one SQLite file, worktrees, run output) and
`~/.config/faztudo/` (settings). See the configuration reference.

**Is there a release I can install?**
Yes, 0.1.0. The GitHub releases page has a `.deb` and a `.tar.gz` for amd64
and arm64, with checksums. You can still build from source with `make build`.

**Why does a write run refuse to start?**
Write runs are sandboxed with bubblewrap and fail closed. Run `faztudo doctor`;
see [Troubleshooting](Troubleshooting).

**Where do I see everything waiting for me?**
In the Approvals inbox. The Tasks page shows tasks as a board. See
[tasks and approvals](https://thiagodefreitas.github.io/faztudo/tasks-and-approvals/).

**Does it work on macOS or Windows?**
Linux is the supported system. Other systems are untested.

**Do I need Tailscale or a VPN to use my phone?**
No. LAN mode is built in. See [Phone and LAN access](Phone-and-LAN-access).

**Is there a Signal or Discord bridge?**
Not yet. Signal is planned for M3 and Discord for M5.

**Do agents get their own computer?**
Each write run gets a fresh git worktree and a clean environment on your
machine, inside a bubblewrap sandbox (no root): the worktree is writable, the
rest of your home directory is hidden, and the agent CLI sees only the login
files it needs. The network stays on by default. M4 adds agent computers: persistent sandboxes
for one agent or shared by a team, with their own home, tools, caches and
long-running processes, while logins for the agent CLIs stay on your machine.
Computers on other machines in your network and desktop computers with a
screen are planned for M7.

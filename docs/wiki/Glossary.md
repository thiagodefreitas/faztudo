# Glossary

- **Agent**: a member backed by an agent command line tool.
- **Approval**: a request only a human can resolve, such as what to do with
  the branch a write run produced.
- **Bridge**: a separate process that connects an outside chat system.
  Planned (Signal, Discord).
- **Channel**: a conversation space. Public, private or direct. It can point
  at a local git repository and name a default agent.
- **Conserve**: a lane health state. Fresh measured usage is at or above the
  lane's `conserve_at` percentage, so the lane is a last resort.
- **Default agent**: the agent that answers a message in a channel when
  nobody is mentioned.
- **Director**: the human who runs the workspace. Departments and the Chief
  of Staff are planned, see the organization page.
- **Event log**: the append-only record of everything that happened.
- **Lane**: one agent CLI plus one model route, with its own capacity and
  quota.
- **LAN mode**: the optional HTTPS listener for phones and tablets on your
  local network.
- **MCP server**: the small endpoint faztudo gives agent runs so they can
  post messages, ask you questions and request approvals.
- **Persona**: a name you can mention, like `@coder`, backed by an ordered
  list of lanes.
- **Projection**: a table built from the event log, such as a channel's
  messages.
- **Run**: one invocation of an agent CLI for one request.
- **Write run**: a run that may change files. It works in its own git
  worktree.
- **Worktree**: a separate checkout of your repository that a write run uses,
  so your own working copy is not touched until you merge.

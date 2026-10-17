# Glossary

- **Agent**: a member backed by an agent command line tool.
- **Persona**: a name you can mention, like `@coder`, backed by a list of lanes.
- **Lane**: one agent CLI plus one account plus one model route, with its own
  capacity and quota.
- **Run**: one invocation of an agent CLI for one request.
- **Write run**: a run that may change files; it works in its own git worktree.
- **Approval**: a request only a human can resolve.
- **Bridge**: a separate process that connects an outside chat system.
- **Event log**: the append-only record of everything that happened.
- **Projection**: a table built from the event log, such as a channel's messages.

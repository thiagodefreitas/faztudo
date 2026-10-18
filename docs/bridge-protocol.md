# Bridge protocol, version 1

This protocol implements [ADR-0002](adr/0002-bridge-protocol.md). The daemon
starts a separate bridge process. The bridge reads daemon messages on stdin and
writes its messages on stdout. Each line is one UTF-8 JSON-RPC 2.0 object.
Stdout is reserved for protocol messages; diagnostics go to stderr. The daemon
owns the channel bindings, sender allowlist, event log, files and approvals.
The Signal transport itself is a later step.

This step installs the daemon protocol and supervisor. `faztudo bridge signal`
is a placeholder until the Signal adapter is built; enabling it now reports
the missing transport and retries. Do not enable it for daily use yet.

The later adapter will read `[bridges.signal]` from `config.toml`:

```toml
[bridges.signal]
enabled = false
account = "+15551234567"
signal_cli = "signal-cli"
allow = ["+15551234567"]
approvals = false
alerts = "self"

[bridges.signal.bind]
self = "general"
```

`bind` values are existing channel names or IDs. An enabled bridge requires
an account, signal-cli command, at least one allowed sender, and at least one
binding. `alerts` must name a bound conversation. `doctor` checks that
signal-cli and Java are on the path when Signal is enabled.

The bridge calls `hello` first:

```json
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":"1","bridge":"signal","version":"1","capabilities":["attachments"]}}
```

The result contains `bindings`, a map from conversation key (`self`,
`group:<id>`, or `direct:<id>`) to channel ID, and `allowed_senders`, an array
of Signal sender IDs or numbers. These fields are information for the bridge;
the daemon checks them again on every inbound delivery.

`inbound.message` posts one message. Its params are:

```json
{"conversation":{"kind":"group","id":"signal-group-id"},"sender":{"id":"signal-sender-id","number":"+15551234567"},"sent_at_ms":1760810400000,"external_id":"signal-message-id","body":"@coder check this","quote":null,"attachments":[{"name":"note.txt","content_type":"text/plain","data_b64":"aGkK"}]}
```

`conversation.kind` is `group`, `self`, or `direct`. `quote` is null or
`{"external_id":"...","author_id":"..."}`. Attachments are optional;
their names are cleaned and their content types are sniffed from the decoded
bytes. Each file is capped by `server.max_upload_mb` (25 MB by default). The
`body` is capped at 1 MiB, the same limit as the HTTP message API; a longer
body fails with `too_large`. The
result is `{"message_id":"...","duplicate":false}`. A repeated delivery
uses the key `signal:<sender.id>:<external_id>`, returns the original ID with
`duplicate:true`, and starts no second agent run. Validation failures use a
JSON-RPC error with `code:-32000`, a plain `message`, and `data` set to one of
`not_allowed`, `unbound`, `too_large`, or `bad_request`.

The bridge sends a `status` notification, with no `id`, when its state changes:
`{"jsonrpc":"2.0","method":"status","params":{"state":"connected","detail":"..."}}`.
Other states are `linking`, `disconnected`, and `error`.
The daemon sends `outbound.send` with `conversation`, `text`, optional
`quote_external_id`, `attachments`, and `ref` containing either `message_id`
or `approval_id`. The bridge replies with `{"external_id":"..."}`. The
daemon stores that mapping and advances its outbound event cursor after the
reply. A newly enabled mirror starts at the current event, not old history.
The daemon never echoes a message whose event actor is `bridge:signal`.
If one `outbound.send` fails (an error reply, a timeout, a missing
attachment), the daemon retries a transport failure a few times, then skips
that event, posts a notice in the channel, and carries on with the next one.

A bridge must keep reading stdin while it writes stdout. The daemon never
lets its reader wait on its writer, but a bridge that stops reading stdin
while it blocks on stdout can still stall itself once the pipe buffer is full.
Read stdin on its own thread or task.

On shutdown the daemon sends a `shutdown` notification, waits five seconds,
then kills the bridge process group.

Configured mirroring needs no per-message approval. An agent request to send
outward still needs human approval. Signal approval replies will only support
`keep` and `discard`; `merge` remains a web action. The daemon's approval
method enforces this even if a bridge forwards `merge`.

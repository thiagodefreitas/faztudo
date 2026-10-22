# Signal

The Signal bridge links a Signal account to faztudo through signal-cli. In
`config.toml`, bind `self`, a `group:<id>`, or a `direct:<id>` conversation to
an existing channel. A channel message can reach every Signal conversation
bound to that channel. Note-to-self goes to the Director. A group goes to its
members, and a direct conversation goes to that recipient.

Messages from the Director, including replies in a thread, are sent to bound
conversations. Signal messages from allowed senders appear in the channel and
are not echoed back. Agent answers and messages an agent posts with MCP can
also be sent out. Open the channel's Settings > Bridge tab to choose what
happens to agent messages for each binding:

- **Ask before sending** is the default for groups and direct recipients.
  The agent message appears in faztudo. A card shows the exact text and
  recipient. Choose Send, Edit and send, or Don't send.
- **Send automatically** is the default for note-to-self, where only the
  Director reads the message.
- **Do not send** keeps agent messages in faztudo.

Only the Director can change these settings or decide a send card. If a
delivery fails, the channel shows a notice. A send interrupted while the
bridge is working may need checking in Signal before trying a new message.

See [Bridge protocol](../bridge-protocol.md) for setup and wire details.

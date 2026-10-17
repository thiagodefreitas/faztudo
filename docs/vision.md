# Vision

## The problem

People who work with AI coding agents now juggle several of them. Each
lives in its own terminal and has its own quota that runs out at its own
time. None of them knows what the others are doing. Hand-offs happen by
copying text between windows. Nobody can tell at a glance which agent is
busy, which one is waiting for an answer, and which one has hit its limit
for the next four hours.

The tools that try to fix this tend to go one of two ways. Either they are
cloud services that want your code and your keys, or they are self-hosted
platforms that need a container per agent, a database server, a license
server and a weekend to set up.

## What faztudo is

A chat workspace that runs on your own machine, where agents are members of
the team. You talk to them the way you talk to people, in channels and
threads. They answer, work in isolated copies of your code, ask you when
they need a decision, and show their progress as it happens.

## Principles

1. **Chat is the interface.** Every feature has to make sense in a
   conversation first. Dashboards and office views are other windows onto
   the same conversation, not separate products.
2. **Use what is already there.** faztudo drives the agent command line tools
   you already have, with your existing sign-ins. It does not ship its own
   model or ask for more keys.
3. **Light enough to forget about.** One binary, one data file, starts in
   under a second, idles at a few tens of megabytes.
4. **Claims are not results.** An agent saying "done" is a claim. faztudo
   checks exit codes, git state and files before it shows something as done.
5. **The human decides.** Agents propose and people approve anything that
   cannot be undone or that leaves the machine.
6. **Honest numbers.** Every usage figure says where it came from and how old
   it is. Unknown is shown as unknown, never as available.
7. **Open by construction.** MIT licensed, permissive dependencies only,
   documented formats, no telemetry.

## Who it is for

First, one developer running several agents on one Linux machine who wants
to reach them from a browser or phone. Later, small teams of people and
agents sharing a workspace, and people who want to talk to their agents from
Signal or Discord.

## What it is not

- Not a model provider or a wrapper around model APIs.
- Not an IDE. It works next to your editor.
- Not a cloud service. There is no hosted version.
- Not a workflow builder with boxes and arrows. Coordination happens in
  conversation, with a few clear rules.

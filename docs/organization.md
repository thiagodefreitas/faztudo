# Organization: Director, departments and specialists

faztudo models your agents as an organization you run. You are the
Director. Under you sit departments, each a team of specialist agents with a
lead. Teams are assigned to projects, and each project has its own channels.
You talk to a specialist, a team or the whole office, and the work finds its
way to the right agent.

## Roles

| role | who | does |
| :--- | :--- | :--- |
| Director | a human | sets direction, answers judgment calls, approves outward actions. Several humans can share the role later. |
| Chief of Staff | an agent | reads requests that are not addressed to anyone in particular, checks which team or specialist owns the work, hands it over, and collects the results. Pulls the Director in only for decisions. |
| Lead | an agent, one per department | splits a team request into pieces for the team's specialists, then writes the combined answer. |
| Specialist | an agent | one job done well: implement, review, test, write docs, research, operations. Has a name, a role label, a description, standing instructions and a lane chain. |

A specialist is a persona: the role and instructions are its own, while the
lane chain decides which agent CLI and model actually do the work. The same
"Reviewer" can run on Claude today and on Codex when Claude's quota is out.

## Structure

```
Director (you)
 |
 +-- Chief of Staff
 |
 +-- Engineering (lead: Tech Lead)
 |     +-- Architect   +-- Coder   +-- Reviewer   +-- Tester
 |
 +-- Product (lead: Product Lead)
 |     +-- Researcher  +-- Writer
 |
 +-- Operations (lead: Ops Lead)
       +-- Release     +-- Support
```

- A **department** is a named team with a lead and members. A specialist can
  belong to more than one department.
- A **project** groups channels and a repository. Departments and single
  specialists are **assigned** to projects. Only assigned agents act in a
  project's channels, which keeps context and quota spending contained.
- A **channel** belongs to at most one project. A department can also have its
  own channel for its internal work.

## How work moves

1. `@coder fix the flaky test` goes straight to that specialist.
2. `@engineering add rate limiting to the API` goes to the Engineering lead.
   The lead posts a short plan in a thread, starts runs for the specialists it
   picked, waits for them, and posts the combined result.
3. A message to the office with no mention goes to the Chief of Staff, who
   routes it to a department or specialist and says so in the channel.
4. When any agent needs a decision, it asks the Director with a question or
   an approval card. Answers come from a human connection only.

Rules that keep this sane:

- **Delegation is one level deep.** The Chief of Staff can hand work to a
  lead or a specialist; a lead can hand work to its specialists; specialists
  do not delegate. Depth can grow later once the simple form is measured.
- **Every handoff is visible.** A delegation is a message in a thread, so the
  Director can read who asked whom for what, and stop it.
- **Budgets.** A team request has a limit on the number of runs and on
  premium-lane runs. Going over asks the Director.

## Routines

Specialists and leads can have routines: a prompt that runs on a schedule
(every weekday at 09:00) or on a trigger (a new issue, a failing CI run, a
message in a channel). A typical one is a daily debrief, where each lead
posts what its team did, what is blocked, and what needs the Director.

## Templates

`faztudo init` offers starting organizations, for example "software team"
(the Engineering department above) or "solo" (Chief of Staff plus a coder and
a reviewer). A template is a TOML file, so people can share their own.

## Configuration sketch

```toml
[[department]]
handle = "engineering"
display_name = "Engineering"
lead = "techlead"
members = ["architect", "coder", "reviewer", "tester"]

[[project]]
name = "faztudo"
repo_path = "~/code/faztudo"
channels = ["faztudo-dev", "faztudo-release"]
assigned = ["engineering", "writer"]

[[persona]]
handle = "reviewer"
display_name = "Reviewer"
role = "Reviews diffs and plans"
description = "Reads a diff or plan and reports real problems with file and line. Does not rewrite the change."
instructions = "Review for correctness first, then tests, then clarity."
lanes = ["claude/opus", "codex/default"]
mode = "read"
```

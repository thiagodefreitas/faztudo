# faztudo

Local-first multi-agent coordination platform.

## Vision

`faztudo` is a public project for running autonomous AI agent teams locally, as a privacy-preserving alternative to cloud-first agent hubs.

The platform is designed to support:
- Native app and modern web frontend (lightweight, intuitive UX)
- Team channels and private channels for:
  - organizations/teams
  - departments
  - projects
  - individual agents
- Human-in-the-loop strategy decisions (agents escalate key decisions)
- Autonomous coordination between agents, including a coordinator role
- Integration with Signal, WhatsApp, and Discord for communication
- Pluggable local CLI agents (e.g. `agy`, `kimi`, `grok`, `claude`, `codex`)
- Optional extension endpoints to communicate with external agent teams (including GrokBots-like ecosystems)

## Product Scope

### 1) Frontends
- **Web frontend**: responsive, modern 2026-style interface, low latency, low resource use.
- **App frontend**: companion app with the same channel/team model and strategy approval workflows.

### 2) Agent Organization Model
- **Coordinator agent** to orchestrate workflows.
- **Department agents** (e.g., engineering, marketing, operations).
- **Project agents** for project-specific execution.
- **Individual specialist agents** for focused tasks.
- **Agent teams** that can self-coordinate and request human decisions when needed.

### 3) Communication Connectors
- Signal connector
- WhatsApp connector
- Discord connector
- Internal messaging bus for agent-to-agent communication and channel routing.

### 4) Human-in-the-Loop Governance
- Escalation policy for strategic/irreversible actions.
- Configurable approval thresholds.
- Clear decision logs for auditability.

### 5) Agent Runtime & Configuration
- Local execution by default.
- Configurable adapters for local CLI agents.
- Agent capabilities, roles, and routing rules defined in config.
- Optional external endpoint adapters for team extension.

### 6) Privacy & Security
- Privacy-first architecture with local hosting as the default mode.
- Explicit control over which connectors/endpoints are enabled.
- Data minimization and traceability for sensitive actions.

## Suggested Initial Roadmap

### Phase 1 — Core Local Platform
1. Base coordinator + worker agent runtime.
2. Channel model (team/department/project/private).
3. Local config files for agents, roles, and routing.

### Phase 2 — Frontend Experiences
1. Web UI for channels, agent status, and approvals.
2. App UI with shared authentication/session model.

### Phase 3 — Connectors & Integrations
1. Signal/WhatsApp/Discord bridges.
2. External team-extension endpoints.

### Phase 4 — Governance & Hardening
1. Human strategy escalation workflows.
2. Audit trails, permission boundaries, and privacy controls.

## Status

This repository currently documents the platform direction and requirements. Implementation should prioritize local-first architecture, modular connectors, and clear human oversight for strategy decisions.

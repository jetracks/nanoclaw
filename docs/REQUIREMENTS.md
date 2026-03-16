# NanoClaw Requirements

This document captures the current OpenAI-first NanoClaw design constraints.

## Product Goals

- small enough to understand end to end
- local-first and easy to fork
- secure by container isolation rather than application-only permission checks
- customizable by editing code and memory files instead of adding a large config surface
- useful as both a containerized agent host and a personal-ops assistant shell

## Core Runtime Requirements

- one host Node.js process
- one SQLite database
- file-based IPC between host and container agents
- one container image for agent execution
- OpenAI Responses runtime inside the container
- Node.js 22.x as the supported local runtime

## Provider Requirements

- `OPENAI_API_KEY` is required
- default model is `gpt-5.4`
- `OPENAI_BASE_URL` is optional for compatible gateways or proxies
- no Anthropic runtime path remains in core

## Isolation Requirements

- every registered group has its own folder under `groups/`
- every group has isolated OpenAI session state under `data/sessions/<group>/openai/`
- host secrets must stay outside the container
- the host credential proxy injects OpenAI auth on outbound requests
- operator UI, local channel, and credential proxy mutation paths require host-generated session tokens

## Memory Requirements

- `AGENTS.md` is the primary memory file name
- legacy `CLAUDE.md` is still readable for compatibility
- global memory lives under `groups/global/`
- group memory lives under `groups/<group>/`

## Tooling Requirements

The container runtime must support:

- local shell execution
- patch application
- web search
- NanoClaw task management tools
- NanoClaw messaging tools
- NanoClaw-managed subagents
- host-backed IPC reads for sanitized personal-ops data when enabled

## Scheduling Requirements

- tasks are stored in SQLite
- tasks run in the originating group context
- main may schedule or manage tasks across groups
- non-main groups may only manage their own tasks

## Operator UI Requirements

The primary product surface is the localhost operator UI.

Current primary pages:

- `Today`
- `Inbox`
- `Work`
- `Review`

Secondary pages:

- `Calendar`
- `Reports`
- `History`
- `Connections`
- `Admin`

The UI must remain able to:

- inspect groups, tasks, transcript state, and runtime health
- drive personal-ops flows for Today, Inbox, Work, Review, and Connections
- keep `/admin/legacy` available for compatibility

## Personal Ops Requirements

When enabled, personal-ops mode must remain:

- local-first
- host-managed
- read-only toward external providers in the current product flow
- explainable and correctable

Current supported provider classes:

- Google mail and calendar
- Microsoft mail and calendar
- Jira Cloud issues
- Slack message sync
- local git and repo activity

Current product model:

- attention classification and open-loop derivation
- review queues, approvals, memory facts, improvement tickets, and assistant questions
- account-aware learning for shared vendor/service email senders
- retroactive recomputation of surfaced views when corrections or learned state change

## Remote Control Requirements

- keep the `/remote-control` and `/remote-control-end` chat surface
- back them with a NanoClaw localhost inspector
- never depend on a provider-hosted remote-control session

## Documentation Source of Truth

Treat these as current:

- `README.md`
- `AGENTS.md`
- `docs/README.md`
- current runtime code under `src/` and `container/agent-runner/`

Historical Claude-era design notes remain in the repo for migration context, but they are not the current contract.

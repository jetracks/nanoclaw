# NanoClaw Requirements

This document captures the current OpenAI-first design constraints for NanoClaw.

## Product Goals

- small enough to understand end to end
- local-first and easy to fork
- secure by container isolation rather than application-only permission checks
- customizable by editing code and memory files instead of adding a large config surface

## Core Runtime

- one host Node.js process
- one SQLite database
- file-based IPC between host and container agents
- one container image for agent execution
- OpenAI Responses runtime inside the container

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

## Scheduling Requirements

- tasks are stored in SQLite
- tasks run in the originating group context
- main may schedule or manage tasks across groups
- non-main groups may only manage their own tasks

## Remote Control Requirements

- keep the `/remote-control` and `/remote-control-end` chat surface
- back them with a NanoClaw localhost inspector
- never depend on a provider-hosted remote-control session

## Documentation Source of Truth

Treat these as current:

- `README.md`
- `AGENTS.md`
- current runtime code under `src/` and `container/agent-runner/`

Historical Claude-era design notes may remain in the repo for migration context, but they are not the current contract.

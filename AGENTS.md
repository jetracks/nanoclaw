# NanoClaw

OpenAI-first local assistant runtime. This file is the primary repo guide for operators and contributors.

## Quick Context

- Host runtime: Node.js orchestrator with SQLite, IPC, scheduling, and per-group queueing.
- Agent runtime: OpenAI Responses inside `container/agent-runner`.
- Isolation model: every group runs in its own container workspace with explicitly mounted paths only.
- Memory model: `groups/*/AGENTS.md` is primary, `groups/*/CLAUDE.md` is legacy fallback.
- Remote control: localhost inspector URL served by NanoClaw, not a provider-hosted session.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main host orchestrator |
| `src/container-runner.ts` | Starts and streams agent containers |
| `container/agent-runner/src/index.ts` | OpenAI runtime inside the container |
| `src/task-scheduler.ts` | Scheduled task execution |
| `src/db.ts` | SQLite schema and accessors |
| `src/credential-proxy.ts` | Injects OpenAI auth outside the container |
| `src/remote-control.ts` | Local inspector server |

## Commands

```bash
npm run build
npm test
npm run dev
npm --prefix container/agent-runner run build
./container/build.sh
```

Setup helpers:

```bash
./setup.sh
npm run setup -- --step environment
npm run setup -- --step container --runtime docker
npm run setup -- --step service
npm run setup -- --step verify
```

## Environment

Required:

- `OPENAI_API_KEY`

Common optional variables:

- `OPENAI_MODEL`
- `OPENAI_REASONING_EFFORT`
- `OPENAI_BASE_URL`
- `OPENAI_ORGANIZATION`
- `OPENAI_PROJECT`
- `ASSISTANT_NAME`

Legacy Anthropic-only configuration is no longer valid.

## Skills

Repo-local skills still live under `.claude/skills/`, but they are just checked-in `SKILL.md` workflows. They are no longer coupled to a Claude runtime and can be consumed by Codex/OpenAI-driven development flows as plain repo assets.

## Development Notes

- Prefer keeping the host/runtime boundary explicit: host owns secrets and authorization, container owns execution.
- Do not reintroduce provider-specific session mounts like `.claude/`.
- Preserve `AGENTS.md` as the primary memory file whenever adding setup or registration flows.
- Keep remote control local-only and tokenized.

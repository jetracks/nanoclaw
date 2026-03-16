<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  NanoClaw is a local-first AI assistant that runs each group in its own container sandbox.<br>
  The core runtime now uses OpenAI, while keeping NanoClaw's existing queueing, SQLite state, IPC, and per-group isolation model.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>
</p>

---

## What NanoClaw Is

NanoClaw is a small Node.js orchestrator that:

- receives messages from installed channels
- keeps each group isolated in its own workspace and session state
- runs an OpenAI agent inside a container sandbox
- lets the agent schedule tasks, send follow-up messages, and use local tools

The project stays intentionally small: one host process, one SQLite database, file-based IPC, and a container image for agent execution.

## Runtime Requirement

NanoClaw is pinned to Node 22 through `.nvmrc`. Use the project version before install, build, test, or start:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use
```

If `better-sqlite3` was built under a different Node version earlier, `npm start` now auto-rebuilds it for the active Node 22 runtime.

## Quick Start

```bash
git clone https://github.com/jetracks/nanoclaw.git
cd nanoclaw
cp .env.example .env
```

Set at least:

```bash
OPENAI_API_KEY=...
```

Then install, build, and start:

```bash
npm ci
npm run build
./container/build.sh
npm start
```

If you want NanoClaw managed as a service, use the setup helpers instead of starting it directly:

```bash
./setup.sh
npm run setup -- --step environment
npm run setup -- --step container --runtime docker
npm run setup -- --step service
npm run setup -- --step verify
```

Use `--runtime apple-container` on macOS if you prefer Apple Container over Docker. The setup step persists `CONTAINER_RUNTIME` into `.env`, and the live host now uses that same runtime.

## Runtime Model

- OpenAI Responses API drives the container agent runtime.
- Default model is `gpt-5.4`.
- Built-in agent tools are local shell, apply patch, web search, NanoClaw task tools, messaging tools, and NanoClaw-managed subagents.
- Session state is stored per group under `data/sessions/<group>/openai/`.
- `AGENTS.md` is the primary memory file. Legacy `CLAUDE.md` files are still read as fallback.
- `/remote-control` now opens a localhost inspector URL rather than a hosted provider session.

## Configuration

Required:

- `OPENAI_API_KEY`

Optional:

- `LOCAL_CHANNEL_ENABLED`
- `LOCAL_CHANNEL_PORT`
- `OPERATOR_UI_ENABLED`
- `OPERATOR_UI_PORT`
- `PERSONAL_OPS_ENABLED`
- `PERSONAL_OPS_PUSH_MAIN_CHAT`
- `PERSONAL_OPS_STORE_DIR`
- `PERSONAL_OPS_CLASSIFICATION_MODEL`
- `PERSONAL_OPS_REPORT_MODEL`
- `PERSONAL_OPS_ACTIVE_START_HOUR`
- `PERSONAL_OPS_ACTIVE_END_HOUR`
- `CONTAINER_RUNTIME`
- `OPENAI_MODEL`
- `OPENAI_REASONING_EFFORT`
- `OPENAI_BASE_URL`
- `OPENAI_ORGANIZATION`
- `OPENAI_PROJECT`
- `ASSISTANT_NAME`
- `REMOTE_CONTROL_PORT`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_TENANT_ID`
- `JIRA_CLIENT_ID`
- `JIRA_CLIENT_SECRET`
- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`

NanoClaw intentionally fails verification if the repo is configured only with legacy Anthropic variables. There is no Claude runtime path anymore.

## What It Supports

- Per-group container isolation with read-only host mounts where possible
- Persistent OpenAI conversations with NanoClaw-managed compaction
- Global and group memory files
- Scheduled tasks with task history stored in SQLite
- File-based IPC between the host and container agent
- Local remote-control inspector for active groups
- Built-in localhost UAT channel for macOS and local testing
- Optional channels and integrations added through repo-local skills or fork-specific patches

## Memory

Primary memory files:

- `groups/global/AGENTS.md`
- `groups/<group>/AGENTS.md`

Compatibility fallback:

- `groups/global/CLAUDE.md`
- `groups/<group>/CLAUDE.md`

When both exist, `AGENTS.md` wins.

## Architecture

```text
Channels -> SQLite -> Host queue -> Container runner -> OpenAI Responses -> Tool calls
```

Host responsibilities:

- channel polling and routing
- task scheduling
- credential proxying
- per-group queueing and state
- remote-control inspector

Container responsibilities:

- OpenAI turn execution
- local shell and patch application
- transcript persistence
- conversation compaction
- IPC task and messaging requests

## Development

Useful commands:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use
npm run build
npm test
npm run dev
npm --prefix container/agent-runner run build
./container/build.sh
```

## Operator UI

NanoClaw includes a separate localhost operator UI for UAT and daily control. The new React app is served by the existing NanoClaw host on the same port, and the previous server-rendered console remains available at `/admin/legacy`.

Default URL:

```bash
http://127.0.0.1:8788
```

Config:

```bash
OPERATOR_UI_ENABLED=true
OPERATOR_UI_PORT=8788
```

Frontend build and dev commands:

```bash
npm run build:ui
npm run dev:ui
```

The operator UI lets you:

- open a personal-ops-first dashboard with `Today`, `Inbox`, `Calendar`, `Workboard`, `History`, `Reports`, `Connections`, and `Admin`
- inspect registered groups and current runtime/session state from the `Admin` screen
- view a readable conversation feed and transcript/tool activity
- send simulated inbound messages, direct active-agent input, and real outbound channel messages
- create, edit, pause, resume, and cancel scheduled tasks
- connect Google, Microsoft, and Jira for personal-ops sync
- inspect personal-ops today/inbox/calendar/workboard/history/report views
- add manual tasks and notes, maintain the client/project registry, and record corrections

If the port is busy, NanoClaw logs a warning and keeps running without the dashboard.

## Personal Ops

NanoClaw can also run as a local-first personal operations assistant.

Product/behavior notes:

- [Personal Ops Assistant](./docs/PERSONAL_OPS_ASSISTANT.md)

What it adds:

- Google OAuth for Gmail + Google Calendar
- Microsoft OAuth for Outlook mail + calendar
- Jira Cloud OAuth for read-only issue sync
- a host-only personal-ops SQLite store outside the repo mounts
- morning brief and end-of-day wrap generation
- chat commands like `/today`, `/inbox`, `/calendar`, `/standup`, `/wrap`, `/history`, `/what-changed`, `/task`, `/note`, and `/correct`
- soft triage guidance per connected account so the model can interpret inboxes in role context instead of relying only on deterministic matching

Default host-only store locations:

- macOS: `~/Library/Application Support/NanoClaw/personal-ops/`
- Linux: `~/.config/nanoclaw/personal-ops/`

Public normalized snapshots for the main container tools are written to:

```bash
data/personal-ops/public/
```

These snapshots are safe to mount into the container because they exclude provider tokens and raw provider payloads.

## Local UAT Channel

If you want NanoClaw to run locally without wiring an external chat provider first, enable the built-in localhost channel:

```bash
LOCAL_CHANNEL_ENABLED=true
LOCAL_CHANNEL_PORT=8787
```

Register a local main group:

```bash
npm run setup -- --step register -- \
  --jid local:main \
  --name "Local Main" \
  --trigger "@Andy" \
  --folder main \
  --channel local \
  --is-main
```

Then start NanoClaw and send inbound UAT traffic from another terminal:

```bash
curl -X POST http://127.0.0.1:8787/inbound \
  -H 'content-type: application/json' \
  -d '{"chatJid":"local:main","text":"@Andy say hello from UAT"}'

curl http://127.0.0.1:8787/outbox?chatJid=local%3Amain
```

Main code paths:

- `src/index.ts` host orchestrator
- `src/container-runner.ts` container lifecycle and streaming
- `container/agent-runner/src/index.ts` OpenAI runtime inside the container
- `src/task-scheduler.ts` scheduled task execution
- `src/credential-proxy.ts` host-side OpenAI auth injection
- `src/operator-ui.ts` separate localhost operator dashboard
- `src/remote-control.ts` localhost inspector server

## Customization

NanoClaw is meant to be customized in code, not through a large config surface.

- Adjust repo and operator guidance in `AGENTS.md`.
- Store durable assistant memory in `groups/*/AGENTS.md`.
- Add channels or integrations through repo-local `SKILL.md` workflows, scripts, or branch patches.

The repo still contains some historical Claude-era documents for migration context. Treat `README.md`, `AGENTS.md`, and the current runtime code as the source of truth.

## Requirements

- Node.js 22.x
- Docker or Apple Container
- An OpenAI API key

## Docs

- [AGENTS.md](AGENTS.md)
- [docs/SECURITY.md](docs/SECURITY.md)
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)
- [docs/docker-sandboxes.md](docs/docker-sandboxes.md)

## License

MIT

<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  NanoClaw is a local-first AI assistant host that runs each group in its own container sandbox.<br>
  The current runtime is OpenAI-first and keeps NanoClaw's queueing, SQLite state, IPC, and per-group isolation model.
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

The project stays intentionally small: one host process, one SQLite database, file-based IPC, and one agent container image.

## Runtime Requirement

NanoClaw is pinned to Node 22 through `.nvmrc`. Use the project version before install, build, test, or start:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use
```

If `better-sqlite3` was built under a different Node version earlier, `npm start` now rebuilds it for the active Node 22 runtime.

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

Useful lifecycle commands:

```bash
npm run stop
npm run restart
```

If you want NanoClaw managed as a service, use the setup helpers instead of starting it directly:

```bash
./setup.sh
npm run setup -- --step environment
npm run setup -- --step container --runtime docker
npm run setup -- --step service
npm run setup -- --step verify
```

Use `--runtime apple-container` on macOS if you prefer Apple Container over Docker. The setup step persists `CONTAINER_RUNTIME` into `.env`, and the live host uses that same runtime.

## Runtime Model

- OpenAI Responses API drives the container agent runtime.
- Default model is `gpt-5.4`.
- Built-in agent tools are local shell, apply patch, web search, NanoClaw task tools, messaging tools, and NanoClaw-managed subagents.
- Session state is stored per group under `data/sessions/<group>/openai/`.
- `AGENTS.md` is the primary memory file. Legacy `CLAUDE.md` files are still read as fallback.
- `/remote-control` opens a localhost inspector URL rather than a provider-hosted session.

High-level flow:

```text
Channels -> SQLite -> Host queue -> Container runner -> OpenAI Responses -> Tool calls
```

Host responsibilities:

- channel polling and routing
- task scheduling
- credential proxying
- per-group queueing and state
- remote-control inspector
- operator UI and personal-ops APIs

Container responsibilities:

- OpenAI turn execution
- local shell and patch application
- transcript persistence
- conversation compaction
- IPC task, messaging, and personal-ops snapshot requests

## Configuration

Required:

- `OPENAI_API_KEY`

Common optional settings:

- `OPENAI_MODEL`
- `OPENAI_REASONING_EFFORT`
- `OPENAI_BASE_URL`
- `OPENAI_ORGANIZATION`
- `OPENAI_PROJECT`
- `CONTAINER_RUNTIME`
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

NanoClaw intentionally fails verification if the repo is configured only with legacy Anthropic variables. There is no Claude runtime path in core anymore.

## Operator UI

NanoClaw includes a localhost operator UI for UAT and day-to-day use. The React app is served by the existing host, and the previous server-rendered console remains available at `/admin/legacy`.

Default URL:

```text
http://127.0.0.1:8788
```

Config:

```bash
OPERATOR_UI_ENABLED=true
OPERATOR_UI_PORT=8788
```

Primary navigation:

- `Today`
- `Inbox`
- `Work`
- `Review`

Secondary navigation under `More`:

- `Calendar`
- `Reports`
- `History`
- `Connections`
- `Admin`

Route aliases:

- `/workboard` redirects to `/work`
- `/queue` redirects to `/review?tab=approvals`

The operator UI lets you:

- work a curated daily cockpit from `Today`
- triage inbound from `Inbox`
- manage open loops and workstreams from `Work`
- handle approvals, suggestions, memory, improvements, and noise controls from `Review`
- inspect runtime state, transcripts, and scheduled tasks from `Admin`
- connect Google, Microsoft, Jira, and Slack for personal-ops sync
- maintain clients, projects, repos, account defaults, and triage guidance from `Connections`

Frontend build and dev commands:

```bash
npm run build:ui
npm run dev:ui
```

## Personal Ops

NanoClaw can also run as a local-first personal operations assistant.

Current product notes:

- [Personal Ops Assistant](./docs/PERSONAL_OPS_ASSISTANT.md)

What it adds:

- Google OAuth for Gmail and Google Calendar
- Microsoft OAuth for Outlook mail and calendar
- Jira Cloud OAuth for read-only issue sync
- Slack OAuth for read-only message sync
- a host-only personal-ops SQLite store outside repo mounts
- `Today`, `Inbox`, `Work`, and `Review` personal-ops workflows
- morning brief, standup, wrap, and report generation
- client/project registry, repo attachment, and correction workflows
- assistant questions, review queues, approvals, memory facts, and internal improvement tickets
- account-aware learning so shared vendor/service mail can be routed by account context instead of global sender defaults

Default host-only store locations:

- macOS: `~/Library/Application Support/NanoClaw/personal-ops/`
- Linux: `~/.config/nanoclaw/personal-ops/`

NanoClaw still writes normalized host-side JSON views to:

```text
data/personal-ops/public/
```

Those files are for host/UI/reporting use. The main container now reads sanitized personal-ops snapshots from the host over IPC rather than by mounting those snapshot files into the container.

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

Then start NanoClaw. The local channel writes its auth token to:

```text
data/local-channel/server.json
```

Example UAT flow:

```bash
TOKEN=$(node -p "require('./data/local-channel/server.json').authToken")

curl -X POST http://127.0.0.1:8787/inbound \
  -H 'content-type: application/json' \
  -H "x-nanoclaw-local-token: $TOKEN" \
  -d '{"chatJid":"local:main","text":"@Andy say hello from UAT"}'

curl "http://127.0.0.1:8787/outbox?chatJid=local%3Amain&token=$TOKEN"
```

## Security Model

NanoClaw's main security goals are:

- keep secrets on the host
- keep groups isolated from each other
- keep the trusted surface small and auditable
- keep agent power bounded by explicit mounts, IPC authorization, and container execution

Important current boundaries:

- real OpenAI credentials stay on the host behind a credential proxy
- operator UI mutation APIs require a session token injected into the served app
- local UAT channel APIs require the local channel token from `data/local-channel/server.json`
- remote-control sessions use random localhost tokens
- personal-ops provider tokens and raw payloads stay in the host-only store

See [docs/SECURITY.md](docs/SECURITY.md) for the current security model.

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

Main code paths:

- `src/index.ts` host orchestrator
- `src/container-runner.ts` container lifecycle and streaming
- `container/agent-runner/src/index.ts` OpenAI runtime inside the container
- `src/task-scheduler.ts` scheduled task execution
- `src/credential-proxy.ts` host-side OpenAI auth injection
- `src/operator-ui.ts` localhost operator dashboard and APIs
- `src/remote-control.ts` localhost inspector server
- `src/personal-ops/` personal-ops providers, storage, and derivation logic

## Customization

NanoClaw is meant to be customized in code, not through a large config surface.

- Adjust repo and operator guidance in `AGENTS.md`.
- Store durable assistant memory in `groups/*/AGENTS.md`.
- Add channels or integrations through checked-in `SKILL.md` workflows, scripts, or fork-specific patches.

The repo still contains historical design notes for migration context. Treat `README.md`, `AGENTS.md`, `docs/README.md`, and the current runtime code as the source of truth.

## Requirements

- Node.js 22.x
- Docker or Apple Container
- An OpenAI API key

## Docs

- [AGENTS.md](AGENTS.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [docs/README.md](docs/README.md)
- [docs/SECURITY.md](docs/SECURITY.md)
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)
- [docs/docker-sandboxes.md](docs/docker-sandboxes.md)
- [docs/APPLE-CONTAINER-NETWORKING.md](docs/APPLE-CONTAINER-NETWORKING.md)
- [docs/PERSONAL_OPS_ASSISTANT.md](docs/PERSONAL_OPS_ASSISTANT.md)

## License

MIT

# Running NanoClaw in Docker Sandboxes

This guide describes the current OpenAI-based sandbox model at a high level.

## Architecture

```text
Host
└── NanoClaw host process
    ├── channel adapters
    ├── SQLite / scheduler / IPC
    ├── OpenAI credential proxy
    └── container spawner
        └── nanoclaw-agent container
            └── OpenAI Responses runtime with local tools
```

## Requirements

- Docker Desktop or another supported Docker runtime
- Node.js 20+
- `OPENAI_API_KEY`

## Container Expectations

The agent container is responsible for:

- OpenAI turn execution
- local shell calls
- patch application
- transcript persistence
- writing IPC task and message requests

The host is responsible for:

- channel I/O
- secret management
- task authorization
- session persistence on disk

## Credential Flow

Containers do not receive the real OpenAI key.

Instead they receive:

- a proxy base URL
- a placeholder API key

The host proxy injects:

- `Authorization: Bearer <real key>`
- optional organization and project headers

## Manual Bring-Up

```bash
cp .env.example .env
# set OPENAI_API_KEY
npm ci
npm run build
./container/build.sh
npm start
```

Optional setup helpers:

```bash
./setup.sh
npm run setup -- --step environment
npm run setup -- --step container --runtime docker
npm run setup -- --step service
npm run setup -- --step verify
```

## Notes

- historical Claude-era sandbox notes have been removed from this guide
- if you need migration context, inspect git history or the archived design docs

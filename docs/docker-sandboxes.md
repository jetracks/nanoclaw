# Running NanoClaw in Docker Sandboxes

This guide describes the current OpenAI-based sandbox model at a high level.

## Architecture

```text
Host
└── NanoClaw host process
    ├── channel adapters
    ├── SQLite / scheduler / IPC
    ├── OpenAI credential proxy
    ├── operator UI / personal-ops APIs
    └── container spawner
        └── nanoclaw-agent container
            └── OpenAI Responses runtime with local tools
```

## Requirements

- Docker Desktop or another supported Docker runtime
- Node.js 22.x
- `OPENAI_API_KEY`

## Container Expectations

The agent container is responsible for:

- OpenAI turn execution
- local shell calls
- patch application
- transcript persistence
- writing IPC task and message requests
- reading sanitized host data through approved IPC paths

The host is responsible for:

- channel I/O
- secret management
- task authorization
- session persistence on disk
- operator UI APIs
- personal-ops provider sync and host-side storage

## Credential Flow

Containers do not receive the real OpenAI key.

Instead they receive:

- a proxy base URL
- a placeholder API key
- a per-process proxy auth token used only for host communication

The host proxy injects:

- `Authorization: Bearer <real key>`
- optional organization and project headers

The credential proxy itself requires:

- `x-nanoclaw-proxy-token`

## Manual Bring-Up

```bash
cp .env.example .env
# set OPENAI_API_KEY
source "$HOME/.nvm/nvm.sh" && nvm use
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

Optional setup helpers:

```bash
./setup.sh
npm run setup -- --step environment
npm run setup -- --step container --runtime docker
npm run setup -- --step service
npm run setup -- --step verify
```

## Notes

- personal-ops provider tokens and raw payloads stay host-side
- the main container reads sanitized personal-ops snapshots over IPC rather than by mounting raw provider data
- historical Claude-era sandbox notes are not the current contract
- if you need migration context, inspect git history or the archived design docs listed in `docs/README.md`

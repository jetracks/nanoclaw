# NanoClaw Security Model

## Current Trust Model

| Entity | Trust level | Notes |
| --- | --- | --- |
| Host process | Trusted | Owns credentials, routing, authorization, local UI, and container lifecycle |
| Main group | Trusted admin context | Can register groups and manage cross-group tasks |
| Non-main groups | Untrusted input | Other humans may be malicious or compromised |
| Container agents | Sandboxed | Execute inside isolated containers with explicit mounts only |
| Personal-ops providers | External | Google, Microsoft, Jira, Slack, and similar upstream systems |

NanoClaw is local-first, not zero-trust against the local machine owner. The security model is about minimizing blast radius inside the app, keeping provider credentials on the host, and reducing cross-group leakage.

## Primary Boundaries

### Container Isolation

Each group runs inside its own container workspace.

- the container runs as an unprivileged user
- only explicitly mounted paths are visible
- repo root can be mounted read-only
- writable paths are restricted to the group workspace, IPC directories, and per-group session state
- group state is isolated under `groups/<group>/` and `data/sessions/<group>/openai/`

### Credential Isolation

Real OpenAI credentials never enter the container.

The host starts a credential proxy and injects authentication headers outside the sandbox:

1. the container receives `OPENAI_BASE_URL=http://host-gateway:<port>/v1`
2. the container receives a placeholder `OPENAI_API_KEY`
3. the OpenAI client sends requests to the host proxy
4. the host proxy replaces placeholder auth with the real `OPENAI_API_KEY`
5. optional `OPENAI_ORGANIZATION` and `OPENAI_PROJECT` headers are added on the host side

The proxy also requires an internal per-process secret header:

- `x-nanoclaw-proxy-token`

This keeps the real key out of container env vars, files, and process state.

### Operator UI Authorization

The React operator UI is served by NanoClaw itself. Mutating APIs are not anonymous localhost endpoints anymore.

- the host injects a per-session token into the served HTML
- state-changing UI calls must send `x-nanoclaw-operator-token`
- the current server-rendered console remains at `/admin/legacy`, but it is behind the same host-side authorization checks

### Local UAT Channel Authorization

The local channel is bound to localhost, but it also requires its own random token.

- token location: `data/local-channel/server.json`
- required header: `x-nanoclaw-local-token`
- the same token may also be provided as `?token=...`

This protects the local inbox/outbox endpoints from arbitrary local web pages.

### Remote Control Authorization

`/remote-control` opens a NanoClaw-served localhost inspector with a random session token.

- tokens are generated cryptographically
- the inspector is localhost-only
- it can inject follow-up input into an active group

### Session Isolation

Each group gets its own session directory under:

```text
data/sessions/<group>/openai/
```

This directory stores transcript JSONL, summaries, and compaction metadata for that group only.

Legacy `.claude/` session data may still exist on disk after migration, but it is not the active runtime path.

### IPC Authorization

The host validates task, messaging, and personal-ops snapshot operations against the originating group.

Main group:

- may register groups
- may view and manage tasks across groups
- may schedule tasks for other groups

Non-main groups:

- may message only their own chat
- may manage only their own tasks

## Memory and Files

Primary memory files:

- `groups/global/AGENTS.md`
- `groups/<group>/AGENTS.md`

Legacy fallback files:

- `groups/global/CLAUDE.md`
- `groups/<group>/CLAUDE.md`

When both exist, `AGENTS.md` takes precedence.

## Personal Ops Boundary

Personal-ops provider tokens and raw provider payloads stay in the host-only store:

- macOS: `~/Library/Application Support/NanoClaw/personal-ops/`
- Linux: `~/.config/nanoclaw/personal-ops/`

Current behavior:

- provider `access_token` and `refresh_token` values live only in the host-side personal-ops database
- raw provider payloads are stored only in the host-side personal-ops store
- the host still writes normalized views under `data/personal-ops/public/` for host/UI/reporting use
- the main container now reads sanitized personal-ops snapshots over IPC instead of consuming mounted snapshot files directly

This is materially safer than the older model, but it is still a local-first system. Host compromise or local malware still has access to host-side files.

## File Permissions

NanoClaw tries to use tighter permissions for local secrets and state where practical:

- local channel state and outbox files are created with restrictive modes
- operator and remote-control session files use host-only permissions where applicable
- personal-ops DB and snapshot directories are created with restrictive host permissions where possible

This reduces casual leakage but is not a substitute for full OS keychain integration.

## Security Goals

- keep secrets on the host
- keep cross-group state isolated
- keep the trusted surface small and auditable
- keep agent power bounded by mounts, IPC authorization, and container execution
- make localhost operator surfaces require explicit session tokens
- keep personal-ops provider writes disabled by default in current product flows

## Non-Goals

- defending against the local machine owner
- making provider data unreadable to privileged host malware
- providing a multi-tenant server-side security boundary

For the active runtime contract, follow `README.md`, `docs/REQUIREMENTS.md`, and the current code under `src/` and `container/agent-runner/`.

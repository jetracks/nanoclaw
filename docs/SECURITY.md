# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Notes |
|--------|-------------|-------|
| Host process | Trusted | Owns credentials, routing, authorization, and container lifecycle |
| Main group | Trusted admin context | Can register groups and manage cross-group tasks |
| Non-main groups | Untrusted input | Other humans may be malicious or compromised |
| Container agents | Sandboxed | Execute inside isolated containers with explicit mounts only |

## Primary Boundaries

### Container Isolation

Each group runs inside its own container workspace.

- the container runs as an unprivileged user
- only explicitly mounted paths are visible
- project root can be mounted read-only
- writable paths are restricted to the group workspace, IPC directories, and per-group session state

### Credential Isolation

Real OpenAI credentials never enter the container.

The host starts a credential proxy and injects authentication headers outside the sandbox:

1. the container receives `OPENAI_BASE_URL=http://host-gateway:proxy/v1`
2. the container receives a placeholder `OPENAI_API_KEY`
3. the OpenAI client sends requests to the host proxy
4. the host proxy replaces placeholder auth with the real `OPENAI_API_KEY`
5. optional `OPENAI_ORGANIZATION` and `OPENAI_PROJECT` headers are added on the host side

This keeps the real API key out of container env vars, files, and process state.

### Session Isolation

Each group gets its own session directory under:

```text
data/sessions/<group>/openai/
```

This directory stores transcript JSONL, summaries, and compaction metadata for that group only.

Legacy `.claude/` session data may still exist on disk after migration, but it is no longer active.

### IPC Authorization

The host validates task and messaging operations against the originating group.

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

## Remote Control

`/remote-control` now opens a localhost-only inspector URL with a random token.

- the inspector is served by NanoClaw itself
- it exposes active-group state and transcript views
- it can inject follow-up input into an active group
- it does not depend on a provider-hosted browser or remote IDE session

## Security Goals

- keep secrets on the host
- keep cross-group state isolated
- keep the trusted surface small and auditable
- keep agent power bounded by mounts, IPC authorization, and container execution

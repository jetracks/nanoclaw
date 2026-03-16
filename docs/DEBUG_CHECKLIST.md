# NanoClaw Debug Checklist

Use this checklist for the current OpenAI-based runtime.

## 1. Confirm the local runtime

```bash
cd /Users/j.csandoval/OpenClaw/nanoclaw
source "$HOME/.nvm/nvm.sh" && nvm use
node -v
```

NanoClaw expects Node 22.x. If `better-sqlite3` was built under another Node version, use:

```bash
npm run restart
```

## 2. Restart cleanly

```bash
npm run restart
```

If you only need to stop the current instance:

```bash
npm run stop
```

## 3. Check the main localhost services

```bash
lsof -nP -iTCP:8788 -sTCP:LISTEN
lsof -nP -iTCP:8787 -sTCP:LISTEN
lsof -nP -iTCP:3001 -sTCP:LISTEN
```

Typical meanings:

- `8788`: operator UI
- `8787`: local channel when enabled
- `3001`: credential proxy

## 4. Verify build state

```bash
npm run build
npm --prefix container/agent-runner run build
```

If the UI looks stale after changes, rebuild and hard-refresh the browser.

## 5. Check the local UAT channel

State file:

```text
data/local-channel/server.json
```

Quick check:

```bash
cat data/local-channel/server.json
```

The file contains:

- `baseUrl`
- `authToken`
- `inboundPath`
- `outboxPath`

Use that token for manual localhost UAT traffic.

## 6. Check the operator UI

Open:

```text
http://127.0.0.1:8788
```

Useful pages:

- `/today`
- `/inbox`
- `/work`
- `/review`
- `/connections`
- `/admin`
- `/admin/legacy`

If pages are not updating, first try a hard refresh. The UI is tokenized and cached more aggressively than the older server-rendered pages.

## 7. Inspect container logs

Per-group container logs are written under:

```text
groups/<group>/logs/container-*.log
```

Recent logs:

```bash
ls -lt groups/*/logs/container-*.log | head -10
```

Read one:

```bash
cat groups/<group>/logs/container-<timestamp>.log
```

## 8. Inspect OpenAI session state

Per-group session state lives under:

```text
data/sessions/<group>/openai/
```

Common files:

- `current-transcript.jsonl`
- `summary.md`

Quick check:

```bash
ls -la data/sessions/<group>/openai
tail -50 data/sessions/<group>/openai/current-transcript.jsonl
```

## 9. Inspect personal-ops state

Host-only personal-ops store:

- macOS: `~/Library/Application Support/NanoClaw/personal-ops/`
- Linux: `~/.config/nanoclaw/personal-ops/`

Repo-local normalized views:

```text
data/personal-ops/public/
```

Use `Connections`, `Today`, `Inbox`, and `Review` first, then inspect the host store directly only when you need the raw state.

## 10. Typical failure patterns

### Port already in use

Symptom:

- `EADDRINUSE` on `8788`, `8787`, or `3001`

Fix:

```bash
npm run stop
npm run restart
```

### Wrong Node version / native module mismatch

Symptom:

- `better-sqlite3` `NODE_MODULE_VERSION` mismatch

Fix:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use
npm run restart
```

### Operator UI actions return 403

Symptom:

- action APIs fail with missing operator token

Fix:

- reload the operator UI from NanoClaw directly
- avoid using stale tabs or copied API requests without the injected session token

### Local channel requests return 403

Symptom:

- `/inbound` or `/outbox` says a token is required

Fix:

- use the token from `data/local-channel/server.json`

### Personal-ops data looks stale

Fix:

- use `Connections -> Sync now`
- verify the relevant connection is healthy
- check whether the change needs retroactive recomputation from corrected memory or source overrides

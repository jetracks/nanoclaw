# Contributing

## Scope

Accepted core changes:

- bug fixes
- security fixes
- simplifications
- performance or reliability improvements
- documentation updates that keep the repo aligned with the live runtime

Usually not accepted in core:

- broad new product features that belong in a fork
- large compatibility layers for removed runtimes
- provider- or channel-specific growth that is better shipped as an optional add-on

## Runtime Baseline

NanoClaw is pinned to Node 22 through `.nvmrc`.

Before installing, building, testing, or starting:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use
```

If `better-sqlite3` was built under the wrong Node version earlier, `npm start` and the guarded scripts rebuild or stop with a clear runtime error instead of failing later.

## Skills

A skill is a checked-in `SKILL.md` workflow that teaches a coding agent how to transform a NanoClaw fork.

Skills are repo assets, not a provider feature. They can live in this repo, in a sibling repo, or in a Codex skills directory. The important contract is the checked-in `SKILL.md`, not an old `.claude/skills/` path convention.

If you contribute a skill:

- prefer keeping the change isolated to the skill itself rather than modifying core source files
- keep the workflow explicit and auditable
- prefer small, composable repo transformations over broad core branching

## Testing

Run the relevant checks before sending a change:

```bash
npm run build
npm test
npm --prefix container/agent-runner run build
```

For UI-only work:

```bash
npm run build:ui
npm run test:ui
```

For docs-only changes, build or test the affected runtime only when the docs depend on commands, paths, or APIs you also touched.

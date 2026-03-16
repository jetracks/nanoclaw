# Contributing

## Source Changes

Accepted:

- bug fixes
- security fixes
- simplifications
- performance or reliability improvements

Usually not accepted in core:

- broad new product features
- large compatibility layers
- channel-specific growth that is better shipped as an optional add-on

## Skills

A skill is a checked-in `SKILL.md` workflow, typically under `.claude/skills/`, that teaches a coding agent how to transform a NanoClaw fork.

Skills are repo assets, not a provider feature. They can be used by Codex/OpenAI-driven workflows the same way they were previously used by Claude-driven workflows.

If you contribute a skill, prefer keeping the change isolated to the skill itself rather than modifying core source files.

## Testing

Run the relevant checks before sending a change:

```bash
npm test
npm run build
npm --prefix container/agent-runner run build
```

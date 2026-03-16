# Changelog

All notable changes to NanoClaw should be documented in this file.

## [Unreleased]

Current local branch state includes:

- OpenAI-first core runtime with the container agent running through the OpenAI Responses API
- Node 22 runtime pinning and guarded start/build/test scripts
- a localhost React operator UI centered on `Today`, `Inbox`, `Work`, and `Review`
- a localhost-only `/admin/legacy` compatibility console
- token-protected operator UI, local channel, and credential proxy flows
- personal-ops support for Google, Microsoft, Jira, Slack, local git/repo activity, and host-only storage
- personal-ops 2.x workflows including open loops, workstreams, approvals, memory, assistant questions, improvements, and noise controls
- account-aware email learning for shared service/vendor senders
- retroactive recomputation of surfaced views when corrections or learned state change
- `npm run stop` and `npm run restart` lifecycle commands

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)

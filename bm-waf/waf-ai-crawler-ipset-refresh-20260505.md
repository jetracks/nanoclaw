# BettyMills AI Crawler IP Set Refresh - 2026-05-05

## Summary

Refreshed the live AWS WAF IP sets used by the BettyMills AI crawler allow rules.

This update keeps the existing spoof-resistant pattern:

- Source IP must be in the provider IP set.
- User agent must match the expected AI crawler/user-agent token.
- Method must be `GET` or `HEAD`.

## Sources

- OpenAI crawler JSON:
  - `https://openai.com/gptbot.json`
  - `https://openai.com/chatgpt-user.json`
  - `https://openai.com/searchbot.json`
- Anthropic published IP documentation:
  - `https://docs.anthropic.com/en/api/ip-addresses`

## Live Changes

### `ai-openai-crawlers-ipv4`

- Previous count: `284`
- New count: `290`
- Added missing official OpenAI IPv4 CIDRs:
  - `20.113.218.16/28`
  - `20.113.225.112/28`
  - `20.199.211.160/28`
  - `4.226.226.32/28`
  - `51.116.2.64/28`
  - `51.116.2.80/28`

### `ai-anthropic-crawlers-ipv4`

- Previous count: `4`
- New count: `5`
- Added current Anthropic published outbound IPv4 CIDR:
  - `160.79.104.0/21`
- Preserved existing observed Anthropic/Claude ranges, including:
  - `216.73.216.0/22`

The existing observed ClaudeBot ranges were intentionally retained because live logs showed real `ClaudeBot` traffic from that owned range. Removing them would have risked reintroducing Bot Control challenges.

## Validation

- `allow-ai-openai-crawlers` remains priority `8` with `Allow`.
- `allow-ai-anthropic-crawlers` remains priority `9` with `Allow`.
- Public smoke tests after the refresh:
  - `/` returned `200`
  - `/robots.txt` returned `200`
  - `/llms.txt` returned `200`
  - `/llms/products/index.txt` returned `200`
- Sensitive-path smoke test after the refresh:
  - `/.env.development.local` returned WAF CAPTCHA / `405`

## Rollback Backups

Backups were written before updating the live IP sets:

- `/tmp/ai-openai-crawlers-ipv4-backup-pre-refresh-20260505.json`
- `/tmp/ai-anthropic-crawlers-ipv4-backup-pre-refresh-20260505.json`


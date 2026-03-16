# 003 Credential Proxy Drops OPENAI_BASE_URL Path Prefixes

Status: done
Priority: medium

## Problem

The credential proxy rebuilds upstream URLs in a way that discards path prefixes from custom `OPENAI_BASE_URL` values.

## Impact

- custom gateways with non-root API prefixes break
- documented optional `OPENAI_BASE_URL` support is incomplete

## Acceptance

- proxy preserves upstream path prefixes when forwarding requests
- regression coverage exists for prefixed base URLs

## Resolution

Fixed in the current working tree by normalizing incoming proxy paths against the configured upstream base path and adding regression coverage in `src/credential-proxy.test.ts`.

# Security Best Practices Report

## Executive summary

This audit treated the repository as hostile and prioritized runtime isolation, secret handling, and supply-chain integrity. The highest-risk issues were real: the main container could read far more host state than intended, the credential proxy could become network-reachable or memory-exhaustible, and both the Docker build and GitHub Actions path relied on mutable upstream inputs. Those specific issues were hardened in this pass. Residual risk remains mainly in build provenance and write-capable automation.

## Critical findings

### SBP-001: Main-group containers could read broad host state from the project root
Impact: A compromised or prompt-injected main-group agent could read host-side runtime data such as SQLite state, logs, and other repo-local artifacts that were never meant to cross the container boundary.

Evidence:
- `src/container-runner.ts:95-145` now builds a curated, symlink-safe readonly mount list instead of mounting the whole repo root.
- `src/container-runner.ts:140-145` limits the main group to a static project view plus its writable group directory.

Status:
- Fixed in this audit.

Mitigation:
- Replaced the broad `projectRoot -> /workspace/project` mount with a curated readonly allowlist.
- Rejected repo-managed symlinks and out-of-tree realpaths before mounting.

### SBP-002: The host credential proxy could fall back to `0.0.0.0` on Linux
Impact: On Linux hosts without a detectable `docker0` bridge, the proxy would have exposed a secret-injecting service on every interface.

Evidence:
- `src/container-runtime.ts:17-44` now fails closed unless it can determine a safe bind address or the operator explicitly sets `CREDENTIAL_PROXY_HOST`.
- `src/index.ts:480-484` resolves the bind address at startup instead of importing a precomputed fallback.

Status:
- Fixed in this audit.

Mitigation:
- Removed the insecure `0.0.0.0` fallback.
- Required explicit operator intent when auto-detection is unsafe.

### SBP-003: Containers could force unbounded buffering in the credential proxy
Impact: An adversarial container could force host-side memory or socket exhaustion by streaming oversized bodies or hanging proxy requests.

Evidence:
- `src/credential-proxy.ts:26-54` adds upstream URL validation and rejects unsafe cleartext remote targets by default.
- `src/credential-proxy.ts:79-189` adds request size limits, request and upstream timeouts, and strips more hop-by-hop/proxy auth headers.

Status:
- Fixed in this audit.

Mitigation:
- Added an 8 MiB request cap.
- Added request and upstream timeouts.
- Rejected non-loopback HTTP upstreams unless `ALLOW_INSECURE_ANTHROPIC_BASE_URL=true`.

### SBP-004: Repo-managed runtime prompts and runner code could persist into agent sessions
Impact: A hostile checkout could push prompt-supply-chain content or self-modified runtime code directly into future sessions, bypassing normal code review expectations.

Evidence:
- `src/container-runner.ts:208-229` makes repo-bundled `container/skills` opt-in and symlink-safe.
- `src/container-runner.ts:222-244` no longer mounts a per-group writable `/app/src` overlay.

Status:
- Fixed in this audit.

Mitigation:
- Disabled automatic loading of repo-bundled skills unless `NANOCLAW_ENABLE_BUNDLED_SKILLS=true`.
- Removed the persistent writable agent-runner source overlay.

## High findings

### SBP-005: Build and automation supply chain relied on mutable upstream references
Evidence:
- `container/Dockerfile:4-49` now pins `agent-browser` and `@anthropic-ai/claude-code` to exact versions and uses `npm ci` for the local runner.
- `package.json:39-40` overrides vulnerable `rollup` to `4.59.0`.
- `.github/workflows/ci.yml:7-19`, `.github/workflows/update-tokens.yml:9-45`, `.github/workflows/merge-forward-skills.yml:7-159`, and `.github/workflows/bump-version.yml:8-35` now pin external actions to immutable SHAs and declare explicit permissions.

Status:
- Partially fixed in this audit.

Mitigation:
- Pinned GitHub Actions to commit SHAs.
- Added least-privilege `permissions` blocks.
- Removed the known high-severity `rollup` advisory from the lockfile.

Residual risk:
- `container/Dockerfile:4` still uses a floating base tag (`node:22-slim`) rather than a digest.
- Global npm installs are version-pinned but not integrity-locked via a checked-in lockfile or internal registry mirror.

### SBP-006: Setup paths still had shell-trusting execution patterns
Evidence:
- `setup/platform.ts:57-136` now uses direct process execution for browser opening and executable discovery.
- `setup/service.ts:119-299` replaces path-interpolated `launchctl`, `pkill`, and `systemctl` shell strings with argumentized execution.
- `setup/container.ts:56-130` replaces shell-built `docker`/`container` checks and test invocations with direct `execFileSync`.
- `setup/groups.ts:184-199` now runs the temporary sync script via `process.execPath` from a temporary directory.

Status:
- Fixed in this audit.

Mitigation:
- Reduced shell interpolation in setup flows that handle filesystem paths and operator environment.

## Medium findings

### SBP-007: Write-capable GitHub workflows still auto-commit and auto-push
Evidence:
- `.github/workflows/update-tokens.yml:37-45`
- `.github/workflows/merge-forward-skills.yml:68-86`
- `.github/workflows/bump-version.yml:25-35`

Status:
- Residual.

Why it matters:
- These workflows are now action-pinned, but they still have write authority and can propagate bad state quickly if branch protection, secret hygiene, or maintainer review is bypassed.

Recommended follow-up:
- Require protected branches with mandatory reviews and status checks.
- Consider moving auto-commit jobs behind manual approval or bot-only protected branches.

### SBP-008: Additional mounts remain powerful when the external allowlist is broad
Evidence:
- `src/mount-security.ts:1-280`
- `src/container-runner.ts:234-241`

Status:
- Residual.

Why it matters:
- The code enforces an external allowlist and readonly defaults, but a permissive operator-maintained allowlist can still reintroduce sensitive host exposure.

Recommended follow-up:
- Keep allowlists narrow, prefer readonly roots, and review them as security policy rather than convenience config.

## Validation and verification

Commands run:
- `npm run typecheck`
- `npm test`
- `npm audit --package-lock-only --json`

Results:
- Typecheck passed.
- All `221` tests passed.
- `npm audit --package-lock-only` reported `0` vulnerabilities after the lockfile update.

Known non-blocker:
- `npm run format:check` still reports pre-existing formatting drift in `src/remote-control.ts` and `src/remote-control.test.ts`. Those files were not part of this hardening change.

## Report output

This report was written to `/Users/j.csandoval/ms-nano-claw/security_best_practices_report.md`.

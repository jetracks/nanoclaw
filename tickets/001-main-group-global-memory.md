# 001 Main Group Global Memory Mount Regression

Status: done
Priority: high

## Problem

The OpenAI port stopped mounting `/workspace/global` for the main group, but the container runner still expects that path for shared memory loading and global-memory writes.

## Impact

- main group no longer auto-loads global memory
- main group cannot write the documented `/workspace/global/AGENTS.md` path

## Acceptance

- main group mounts `/workspace/global`
- main group can read and write global memory
- regression coverage exists for the main-group mount behavior

## Resolution

Fixed in the current working tree by restoring the `/workspace/global` mount for the main group and adding regression coverage in `src/container-runner.test.ts`.

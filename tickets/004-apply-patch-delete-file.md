# 004 apply_patch Delete Operations Fail

Status: done
Priority: medium

## Problem

The apply-patch execution path requires `operation.diff` for every call, so delete operations are rejected before execution.

## Impact

- the OpenAI `apply_patch` parity layer cannot delete files
- coding flows that rely on delete operations regress

## Acceptance

- `delete_file` operations succeed
- create and update behavior stays intact
- regression coverage exists for delete operations

## Resolution

Fixed in the current working tree by extracting apply-patch execution into `container/agent-runner/src/apply-patch-operation.ts` and adding regression coverage for delete and update flows.

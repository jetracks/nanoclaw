# 002 Compaction Does Not Reset Response Chain

Status: done
Priority: high

## Problem

Compaction clears `previousResponseId`, but the final session-state merge writes the last response ID back into state, so the next turn still resumes the old chain.

## Impact

- compaction does not reduce future context pressure
- summary files do not become the primary continuation source

## Acceptance

- compacted conversations return a fresh session state with no prior response chain
- regression coverage exists for the post-compaction merge behavior

## Resolution

Fixed in the current working tree by extracting turn-session merge logic into `container/agent-runner/src/openai-session-state.ts` and adding regression coverage there.

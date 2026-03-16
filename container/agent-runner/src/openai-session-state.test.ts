import { describe, expect, it } from 'vitest';

import {
  createIsolatedSubagentSessionState,
  didCompactConversation,
  mergeTurnSessionState,
  OpenAISessionState,
} from './openai-session-state.js';

describe('openai-session-state', () => {
  it('detects when compaction reset the response chain', () => {
    const before: OpenAISessionState = {
      provider: 'openai',
      previousResponseId: 'resp_before',
      compactedAt: undefined,
      compactionCount: 0,
    };
    const after: OpenAISessionState = {
      provider: 'openai',
      previousResponseId: undefined,
      compactedAt: '2026-03-14T00:00:00.000Z',
      compactionCount: 1,
    };

    expect(didCompactConversation(before, after)).toBe(true);
  });

  it('keeps the chain cleared after compaction', () => {
    const before: OpenAISessionState = {
      provider: 'openai',
      previousResponseId: 'resp_before',
      compactionCount: 0,
    };
    const after: OpenAISessionState = {
      provider: 'openai',
      previousResponseId: undefined,
      compactedAt: '2026-03-14T00:00:00.000Z',
      compactionCount: 1,
    };

    expect(
      mergeTurnSessionState(
        before,
        after,
        'resp_after',
        'conv_after',
        '/tmp/transcript.jsonl',
        '/tmp/summary.md',
      ),
    ).toEqual({
      provider: 'openai',
      previousResponseId: undefined,
      conversationId: undefined,
      compactedAt: '2026-03-14T00:00:00.000Z',
      compactionCount: 1,
      transcriptPath: '/tmp/transcript.jsonl',
      summaryPath: '/tmp/summary.md',
    });
  });

  it('creates isolated transcript and summary files for subagents', () => {
    expect(
      createIsolatedSubagentSessionState('/tmp/openai-session', {
        now: 123,
        random: () => 0.5,
      }),
    ).toEqual({
      provider: 'openai',
      transcriptPath: '/tmp/openai-session/subagent-123-i.jsonl',
      summaryPath: '/tmp/openai-session/subagent-123-i-summary.md',
    });
  });
});

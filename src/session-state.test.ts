import { describe, expect, it } from 'vitest';

import {
  normalizeSessionState,
  serializeSessionState,
} from './session-state.js';

describe('session-state', () => {
  it('round-trips structured OpenAI session state', () => {
    const serialized = serializeSessionState({
      provider: 'openai',
      previousResponseId: 'resp_123',
      conversationId: 'conv_456',
      transcriptPath: '/tmp/transcript.jsonl',
      summaryPath: '/tmp/summary.md',
      compactedAt: '2026-03-14T00:00:00.000Z',
      compactionCount: 2,
    });

    expect(normalizeSessionState(serialized)).toEqual({
      provider: 'openai',
      previousResponseId: 'resp_123',
      conversationId: 'conv_456',
      transcriptPath: '/tmp/transcript.jsonl',
      summaryPath: '/tmp/summary.md',
      compactedAt: '2026-03-14T00:00:00.000Z',
      compactionCount: 2,
      invalidatedLegacySessionId: undefined,
    });
  });

  it('invalidates legacy non-JSON session ids', () => {
    expect(normalizeSessionState('legacy-claude-session-id')).toEqual({
      provider: 'openai',
      invalidatedLegacySessionId: 'legacy-claude-session-id',
    });
  });

  it('treats malformed JSON as legacy session data', () => {
    expect(normalizeSessionState('{not-json')).toEqual({
      provider: 'openai',
      invalidatedLegacySessionId: '{not-json',
    });
  });
});

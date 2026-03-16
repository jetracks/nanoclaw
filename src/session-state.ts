export interface OpenAISessionState {
  provider: 'openai';
  previousResponseId?: string;
  conversationId?: string;
  transcriptPath?: string;
  summaryPath?: string;
  compactedAt?: string;
  compactionCount?: number;
  invalidatedLegacySessionId?: string;
}

export function normalizeSessionState(
  raw: string | null | undefined,
): OpenAISessionState | undefined {
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as Partial<OpenAISessionState> | null;
    if (!parsed || typeof parsed !== 'object') {
      return {
        provider: 'openai',
        invalidatedLegacySessionId: raw,
      };
    }

    return {
      provider: 'openai',
      previousResponseId: parsed.previousResponseId,
      conversationId: parsed.conversationId,
      transcriptPath: parsed.transcriptPath,
      summaryPath: parsed.summaryPath,
      compactedAt: parsed.compactedAt,
      compactionCount: parsed.compactionCount,
      invalidatedLegacySessionId: parsed.invalidatedLegacySessionId,
    };
  } catch {
    return {
      provider: 'openai',
      invalidatedLegacySessionId: raw,
    };
  }
}

export function serializeSessionState(
  state: OpenAISessionState | undefined,
): string | undefined {
  if (!state) return undefined;
  return JSON.stringify(state);
}

import path from 'path';

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

export function didCompactConversation(
  before: OpenAISessionState,
  after: OpenAISessionState,
): boolean {
  return (
    after.previousResponseId === undefined &&
    ((after.compactedAt || '') !== (before.compactedAt || '') ||
      (after.compactionCount || 0) !== (before.compactionCount || 0))
  );
}

export function mergeTurnSessionState(
  beforeCompaction: OpenAISessionState,
  compactedState: OpenAISessionState,
  responseId: string,
  conversationId: string | undefined,
  transcriptPath: string,
  summaryPath: string,
): OpenAISessionState {
  const compacted = didCompactConversation(beforeCompaction, compactedState);

  return {
    ...compactedState,
    provider: 'openai',
    previousResponseId: compacted ? undefined : responseId,
    conversationId: compacted
      ? undefined
      : conversationId || compactedState.conversationId,
    transcriptPath,
    summaryPath,
  };
}

export function createIsolatedSubagentSessionState(
  sessionRoot: string,
  options?: {
    now?: number;
    random?: () => number;
  },
): OpenAISessionState {
  const now = options?.now ?? Date.now();
  const randomValue = options?.random ? options.random() : Math.random();
  const randomToken = randomValue.toString(36).split('.')[1] || 'run';
  const suffix = `${now}-${randomToken}`;

  return {
    provider: 'openai',
    transcriptPath: path.join(sessionRoot, `subagent-${suffix}.jsonl`),
    summaryPath: path.join(sessionRoot, `subagent-${suffix}-summary.md`),
  };
}

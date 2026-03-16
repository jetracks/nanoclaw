export interface TranscriptEvent {
  ts: string;
  kind: string;
  prompt?: string;
  output_text?: string;
  name?: string;
  tool_type?: string;
  [key: string]: unknown;
}

export interface TranscriptAssistantMessage {
  timestamp: string;
  text: string;
}

export interface TranscriptToolEvent {
  timestamp: string;
  name: string;
  summary: string;
}

export function summarizePrompt(prompt: string): string {
  const matches = Array.from(
    prompt.matchAll(
      /<message sender="([^"]*)" time="([^"]*)">([\s\S]*?)<\/message>/g,
    ),
  );

  if (matches.length === 0) {
    return prompt.trim();
  }

  return matches
    .map(([, sender, time, content]) => `[${time}] ${sender}: ${content.trim()}`)
    .join('\n');
}

export function parseTranscriptEvents(
  rawTranscript: string,
  limit = 120,
): TranscriptEvent[] {
  return rawTranscript
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TranscriptEvent];
      } catch {
        return [];
      }
    });
}

export function formatTranscript(rawTranscript: string): string {
  const formatted = parseTranscriptEvents(rawTranscript).map((event) => {
    const ts = typeof event.ts === 'string' ? event.ts : 'unknown-time';

    if (event.kind === 'user_prompt') {
      const prompt =
        typeof event.prompt === 'string' ? summarizePrompt(event.prompt) : '';
      return [`[${ts}] User`, prompt].filter(Boolean).join('\n');
    }

    if (event.kind === 'response') {
      const outputText =
        typeof event.output_text === 'string' ? event.output_text.trim() : '';
      return [`[${ts}] Assistant`, outputText || '(no visible response text)'].join(
        '\n',
      );
    }

    if (event.kind === 'tool') {
      const toolName =
        typeof event.name === 'string'
          ? event.name
          : typeof event.tool_type === 'string'
            ? event.tool_type
            : 'tool';
      return `[${ts}] Tool: ${toolName}`;
    }

    return `[${ts}] ${JSON.stringify(event)}`;
  });

  return formatted.join('\n\n');
}

export function extractAssistantMessages(
  rawTranscript: string,
  limit = 60,
): TranscriptAssistantMessage[] {
  return parseTranscriptEvents(rawTranscript, limit * 3)
    .filter(
      (event) =>
        event.kind === 'response' &&
        typeof event.ts === 'string' &&
        typeof event.output_text === 'string' &&
        event.output_text.trim().length > 0,
    )
    .slice(-limit)
    .map((event) => ({
      timestamp: event.ts,
      text: event.output_text!.trim(),
    }));
}

export function extractToolEvents(
  rawTranscript: string,
  limit = 60,
): TranscriptToolEvent[] {
  return parseTranscriptEvents(rawTranscript, limit * 3)
    .filter((event) => event.kind === 'tool' && typeof event.ts === 'string')
    .slice(-limit)
    .map((event) => {
      const name =
        typeof event.name === 'string'
          ? event.name
          : typeof event.tool_type === 'string'
            ? event.tool_type
            : 'tool';
      const payloadSummary =
        event.payload === undefined ? '' : JSON.stringify(event.payload).slice(0, 240);
      return {
        timestamp: event.ts,
        name,
        summary: payloadSummary,
      };
    });
}

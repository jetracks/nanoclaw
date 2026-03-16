import { describe, expect, it } from 'vitest';

import {
  extractAssistantMessages,
  extractToolEvents,
  formatTranscript,
  summarizePrompt,
} from './transcript-view.js';

describe('transcript-view', () => {
  it('summarizes XML-style prompts into readable lines', () => {
    expect(
      summarizePrompt(
        '<messages>\n<message sender="Local User" time="Mar 14, 2026, 11:00 AM">hello</message>\n</messages>',
      ),
    ).toContain('Local User: hello');
  });

  it('formats transcript events into readable text', () => {
    const transcript = [
      JSON.stringify({
        ts: '2026-03-14T18:00:00.000Z',
        kind: 'user_prompt',
        prompt:
          '<messages>\n<message sender="Local User" time="Mar 14, 2026, 11:00 AM">hello</message>\n</messages>',
      }),
      JSON.stringify({
        ts: '2026-03-14T18:00:01.000Z',
        kind: 'response',
        output_text: 'Hi there.',
      }),
    ].join('\n');

    expect(formatTranscript(transcript)).toContain(
      '[2026-03-14T18:00:00.000Z] User',
    );
    expect(formatTranscript(transcript)).toContain('Hi there.');
  });

  it('extracts assistant messages and tool events', () => {
    const transcript = [
      JSON.stringify({
        ts: '2026-03-14T18:00:01.000Z',
        kind: 'response',
        output_text: 'Hi there.',
      }),
      JSON.stringify({
        ts: '2026-03-14T18:00:02.000Z',
        kind: 'tool',
        tool_type: 'function_call',
        name: 'send_message',
        payload: { ok: true },
      }),
    ].join('\n');

    expect(extractAssistantMessages(transcript)).toEqual([
      { timestamp: '2026-03-14T18:00:01.000Z', text: 'Hi there.' },
    ]);
    expect(extractToolEvents(transcript)).toEqual([
      {
        timestamp: '2026-03-14T18:00:02.000Z',
        name: 'send_message',
        summary: '{"ok":true}',
      },
    ]);
  });
});

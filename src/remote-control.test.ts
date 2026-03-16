import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = '/tmp/nanoclaw-remote-control-test';
fs.mkdirSync(dataDir, { recursive: true });

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-remote-control-test',
  REMOTE_CONTROL_PORT: 0,
}));

import {
  _resetForTesting,
  configureRemoteControl,
  getActiveSession,
  listenRemoteControlServer,
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';

class FakeRemoteControlServer extends EventEmitter {
  constructor(
    private readonly mode: 'success' | 'error' | 'no-address',
    private readonly port = 43123,
  ) {
    super();
  }

  listen(_port: number, _host: string, callback: () => void): this {
    queueMicrotask(() => {
      if (this.mode === 'error') {
        this.emit('error', new Error('listen EADDRINUSE: address already in use'));
        return;
      }

      callback();
    });
    return this;
  }

  address(): { address: string; family: string; port: number } | null {
    if (this.mode === 'no-address') {
      return null;
    }

    return {
      address: '127.0.0.1',
      family: 'IPv4',
      port: this.port,
    };
  }

  close(): this {
    return this;
  }
}

describe('remote-control', () => {
  const sendInput = vi.fn(() => true);

  beforeEach(() => {
    _resetForTesting();
    sendInput.mockReset();
    sendInput.mockReturnValue(true);
    configureRemoteControl({
      getGroups: () => [
        {
          chatJid: 'tg:123',
          name: 'Main',
          folder: 'main',
          active: true,
          idleWaiting: false,
          transcriptPath: path.join(dataDir, 'transcript.jsonl'),
          previousResponseId: 'resp_123',
        },
      ],
      sendInput,
    });
    fs.writeFileSync(
      path.join(dataDir, 'transcript.jsonl'),
      [
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
      ].join('\n') + '\n',
    );
  });

  afterEach(() => {
    stopRemoteControl();
    _resetForTesting();
  });

  it('starts a localhost inspector session and returns the URL', async () => {
    const result = await startRemoteControl('user1', 'tg:123');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/remote-control\//);

    const session = getActiveSession();
    expect(session?.startedBy).toBe('user1');
    expect(session?.startedInChat).toBe('tg:123');
  });

  it('returns the existing session URL if already active', async () => {
    const first = await startRemoteControl('user1', 'tg:123');
    const second = await startRemoteControl('user2', 'tg:456');
    expect(first).toEqual(second);
  });

  it('serves state and transcript data through the inspector API', async () => {
    const result = await startRemoteControl('user1', 'tg:123');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const token = result.url.split('/').pop()!;
    const stateRes = await fetch(
      `http://127.0.0.1:${getActiveSession()!.port}/api/session/${token}/state`,
    );
    const state: any = await stateRes.json();
    expect(state.ok).toBe(true);
    expect(state.groups[0].chatJid).toBe('tg:123');

    const transcriptRes = await fetch(
      `http://127.0.0.1:${getActiveSession()!.port}/api/session/${token}/transcript?chatJid=tg%3A123`,
    );
    const transcript: any = await transcriptRes.json();
    expect(transcript.ok).toBe(true);
    expect(transcript.transcript).toContain('User');
    expect(transcript.transcript).toContain('Local User: hello');
    expect(transcript.transcript).toContain('Assistant');
    expect(transcript.transcript).toContain('Hi there.');
  });

  it('injects follow-up input into an active group', async () => {
    const result = await startRemoteControl('user1', 'tg:123');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const token = result.url.split('/').pop()!;
    const response = await fetch(
      `http://127.0.0.1:${getActiveSession()!.port}/api/session/${token}/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatJid: 'tg:123', text: 'follow up' }),
      },
    );
    const payload: any = await response.json();
    expect(payload.ok).toBe(true);
    expect(sendInput).toHaveBeenCalledWith('tg:123', 'follow up');
  });

  it('restoreRemoteControl clears stale persisted state', () => {
    fs.writeFileSync(
      path.join(dataDir, 'remote-control.json'),
      JSON.stringify({ stale: true }),
    );
    restoreRemoteControl();
    expect(getActiveSession()).toBeNull();
    expect(fs.existsSync(path.join(dataDir, 'remote-control.json'))).toBe(false);
  });

  it('stops the current session', async () => {
    const result = await startRemoteControl('user1', 'tg:123');
    expect(result.ok).toBe(true);
    const stopped = stopRemoteControl();
    expect(stopped).toEqual({ ok: true });
    expect(getActiveSession()).toBeNull();
  });

  it('surfaces bind failures when the inspector server cannot listen', async () => {
    await expect(
      listenRemoteControlServer(new FakeRemoteControlServer('error') as any, 43123),
    ).resolves.toEqual({
      ok: false,
      error: 'listen EADDRINUSE: address already in use',
    });
  });
});

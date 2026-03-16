import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalChannel, LocalChannel } from './local.js';

describe('local channel', () => {
  const stateDir = path.join('/tmp', 'nanoclaw-local-channel-test');

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('returns null when disabled', () => {
    expect(
      createLocalChannel(
        {
          onMessage: () => {},
          onChatMetadata: () => {},
          registeredGroups: () => ({}),
        },
        {
          enabled: false,
          host: '127.0.0.1',
          port: 0,
          stateDir,
        },
      ),
    ).toBeNull();
  });

  it('accepts inbound messages and exposes outbound messages over HTTP', async () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const channel = createLocalChannel(
      {
        onMessage,
        onChatMetadata,
        registeredGroups: () => ({}),
      },
      {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
        stateDir,
      },
    ) as LocalChannel;

    await channel.connect();

    const inboundResponse = await fetch(`${channel.getBaseUrl()}/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nanoclaw-local-token': channel.getAuthToken(),
      },
      body: JSON.stringify({
        chatJid: 'local:main',
        chatName: 'Local Main',
        sender: 'local:tester',
        senderName: 'UAT Tester',
        text: 'hello from local channel',
      }),
    });

    expect(inboundResponse.status).toBe(202);
    expect(onChatMetadata).toHaveBeenCalledWith(
      'local:main',
      expect.any(String),
      'Local Main',
      'local',
      true,
    );
    expect(onMessage).toHaveBeenCalledWith(
      'local:main',
      expect.objectContaining({
        chat_jid: 'local:main',
        sender: 'local:tester',
        sender_name: 'UAT Tester',
        content: 'hello from local channel',
      }),
    );

    await channel.sendMessage('local:main', 'assistant reply');
    const outboxResponse = await fetch(
      `${channel.getBaseUrl()}/outbox?chatJid=local%3Amain&token=${channel.getAuthToken()}`,
    );
    const outbox = (await outboxResponse.json()) as {
      ok: boolean;
      messages: Array<{ jid: string; text: string }>;
    };
    expect(outbox.ok).toBe(true);
    expect(outbox.messages).toEqual([
      expect.objectContaining({
        jid: 'local:main',
        text: 'assistant reply',
      }),
    ]);

    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it('rejects unauthenticated inbound requests', async () => {
    const channel = createLocalChannel(
      {
        onMessage: () => {},
        onChatMetadata: () => {},
        registeredGroups: () => ({}),
      },
      {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
        stateDir,
      },
    ) as LocalChannel;

    await channel.connect();

    const inboundResponse = await fetch(`${channel.getBaseUrl()}/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatJid: 'local:main', text: 'hello' }),
    });

    expect(inboundResponse.status).toBe(403);

    await channel.disconnect();
  });
});

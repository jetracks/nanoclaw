import { randomBytes } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  LOCAL_CHANNEL_ENABLED,
  LOCAL_CHANNEL_HOST,
  LOCAL_CHANNEL_PORT,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

interface LocalChannelConfig {
  enabled: boolean;
  host: string;
  port: number;
  stateDir: string;
}

interface LocalInboundPayload {
  chatJid?: string;
  chatName?: string;
  sender?: string;
  senderName?: string;
  text?: string;
  isGroup?: boolean;
}

interface LocalOutboundMessage {
  jid: string;
  text: string;
  sentAt: string;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore
  }
}

function appendJsonLine(filePath: string, value: object): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  res.statusCode = statusCode;
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export class LocalChannel implements Channel {
  readonly name = 'local';

  private readonly stateFilePath: string;
  private readonly outboxFilePath: string;
  private readonly outbox: LocalOutboundMessage[] = [];
  private readonly authToken = randomBytes(24).toString('hex');
  private server: Server | null = null;
  private connected = false;
  private boundPort: number | null = null;

  constructor(
    private readonly opts: ChannelOpts,
    private readonly config: LocalChannelConfig,
  ) {
    this.stateFilePath = path.join(this.config.stateDir, 'server.json');
    this.outboxFilePath = path.join(this.config.stateDir, 'outbox.jsonl');
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    ensureDir(this.config.stateDir);
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        logger.error({ err }, 'Local channel request failed');
        writeJson(res, 500, { ok: false, error: 'Internal server error.' });
      });
    });

    await new Promise<void>((resolve, reject) => {
      const currentServer = this.server!;
      const onError = (err: Error): void => {
        currentServer.off('error', onError);
        reject(err);
      };

      currentServer.once('error', onError);
      currentServer.listen(this.config.port, this.config.host, () => {
        currentServer.off('error', onError);
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to determine local channel address.');
    }

    this.boundPort = address.port;
    this.connected = true;
    fs.writeFileSync(
      this.stateFilePath,
      JSON.stringify(
        {
          host: this.config.host,
          port: this.boundPort,
          baseUrl: this.getBaseUrl(),
          authToken: this.authToken,
          inboundPath: '/inbound',
          outboxPath: '/outbox',
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    logger.info(
      { baseUrl: this.getBaseUrl(), stateFile: this.stateFilePath },
      'Local channel listening',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const outboundMessage: LocalOutboundMessage = {
      jid,
      text,
      sentAt: new Date().toISOString(),
    };

    this.outbox.push(outboundMessage);
    appendJsonLine(this.outboxFilePath, outboundMessage);
    logger.info({ jid, text }, 'Local channel sent outbound message');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('local:');
  }

  async disconnect(): Promise<void> {
    if (!this.server) {
      this.connected = false;
      this.boundPort = null;
      return;
    }

    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
    this.connected = false;
    this.boundPort = null;

    try {
      fs.unlinkSync(this.stateFilePath);
    } catch {
      // ignore
    }
  }

  async syncGroups(_force: boolean): Promise<void> {
    // Local UAT traffic does not require platform-side sync.
  }

  getBaseUrl(): string {
    if (!this.boundPort) {
      throw new Error('Local channel is not connected.');
    }
    return `http://${this.config.host}:${this.boundPort}`;
  }

  getOutbox(): LocalOutboundMessage[] {
    return [...this.outbox];
  }

  getAuthToken(): string {
    return this.authToken;
  }

  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    const header = req.headers['x-nanoclaw-local-token'];
    const headerValue = Array.isArray(header) ? header[0] || '' : header || '';
    const queryValue = url.searchParams.get('token') || '';
    return headerValue === this.authToken || queryValue === this.authToken;
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://${this.config.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      writeJson(res, 200, {
        ok: true,
        connected: this.connected,
        baseUrl: this.boundPort ? this.getBaseUrl() : null,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/outbox') {
      if (!this.isAuthorized(req, url)) {
        writeJson(res, 403, { ok: false, error: 'Local channel token is required.' });
        return;
      }
      const chatJid = url.searchParams.get('chatJid');
      const messages = chatJid
        ? this.outbox.filter((entry) => entry.jid === chatJid)
        : this.outbox;
      writeJson(res, 200, { ok: true, messages });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/inbound') {
      if (!this.isAuthorized(req, url)) {
        writeJson(res, 403, { ok: false, error: 'Local channel token is required.' });
        return;
      }
      const contentType = req.headers['content-type'] || '';
      const contentTypeValue = Array.isArray(contentType) ? contentType[0] || '' : contentType;
      if (!contentTypeValue.toLowerCase().includes('application/json')) {
        writeJson(res, 415, {
          ok: false,
          error: 'Requests must use Content-Type: application/json.',
        });
        return;
      }
      const rawBody = await readBody(req);
      let payload: LocalInboundPayload = {};
      try {
        payload = JSON.parse(rawBody);
      } catch {
        writeJson(res, 400, { ok: false, error: 'Invalid JSON body.' });
        return;
      }

      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      const chatJid = payload.chatJid || 'local:main';
      if (!text) {
        writeJson(res, 400, { ok: false, error: 'text is required.' });
        return;
      }
      if (!this.ownsJid(chatJid)) {
        writeJson(res, 400, {
          ok: false,
          error: 'chatJid must start with "local:".',
        });
        return;
      }

      const timestamp = new Date().toISOString();
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        payload.chatName || 'Local UAT',
        'local',
        payload.isGroup ?? true,
      );

      const message: NewMessage = {
        id: `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        chat_jid: chatJid,
        sender: payload.sender || 'local:user',
        sender_name: payload.senderName || 'Local User',
        content: text,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };
      this.opts.onMessage(chatJid, message);

      writeJson(res, 202, { ok: true, chatJid, messageId: message.id });
      return;
    }

    writeJson(res, 404, { ok: false, error: 'Not found.' });
  }
}

export function createLocalChannel(
  opts: ChannelOpts,
  config?: Partial<LocalChannelConfig>,
): LocalChannel | null {
  const resolvedConfig: LocalChannelConfig = {
    enabled: LOCAL_CHANNEL_ENABLED,
    host: LOCAL_CHANNEL_HOST,
    port: LOCAL_CHANNEL_PORT,
    stateDir: path.join(DATA_DIR, 'local-channel'),
    ...config,
  };

  if (!resolvedConfig.enabled) {
    return null;
  }

  return new LocalChannel(opts, resolvedConfig);
}

registerChannel('local', (opts) => createLocalChannel(opts));

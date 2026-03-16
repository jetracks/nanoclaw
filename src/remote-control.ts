import { randomBytes } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import fs from 'fs';
import { AddressInfo } from 'net';
import path from 'path';

import { DATA_DIR, REMOTE_CONTROL_PORT } from './config.js';
import { logger } from './logger.js';
import { isAllowedLoopbackHost } from './network-security.js';
import { formatTranscript } from './transcript-view.js';

interface RemoteControlSession {
  token: string;
  url: string;
  startedBy: string;
  startedInChat: string;
  startedAt: string;
  port: number;
}

export interface RemoteControlGroupView {
  chatJid: string;
  name: string;
  folder: string;
  active: boolean;
  idleWaiting: boolean;
  transcriptPath?: string;
  previousResponseId?: string;
}

export interface RemoteControlDependencies {
  getGroups: () => RemoteControlGroupView[];
  sendInput: (chatJid: string, text: string) => boolean;
}

let activeSession: RemoteControlSession | null = null;
let server: Server | null = null;
let dependencies: RemoteControlDependencies | null = null;

const STATE_FILE = path.join(DATA_DIR, 'remote-control.json');

type RemoteControlListenServer = Pick<
  Server,
  'address' | 'close' | 'listen' | 'off' | 'once'
>;

function saveState(session: RemoteControlSession): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(STATE_FILE), 0o700);
  } catch {
    // ignore
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(session), { mode: 0o600 });
}

function clearState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // ignore
  }
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

function html(token: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>NanoClaw Remote Control</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 24px; background: #101418; color: #f2f5f7; }
    h1 { font-size: 20px; }
    .meta { color: #9db0bf; margin-bottom: 16px; }
    .layout { display: grid; grid-template-columns: 320px 1fr; gap: 20px; }
    .panel { border: 1px solid #2d3942; border-radius: 10px; padding: 14px; background: #151b20; }
    button, select, textarea { font: inherit; }
    button { background: #3f8cff; color: white; border: 0; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
    textarea { width: 100%; min-height: 110px; background: #0c1013; color: #f2f5f7; border: 1px solid #2d3942; border-radius: 8px; padding: 10px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0c1013; padding: 10px; border-radius: 8px; min-height: 280px; }
    .group { padding: 8px 0; border-bottom: 1px solid #232c33; }
    .status { color: #74d680; }
    .inactive { color: #d9a066; }
  </style>
</head>
<body>
  <h1>NanoClaw Remote Control</h1>
  <div class="meta">Local inspector session for active NanoClaw groups.</div>
  <div class="layout">
    <div class="panel">
      <strong>Groups</strong>
      <div id="groups"></div>
    </div>
    <div class="panel">
      <strong>Transcript</strong>
      <pre id="transcript">Loading...</pre>
      <div style="margin-top: 16px;">
        <textarea id="message" placeholder="Send follow-up input to an active group"></textarea>
        <div style="margin-top: 10px;">
          <button id="send">Send Input</button>
          <span id="result" style="margin-left: 10px; color: #9db0bf;"></span>
        </div>
      </div>
    </div>
  </div>
  <script>
    const token = ${JSON.stringify(token)};
    let selectedGroup = null;

    async function refresh() {
      const res = await fetch('/api/session/' + token + '/state');
      const state = await res.json();
      const groupsEl = document.getElementById('groups');
      groupsEl.innerHTML = '';
      let firstGroup = null;
      let firstActiveGroup = null;
      for (const group of state.groups) {
        if (!firstGroup) firstGroup = group.chatJid;
        if (!firstActiveGroup && group.active) firstActiveGroup = group.chatJid;
        const div = document.createElement('div');
        div.className = 'group';
        const status = group.active ? 'active' : 'inactive';
        const name = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = group.name;
        name.appendChild(strong);
        const statusLine = document.createElement('div');
        statusLine.className = group.active ? 'status' : 'inactive';
        statusLine.textContent = status;
        const folder = document.createElement('div');
        folder.textContent = group.folder;
        div.appendChild(name);
        div.appendChild(statusLine);
        div.appendChild(folder);
        div.onclick = async () => {
          selectedGroup = group.chatJid;
          await loadTranscript();
        };
        groupsEl.appendChild(div);
      }
      if (!selectedGroup) selectedGroup = firstActiveGroup || firstGroup;
      await loadTranscript();
    }

    async function loadTranscript() {
      if (!selectedGroup) {
        document.getElementById('transcript').textContent = 'No group selected.';
        return;
      }
      const res = await fetch('/api/session/' + token + '/transcript?chatJid=' + encodeURIComponent(selectedGroup));
      const payload = await res.json();
      document.getElementById('transcript').textContent = payload.transcript || 'No transcript data.';
    }

    document.getElementById('send').onclick = async () => {
      const text = document.getElementById('message').value;
      if (!selectedGroup || !text.trim()) return;
      const res = await fetch('/api/session/' + token + '/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatJid: selectedGroup, text })
      });
      const payload = await res.json();
      document.getElementById('result').textContent = payload.ok ? 'Input sent.' : payload.error;
      if (payload.ok) document.getElementById('message').value = '';
      await refresh();
    };

    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}

function notFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end('Not found');
}

function getStatePayload(token: string): Record<string, unknown> {
  if (!activeSession || activeSession.token !== token || !dependencies) {
    return { ok: false, error: 'Invalid or expired token', groups: [] };
  }
  return {
    ok: true,
    startedBy: activeSession.startedBy,
    startedAt: activeSession.startedAt,
    groups: dependencies.getGroups(),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (!isAllowedLoopbackHost(req.headers.host, ['127.0.0.1'])) {
    res.statusCode = 400;
    res.end('Invalid Host header');
    return;
  }
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'remote-control' && parts[1] && req.method === 'GET') {
    if (!activeSession || parts[1] !== activeSession.token) {
      notFound(res);
      return;
    }
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html(parts[1]));
    return;
  }

  if (parts[0] !== 'api' || parts[1] !== 'session' || !parts[2]) {
    notFound(res);
    return;
  }

  const token = parts[2];
  if (!activeSession || activeSession.token !== token || !dependencies) {
    res.statusCode = 403;
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Invalid or expired token' }));
    return;
  }

  if (parts[3] === 'state' && req.method === 'GET') {
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(getStatePayload(token)));
    return;
  }

  if (parts[3] === 'transcript' && req.method === 'GET') {
    const chatJid = url.searchParams.get('chatJid');
    const group = dependencies
      .getGroups()
      .find((entry) => entry.chatJid === chatJid);
    const transcript =
      group?.transcriptPath && fs.existsSync(group.transcriptPath)
        ? formatTranscript(fs.readFileSync(group.transcriptPath, 'utf-8'))
        : '';
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, transcript }));
    return;
  }

  if (parts[3] === 'message' && req.method === 'POST') {
    const contentType = req.headers['content-type'] || '';
    const contentTypeValue = Array.isArray(contentType)
      ? contentType[0] || ''
      : contentType;
    if (!contentTypeValue.toLowerCase().includes('application/json')) {
      res.statusCode = 415;
      res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
      res.setHeader('pragma', 'no-cache');
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ok: false,
          error: 'Requests must use Content-Type: application/json.',
        }),
      );
      return;
    }
    const body = await readBody(req);
    let payload: { chatJid?: string; text?: string } = {};
    try {
      payload = JSON.parse(body);
    } catch {
      // ignore
    }
    const ok =
      typeof payload.chatJid === 'string' &&
      typeof payload.text === 'string' &&
      dependencies.sendInput(payload.chatJid, payload.text);
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        ok
          ? { ok: true }
          : { ok: false, error: 'Group is not active or payload was invalid.' },
      ),
    );
    return;
  }

  notFound(res);
}

export function configureRemoteControl(
  remoteControlDependencies: RemoteControlDependencies,
): void {
  dependencies = remoteControlDependencies;
}

export function restoreRemoteControl(): void {
  clearState();
  activeSession = null;
}

export function getActiveSession(): RemoteControlSession | null {
  return activeSession;
}

export async function listenRemoteControlServer(
  listenServer: RemoteControlListenServer,
  port: number,
): Promise<{ ok: true; port: number } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false;

    const settle = (
      result: { ok: true; port: number } | { ok: false; error: string },
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      listenServer.off('error', onError);
      resolve(result);
    };

    const onError = (err: NodeJS.ErrnoException): void => {
      settle({
        ok: false,
        error: err.message || 'Failed to bind remote control inspector.',
      });
    };

    listenServer.once('error', onError);

    try {
      listenServer.listen(port, '127.0.0.1', () => {
        const address = listenServer.address();
        if (!address || typeof address === 'string') {
          settle({
            ok: false,
            error: 'Failed to determine remote control port.',
          });
          return;
        }

        settle({ ok: true, port: (address as AddressInfo).port });
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      settle({ ok: false, error: errorMessage });
    }
  });
}

/** @internal */
export function _resetForTesting(): void {
  activeSession = null;
  dependencies = null;
  if (server) {
    server.close();
    server = null;
  }
  clearState();
}

export async function startRemoteControl(
  sender: string,
  chatJid: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (activeSession) {
    return { ok: true, url: activeSession.url };
  }
  if (!dependencies) {
    return {
      ok: false,
      error: 'Remote control dependencies are not configured.',
    };
  }

  server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error({ err }, 'Remote control request failed');
      res.statusCode = 500;
      res.end('Internal server error');
    });
  });

  const listenResult = await listenRemoteControlServer(
    server,
    REMOTE_CONTROL_PORT,
  );
  if (!listenResult.ok) {
    logger.error(
      { error: listenResult.error },
      'Failed to start Remote Control session',
    );
    server.close();
    server = null;
    clearState();
    return listenResult;
  }

  const token = randomBytes(24).toString('hex');
  const session: RemoteControlSession = {
    token,
    url: `http://127.0.0.1:${listenResult.port}/remote-control/${token}`,
    startedBy: sender,
    startedInChat: chatJid,
    startedAt: new Date().toISOString(),
    port: listenResult.port,
  };
  activeSession = session;
  saveState(session);
  logger.info(
    { url: session.url, sender, chatJid },
    'Remote Control session started',
  );
  return { ok: true, url: session.url };
}

export function stopRemoteControl():
  | { ok: true }
  | { ok: false; error: string } {
  if (!activeSession || !server) {
    return { ok: false, error: 'No active Remote Control session.' };
  }

  server.close();
  server = null;
  logger.info({ url: activeSession.url }, 'Remote Control session stopped');
  activeSession = null;
  clearState();
  return { ok: true };
}

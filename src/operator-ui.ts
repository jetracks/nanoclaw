import { randomBytes } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import { AddressInfo } from 'net';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  OPERATOR_UI_ENABLED,
  OPERATOR_UI_HOST,
  OPERATOR_UI_PORT,
  TIMEZONE,
} from './config.js';
import { logger } from './logger.js';
import {
  extractAssistantMessages,
  extractToolEvents,
  parseTranscriptEvents,
} from './transcript-view.js';
import {
  AccountScopedContactHint,
  ApprovalQueueItem,
  AssistantQuestion,
  Activity,
  Client,
  ConnectedAccount,
  Contact,
  ContactIdentity,
  ContactMappingSuggestion,
  Correction,
  GitRepository,
  ImprovementTicket,
  MemoryFact,
  NewMessage,
  OpenLoop,
  OpenAISessionState,
  OperatorProfile,
  PersonalOpsConnectionCatalog,
  PersonalOpsConnectionSettings,
  PersonalOpsProvider,
  PersonalOpsQuestionSurface,
  PersonalOpsQuestionTargetType,
  PersonalOpsQuestionUrgency,
  PersonalOpsTodayView,
  PersonalOpsWorkstream,
  Project,
  ReportSnapshot,
  ReviewQueueItem,
  ScheduledTask,
  SourceRecord,
  TaskRunLog,
  WorkItem,
} from './types.js';
import { getSourceRecordKey } from './personal-ops/db.js';
import { getSourceRecord, getWorkItem, parseSourceRecordKey } from './personal-ops/db.js';

interface OperatorUiConversationItem {
  timestamp: string;
  role: 'user' | 'assistant';
  label: string;
  text: string;
  source: 'messages' | 'local-outbox' | 'transcript';
}

export interface OperatorUiGroupView {
  chatJid: string;
  name: string;
  folder: string;
  trigger: string;
  addedAt: string;
  requiresTrigger: boolean;
  isMain: boolean;
  active: boolean;
  idleWaiting: boolean;
  lastMessageTime?: string;
  channel?: string;
  session?: OpenAISessionState;
  transcriptPath?: string;
}

export interface OperatorUiTaskView extends ScheduledTask {
  recentRuns: TaskRunLog[];
}

export interface OperatorUiPersonalOpsDependencies {
  listConnections: () => Array<
    ConnectedAccount & {
      syncJobs: Array<{
        sourceKind: string;
        cursor: string | null;
        lastRunAt: string | null;
        nextRunAt: string | null;
        backoffUntil: string | null;
        status: string;
        error: string | null;
      }>;
    }
  >;
  getToday: () => unknown;
  getInbox: (input?: { includeNoise?: boolean }) => SourceRecord[];
  getCalendar: () => SourceRecord[];
  getWorkboard: () => PersonalOpsWorkstream[];
  getHistory: (input?: {
    since?: string;
    until?: string;
  }) => Activity[];
  getHistoryWorkstreams: (input?: {
    since?: string;
    until?: string;
  }) => PersonalOpsWorkstream[];
  getReports: () => ReportSnapshot[];
  generateReport: (
    reportType: 'morning' | 'standup' | 'wrap' | 'history' | 'what_changed',
    range?: { start?: string; end?: string },
  ) => Promise<ReportSnapshot>;
  getCorrections: () => Correction[];
  getClients: () => Client[];
  getProjects: () => Project[];
  getRepositories: () => GitRepository[];
  getContacts: () => {
    contacts: Contact[];
    identities: ContactIdentity[];
    suggestions: ContactMappingSuggestion[];
    accountHints: AccountScopedContactHint[];
    operatorProfile: OperatorProfile;
  };
  linkContact: (input: {
    contactId: string;
    clientId?: string | null;
    projectId?: string | null;
    likelyRole?: string | null;
    importance?: Contact['importance'];
    notes?: string | null;
    identity?: {
      type: ContactIdentity['type'];
      provider: ContactIdentity['provider'];
      value: string;
      label?: string | null;
    };
  }) => Contact;
  getOpenLoops: () => OpenLoop[];
  getAssistantQuestions: (input?: {
    surface?: PersonalOpsQuestionSurface;
    targetType?: PersonalOpsQuestionTargetType;
    targetId?: string;
    urgency?: PersonalOpsQuestionUrgency;
  }) => AssistantQuestion[];
  answerAssistantQuestion: (input: {
    id: string;
    optionId?: string | null;
    value?: string | null;
  }) => AssistantQuestion;
  dismissAssistantQuestion: (input: {
    id: string;
    reason: 'not_now' | 'resolved' | 'wrong_question';
  }) => AssistantQuestion;
  getApprovalQueue: () => ApprovalQueueItem[];
  approveQueueItem: (id: string) => ApprovalQueueItem;
  rejectQueueItem: (id: string) => ApprovalQueueItem;
  editQueueItem: (
    id: string,
    input: Partial<Pick<ApprovalQueueItem, 'title' | 'summary' | 'body' | 'reason'>>,
  ) => ApprovalQueueItem;
  getMemoryFacts: () => MemoryFact[];
  acceptMemoryFact: (id: string) => void;
  rejectMemoryFact: (id: string) => void;
  getReviewQueue: () => ReviewQueueItem[];
  getImprovementTickets: () => ImprovementTicket[];
  approveImprovementTicket: (id: string) => ImprovementTicket;
  rejectImprovementTicket: (id: string) => ImprovementTicket;
  editImprovementTicket: (
    id: string,
    input: Partial<
      Pick<
        ImprovementTicket,
        | 'title'
        | 'problem'
        | 'observedContext'
        | 'desiredBehavior'
        | 'userValue'
        | 'acceptanceCriteria'
        | 'suggestedSurface'
        | 'suggestedSubsystem'
        | 'notes'
      >
    >,
  ) => ImprovementTicket;
  reviewAccept: (id: string) => void;
  reviewReject: (id: string) => void;
  getOperatorProfile: () => OperatorProfile;
  updateOperatorProfile: (input: Partial<OperatorProfile>) => OperatorProfile;
  beginOAuth: (provider: PersonalOpsProvider, appBaseUrl: string) => string;
  handleOAuthCallback: (
    provider: PersonalOpsProvider,
    code: string,
    state: string,
    appBaseUrl: string,
  ) => Promise<void>;
  disconnect: (input: {
    provider: PersonalOpsProvider;
    accountId: string;
  }) => void;
  getConnectionCatalog: (input: {
    provider: PersonalOpsProvider;
    accountId: string;
  }) => Promise<PersonalOpsConnectionCatalog>;
  updateConnectionSettings: (input: {
    provider: PersonalOpsProvider;
    accountId: string;
    settings: PersonalOpsConnectionSettings;
  }) => ConnectedAccount;
  syncProvider: (input: {
    provider: PersonalOpsProvider;
    accountId: string;
  }) => Promise<void>;
  createManualTask: (input: {
    title: string;
    notes?: string;
    clientId?: string | null;
    projectId?: string | null;
    dueDate?: string | null;
    priority?: 'low' | 'medium' | 'high' | 'urgent';
  }) => WorkItem;
  createManualNote: (input: {
    title: string;
    body?: string;
    clientId?: string | null;
    projectId?: string | null;
  }) => SourceRecord;
  upsertClient: (input: {
    id?: string;
    name: string;
    parentClientId?: string | null;
    roles?: string[];
    status?: Client['status'];
    notes?: string;
    communicationPreferences?: string;
  }) => Client;
  upsertProject: (input: {
    id?: string;
    clientId?: string | null;
    name: string;
    status?: Project['status'];
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    deadline?: string | null;
    notes?: string;
    tags?: string[];
  }) => Project;
  upsertRepository: (input: {
    id?: string;
    clientId?: string | null;
    projectId?: string | null;
    name?: string;
    localPath: string;
    notes?: string;
  }) => GitRepository;
  discoverRepositories: (input?: {
    rootPath?: string;
    maxDepth?: number;
  }) => GitRepository[];
  recordCorrection: (input: {
    targetType: Correction['targetType'];
    targetId: string;
    field: string;
    value: string;
  }) => Correction;
}

export interface OperatorUiDependencies {
  getGroups: () => OperatorUiGroupView[];
  getMessages: (chatJid: string, limit: number) => NewMessage[];
  getTasks: (groupFolder: string) => ScheduledTask[];
  getTaskRuns: (taskId: string, limit: number) => TaskRunLog[];
  injectMessage: (
    chatJid: string,
    text: string,
    sender?: string,
    senderName?: string,
  ) => { ok: true; messageId: string } | { ok: false; error: string };
  sendInput: (chatJid: string, text: string) => boolean;
  sendOutbound: (
    chatJid: string,
    text: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  createTask: (input: {
    chatJid: string;
    groupFolder: string;
    prompt: string;
    scheduleType: 'cron' | 'interval' | 'once';
    scheduleValue: string;
    contextMode: 'group' | 'isolated';
  }) => { ok: true; taskId: string } | { ok: false; error: string };
  updateTask: (input: {
    taskId: string;
    prompt: string;
    scheduleType: 'cron' | 'interval' | 'once';
    scheduleValue: string;
    contextMode: 'group' | 'isolated';
  }) => { ok: true } | { ok: false; error: string };
  pauseTask: (taskId: string) => { ok: true } | { ok: false; error: string };
  resumeTask: (taskId: string) => { ok: true } | { ok: false; error: string };
  cancelTask: (taskId: string) => { ok: true } | { ok: false; error: string };
  personalOps?: OperatorUiPersonalOpsDependencies;
}

interface LocalOutboundMessage {
  jid: string;
  text: string;
  sentAt: string;
}

interface OperatorUiServerState {
  server: Server | null;
  dependencies: OperatorUiDependencies | null;
  url: string | null;
  authToken: string | null;
}

const LOCAL_OUTBOX_PATH = path.join(DATA_DIR, 'local-channel', 'outbox.jsonl');
const UI_DIST_DIR = path.resolve(process.cwd(), 'ui', 'dist');
const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const operatorUiState: OperatorUiServerState = {
  server: null,
  dependencies: null,
  url: null,
  authToken: null,
};

const OPERATOR_UI_AUTH_HEADER = 'x-nanoclaw-operator-token';

function applySecurityHeaders(
  res: ServerResponse,
  options?: { cache?: 'store' | 'no-store'; html?: boolean },
): void {
  const cacheMode = options?.cache || 'no-store';
  res.setHeader(
    'cache-control',
    cacheMode === 'no-store'
      ? 'no-store, no-cache, must-revalidate'
      : 'private, max-age=300',
  );
  res.setHeader('pragma', 'no-cache');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  if (options?.html) {
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  }
}

function ensureOperatorUiAuthToken(): string {
  if (!operatorUiState.authToken) {
    operatorUiState.authToken = randomBytes(32).toString('hex');
  }
  return operatorUiState.authToken;
}

function getOperatorUiTokenScript(): string {
  return `<script>window.__NANOCLAW_OPERATOR_TOKEN__=${JSON.stringify(ensureOperatorUiAuthToken())};</script>`;
}

function injectOperatorUiToken(html: string): string {
  const tokenScript = getOperatorUiTokenScript();
  if (html.includes('</head>')) {
    return html.replace('</head>', `${tokenScript}</head>`);
  }
  return `${tokenScript}${html}`;
}

function requestAuthHeader(req: IncomingMessage): string {
  const value = req.headers[OPERATOR_UI_AUTH_HEADER];
  if (Array.isArray(value)) {
    return value[0] || '';
  }
  return value || '';
}

function hasValidOperatorUiAuth(req: IncomingMessage): boolean {
  return requestAuthHeader(req) === ensureOperatorUiAuthToken();
}

function requireOperatorUiAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (hasValidOperatorUiAuth(req)) {
    return true;
  }
  writeJson(res, 403, { ok: false, error: 'Operator UI session token is required.' });
  return false;
}

function requireJsonRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const contentType = req.headers['content-type'] || '';
  const value = Array.isArray(contentType) ? contentType[0] || '' : contentType;
  if (value.toLowerCase().includes('application/json')) {
    return true;
  }
  writeJson(res, 415, {
    ok: false,
    error: 'Requests must use Content-Type: application/json.',
  });
  return false;
}

function hasBuiltUi(): boolean {
  return fs.existsSync(path.join(UI_DIST_DIR, 'index.html'));
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  res.statusCode = statusCode;
  applySecurityHeaders(res);
  res.setHeader('content-type', 'application/json; charset=utf-8');
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

function getOperatorUiBaseUrl(): string {
  return operatorUiState.url || `http://${OPERATOR_UI_HOST}:${OPERATOR_UI_PORT}`;
}

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function resolveStaticPath(urlPath: string): string | null {
  const normalized = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.(\/|\\|$))+/, '');
  const candidate = path.join(UI_DIST_DIR, normalized);
  const relative = path.relative(UI_DIST_DIR, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}

function serveStaticFile(res: ServerResponse, filePath: string): void {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  res.statusCode = 200;
  applySecurityHeaders(res, {
    cache: filePath.endsWith('.html') ? 'no-store' : 'store',
    html: filePath.endsWith('.html'),
  });
  res.setHeader('content-type', contentTypeFor(filePath));
  res.end(fs.readFileSync(filePath));
}

function serveAppIndex(res: ServerResponse): void {
  const indexPath = path.join(UI_DIST_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  applySecurityHeaders(res, { cache: 'no-store', html: true });
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(injectOperatorUiToken(fs.readFileSync(indexPath, 'utf-8')));
}

function legacyHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NanoClaw Operator</title>
  <style>
    :root {
      --bg: #f4efe7;
      --panel: rgba(255, 252, 247, 0.88);
      --panel-strong: #fffaf2;
      --ink: #1f1710;
      --muted: #6b5848;
      --border: rgba(82, 57, 34, 0.14);
      --shadow: 0 18px 50px rgba(54, 37, 22, 0.1);
      --accent: #b6512d;
      --accent-soft: #f7d8c8;
      --success: #2f7d5d;
      --warning: #a0621b;
      --danger: #b33b2e;
      --user: #efe7ff;
      --assistant: #fff4da;
      --tool: #e5f2ed;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(182, 81, 45, 0.16), transparent 30%),
        radial-gradient(circle at top right, rgba(47, 125, 93, 0.13), transparent 24%),
        linear-gradient(180deg, #f8f4ed 0%, var(--bg) 100%);
      min-height: 100vh;
    }
    .shell {
      display: grid;
      grid-template-columns: 300px minmax(0, 1.25fr) 360px;
      gap: 18px;
      padding: 20px;
      min-height: 100vh;
    }
    .column {
      display: flex;
      flex-direction: column;
      gap: 18px;
      min-height: 0;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 22px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
      overflow: hidden;
    }
    .panel-body { padding: 18px; }
    .hero {
      padding: 22px 22px 18px;
      background:
        linear-gradient(135deg, rgba(182, 81, 45, 0.08), rgba(47, 125, 93, 0.06)),
        var(--panel-strong);
    }
    .eyebrow {
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 8px;
    }
    h1, h2, h3, h4 { margin: 0; font-weight: 600; }
    h1 { font-size: 28px; line-height: 1.05; }
    h2 { font-size: 16px; }
    .hero p, .meta, .hint, .subtle {
      color: var(--muted);
      margin: 0;
      line-height: 1.45;
      font-size: 14px;
    }
    .stack { display: flex; flex-direction: column; gap: 12px; }
    .pill-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.72);
      border: 1px solid var(--border);
      font-size: 12px;
      color: var(--muted);
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--muted);
      display: inline-block;
    }
    .status-dot.active { background: var(--success); }
    .status-dot.waiting { background: var(--warning); }
    .status-dot.inactive { background: #9b8877; }
    .group-list {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: calc(100vh - 260px);
      overflow: auto;
    }
    .group-card {
      width: 100%;
      text-align: left;
      border: 1px solid var(--border);
      border-radius: 18px;
      background: rgba(255,255,255,0.72);
      padding: 14px;
      cursor: pointer;
      transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
    }
    .group-card:hover { transform: translateY(-1px); border-color: rgba(182,81,45,0.4); }
    .group-card.selected {
      border-color: rgba(182,81,45,0.55);
      background: rgba(255, 247, 241, 0.96);
    }
    .group-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    .group-name { font-size: 16px; margin-bottom: 4px; }
    .group-meta { color: var(--muted); font-size: 12px; }
    .live-banner {
      margin-top: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 18px;
      border: 1px solid rgba(82,57,34,0.12);
      background: rgba(255,255,255,0.72);
    }
    .live-banner.active {
      background: linear-gradient(135deg, rgba(215,236,223,0.95), rgba(244,250,246,0.96));
      border-color: rgba(47,125,93,0.22);
    }
    .live-banner.waiting {
      background: linear-gradient(135deg, rgba(242,224,191,0.9), rgba(255,248,236,0.96));
      border-color: rgba(160,98,27,0.18);
    }
    .live-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 14px;
      font-weight: 600;
    }
    .pulse {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--muted);
      box-shadow: 0 0 0 0 rgba(107,88,72,0.25);
    }
    .pulse.active {
      background: var(--success);
      animation: pulse-ring 1.4s infinite;
    }
    .pulse.waiting {
      background: var(--warning);
    }
    @keyframes pulse-ring {
      0% { box-shadow: 0 0 0 0 rgba(47,125,93,0.34); }
      70% { box-shadow: 0 0 0 12px rgba(47,125,93,0); }
      100% { box-shadow: 0 0 0 0 rgba(47,125,93,0); }
    }
    .conversation {
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      overflow: auto;
      min-height: 380px;
      max-height: calc(100vh - 340px);
    }
    .bubble {
      max-width: 88%;
      border-radius: 20px;
      padding: 12px 14px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.4);
      border: 1px solid rgba(0,0,0,0.05);
      align-self: flex-start;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .bubble.user { background: var(--user); align-self: flex-end; }
    .bubble.assistant { background: var(--assistant); }
    .bubble.live {
      background: var(--tool);
      border-style: dashed;
      align-self: flex-start;
    }
    .bubble-title {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .bubble-footer {
      display: flex;
      justify-content: flex-end;
      margin-top: 10px;
    }
    .copy-button {
      padding: 6px 10px;
      font-size: 12px;
      background: rgba(255,255,255,0.78);
      color: var(--muted);
      border: 1px solid rgba(82,57,34,0.14);
    }
    .copy-button.copied {
      background: #d7ecdf;
      color: #164d36;
      border-color: rgba(47,125,93,0.2);
    }
    .copy-button.error {
      background: #f3d5d0;
      color: #712b21;
      border-color: rgba(179,59,46,0.2);
    }
    .composer {
      border-top: 1px solid var(--border);
      padding: 16px 18px 18px;
      background: rgba(255,255,255,0.56);
    }
    .composer textarea,
    .composer input,
    .composer select,
    .task-form textarea,
    .task-form input,
    .task-form select {
      width: 100%;
      border: 1px solid rgba(82,57,34,0.16);
      border-radius: 14px;
      padding: 11px 12px;
      font: inherit;
      background: rgba(255,255,255,0.92);
      color: var(--ink);
    }
    textarea { min-height: 108px; resize: vertical; }
    .composer-actions,
    .task-actions,
    .inline-actions,
    .task-grid {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .task-grid > * { flex: 1 1 150px; }
    button {
      border: 0;
      border-radius: 999px;
      padding: 10px 15px;
      font: inherit;
      cursor: pointer;
      transition: transform 140ms ease, opacity 140ms ease;
    }
    button:hover { transform: translateY(-1px); }
    button:disabled {
      opacity: 0.48;
      cursor: not-allowed;
      transform: none;
    }
    button.primary { background: var(--accent); color: white; }
    button.secondary { background: rgba(255,255,255,0.86); color: var(--ink); border: 1px solid var(--border); }
    button.ghost { background: transparent; color: var(--muted); border: 1px dashed rgba(82,57,34,0.2); }
    button.warning { background: #f1d7b4; color: #53320a; }
    button.success { background: #d7ecdf; color: #164d36; }
    button.danger { background: #f3d5d0; color: #712b21; }
    .section-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 12px;
    }
    .session-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .stat {
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 12px;
      background: rgba(255,255,255,0.72);
    }
    .stat .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .stat .value {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      word-break: break-all;
    }
    .task-list, .event-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-height: 320px;
      overflow: auto;
    }
    .task-card, .event-card {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: rgba(255,255,255,0.74);
      padding: 12px;
    }
    .task-card h4, .event-card h4 { font-size: 14px; margin-bottom: 6px; }
    .task-card p, .event-card p { margin: 0; white-space: pre-wrap; word-break: break-word; }
    .ops-card {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: rgba(255,255,255,0.74);
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .ops-card h4 { font-size: 14px; margin: 0; }
    .ops-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 320px;
      overflow: auto;
    }
    .ops-card pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: inherit;
      color: var(--ink);
    }
    .ops-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .ops-meta {
      font-size: 12px;
      color: var(--muted);
    }
    .status-pill {
      display: inline-flex;
      padding: 4px 8px;
      border-radius: 999px;
      background: var(--accent-soft);
      font-size: 11px;
      color: var(--accent);
    }
    .status-pill.active { background: #d7ecdf; color: #17523a; }
    .status-pill.paused { background: #f2e0bf; color: #80500d; }
    .status-pill.completed { background: #ece8e2; color: #584a3c; }
    .empty {
      padding: 18px;
      border: 1px dashed rgba(82,57,34,0.18);
      border-radius: 16px;
      color: var(--muted);
      text-align: center;
      background: rgba(255,255,255,0.55);
    }
    .footer-note {
      padding: 12px 18px 18px;
      color: var(--muted);
      font-size: 12px;
    }
    .feed-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      color: var(--muted);
      margin-top: 12px;
    }
    @media (max-width: 1220px) {
      .shell { grid-template-columns: 280px 1fr; }
      .right-column { grid-column: 1 / -1; }
    }
    @media (max-width: 900px) {
      .shell { grid-template-columns: 1fr; }
      .group-list, .conversation, .task-list, .event-list { max-height: none; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="column">
      <section class="panel">
        <div class="hero">
          <div class="eyebrow">NanoClaw Operator</div>
          <h1>Local control surface for groups, sessions, and scheduled work.</h1>
          <p id="heroMeta" class="meta">Loading dashboard state…</p>
          <div class="pill-row" id="heroPills"></div>
        </div>
        <div class="group-list" id="groupList"></div>
      </section>
    </div>

    <div class="column">
      <section class="panel">
        <div class="hero">
          <div class="section-title">
            <div>
              <div class="eyebrow">Conversation</div>
              <h2 id="conversationTitle">Select a group</h2>
            </div>
            <div class="pill-row" id="conversationPills"></div>
          </div>
          <p id="conversationMeta" class="meta"></p>
          <div class="live-banner" id="liveBanner">
            <div>
              <div class="live-title">
                <span class="pulse" id="livePulse"></span>
                <span id="liveTitle">Waiting for selection</span>
              </div>
              <p class="meta" id="liveMeta" style="margin-top: 6px;"></p>
            </div>
            <div class="pill" id="pollMeta">Poll 3s</div>
          </div>
          <div class="feed-meta">
            <span id="conversationStats"></span>
            <span id="refreshMeta"></span>
          </div>
        </div>
        <div class="conversation" id="conversationFeed"></div>
        <div class="composer">
          <div class="inline-actions" style="margin-bottom: 10px;">
            <button class="primary" id="sendMessageButton">Queue User Message</button>
            <button class="secondary" id="sendInputButton">Send Input To Active Agent</button>
            <button class="secondary" id="sendOutboundButton">Send Outbound Reply</button>
          </div>
          <textarea id="composerText" placeholder="Write a user message, or inject direct input into the active agent loop."></textarea>
          <div class="composer-actions" style="margin-top: 10px;">
            <input id="senderName" placeholder="Sender name (optional)" />
            <input id="senderId" placeholder="Sender id (optional)" />
          </div>
          <div class="hint" id="composerResult" style="margin-top: 10px;"></div>
        </div>
      </section>
    </div>

    <div class="column right-column">
      <section class="panel">
        <div class="panel-body stack">
          <div class="section-title">
            <div>
              <div class="eyebrow">Session</div>
              <h2>Runtime state</h2>
            </div>
          </div>
          <div class="session-grid" id="sessionGrid"></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-body stack">
          <div class="section-title">
            <div>
              <div class="eyebrow">Tasks</div>
              <h2>Scheduled work</h2>
            </div>
          </div>
          <div class="task-list" id="taskList"></div>
          <div class="task-form stack">
            <textarea id="taskPrompt" placeholder="Task prompt"></textarea>
            <div class="task-grid">
              <select id="taskScheduleType">
                <option value="cron">Cron</option>
                <option value="interval">Interval (ms)</option>
                <option value="once">Once</option>
              </select>
              <input id="taskScheduleValue" placeholder="0 9 * * * | 300000 | 2026-03-15T09:00" />
            </div>
            <div class="task-grid">
              <select id="taskContextMode">
                <option value="group">Group context</option>
                <option value="isolated">Isolated context</option>
              </select>
              <button class="primary" id="createTaskButton">Create Task</button>
            </div>
            <div class="hint" id="taskResult"></div>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-body stack">
          <div class="section-title">
            <div>
              <div class="eyebrow">Personal Ops</div>
              <h2>Connections</h2>
            </div>
          </div>
          <div class="ops-list" id="connectionsList"></div>
          <div class="task-grid">
            <button class="secondary" id="connectGoogleButton">Connect Google</button>
            <button class="secondary" id="connectMicrosoftButton">Connect Microsoft</button>
            <button class="secondary" id="connectJiraButton">Connect Jira</button>
            <button class="secondary" id="connectSlackButton">Connect Slack</button>
          </div>
          <div class="hint" id="connectionsResult"></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-body stack">
          <div class="section-title">
            <div>
              <div class="eyebrow">Today</div>
              <h2>Personal ops brief</h2>
            </div>
          </div>
          <div class="ops-list" id="todayList"></div>
          <div class="task-form stack">
            <input id="manualTaskTitle" placeholder="Quick task title" />
            <input id="manualTaskNotes" placeholder="Task notes (optional)" />
            <div class="task-grid">
              <select id="manualTaskPriority">
                <option value="medium">Medium priority</option>
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="low">Low</option>
              </select>
              <input id="manualTaskDueDate" placeholder="Due date (optional ISO/local)" />
            </div>
            <button class="primary" id="createManualTaskButton">Add Manual Task</button>
            <input id="manualNoteTitle" placeholder="Quick note title" />
            <textarea id="manualNoteBody" placeholder="Manual note body"></textarea>
            <button class="secondary" id="createManualNoteButton">Add Manual Note</button>
            <div class="hint" id="personalOpsEntryResult"></div>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-body stack">
          <div class="section-title">
            <div>
              <div class="eyebrow">Reports</div>
              <h2>Morning, standup, wrap</h2>
            </div>
          </div>
          <div class="ops-list" id="reportsList"></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-body stack">
          <div class="section-title">
            <div>
              <div class="eyebrow">Corrections</div>
              <h2>Overrides and registry</h2>
            </div>
          </div>
          <div class="ops-list" id="correctionsList"></div>
          <div class="task-form stack">
            <input id="clientName" placeholder="Client name" />
            <input id="clientNotes" placeholder="Client notes" />
            <button class="secondary" id="createClientButton">Add Client</button>
            <input id="projectName" placeholder="Project name" />
            <input id="projectClientId" placeholder="Client ID (optional)" />
            <button class="secondary" id="createProjectButton">Add Project</button>
            <input id="correctionTargetType" placeholder="Correction target type" />
            <input id="correctionTargetId" placeholder="Correction target id" />
            <input id="correctionField" placeholder="Field" />
            <input id="correctionValue" placeholder="Value" />
            <button class="warning" id="recordCorrectionButton">Record Correction</button>
            <div class="hint" id="correctionResult"></div>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-body stack">
          <div class="section-title">
            <div>
              <div class="eyebrow">Transcript Events</div>
              <h2>Recent OpenAI/runtime activity</h2>
            </div>
          </div>
          <div class="event-list" id="eventList"></div>
        </div>
        <div class="footer-note">Localhost only. Refreshes automatically every 3 seconds.</div>
      </section>
    </div>
  </div>

  <script>
    const assistantName = ${JSON.stringify(ASSISTANT_NAME)};
    const operatorToken = ${JSON.stringify(ensureOperatorUiAuthToken())};
    const state = {
      selectedChatJid: null,
      dashboard: null,
      refreshTimer: null,
      refreshInFlight: false,
      autoScrollConversation: true,
      lastConversationSignature: '',
    };

    function formatTime(ts) {
      if (!ts) return 'n/a';
      const date = new Date(ts);
      if (Number.isNaN(date.getTime())) return ts;
      return date.toLocaleString();
    }

    function clearChildren(node) {
      while (node.firstChild) node.removeChild(node.firstChild);
    }

    function setAutoRefresh(delayMs) {
      if (state.refreshTimer) clearTimeout(state.refreshTimer);
      state.refreshTimer = setTimeout(refreshDashboard, delayMs);
    }

    function setResult(id, text, tone) {
      const el = document.getElementById(id);
      el.textContent = text || '';
      el.style.color =
        tone === 'error' ? 'var(--danger)' :
        tone === 'success' ? 'var(--success)' :
        'var(--muted)';
    }

    async function copyText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return;
      }

      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', 'readonly');
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);

      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);

      if (!copied) {
        throw new Error('copy_failed');
      }
    }

    function setCopyButtonState(button, label, tone) {
      button.textContent = label;
      button.classList.remove('copied', 'error');
      if (tone) button.classList.add(tone);
    }

    function renderPillRow(target, values) {
      clearChildren(target);
      values.filter(Boolean).forEach((value) => {
        const pill = document.createElement('div');
        pill.className = 'pill';
        pill.textContent = value;
        target.appendChild(pill);
      });
    }

    function renderGroups(groups) {
      const list = document.getElementById('groupList');
      clearChildren(list);

      if (!groups.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No registered groups yet.';
        list.appendChild(empty);
        return;
      }

      groups.forEach((group) => {
        const button = document.createElement('button');
        button.className = 'group-card' + (group.chatJid === state.selectedChatJid ? ' selected' : '');
        button.type = 'button';
        button.onclick = () => {
          state.selectedChatJid = group.chatJid;
          refreshDashboard();
        };

        const top = document.createElement('div');
        top.className = 'group-top';

        const titleWrap = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'group-name';
        title.textContent = group.name;
        const meta = document.createElement('div');
        meta.className = 'group-meta';
        meta.textContent = group.chatJid;
        titleWrap.appendChild(title);
        titleWrap.appendChild(meta);

        const status = document.createElement('div');
        status.className = 'pill';
        const dot = document.createElement('span');
        dot.className = 'status-dot ' + (group.active ? 'active' : group.idleWaiting ? 'waiting' : 'inactive');
        const text = document.createElement('span');
        text.textContent = group.active ? 'active' : group.idleWaiting ? 'idle' : 'resting';
        status.appendChild(dot);
        status.appendChild(text);

        top.appendChild(titleWrap);
        top.appendChild(status);
        button.appendChild(top);

        const footer = document.createElement('div');
        footer.className = 'group-meta';
        footer.textContent =
          group.folder +
          ' • ' +
          (group.isMain ? 'main' : 'member') +
          ' • ' +
          (group.channel || 'unknown channel');
        button.appendChild(footer);

        list.appendChild(button);
      });
    }

    function renderConversation(detail) {
      const feed = document.getElementById('conversationFeed');
      const previousScrollTop = feed.scrollTop;
      const previousScrollHeight = feed.scrollHeight;
      const wasNearBottom =
        state.autoScrollConversation ||
        feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
      clearChildren(feed);

      if (!detail) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Select a group to inspect its conversation.';
        feed.appendChild(empty);
        return;
      }

      if (!detail.conversation.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No conversation history yet.';
        feed.appendChild(empty);
        return;
      }

      detail.conversation.forEach((item) => {
        const bubble = document.createElement('div');
        bubble.className = 'bubble ' + item.role;

        const title = document.createElement('div');
        title.className = 'bubble-title';
        const left = document.createElement('span');
        left.textContent = item.label;
        const right = document.createElement('span');
        right.textContent = formatTime(item.timestamp) + ' • ' + item.source;
        title.appendChild(left);
        title.appendChild(right);

        const body = document.createElement('div');
        body.textContent = item.text;

        bubble.appendChild(title);
        bubble.appendChild(body);

        if (item.role === 'assistant') {
          const footer = document.createElement('div');
          footer.className = 'bubble-footer';

          const copyButton = document.createElement('button');
          copyButton.type = 'button';
          copyButton.className = 'copy-button';
          copyButton.textContent = 'Copy response';
          copyButton.onclick = async () => {
            copyButton.disabled = true;
            try {
              await copyText(item.text);
              setCopyButtonState(copyButton, 'Copied', 'copied');
            } catch (error) {
              setCopyButtonState(copyButton, 'Copy failed', 'error');
            }

            setTimeout(() => {
              if (!copyButton.isConnected) return;
              copyButton.disabled = false;
              setCopyButtonState(copyButton, 'Copy response');
            }, 1600);
          };

          footer.appendChild(copyButton);
          bubble.appendChild(footer);
        }

        feed.appendChild(bubble);
      });

      if (detail.group.active) {
        const liveBubble = document.createElement('div');
        liveBubble.className = 'bubble live';

        const liveTitle = document.createElement('div');
        liveTitle.className = 'bubble-title';
        const left = document.createElement('span');
        left.textContent = assistantName;
        const right = document.createElement('span');
        right.textContent = 'working live';
        liveTitle.appendChild(left);
        liveTitle.appendChild(right);

        const body = document.createElement('div');
        body.textContent =
          'Container is active. New messages and tool events will stream in here as the turn progresses.';

        liveBubble.appendChild(liveTitle);
        liveBubble.appendChild(body);
        feed.appendChild(liveBubble);
      }

      if (wasNearBottom) {
        feed.scrollTop = feed.scrollHeight;
      } else {
        const heightDelta = feed.scrollHeight - previousScrollHeight;
        feed.scrollTop = Math.max(0, previousScrollTop + heightDelta);
      }
    }

    function renderSession(detail) {
      const grid = document.getElementById('sessionGrid');
      clearChildren(grid);

      if (!detail) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No session selected.';
        grid.appendChild(empty);
        return;
      }

      const values = [
        ['Folder', detail.group.folder],
        ['Trigger', detail.group.trigger || '(none)'],
        ['Response ID', detail.group.session?.previousResponseId || 'new'],
        ['Conversation ID', detail.group.session?.conversationId || 'n/a'],
        ['Compactions', String(detail.group.session?.compactionCount || 0)],
        ['Transcript Path', detail.group.transcriptPath || 'n/a'],
        ['Summary Path', detail.group.session?.summaryPath || 'n/a'],
        ['Last Message', detail.group.lastMessageTime || 'n/a'],
      ];

      values.forEach(([label, value]) => {
        const stat = document.createElement('div');
        stat.className = 'stat';
        const labelEl = document.createElement('div');
        labelEl.className = 'label';
        labelEl.textContent = label;
        const valueEl = document.createElement('div');
        valueEl.className = 'value';
        valueEl.textContent = value;
        stat.appendChild(labelEl);
        stat.appendChild(valueEl);
        grid.appendChild(stat);
      });
    }

    function renderTasks(detail) {
      const list = document.getElementById('taskList');
      clearChildren(list);

      if (!detail || !detail.tasks.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No scheduled tasks for this group.';
        list.appendChild(empty);
        return;
      }

      detail.tasks.forEach((task) => {
        const card = document.createElement('div');
        card.className = 'task-card';

        const title = document.createElement('h4');
        title.textContent = task.prompt.slice(0, 90);
        card.appendChild(title);

        const status = document.createElement('span');
        status.className = 'status-pill ' + task.status;
        status.textContent = task.status;
        card.appendChild(status);

        const body = document.createElement('p');
        body.textContent =
          task.schedule_type + ' • ' + task.schedule_value +
          '\\nnext: ' + (task.next_run || 'n/a') +
          '\\nlast: ' + (task.last_run || 'n/a') +
          (task.last_result ? '\\nresult: ' + task.last_result : '');
        body.style.marginTop = '10px';
        card.appendChild(body);

        if (task.recentRuns && task.recentRuns.length) {
          const runs = document.createElement('p');
          runs.className = 'subtle';
          runs.style.marginTop = '10px';
          runs.textContent =
            'recent runs: ' +
            task.recentRuns
              .slice(0, 2)
              .map((run) => run.status + ' @ ' + formatTime(run.run_at))
              .join(' • ');
          card.appendChild(runs);
        }

        const actions = document.createElement('div');
        actions.className = 'task-actions';
        actions.style.marginTop = '10px';

        if (task.status === 'active') {
          const pause = document.createElement('button');
          pause.className = 'warning';
          pause.textContent = 'Pause';
          pause.onclick = () => runTaskAction(task.id, 'pause');
          actions.appendChild(pause);
        }

        if (task.status === 'paused') {
          const resume = document.createElement('button');
          resume.className = 'success';
          resume.textContent = 'Resume';
          resume.onclick = () => runTaskAction(task.id, 'resume');
          actions.appendChild(resume);
        }

        const cancel = document.createElement('button');
        cancel.className = 'danger';
        cancel.textContent = 'Cancel';
        cancel.onclick = () => runTaskAction(task.id, 'cancel');
        actions.appendChild(cancel);

        card.appendChild(actions);

        const editWrap = document.createElement('div');
        editWrap.className = 'stack';
        editWrap.style.marginTop = '12px';

        const editPrompt = document.createElement('textarea');
        editPrompt.value = task.prompt;
        editPrompt.style.minHeight = '88px';

        const editGrid = document.createElement('div');
        editGrid.className = 'task-grid';

        const editType = document.createElement('select');
        ['cron', 'interval', 'once'].forEach((value) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = value;
          if (task.schedule_type === value) option.selected = true;
          editType.appendChild(option);
        });

        const editValue = document.createElement('input');
        editValue.value = task.schedule_value;

        const editContext = document.createElement('select');
        [
          ['group', 'Group context'],
          ['isolated', 'Isolated context'],
        ].forEach(([value, label]) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          if (task.context_mode === value) option.selected = true;
          editContext.appendChild(option);
        });

        const save = document.createElement('button');
        save.className = 'secondary';
        save.textContent = 'Save';
        save.onclick = async () => {
          const result = await postJson('/api/tasks/' + encodeURIComponent(task.id) + '/update', {
            chatJid: task.chat_jid,
            groupFolder: task.group_folder,
            prompt: editPrompt.value.trim(),
            scheduleType: editType.value,
            scheduleValue: editValue.value.trim(),
            contextMode: editContext.value,
          });
          setResult('taskResult', result.ok ? 'Task updated.' : result.error, result.ok ? 'success' : 'error');
          await refreshDashboard();
        };

        editGrid.appendChild(editType);
        editGrid.appendChild(editValue);
        editGrid.appendChild(editContext);
        editGrid.appendChild(save);
        editWrap.appendChild(editPrompt);
        editWrap.appendChild(editGrid);
        card.appendChild(editWrap);
        list.appendChild(card);
      });
    }

    function renderEvents(detail) {
      const list = document.getElementById('eventList');
      clearChildren(list);

      if (!detail || !detail.events.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No transcript events yet.';
        list.appendChild(empty);
        return;
      }

      [...detail.events].reverse().forEach((event) => {
        const card = document.createElement('div');
        card.className = 'event-card';

        const title = document.createElement('h4');
        title.textContent = event.name + ' • ' + formatTime(event.timestamp);
        card.appendChild(title);

        const body = document.createElement('p');
        body.textContent = event.summary || '(no details)';
        card.appendChild(body);
        list.appendChild(card);
      });
    }

    function renderConnections(personalOps) {
      const list = document.getElementById('connectionsList');
      clearChildren(list);

      if (!personalOps || !personalOps.connections || !personalOps.connections.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No personal-ops providers configured yet.';
        list.appendChild(empty);
        return;
      }

      personalOps.connections.forEach((connection) => {
        const card = document.createElement('div');
        card.className = 'ops-card';

        const title = document.createElement('h4');
        title.textContent =
          connection.accountLabel || connection.accountId
            ? connection.provider + ' • ' + (connection.accountLabel || connection.accountId)
            : connection.provider;
        card.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'ops-meta';
        meta.textContent =
          (connection.accountLabel || 'Not connected') +
          ' • ' +
          connection.status +
          ' • last sync ' +
          formatTime(connection.lastSyncAt);
        card.appendChild(meta);

        const jobs = document.createElement('pre');
        jobs.textContent = connection.syncJobs && connection.syncJobs.length
          ? connection.syncJobs
              .map((job) =>
                job.sourceKind + ': ' + job.status + ' • next ' + formatTime(job.nextRunAt) + (job.error ? ' • ' + job.error : ''),
              )
              .join('\\n')
          : 'No sync jobs initialized yet.';
        card.appendChild(jobs);

        const actions = document.createElement('div');
        actions.className = 'ops-actions';

        const sync = document.createElement('button');
        sync.className = 'secondary';
        sync.textContent = 'Sync now';
        sync.disabled = !connection.accountId;
        sync.onclick = async () => {
          const result = await postJson(
            '/api/connections/' +
              encodeURIComponent(connection.provider) +
              '/' +
              encodeURIComponent(connection.accountId || '') +
              '/sync',
            {},
          );
          setResult(
            'connectionsResult',
            result.ok ? connection.provider + ' sync started.' : result.error,
            result.ok ? 'success' : 'error',
          );
          await refreshDashboard();
        };
        actions.appendChild(sync);

        if (connection.status !== 'disconnected') {
          const disconnect = document.createElement('button');
          disconnect.className = 'danger';
          disconnect.textContent = 'Disconnect';
          disconnect.onclick = async () => {
            const result = await postJson(
              '/api/connections/' +
                encodeURIComponent(connection.provider) +
                '/' +
                encodeURIComponent(connection.accountId || '') +
                '/disconnect',
              {},
            );
            setResult(
              'connectionsResult',
              result.ok ? connection.provider + ' disconnected.' : result.error,
              result.ok ? 'success' : 'error',
            );
            await refreshDashboard();
          };
          actions.appendChild(disconnect);
        }

        card.appendChild(actions);
        list.appendChild(card);
      });
    }

    function renderTodayOps(personalOps) {
      const list = document.getElementById('todayList');
      clearChildren(list);

      const today = personalOps?.today;
      if (!today) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No personal-ops summary available yet.';
        list.appendChild(empty);
        return;
      }

      const sections = [
        [
          'Meetings',
          (today.meetings || []).slice(0, 5).map(
            (meeting) => meeting.title + ' @ ' + formatTime(meeting.occurredAt),
          ),
        ],
        [
          'Priorities',
          (today.priorities || []).slice(0, 5).map((item) => item.title),
        ],
        [
          'Overdue',
          (today.overdue || []).slice(0, 5).map((item) => item.title),
        ],
        [
          'Suggested plan',
          (today.suggestedPlan || []).slice(0, 5),
        ],
      ];

      sections.forEach(([label, lines]) => {
        const card = document.createElement('div');
        card.className = 'ops-card';
        const title = document.createElement('h4');
        title.textContent = label;
        const body = document.createElement('pre');
        body.textContent = lines.length ? lines.map((line) => '- ' + line).join('\\n') : 'No items.';
        card.appendChild(title);
        card.appendChild(body);
        list.appendChild(card);
      });
    }

    function renderReports(personalOps) {
      const list = document.getElementById('reportsList');
      clearChildren(list);

      const reports = personalOps?.reports || [];
      if (!reports.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No reports generated yet.';
        list.appendChild(empty);
        return;
      }

      reports.slice(0, 6).forEach((report) => {
        const card = document.createElement('div');
        card.className = 'ops-card';
        const title = document.createElement('h4');
        title.textContent = report.reportType + ' • ' + formatTime(report.generatedAt);
        const body = document.createElement('pre');
        body.textContent = report.groupedOutput;
        card.appendChild(title);
        card.appendChild(body);
        list.appendChild(card);
      });
    }

    function renderCorrections(personalOps) {
      const list = document.getElementById('correctionsList');
      clearChildren(list);

      const corrections = personalOps?.corrections || [];
      const clients = personalOps?.clients || [];
      const projects = personalOps?.projects || [];

      const registry = document.createElement('div');
      registry.className = 'ops-card';
      const registryTitle = document.createElement('h4');
      registryTitle.textContent = 'Registry';
      const registryBody = document.createElement('pre');
      registryBody.textContent =
        'Clients:\\n' +
        (clients.length
          ? clients.map((client) => '- ' + client.name + ' [' + client.id + ']').join('\\n')
          : '- none') +
        '\\n\\nProjects:\\n' +
        (projects.length
          ? projects.map((project) => '- ' + project.name + ' [' + project.id + ']').join('\\n')
          : '- none');
      registry.appendChild(registryTitle);
      registry.appendChild(registryBody);
      list.appendChild(registry);

      if (!corrections.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No corrections recorded yet.';
        list.appendChild(empty);
        return;
      }

      corrections.slice(0, 8).forEach((correction) => {
        const card = document.createElement('div');
        card.className = 'ops-card';
        const title = document.createElement('h4');
        title.textContent = correction.targetType + ' • ' + correction.field;
        const body = document.createElement('pre');
        body.textContent =
          correction.targetId + '\\n' + correction.value + '\\n' + formatTime(correction.createdAt);
        card.appendChild(title);
        card.appendChild(body);
        list.appendChild(card);
      });
    }

    function renderDetail(detail) {
      document.getElementById('conversationTitle').textContent =
        detail ? detail.group.name : 'Select a group';
      document.getElementById('conversationMeta').textContent =
        detail
          ? detail.group.chatJid + ' • ' + (detail.group.isMain ? 'main control group' : detail.group.requiresTrigger ? 'triggered' : 'direct') + ' • added ' + formatTime(detail.group.addedAt)
          : '';

      renderPillRow(
        document.getElementById('conversationPills'),
        detail
          ? [
              detail.group.isMain ? 'main group' : null,
              detail.group.active ? 'container active' : 'container idle',
              detail.group.idleWaiting ? 'idle waiting' : null,
              detail.group.channel || null,
            ]
          : [],
      );

      renderConversation(detail);
      renderSession(detail);
      renderTasks(detail);
      renderEvents(detail);
      renderConnections(state.dashboard?.personalOps || null);
      renderTodayOps(state.dashboard?.personalOps || null);
      renderReports(state.dashboard?.personalOps || null);
      renderCorrections(state.dashboard?.personalOps || null);

      document.getElementById('conversationStats').textContent = detail
        ? detail.conversation.length + ' conversation items • ' + detail.transcriptEventCount + ' transcript events'
        : '';

      const sendInputButton = document.getElementById('sendInputButton');
      if (detail && detail.group.active) {
        sendInputButton.disabled = false;
        sendInputButton.title = '';
      } else {
        sendInputButton.disabled = true;
        sendInputButton.title = 'This only works while a container is already active.';
      }

      const liveBanner = document.getElementById('liveBanner');
      const livePulse = document.getElementById('livePulse');
      const liveTitle = document.getElementById('liveTitle');
      const liveMeta = document.getElementById('liveMeta');
      const pollMeta = document.getElementById('pollMeta');

      if (!detail) {
        liveBanner.className = 'live-banner';
        livePulse.className = 'pulse';
        liveTitle.textContent = 'Waiting for selection';
        liveMeta.textContent = 'Choose a group to inspect its live state.';
        pollMeta.textContent = 'Poll 3s';
        return;
      }

      const active = detail.group.active;
      const waiting = !active && detail.group.idleWaiting;
      liveBanner.className = 'live-banner' + (active ? ' active' : waiting ? ' waiting' : '');
      livePulse.className = 'pulse' + (active ? ' active' : waiting ? ' waiting' : '');
      liveTitle.textContent = active
        ? assistantName + ' is actively working'
        : waiting
          ? 'Container is idle but still attached'
          : 'Group is resting';
      liveMeta.textContent = active
        ? 'Polling faster and keeping the feed pinned so new replies and tool events stay visible.'
        : waiting
          ? 'You can still inspect the session, but direct input waits until the container becomes active.'
          : 'Queue a user message to start a fresh turn.';
      pollMeta.textContent = active ? 'Poll 1s' : 'Poll 3s';
    }

    async function refreshDashboard() {
      if (state.refreshInFlight) {
        return;
      }
      state.refreshInFlight = true;
      const url = new URL('/api/dashboard', window.location.origin);
      if (state.selectedChatJid) url.searchParams.set('chatJid', state.selectedChatJid);
      try {
        const res = await fetch(url, {
          headers: { '${OPERATOR_UI_AUTH_HEADER}': operatorToken }
        });
        const payload = await res.json();
        state.dashboard = payload;
        state.selectedChatJid = payload.selectedChatJid;

        const conversationSignature = JSON.stringify(
          payload.detail?.conversation?.slice(-6) || [],
        );
        state.lastConversationSignature = conversationSignature;

        renderGroups(payload.groups);
        renderDetail(payload.detail);

        document.getElementById('heroMeta').textContent =
          payload.groups.length + ' groups • timezone ' + payload.timezone + ' • assistant ' + payload.assistantName;
        renderPillRow(document.getElementById('heroPills'), [
          payload.detail?.group?.active ? 'agent live' : 'waiting for next turn',
          payload.detail?.group?.session?.previousResponseId ? 'session resumed' : 'fresh session',
        ]);
        document.getElementById('refreshMeta').textContent =
          'Last refresh ' + formatTime(payload.refreshedAt);

        const nextDelay = payload.detail?.group?.active ? 1000 : 3000;
        setAutoRefresh(nextDelay);
      } finally {
        state.refreshInFlight = false;
      }
    }

    async function postJson(path, payload) {
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          '${OPERATOR_UI_AUTH_HEADER}': operatorToken,
        },
        body: JSON.stringify(payload),
      });
      return res.json();
    }

    async function runTaskAction(taskId, action) {
      const result = await postJson('/api/tasks/' + encodeURIComponent(taskId) + '/' + action, {});
      setResult('taskResult', result.ok ? 'Task updated.' : result.error, result.ok ? 'success' : 'error');
      await refreshDashboard();
    }

    document.getElementById('sendMessageButton').onclick = async () => {
      if (!state.selectedChatJid) return;
      const text = document.getElementById('composerText').value.trim();
      if (!text) return;
      const result = await postJson('/api/messages', {
        chatJid: state.selectedChatJid,
        text,
        sender: document.getElementById('senderId').value || undefined,
        senderName: document.getElementById('senderName').value || undefined,
      });
      setResult('composerResult', result.ok ? 'User message queued. NanoClaw will start a turn for this group.' : result.error, result.ok ? 'success' : 'error');
      if (result.ok) document.getElementById('composerText').value = '';
      await refreshDashboard();
    };

    document.getElementById('sendInputButton').onclick = async () => {
      if (!state.selectedChatJid) return;
      if (!state.dashboard?.detail?.group?.active) {
        setResult(
          'composerResult',
          'The group is idle. Use "Queue User Message" to start a new turn, then use direct input while the container is active.',
          'error',
        );
        return;
      }
      const text = document.getElementById('composerText').value.trim();
      if (!text) return;
      const result = await postJson('/api/input', {
        chatJid: state.selectedChatJid,
        text,
      });
      setResult('composerResult', result.ok ? 'Input sent to the active container.' : result.error, result.ok ? 'success' : 'error');
      if (result.ok) document.getElementById('composerText').value = '';
      await refreshDashboard();
    };

    document.getElementById('sendOutboundButton').onclick = async () => {
      if (!state.selectedChatJid) return;
      const text = document.getElementById('composerText').value.trim();
      if (!text) return;
      const result = await postJson('/api/outbound', {
        chatJid: state.selectedChatJid,
        text,
      });
      setResult('composerResult', result.ok ? 'Outbound message sent.' : result.error, result.ok ? 'success' : 'error');
      if (result.ok) document.getElementById('composerText').value = '';
      await refreshDashboard();
    };

    document.getElementById('createTaskButton').onclick = async () => {
      if (!state.dashboard?.detail) return;
      const result = await postJson('/api/tasks', {
        chatJid: state.dashboard.detail.group.chatJid,
        groupFolder: state.dashboard.detail.group.folder,
        prompt: document.getElementById('taskPrompt').value.trim(),
        scheduleType: document.getElementById('taskScheduleType').value,
        scheduleValue: document.getElementById('taskScheduleValue').value.trim(),
        contextMode: document.getElementById('taskContextMode').value,
      });
      setResult('taskResult', result.ok ? 'Task created.' : result.error, result.ok ? 'success' : 'error');
      if (result.ok) {
        document.getElementById('taskPrompt').value = '';
        document.getElementById('taskScheduleValue').value = '';
      }
      await refreshDashboard();
    };

    document.getElementById('connectGoogleButton').onclick = () => {
      window.location.href = '/oauth/google/start?token=' + encodeURIComponent(operatorToken);
    };
    document.getElementById('connectMicrosoftButton').onclick = () => {
      window.location.href = '/oauth/microsoft/start?token=' + encodeURIComponent(operatorToken);
    };
    document.getElementById('connectJiraButton').onclick = () => {
      window.location.href = '/oauth/jira/start?token=' + encodeURIComponent(operatorToken);
    };
    document.getElementById('connectSlackButton').onclick = () => {
      window.location.href = '/oauth/slack/start?token=' + encodeURIComponent(operatorToken);
    };

    document.getElementById('createManualTaskButton').onclick = async () => {
      const title = document.getElementById('manualTaskTitle').value.trim();
      if (!title) return;
      const result = await postJson('/api/manual/task', {
        title,
        notes: document.getElementById('manualTaskNotes').value.trim() || undefined,
        dueDate: document.getElementById('manualTaskDueDate').value.trim() || undefined,
        priority: document.getElementById('manualTaskPriority').value,
      });
      setResult(
        'personalOpsEntryResult',
        result.ok ? 'Manual task added.' : result.error,
        result.ok ? 'success' : 'error',
      );
      if (result.ok) {
        document.getElementById('manualTaskTitle').value = '';
        document.getElementById('manualTaskNotes').value = '';
        document.getElementById('manualTaskDueDate').value = '';
      }
      await refreshDashboard();
    };

    document.getElementById('createManualNoteButton').onclick = async () => {
      const title = document.getElementById('manualNoteTitle').value.trim();
      if (!title) return;
      const result = await postJson('/api/manual/note', {
        title,
        body: document.getElementById('manualNoteBody').value.trim() || undefined,
      });
      setResult(
        'personalOpsEntryResult',
        result.ok ? 'Manual note added.' : result.error,
        result.ok ? 'success' : 'error',
      );
      if (result.ok) {
        document.getElementById('manualNoteTitle').value = '';
        document.getElementById('manualNoteBody').value = '';
      }
      await refreshDashboard();
    };

    document.getElementById('createClientButton').onclick = async () => {
      const name = document.getElementById('clientName').value.trim();
      if (!name) return;
      const result = await postJson('/api/clients', {
        name,
        notes: document.getElementById('clientNotes').value.trim() || undefined,
      });
      setResult(
        'correctionResult',
        result.ok ? 'Client added.' : result.error,
        result.ok ? 'success' : 'error',
      );
      if (result.ok) {
        document.getElementById('clientName').value = '';
        document.getElementById('clientNotes').value = '';
      }
      await refreshDashboard();
    };

    document.getElementById('createProjectButton').onclick = async () => {
      const name = document.getElementById('projectName').value.trim();
      if (!name) return;
      const result = await postJson('/api/projects', {
        name,
        clientId: document.getElementById('projectClientId').value.trim() || undefined,
      });
      setResult(
        'correctionResult',
        result.ok ? 'Project added.' : result.error,
        result.ok ? 'success' : 'error',
      );
      if (result.ok) {
        document.getElementById('projectName').value = '';
        document.getElementById('projectClientId').value = '';
      }
      await refreshDashboard();
    };

    document.getElementById('recordCorrectionButton').onclick = async () => {
      const result = await postJson('/api/corrections', {
        targetType: document.getElementById('correctionTargetType').value.trim(),
        targetId: document.getElementById('correctionTargetId').value.trim(),
        field: document.getElementById('correctionField').value.trim(),
        value: document.getElementById('correctionValue').value.trim(),
      });
      setResult(
        'correctionResult',
        result.ok ? 'Correction recorded.' : result.error,
        result.ok ? 'success' : 'error',
      );
      if (result.ok) {
        document.getElementById('correctionTargetType').value = '';
        document.getElementById('correctionTargetId').value = '';
        document.getElementById('correctionField').value = '';
        document.getElementById('correctionValue').value = '';
      }
      await refreshDashboard();
    };

    document.getElementById('conversationFeed').addEventListener('scroll', () => {
      const feed = document.getElementById('conversationFeed');
      state.autoScrollConversation =
        feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    });

    refreshDashboard();
  </script>
</body>
</html>`;
}

function readLocalOutbox(
  chatJid: string,
  limit = 80,
): Array<{ timestamp: string; text: string }> {
  if (!chatJid.startsWith('local:') || !fs.existsSync(LOCAL_OUTBOX_PATH)) {
    return [];
  }

  const entries = fs
    .readFileSync(LOCAL_OUTBOX_PATH, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LocalOutboundMessage];
      } catch {
        return [];
      }
    })
    .filter((entry) => entry.jid === chatJid)
    .slice(-limit);

  return entries.map((entry) => ({
    timestamp: entry.sentAt,
    text: entry.text,
  }));
}

function readTranscriptRaw(transcriptPath?: string): string {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return '';
  }
  return fs.readFileSync(transcriptPath, 'utf-8');
}

function buildConversation(
  chatJid: string,
  messages: NewMessage[],
  transcriptRaw: string,
): OperatorUiConversationItem[] {
  const fromMessages = messages.map((message) => ({
    timestamp: message.timestamp,
    role:
      message.is_from_me || message.is_bot_message
        ? ('assistant' as const)
        : ('user' as const),
    label:
      message.is_from_me || message.is_bot_message
        ? ASSISTANT_NAME
        : message.sender_name || message.sender,
    text: message.content,
    source: 'messages' as const,
  }));

  const latestAssistantTimestampFromMessages = fromMessages
    .filter((item) => item.role === 'assistant')
    .map((item) => item.timestamp)
    .sort()
    .at(-1) || '';

  const fallbackAssistantMessages = (
    chatJid.startsWith('local:')
      ? readLocalOutbox(chatJid)
      : extractAssistantMessages(transcriptRaw)
  )
    .filter(
      (message) =>
        !latestAssistantTimestampFromMessages ||
        message.timestamp > latestAssistantTimestampFromMessages,
    )
    .map((message) => ({
      timestamp: message.timestamp,
      role: 'assistant' as const,
      label: ASSISTANT_NAME,
      text: message.text,
      source: chatJid.startsWith('local:')
        ? ('local-outbox' as const)
        : ('transcript' as const),
    }));

  const deduped = [...fromMessages, ...fallbackAssistantMessages]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .filter((item, index, all) => {
      const firstMatch = all.findIndex(
        (candidate) =>
          candidate.role === item.role &&
          candidate.timestamp === item.timestamp &&
          candidate.text === item.text,
      );
      return firstMatch === index;
    });

  return deduped.slice(-120);
}

function enrichTasks(
  tasks: ScheduledTask[],
  getTaskRuns: OperatorUiDependencies['getTaskRuns'],
): OperatorUiTaskView[] {
  return tasks.map((task) => ({
    ...task,
    recentRuns: getTaskRuns(task.id, 5),
  }));
}

function defaultSelectedChatJid(groups: OperatorUiGroupView[]): string | null {
  const main = groups.find((group) => group.isMain);
  return main?.chatJid || groups[0]?.chatJid || null;
}

function buildGroupDetail(
  deps: OperatorUiDependencies,
  group: OperatorUiGroupView,
): Record<string, unknown> {
  const transcriptRaw = readTranscriptRaw(group.transcriptPath);
  return {
    group,
    conversation: buildConversation(
      group.chatJid,
      deps.getMessages(group.chatJid, 80),
      transcriptRaw,
    ),
    tasks: enrichTasks(deps.getTasks(group.folder), deps.getTaskRuns),
    events: extractToolEvents(transcriptRaw, 30),
    transcriptEventCount: parseTranscriptEvents(transcriptRaw).length,
  };
}

function sourceAttentionStateForUi(source: SourceRecord): NonNullable<SourceRecord['attention']> {
  const input = (source.attention || {}) as NonNullable<SourceRecord['attention']>;
  const directness =
    input.directness === 'direct' ||
    input.directness === 'mentioned' ||
    input.directness === 'shared'
      ? input.directness
      : 'ambient';
  return {
    awarenessOnly: input.awarenessOnly === true,
    actionRequired: input.actionRequired === true,
    operationalRisk: input.operationalRisk === true,
    reportWorthy: input.reportWorthy === true,
    directness,
    importanceReason: typeof input.importanceReason === 'string' ? input.importanceReason : '',
    actionConfidence:
      typeof input.actionConfidence === 'number'
        ? input.actionConfidence
        : source.attributionConfidence ?? null,
    mappingConfidence:
      typeof input.mappingConfidence === 'number'
        ? input.mappingConfidence
        : source.attributionConfidence ?? null,
  };
}

function sourceLooksAutomatedForToday(source: SourceRecord): boolean {
  if (source.kind !== 'email') return false;
  if (source.metadata?.automatedSender === true) return true;
  const fields = [
    ...(Array.isArray(source.participants) ? source.participants : []),
    typeof source.metadata?.fromAddress === 'string' ? source.metadata.fromAddress : '',
    typeof source.metadata?.senderAddress === 'string' ? source.metadata.senderAddress : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /(^|[._\s-])(no-?reply|donotreply|do-?not-?reply|notifications?|noreply|mailer-daemon|postmaster)([._+\s-]|@|$)/i.test(
    fields,
  );
}

function sourceHasTodayCriticalSignal(source: SourceRecord): boolean {
  const text = `${source.title}\n${source.summary || ''}\n${source.body || ''}`;
  return /\b(website down|site down|system down|outage|incident|security alert|breach|bank data import failed|edi transfer failed|cloudwatch alarm|gateway .* down|past due invoice|under shipped|ship request|vendor pricing|pricing update|price file|map violation)\b/i.test(
    text,
  );
}

function sourceShouldSurfaceOnToday(source: SourceRecord): boolean {
  const attention = sourceAttentionStateForUi(source);
  const direct =
    attention.directness === 'direct' || attention.directness === 'mentioned';
  if (source.kind === 'email') {
    const automated = sourceLooksAutomatedForToday(source);
    const critical = sourceHasTodayCriticalSignal(source);
    if (attention.operationalRisk) {
      return direct || critical;
    }
    if (attention.actionRequired && direct && !automated) {
      return true;
    }
    if (direct && critical) {
      return true;
    }
    return false;
  }
  if (source.kind === 'slack_message') {
    return direct && (attention.actionRequired || attention.operationalRisk);
  }
  if (source.kind === 'jira_issue') {
    return attention.actionRequired || attention.operationalRisk || source.priority === 'urgent';
  }
  return attention.actionRequired || attention.operationalRisk;
}

function sourceShouldSurfaceInTodayAwareness(source: SourceRecord): boolean {
  const attention = sourceAttentionStateForUi(source);
  if (!attention.awarenessOnly) return false;
  if (!attention.reportWorthy && !attention.operationalRisk) return false;
  const direct =
    attention.directness === 'direct' || attention.directness === 'mentioned';
  return direct || sourceHasTodayCriticalSignal(source);
}

function sourceFromSourceRecordKeyForUi(sourceRecordKey: string | null | undefined): SourceRecord | null {
  if (!sourceRecordKey) return null;
  const parsed = parseSourceRecordKey(sourceRecordKey);
  if (!parsed) return null;
  return (
    getSourceRecord(
      parsed.provider,
      parsed.accountId,
      parsed.kind,
      parsed.externalId,
    ) || null
  );
}

function workItemShouldSurfaceOnToday(item: WorkItem): boolean {
  if (item.status === 'done' || item.status === 'ignored') return false;
  const source = sourceFromSourceRecordKeyForUi(item.sourceRecordKey);
  if (!source || item.sourceProvider === 'manual') {
    return (
      item.status === 'blocked' ||
      item.priority === 'urgent' ||
      item.priority === 'high' ||
      Boolean(item.dueDate)
    );
  }
  return sourceShouldSurfaceOnToday(source);
}

function openLoopShouldSurfaceOnToday(loop: OpenLoop): boolean {
  if (!(loop.state === 'blocked' || loop.state === 'waiting' || loop.needsReview)) {
    return false;
  }
  if (loop.workItemId) {
    const workItem = getWorkItem(loop.workItemId);
    if (workItem) {
      return workItemShouldSurfaceOnToday(workItem);
    }
  }
  const source = sourceFromSourceRecordKeyForUi(loop.sourceRecordKey);
  if (source) {
    return sourceShouldSurfaceOnToday(source);
  }
  return loop.state === 'blocked';
}

function sourceNeedsActionForUi(source: SourceRecord): boolean {
  const attention = sourceAttentionStateForUi(source);
  return attention.actionRequired || attention.operationalRisk;
}

function sourceIsImportantAwarenessForUi(source: SourceRecord): boolean {
  const attention = sourceAttentionStateForUi(source);
  return attention.awarenessOnly && (attention.reportWorthy || attention.operationalRisk);
}

function sourceNeedsReviewForUi(source: SourceRecord): boolean {
  const attention = sourceAttentionStateForUi(source);
  return (
    source.reviewState === 'suggested' ||
    (attention.actionConfidence !== null && attention.actionConfidence < 0.7) ||
    (attention.mappingConfidence !== null && attention.mappingConfidence < 0.7)
  );
}

function sourceSurfacedReasonSummary(source: SourceRecord): string {
  const attention = sourceAttentionStateForUi(source);
  if (attention.operationalRisk) {
    return attention.importanceReason || 'Operational risk';
  }
  if (attention.actionRequired) {
    return attention.importanceReason || 'Needs action';
  }
  if (attention.awarenessOnly) {
    return attention.importanceReason || 'Important awareness';
  }
  if (source.metadata?.isImportant === true) {
    return 'Marked important';
  }
  if (source.metadata?.mentionsSelf === true || source.metadata?.isDirectMessage === true) {
    return 'Directly addressed to you';
  }
  if (sourceNeedsReviewForUi(source)) {
    return 'Needs review';
  }
  if (source.status === 'filtered' || source.metadata?.likelyNoise === true) {
    return 'Low signal';
  }
  return 'Recently synced';
}

function summarizeWorkItemReason(item: WorkItem): string {
  if (item.needsReview) {
    return 'Needs review before it can be trusted';
  }
  switch (item.status) {
    case 'blocked':
      return 'Blocked and needs your attention';
    case 'waiting':
      return 'Waiting on someone else';
    case 'in_progress':
      return 'In progress and still active';
    case 'done':
      return 'Recently completed';
    case 'on_hold':
      return 'Paused until something changes';
    case 'ignored':
      return 'Quieted from active follow-up';
    case 'open':
    default:
      if (item.openLoopState === 'blocked') return 'Blocked and needs your attention';
      if (item.openLoopState === 'waiting') return 'Waiting on someone else';
      if (item.openLoopState === 'awareness') return 'Worth keeping in view';
      return 'Needs your next move';
  }
}

function summarizeOpenLoopReason(loop: OpenLoop): string {
  if (loop.needsReview) {
    return 'Needs review before it can be trusted';
  }
  switch (loop.state) {
    case 'blocked':
      return 'Blocked and needs your attention';
    case 'waiting':
      return 'Waiting on someone else';
    case 'awareness':
      return 'Worth keeping in view';
    case 'closed':
      return 'Recently closed';
    case 'action':
    default:
      return 'Needs your next move';
  }
}

function summarizeWorkstreamReason(stream: PersonalOpsWorkstream): string {
  if (stream.blockerCount > 0) {
    return `${stream.blockerCount} blocker${stream.blockerCount === 1 ? ' needs' : 's need'} attention`;
  }
  if (stream.needsReviewCount > 0) {
    return `${stream.needsReviewCount} item${stream.needsReviewCount === 1 ? '' : 's'} need review`;
  }
  if (stream.waitingCount > 0) {
    return `${stream.waitingCount} item${stream.waitingCount === 1 ? '' : 's'} waiting on others`;
  }
  if (stream.items.length > 0) {
    return `${stream.items.length} active item${stream.items.length === 1 ? '' : 's'} still need movement`;
  }
  if (stream.openLoopCount > 0) {
    return `${stream.openLoopCount} open loop${stream.openLoopCount === 1 ? '' : 's'} still active`;
  }
  return 'Recent evidence keeps this work visible';
}

function dedupeSummaryCards(cards: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const sourceRecordKey =
      typeof card.sourceRecordKey === 'string' && card.sourceRecordKey ? card.sourceRecordKey : null;
    const workItemId =
      typeof card.workItemId === 'string' && card.workItemId ? card.workItemId : null;
    const id = typeof card.id === 'string' ? card.id : JSON.stringify(card);
    const key = sourceRecordKey
      ? `source:${sourceRecordKey}`
      : workItemId
        ? `work:${workItemId}`
        : `id:${id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function splitInboxItemsForUi(items: SourceRecord[]): {
  needsAction: SourceRecord[];
  importantAwareness: SourceRecord[];
  lowSignal: SourceRecord[];
} {
  const needsAction = items.filter(sourceNeedsActionForUi);
  const importantAwareness = items.filter(
    (source) => !sourceNeedsActionForUi(source) && sourceIsImportantAwarenessForUi(source),
  );
  const hiddenKeys = new Set([
    ...needsAction.map((source) =>
      getSourceRecordKey(source.provider, source.accountId, source.kind, source.externalId),
    ),
    ...importantAwareness.map((source) =>
      getSourceRecordKey(source.provider, source.accountId, source.kind, source.externalId),
    ),
  ]);
  return {
    needsAction,
    importantAwareness,
    lowSignal: items.filter(
      (source) =>
        !hiddenKeys.has(
          getSourceRecordKey(source.provider, source.accountId, source.kind, source.externalId),
        ),
    ),
  };
}

function buildSourceSummaryCard(source: SourceRecord): Record<string, unknown> {
  return {
    kind: 'source_record',
    id: getSourceRecordKey(source.provider, source.accountId, source.kind, source.externalId),
    title: source.title,
    summary: source.summary || source.body || 'No preview available.',
    timestamp: source.occurredAt,
    surfacedReasonSummary: sourceSurfacedReasonSummary(source),
    status: source.status,
    priority: source.priority,
    provider: source.provider,
    accountLabel: source.accountLabel || source.accountId || null,
    clientId: source.clientId || null,
    projectId: source.projectId || null,
  };
}

function buildWorkItemSummaryCard(item: WorkItem): Record<string, unknown> {
  return {
    kind: 'work_item',
    id: item.id,
    title: item.title,
    summary: item.notes || 'No notes available.',
    timestamp: item.updatedAt || item.createdAt,
    surfacedReasonSummary: summarizeWorkItemReason(item),
    status: item.status,
    priority: item.priority,
    clientId: item.clientId || null,
    projectId: item.projectId || null,
    sourceRecordKey: item.sourceRecordKey || null,
    workItemId: item.id,
  };
}

function buildOpenLoopSummaryCard(loop: OpenLoop): Record<string, unknown> {
  return {
    kind: 'open_loop',
    id: loop.id,
    title: loop.title,
    summary: loop.summary,
    timestamp: loop.lastUpdatedAt || loop.dueAt || null,
    surfacedReasonSummary: summarizeOpenLoopReason(loop),
    status: loop.state,
    priority: null,
    clientId: loop.clientId || null,
    projectId: loop.projectId || null,
    sourceRecordKey: loop.sourceRecordKey || null,
    workItemId: loop.workItemId || null,
  };
}

function buildApprovalSummaryCard(item: ApprovalQueueItem): Record<string, unknown> {
  return {
    kind: 'approval_queue',
    id: item.id,
    title: item.title,
    summary: item.summary,
    timestamp: item.updatedAt,
    surfacedReasonSummary: item.reason || 'Needs approval',
    status: item.status,
    priority: null,
    clientId: item.clientId || null,
    projectId: item.projectId || null,
  };
}

function buildWorkstreamSummaryCard(stream: PersonalOpsWorkstream): Record<string, unknown> {
  return {
    kind: 'workstream',
    id: stream.key,
    title: [stream.client?.name || 'Unassigned client', stream.project?.name || 'General work'].join(' / '),
    summary:
      stream.signals[0] ||
      `${stream.items.length} open item${stream.items.length === 1 ? '' : 's'} • ${stream.openLoopCount} open loop${stream.openLoopCount === 1 ? '' : 's'}`,
    timestamp: stream.lastUpdatedAt || stream.nextDueAt || null,
    surfacedReasonSummary: summarizeWorkstreamReason(stream),
    status:
      stream.blockerCount > 0
        ? 'blocked'
        : stream.needsReviewCount > 0
          ? 'needs review'
          : stream.waitingCount > 0
            ? 'waiting'
            : 'active',
    priority: null,
    clientId: stream.client?.id || null,
    projectId: stream.project?.id || null,
  };
}

function buildSetupPayload(deps: OperatorUiDependencies): Record<string, unknown> {
  const personalOps = deps.personalOps;
  if (!personalOps) {
    return {
      ok: true,
      setup: {
        complete: false,
        incompleteCount: 1,
        recommendedNextAction: 'Enable personal ops to use the assistant cockpit.',
        reviewBurden: 0,
        recommendedQuestionId: null,
        pendingInlineQuestions: 0,
        queuedQuestions: 0,
        improvementDrafts: 0,
        questions: [
          {
            id: 'enable-personal-ops',
            dedupeKey: 'enable-personal-ops',
            status: 'pending',
            surface: 'connections',
            targetType: 'setup',
            targetId: null,
            urgency: 'queued',
            prompt:
              'Do you want to enable personal ops so the assistant can guide Today, Inbox, and Work?',
            rationale:
              'Turn on personal ops first, then connect one account and seed your working clients and projects.',
            recommendedOptionId: null,
            options: [],
            freeformAllowed: false,
            effectPreview: 'Open setup',
            createdFrom: 'setup_enable_personal_ops',
            answerOptionId: null,
            answerValue: null,
            snoozeUntil: null,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            answeredAt: null,
          },
        ],
        checklist: [
          {
            key: 'personal_ops',
            label: 'Enable personal ops',
            detail: 'Personal ops is currently unavailable.',
            done: false,
            href: '/connections',
          },
        ],
      },
    };
  }

  const connections = personalOps
    .listConnections()
    .filter((connection) => Boolean(connection.accountId) && connection.status !== 'disconnected');
  const clients = personalOps.getClients();
  const projects = personalOps.getProjects();
  const queueCount = personalOps.getApprovalQueue().length;
  const reviewCount = personalOps.getReviewQueue().length;
  const questions = personalOps.getAssistantQuestions({ surface: 'connections' });
  const queuedQuestions = personalOps.getAssistantQuestions({ urgency: 'queued' }).length;
  const improvementDrafts = personalOps
    .getImprovementTickets()
    .filter((ticket) => ticket.status === 'draft').length;
  const repositories = personalOps.getRepositories();
  const configuredDefaults = connections.filter((connection) => {
    const settings = connection.settings || {};
    return Boolean(
      settings.defaultClientId ||
        settings.defaultProjectId ||
        settings.preferClientOnlyMapping ||
        settings.triageGuidance,
    );
  }).length;

  const checklist = [
    {
      key: 'connections',
      label: 'Connect at least one account',
      detail:
        connections.length > 0
          ? `${connections.length} connected account${connections.length === 1 ? '' : 's'}`
          : 'No connected accounts yet.',
      done: connections.length > 0,
      href: '/connections',
    },
    {
      key: 'registry',
      label: 'Seed clients and projects',
      detail: `${clients.length} client${clients.length === 1 ? '' : 's'} • ${projects.length} project${projects.length === 1 ? '' : 's'}`,
      done: clients.length > 0 && projects.length > 0,
      href: '/connections',
    },
    {
      key: 'defaults',
      label: 'Set defaults or triage guidance',
      detail:
        connections.length > 0
          ? `${configuredDefaults}/${connections.length} account${connections.length === 1 ? '' : 's'} tuned`
          : 'Add account defaults after connecting.',
      done: connections.length === 0 ? false : configuredDefaults === connections.length,
      href: '/connections',
    },
    {
      key: 'review',
      label: 'Clear review and approval backlog',
      detail:
        queueCount + reviewCount > 0
          ? `${queueCount} approval${queueCount === 1 ? '' : 's'} • ${reviewCount} suggestion${reviewCount === 1 ? '' : 's'}`
          : 'Nothing waiting in Review.',
      done: queueCount + reviewCount === 0,
      href: '/review',
    },
  ];

  const incompleteCount = checklist.filter((item) => !item.done).length;
  const recommendedNextAction =
    !checklist[0].done
      ? 'Connect your first account in Connections.'
      : !checklist[1].done
        ? 'Create the core clients and projects in Connections.'
        : !checklist[2].done
          ? 'Set default client/project mappings or triage guidance on your accounts.'
          : queueCount > 0
            ? `Review ${queueCount} pending approval${queueCount === 1 ? '' : 's'}.`
            : reviewCount > 0
              ? `Confirm ${reviewCount} suggestion${reviewCount === 1 ? '' : 's'} in Review.`
              : 'Start with Today to work the most important open loops.';

  return {
    ok: true,
    setup: {
      complete: incompleteCount === 0,
      incompleteCount,
      recommendedNextAction,
      reviewBurden: queueCount + reviewCount,
      recommendedQuestionId: questions[0]?.id || null,
      pendingInlineQuestions: questions.length,
      queuedQuestions,
      improvementDrafts,
      questions,
      checklist,
    },
  };
}

function buildTodayPayload(deps: OperatorUiDependencies): Record<string, unknown> {
  const personalOps = deps.personalOps;
  const today = (personalOps?.getToday() || null) as PersonalOpsTodayView | null;
  const setup = buildSetupPayload(deps).setup as {
    recommendedNextAction: string;
    incompleteCount: number;
  };
  const connections = personalOps?.listConnections() || [];
  const degradedConnections = connections.filter(
    (connection) => connection.status === 'degraded' || connection.lastSyncStatus === 'error',
  );

  if (!today) {
    return {
      ok: true,
      today: {
        generatedAt: new Date().toISOString(),
        meetings: [],
        priorities: [],
        overdue: [],
        followUps: [],
        blockers: [],
        awareness: [],
        inbox: [],
        openLoops: [],
        approvalQueue: [],
        workstreams: [],
        suggestedPlan: [],
        draftStandup: '',
        headerSummary: 'Personal ops data is not available yet.',
        recommendedNextAction: setup.recommendedNextAction,
        degradedSummary: 'Connect accounts and sync data to populate Today.',
        statusStrip: [],
        now: [],
        next: [],
        waiting: [],
        awarenessLane: [],
        secondary: {
          meetings: [],
          approvals: [],
          workstreams: [],
          standupPreview: '',
        },
      },
    };
  }

  const curatedPriorities = today.priorities.filter(workItemShouldSurfaceOnToday);
  const curatedBlockers = today.blockers.filter(workItemShouldSurfaceOnToday);
  const curatedOpenLoops = today.openLoops.filter(openLoopShouldSurfaceOnToday);
  const curatedAwareness = today.awareness.filter(sourceShouldSurfaceInTodayAwareness);
  const now = curatedPriorities.slice(0, 4).map(buildWorkItemSummaryCard);
  const next = [
    ...today.approvalQueue.slice(0, 2).map(buildApprovalSummaryCard),
    ...today.meetings.slice(0, 3).map(buildSourceSummaryCard),
    ...today.workstreams.slice(0, 2).map(buildWorkstreamSummaryCard),
  ].slice(0, 6);
  const waiting = [
    ...curatedBlockers.slice(0, 4).map(buildWorkItemSummaryCard),
    ...curatedOpenLoops
      .slice(0, 6)
      .map(buildOpenLoopSummaryCard),
  ];
  const waitingDeduped = dedupeSummaryCards(waiting).slice(0, 8);
  const awarenessLane = curatedAwareness.slice(0, 8).map(buildSourceSummaryCard);
  const headerSummary =
    now[0]
      ? `${now.length} item${now.length === 1 ? '' : 's'} need your attention first.`
      : next[0]
        ? 'No urgent tasks are open; your next actions are queued below.'
        : 'The day is relatively clear right now.';
  const degradedSummary =
    degradedConnections.length > 0
      ? `${degradedConnections.length} connection${degradedConnections.length === 1 ? '' : 's'} need attention.`
      : setup.incompleteCount > 0
        ? 'Setup is still incomplete, so some views may be less useful.'
        : null;

  return {
    ok: true,
    today: {
      ...today,
      headerSummary,
      recommendedNextAction: today.suggestedPlan[0] || setup.recommendedNextAction,
      degradedSummary,
      statusStrip: [
        {
          key: 'priorities',
          label: `${curatedPriorities.length} priorities`,
          tone: curatedPriorities.length ? 'accent' : 'muted',
        },
        {
          key: 'openLoops',
          label: `${curatedOpenLoops.length} open loop${curatedOpenLoops.length === 1 ? '' : 's'}`,
          tone: curatedBlockers.length ? 'warning' : 'muted',
        },
        {
          key: 'approvals',
          label: `${today.approvalQueue.length} approval${today.approvalQueue.length === 1 ? '' : 's'}`,
          tone: today.approvalQueue.length ? 'warning' : 'muted',
        },
      ],
      now,
      next,
      waiting: waitingDeduped,
      awarenessLane,
      secondary: {
        meetings: today.meetings.map(buildSourceSummaryCard),
        approvals: today.approvalQueue.map(buildApprovalSummaryCard),
        workstreams: today.workstreams.map(buildWorkstreamSummaryCard),
        standupPreview: today.draftStandup,
      },
    },
  };
}

function buildInboxPayload(
  deps: OperatorUiDependencies,
  input?: { includeNoise?: boolean },
): Record<string, unknown> {
  const items = deps.personalOps?.getInbox(input) || [];
  const lanes = splitInboxItemsForUi(items);

  return {
    ok: true,
    inbox: items,
    lanes: {
      needsAction: lanes.needsAction.map(buildSourceSummaryCard),
      importantAwareness: lanes.importantAwareness.map(buildSourceSummaryCard),
      lowSignal: lanes.lowSignal.map(buildSourceSummaryCard),
    },
  };
}

function classifyWorkstreamSectionForUi(
  stream: PersonalOpsWorkstream,
): 'needsMyAction' | 'waitingOnOthers' | 'blocked' | 'needsReview' {
  if (stream.blockerCount > 0) return 'blocked';
  if (
    stream.items.length > 0 &&
    stream.items.every((item) => item.status === 'waiting' || item.status === 'on_hold')
  ) {
    return 'waitingOnOthers';
  }
  if (stream.needsReviewCount > 0) return 'needsReview';
  return 'needsMyAction';
}

function buildWorkboardPayload(deps: OperatorUiDependencies): Record<string, unknown> {
  const workboard = deps.personalOps?.getWorkboard() || [];
  const sections = {
    needsMyAction: [] as Array<Record<string, unknown>>,
    waitingOnOthers: [] as Array<Record<string, unknown>>,
    blocked: [] as Array<Record<string, unknown>>,
    needsReview: [] as Array<Record<string, unknown>>,
  };

  for (const stream of workboard) {
    const section = classifyWorkstreamSectionForUi(stream);
    sections[section].push({
      ...buildWorkstreamSummaryCard(stream),
      streamKey: stream.key,
      latestEvidence:
        stream.sourceRecords[0]?.title ||
        stream.items[0]?.title ||
        stream.links[0]?.label ||
        'No recent evidence',
      nextExpectedMove:
        stream.blockerCount > 0
          ? 'Unblock this workstream.'
          : stream.waitingCount > 0
            ? 'Check for a response or unblock condition.'
            : stream.items[0]?.title || 'Confirm the next move.',
    });
  }

  return {
    ok: true,
    workboard,
    sections: [
      { key: 'needsMyAction', title: 'Needs My Action', items: sections.needsMyAction },
      { key: 'waitingOnOthers', title: 'Waiting On Others', items: sections.waitingOnOthers },
      { key: 'blocked', title: 'Blocked', items: sections.blocked },
      { key: 'needsReview', title: 'Needs Review', items: sections.needsReview },
    ],
  };
}

function buildAppBootstrap(deps: OperatorUiDependencies): Record<string, unknown> {
  const groups = deps.getGroups();
  const personalOps = deps.personalOps;
  const today = (personalOps?.getToday() || null) as PersonalOpsTodayView | null;
  const connections = personalOps?.listConnections() || [];
  const degradedConnections = connections.filter(
    (connection) => connection.status === 'degraded' || connection.lastSyncStatus === 'error',
  );
  const runningSyncJobs = connections.flatMap((connection) => connection.syncJobs).filter(
    (job) => job.status === 'running',
  ).length;
  const totalTasks = groups.reduce(
    (count, group) => count + deps.getTasks(group.folder).length,
    0,
  );
  const setup = buildSetupPayload(deps).setup as {
    complete: boolean;
    incompleteCount: number;
    recommendedNextAction: string;
    reviewBurden: number;
    pendingInlineQuestions: number;
    queuedQuestions: number;
    improvementDrafts: number;
    checklist: Array<Record<string, unknown>>;
  };
  const inboxItems = personalOps?.getInbox() || [];
  const inboxLanes = splitInboxItemsForUi(inboxItems);
  const inboxCount = inboxLanes.needsAction.length;
  const prioritiesCount = Array.isArray(today?.priorities)
    ? today.priorities.filter(workItemShouldSurfaceOnToday).length
    : 0;
  const meetingsCount = Array.isArray(today?.meetings) ? today.meetings.length : 0;
  const openLoopCount = Array.isArray(today?.openLoops)
    ? today.openLoops.filter(openLoopShouldSurfaceOnToday).length
    : 0;
  const blockersCount = Array.isArray(today?.blockers)
    ? today.blockers.filter(workItemShouldSurfaceOnToday).length
    : 0;
  const queueCount = personalOps?.getApprovalQueue().slice(0, 200).length || 0;
  const reviewCount = personalOps?.getReviewQueue().slice(0, 200).length || 0;

  return {
    ok: true,
    assistantName: ASSISTANT_NAME,
    timezone: TIMEZONE,
    refreshedAt: new Date().toISOString(),
    legacyUrl: '/admin/legacy',
    capabilities: {
      personalOps: Boolean(personalOps),
      admin: true,
      legacyAdmin: true,
    },
    primaryCounts: {
      today: prioritiesCount + blockersCount,
      inbox: inboxCount,
      work: openLoopCount,
      review:
        queueCount +
        reviewCount +
        (setup.queuedQuestions || 0) +
        (setup.improvementDrafts || 0),
    },
    setupChecklist: setup,
    recommendedNextAction: setup.recommendedNextAction,
    pendingInlineQuestions: setup.pendingInlineQuestions || 0,
    queuedQuestions: setup.queuedQuestions || 0,
    improvementDrafts: setup.improvementDrafts || 0,
    degradedSummary:
      degradedConnections.length > 0
        ? `${degradedConnections.length} connection${degradedConnections.length === 1 ? '' : 's'} need attention.`
        : setup.incompleteCount > 0
          ? 'Setup is still incomplete.'
          : null,
    navCounts: {
      inbox: inboxCount,
      priorities: prioritiesCount,
      meetings: meetingsCount,
      queue: queueCount,
      review: reviewCount,
      questions: setup.queuedQuestions || 0,
      improvements: setup.improvementDrafts || 0,
      openLoops: openLoopCount,
      blockers: blockersCount,
      reports: personalOps?.getReports().slice(0, 6).length || 0,
      connections: connections.length,
      degradedConnections: degradedConnections.length,
      groups: groups.length,
      activeGroups: groups.filter((group) => group.active).length,
      tasks: totalTasks,
    },
    status: {
      degradedConnections: degradedConnections.length,
      runningSyncJobs,
      activeGroups: groups.filter((group) => group.active).length,
      idleGroups: groups.filter((group) => group.idleWaiting).length,
    },
    admin: {
      defaultGroupJid: defaultSelectedChatJid(groups),
      groupCount: groups.length,
      taskCount: totalTasks,
    },
    registry: {
      clients: personalOps?.getClients() || [],
      projects: personalOps?.getProjects() || [],
      repositories: personalOps?.getRepositories() || [],
    },
  };
}

function buildAdminGroupsPayload(deps: OperatorUiDependencies): Record<string, unknown> {
  const groups = deps.getGroups();
  return {
    ok: true,
    refreshedAt: new Date().toISOString(),
    defaultGroupJid: defaultSelectedChatJid(groups),
    groups,
  };
}

function buildAdminTasksPayload(deps: OperatorUiDependencies): Record<string, unknown> {
  const groups = deps.getGroups();
  const tasks = groups
    .flatMap((group) =>
      enrichTasks(deps.getTasks(group.folder), deps.getTaskRuns).map((task) => ({
        ...task,
        groupName: group.name,
        groupFolder: group.folder,
        chatJid: group.chatJid,
      })),
    )
    .sort((a, b) => (a.next_run || '').localeCompare(b.next_run || ''));

  return {
    ok: true,
    refreshedAt: new Date().toISOString(),
    tasks,
  };
}

function buildDashboardPayload(
  deps: OperatorUiDependencies,
  selectedChatJid: string | null,
): Record<string, unknown> {
  const groups = deps.getGroups();
  const resolvedChatJid = selectedChatJid || defaultSelectedChatJid(groups);
  const selectedGroup = groups.find((group) => group.chatJid === resolvedChatJid) || null;

  const detail = selectedGroup ? buildGroupDetail(deps, selectedGroup) : null;

  const personalOps = deps.personalOps
    ? {
        connections: deps.personalOps.listConnections(),
        today: deps.personalOps.getToday(),
        inbox: deps.personalOps.getInbox(),
        calendar: deps.personalOps.getCalendar(),
        workboard: deps.personalOps.getWorkboard(),
        history: deps.personalOps.getHistory(),
        reports: deps.personalOps.getReports(),
        corrections: deps.personalOps.getCorrections(),
        clients: deps.personalOps.getClients(),
        projects: deps.personalOps.getProjects(),
        repositories: deps.personalOps.getRepositories(),
      }
    : null;

  return {
    ok: true,
    assistantName: ASSISTANT_NAME,
    timezone: TIMEZONE,
    refreshedAt: new Date().toISOString(),
    selectedChatJid: resolvedChatJid,
    groups,
    detail,
    personalOps,
  };
}

function validateTaskInput(payload: Record<string, unknown>): {
  ok: true;
  chatJid: string;
  groupFolder: string;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  contextMode: 'group' | 'isolated';
} | {
  ok: false;
  error: string;
} {
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  const chatJid = typeof payload.chatJid === 'string' ? payload.chatJid : '';
  const groupFolder =
    typeof payload.groupFolder === 'string' ? payload.groupFolder : '';
  const scheduleType =
    payload.scheduleType === 'cron' ||
    payload.scheduleType === 'interval' ||
    payload.scheduleType === 'once'
      ? payload.scheduleType
      : null;
  const scheduleValue =
    typeof payload.scheduleValue === 'string' ? payload.scheduleValue.trim() : '';
  const contextMode =
    payload.contextMode === 'isolated' ? 'isolated' : 'group';

  if (!chatJid || !groupFolder || !prompt || !scheduleType || !scheduleValue) {
    return { ok: false, error: 'Task form is incomplete.' };
  }

  if (scheduleType === 'cron') {
    try {
      CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE });
    } catch {
      return { ok: false, error: 'Invalid cron expression.' };
    }
  } else if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) {
      return { ok: false, error: 'Interval must be a positive millisecond value.' };
    }
  } else {
    const date = new Date(scheduleValue);
    if (isNaN(date.getTime())) {
      return { ok: false, error: 'Once schedule must be a valid local timestamp.' };
    }
  }

  return {
    ok: true,
    chatJid,
    groupFolder,
    prompt,
    scheduleType,
    scheduleValue,
    contextMode,
  };
}

async function handleApiRequest(
  deps: OperatorUiDependencies,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '/', `http://${OPERATOR_UI_HOST}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    writeJson(res, 200, { ok: true, url: operatorUiState.url });
    return;
  }

  if (!requireOperatorUiAuth(req, res)) {
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    writeJson(
      res,
      200,
      buildDashboardPayload(deps, url.searchParams.get('chatJid')),
    );
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/app/bootstrap') {
    writeJson(res, 200, buildAppBootstrap(deps));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/setup') {
    writeJson(res, 200, buildSetupPayload(deps));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/groups') {
    writeJson(res, 200, buildAdminGroupsPayload(deps));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/tasks') {
    writeJson(res, 200, buildAdminTasksPayload(deps));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/admin/groups/')) {
    const chatJid = decodeURIComponent(url.pathname.replace('/api/admin/groups/', ''));
    const group = deps.getGroups().find((entry) => entry.chatJid === chatJid);
    if (!group) {
      writeJson(res, 404, { ok: false, error: 'Group not found.' });
      return;
    }
    writeJson(res, 200, { ok: true, detail: buildGroupDetail(deps, group) });
    return;
  }

  if (req.method === 'GET' && deps.personalOps) {
    if (url.pathname === '/api/connections') {
      writeJson(res, 200, { ok: true, connections: deps.personalOps.listConnections() });
      return;
    }
    if (url.pathname === '/api/today') {
      writeJson(res, 200, buildTodayPayload(deps));
      return;
    }
    if (url.pathname === '/api/inbox') {
      writeJson(
        res,
        200,
        buildInboxPayload(deps, {
          includeNoise: url.searchParams.get('includeNoise') === 'true',
        }),
      );
      return;
    }
    if (url.pathname === '/api/calendar') {
      writeJson(res, 200, { ok: true, calendar: deps.personalOps.getCalendar() });
      return;
    }
    if (url.pathname === '/api/workboard') {
      writeJson(res, 200, buildWorkboardPayload(deps));
      return;
    }
    if (url.pathname === '/api/history') {
      const range = {
        since: url.searchParams.get('since') || undefined,
        until: url.searchParams.get('until') || undefined,
      };
      writeJson(res, 200, {
        ok: true,
        history: deps.personalOps.getHistory(range),
        workstreams: deps.personalOps.getHistoryWorkstreams(range),
      });
      return;
    }
    if (url.pathname === '/api/corrections') {
      writeJson(res, 200, {
        ok: true,
        corrections: deps.personalOps.getCorrections(),
        clients: deps.personalOps.getClients(),
        projects: deps.personalOps.getProjects(),
        repositories: deps.personalOps.getRepositories(),
      });
      return;
    }
    if (url.pathname === '/api/contacts') {
      writeJson(res, 200, {
        ok: true,
        ...deps.personalOps.getContacts(),
      });
      return;
    }
    if (url.pathname === '/api/open-loops') {
      writeJson(res, 200, {
        ok: true,
        openLoops: deps.personalOps.getOpenLoops(),
      });
      return;
    }
    if (url.pathname === '/api/questions') {
      const surfaceParam = url.searchParams.get('surface');
      const targetTypeParam = url.searchParams.get('targetType');
      const urgencyParam = url.searchParams.get('urgency');
      writeJson(res, 200, {
        ok: true,
        questions: deps.personalOps.getAssistantQuestions({
          surface:
            surfaceParam === 'today' ||
            surfaceParam === 'inbox' ||
            surfaceParam === 'work' ||
            surfaceParam === 'review' ||
            surfaceParam === 'connections' ||
            surfaceParam === 'calendar'
              ? surfaceParam
              : undefined,
          targetType:
            targetTypeParam === 'source_record' ||
            targetTypeParam === 'contact' ||
            targetTypeParam === 'connection' ||
            targetTypeParam === 'calendar_event' ||
            targetTypeParam === 'work_item' ||
            targetTypeParam === 'setup'
              ? targetTypeParam
              : undefined,
          targetId: url.searchParams.get('targetId') || undefined,
          urgency:
            urgencyParam === 'inline' || urgencyParam === 'queued'
              ? urgencyParam
              : undefined,
        }),
      });
      return;
    }
    if (url.pathname === '/api/queue') {
      writeJson(res, 200, {
        ok: true,
        queue: deps.personalOps.getApprovalQueue(),
      });
      return;
    }
    if (url.pathname === '/api/memory') {
      writeJson(res, 200, {
        ok: true,
        memory: deps.personalOps.getMemoryFacts(),
      });
      return;
    }
    if (url.pathname === '/api/review') {
      writeJson(res, 200, {
        ok: true,
        review: deps.personalOps.getReviewQueue(),
      });
      return;
    }
    if (url.pathname === '/api/improvements') {
      writeJson(res, 200, {
        ok: true,
        improvements: deps.personalOps.getImprovementTickets(),
      });
      return;
    }
    if (url.pathname === '/api/operator-profile') {
      writeJson(res, 200, {
        ok: true,
        profile: deps.personalOps.getOperatorProfile(),
      });
      return;
    }
    if (url.pathname.startsWith('/api/reports/')) {
      const reportType = url.pathname.split('/').pop() as
        | 'morning'
        | 'standup'
        | 'wrap';
      if (reportType !== 'morning' && reportType !== 'standup' && reportType !== 'wrap') {
        writeJson(res, 404, { ok: false, error: 'Report not found.' });
        return;
      }
      writeJson(res, 200, {
        ok: true,
        report: deps.personalOps.getReports().find((report) => report.reportType === reportType) || null,
      });
      return;
    }
    const connectionParts = url.pathname.split('/').filter(Boolean);
    if (
      connectionParts[0] === 'api' &&
      connectionParts[1] === 'connections' &&
      connectionParts[2] &&
      connectionParts[3] &&
      connectionParts[4] === 'catalog'
    ) {
      const provider = decodeURIComponent(connectionParts[2]) as PersonalOpsProvider;
      const accountId = decodeURIComponent(connectionParts[3]);
      if (
        provider !== 'google' &&
        provider !== 'microsoft' &&
        provider !== 'jira' &&
        provider !== 'slack'
      ) {
        writeJson(res, 400, { ok: false, error: 'Unsupported provider.' });
        return;
      }
      const catalog = await deps.personalOps.getConnectionCatalog({
        provider,
        accountId,
      });
      writeJson(res, 200, { ok: true, catalog });
      return;
    }
  }

  if (req.method !== 'POST') {
    writeJson(res, 404, { ok: false, error: 'Not found.' });
    return;
  }

  if (!requireJsonRequest(req, res)) {
    return;
  }

  const rawBody = await readBody(req);
  let payload: Record<string, unknown> = {};
  try {
    payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    writeJson(res, 400, { ok: false, error: 'Invalid JSON body.' });
    return;
  }

  if (url.pathname === '/api/messages' || url.pathname === '/api/admin/messages') {
    const chatJid = typeof payload.chatJid === 'string' ? payload.chatJid : '';
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const sender =
      typeof payload.sender === 'string' && payload.sender.trim()
        ? payload.sender.trim()
        : undefined;
    const senderName =
      typeof payload.senderName === 'string' && payload.senderName.trim()
        ? payload.senderName.trim()
        : undefined;

    if (!chatJid || !text) {
      writeJson(res, 400, { ok: false, error: 'chatJid and text are required.' });
      return;
    }

    const result = deps.injectMessage(chatJid, text, sender, senderName);
    writeJson(res, result.ok ? 202 : 400, result);
    return;
  }

  if (url.pathname === '/api/input' || url.pathname === '/api/admin/input') {
    const chatJid = typeof payload.chatJid === 'string' ? payload.chatJid : '';
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!chatJid || !text) {
      writeJson(res, 400, { ok: false, error: 'chatJid and text are required.' });
      return;
    }
    const ok = deps.sendInput(chatJid, text);
    writeJson(
      res,
      ok ? 202 : 400,
      ok
        ? { ok: true }
        : { ok: false, error: 'Group is not active or no live container is available.' },
    );
    return;
  }

  if (url.pathname === '/api/outbound' || url.pathname === '/api/admin/outbound') {
    const chatJid = typeof payload.chatJid === 'string' ? payload.chatJid : '';
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!chatJid || !text) {
      writeJson(res, 400, { ok: false, error: 'chatJid and text are required.' });
      return;
    }
    const result = await deps.sendOutbound(chatJid, text);
    writeJson(res, result.ok ? 202 : 400, result);
    return;
  }

  if (url.pathname === '/api/tasks') {
    const validation = validateTaskInput(payload);
    if (!validation.ok) {
      writeJson(res, 400, validation);
      return;
    }
    const result = deps.createTask(validation);
    writeJson(res, result.ok ? 201 : 400, result);
    return;
  }

  if (deps.personalOps && url.pathname === '/api/manual/task') {
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    if (!title) {
      writeJson(res, 400, { ok: false, error: 'title is required.' });
      return;
    }
    const item = deps.personalOps.createManualTask({
      title,
      notes: typeof payload.notes === 'string' ? payload.notes.trim() || undefined : undefined,
      dueDate:
        typeof payload.dueDate === 'string' ? payload.dueDate.trim() || undefined : undefined,
      priority:
        payload.priority === 'low' ||
        payload.priority === 'medium' ||
        payload.priority === 'high' ||
        payload.priority === 'urgent'
          ? payload.priority
          : undefined,
      clientId:
        typeof payload.clientId === 'string' ? payload.clientId.trim() || undefined : undefined,
      projectId:
        typeof payload.projectId === 'string' ? payload.projectId.trim() || undefined : undefined,
    });
    writeJson(res, 201, { ok: true, item });
    return;
  }

  if (deps.personalOps && url.pathname === '/api/manual/note') {
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    if (!title) {
      writeJson(res, 400, { ok: false, error: 'title is required.' });
      return;
    }
    const note = deps.personalOps.createManualNote({
      title,
      body: typeof payload.body === 'string' ? payload.body.trim() || undefined : undefined,
      clientId:
        typeof payload.clientId === 'string' ? payload.clientId.trim() || undefined : undefined,
      projectId:
        typeof payload.projectId === 'string' ? payload.projectId.trim() || undefined : undefined,
    });
    writeJson(res, 201, { ok: true, note });
    return;
  }

  if (deps.personalOps && url.pathname === '/api/clients') {
    const id = typeof payload.id === 'string' ? payload.id.trim() : '';
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name) {
      writeJson(res, 400, { ok: false, error: 'name is required.' });
      return;
    }
    const client = deps.personalOps.upsertClient({
      id: id || undefined,
      name,
      parentClientId:
        typeof payload.parentClientId === 'string'
          ? payload.parentClientId.trim() || undefined
          : undefined,
      roles: Array.isArray(payload.roles)
        ? payload.roles
            .map((role) => (typeof role === 'string' ? role.trim() : ''))
            .filter(Boolean)
        : typeof payload.roles === 'string'
          ? payload.roles
              .split(',')
              .map((role) => role.trim())
              .filter(Boolean)
          : undefined,
      status:
        payload.status === 'active' ||
        payload.status === 'prospect' ||
        payload.status === 'on_hold' ||
        payload.status === 'archived'
          ? payload.status
          : undefined,
      notes: typeof payload.notes === 'string' ? payload.notes.trim() || undefined : undefined,
      communicationPreferences:
        typeof payload.communicationPreferences === 'string'
          ? payload.communicationPreferences.trim() || undefined
          : undefined,
    });
    writeJson(res, 201, { ok: true, client });
    return;
  }

  if (deps.personalOps && url.pathname === '/api/projects') {
    const id = typeof payload.id === 'string' ? payload.id.trim() : '';
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name) {
      writeJson(res, 400, { ok: false, error: 'name is required.' });
      return;
    }
    const project = deps.personalOps.upsertProject({
      id: id || undefined,
      name,
      clientId:
        typeof payload.clientId === 'string' ? payload.clientId.trim() || undefined : undefined,
      notes: typeof payload.notes === 'string' ? payload.notes.trim() || undefined : undefined,
      deadline:
        typeof payload.deadline === 'string' ? payload.deadline.trim() || undefined : undefined,
      tags:
        typeof payload.tags === 'string'
          ? payload.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
          : undefined,
    });
    writeJson(res, 201, { ok: true, project });
    return;
  }

  if (deps.personalOps && url.pathname === '/api/repositories') {
    const localPath = typeof payload.localPath === 'string' ? payload.localPath.trim() : '';
    if (!localPath) {
      writeJson(res, 400, { ok: false, error: 'localPath is required.' });
      return;
    }
    const repository = deps.personalOps.upsertRepository({
      id:
        typeof payload.id === 'string' ? payload.id.trim() || undefined : undefined,
      name:
        typeof payload.name === 'string' ? payload.name.trim() || undefined : undefined,
      localPath,
      clientId:
        typeof payload.clientId === 'string' ? payload.clientId.trim() || undefined : undefined,
      projectId:
        typeof payload.projectId === 'string' ? payload.projectId.trim() || undefined : undefined,
      notes: typeof payload.notes === 'string' ? payload.notes.trim() || undefined : undefined,
    });
    writeJson(res, 201, { ok: true, repository });
    return;
  }

  if (deps.personalOps && url.pathname === '/api/repositories/discover') {
    const repositories = deps.personalOps.discoverRepositories({
      rootPath:
        typeof payload.rootPath === 'string' ? payload.rootPath.trim() || undefined : undefined,
      maxDepth:
        typeof payload.maxDepth === 'number'
          ? payload.maxDepth
          : typeof payload.maxDepth === 'string'
            ? parseInt(payload.maxDepth, 10)
            : undefined,
    });
    writeJson(res, 200, {
      ok: true,
      repositories,
      count: repositories.length,
    });
    return;
  }

  if (deps.personalOps && url.pathname === '/api/corrections') {
    const targetType =
      payload.targetType === 'source_record' ||
      payload.targetType === 'work_item' ||
      payload.targetType === 'activity' ||
      payload.targetType === 'report' ||
      payload.targetType === 'preference'
        ? payload.targetType
        : null;
    const targetId =
      typeof payload.targetId === 'string' ? payload.targetId.trim() : '';
    const field = typeof payload.field === 'string' ? payload.field.trim() : '';
    const value = typeof payload.value === 'string' ? payload.value.trim() : '';
    if (!targetType || !targetId || !field || !value) {
      writeJson(res, 400, { ok: false, error: 'targetType, targetId, field, and value are required.' });
      return;
    }
    const correction = deps.personalOps.recordCorrection({
      targetType,
      targetId,
      field,
      value,
    });
    writeJson(res, 201, { ok: true, correction });
    return;
  }

  if (deps.personalOps && url.pathname === '/api/operator-profile') {
    const profile = deps.personalOps.updateOperatorProfile({
      roleSummary:
        typeof payload.roleSummary === 'string' ? payload.roleSummary : undefined,
      workHoursStart:
        typeof payload.workHoursStart === 'number'
          ? payload.workHoursStart
          : typeof payload.workHoursStart === 'string'
            ? parseInt(payload.workHoursStart, 10)
            : undefined,
      workHoursEnd:
        typeof payload.workHoursEnd === 'number'
          ? payload.workHoursEnd
          : typeof payload.workHoursEnd === 'string'
            ? parseInt(payload.workHoursEnd, 10)
            : undefined,
      reportingPreferences:
        typeof payload.reportingPreferences === 'string'
          ? payload.reportingPreferences
          : undefined,
      escalationPreferences:
        typeof payload.escalationPreferences === 'string'
          ? payload.escalationPreferences
          : undefined,
      assistantStyle:
        typeof payload.assistantStyle === 'string' ? payload.assistantStyle : undefined,
      clientOperatingPosture:
        typeof payload.clientOperatingPosture === 'string'
          ? payload.clientOperatingPosture
          : undefined,
    });
    writeJson(res, 200, { ok: true, profile });
    return;
  }

  if (
    deps.personalOps &&
    url.pathname.startsWith('/api/questions/') &&
    (url.pathname.endsWith('/answer') || url.pathname.endsWith('/dismiss'))
  ) {
    const action = url.pathname.endsWith('/answer') ? 'answer' : 'dismiss';
    const encodedId = url.pathname
      .replace('/api/questions/', '')
      .replace(`/${action}`, '');
    const id = decodeURIComponent(encodedId);
    if (!id) {
      writeJson(res, 400, { ok: false, error: 'Question id is required.' });
      return;
    }
    if (action === 'answer') {
      const question = deps.personalOps.answerAssistantQuestion({
        id,
        optionId:
          typeof payload.optionId === 'string' ? payload.optionId.trim() || null : null,
        value: typeof payload.value === 'string' ? payload.value : null,
      });
      writeJson(res, 200, { ok: true, question });
      return;
    }
    const reason =
      payload.reason === 'not_now' ||
      payload.reason === 'resolved' ||
      payload.reason === 'wrong_question'
        ? payload.reason
        : null;
    if (!reason) {
      writeJson(res, 400, { ok: false, error: 'A valid dismiss reason is required.' });
      return;
    }
    const question = deps.personalOps.dismissAssistantQuestion({ id, reason });
    writeJson(res, 200, { ok: true, question });
    return;
  }

  if (
    deps.personalOps &&
    url.pathname.startsWith('/api/review/') &&
    (url.pathname.endsWith('/accept') || url.pathname.endsWith('/reject'))
  ) {
    const accepted = url.pathname.endsWith('/accept');
    const encodedId = url.pathname
      .replace('/api/review/', '')
      .replace(accepted ? '/accept' : '/reject', '');
    const id = decodeURIComponent(encodedId);
    if (!id) {
      writeJson(res, 400, { ok: false, error: 'Review id is required.' });
      return;
    }
    if (accepted) {
      deps.personalOps.reviewAccept(id);
    } else {
      deps.personalOps.reviewReject(id);
    }
    writeJson(res, 200, { ok: true });
    return;
  }

  if (
    deps.personalOps &&
    url.pathname.startsWith('/api/improvements/') &&
    (url.pathname.endsWith('/approve') ||
      url.pathname.endsWith('/reject') ||
      url.pathname.endsWith('/edit'))
  ) {
    const action = url.pathname.endsWith('/approve')
      ? 'approve'
      : url.pathname.endsWith('/reject')
        ? 'reject'
        : 'edit';
    const encodedId = url.pathname
      .replace('/api/improvements/', '')
      .replace(`/${action}`, '');
    const id = decodeURIComponent(encodedId);
    if (!id) {
      writeJson(res, 400, { ok: false, error: 'Improvement id is required.' });
      return;
    }
    if (action === 'approve') {
      writeJson(res, 200, { ok: true, ticket: deps.personalOps.approveImprovementTicket(id) });
      return;
    }
    if (action === 'reject') {
      writeJson(res, 200, { ok: true, ticket: deps.personalOps.rejectImprovementTicket(id) });
      return;
    }
    writeJson(res, 200, {
      ok: true,
      ticket: deps.personalOps.editImprovementTicket(id, {
        title: typeof payload.title === 'string' ? payload.title : undefined,
        problem: typeof payload.problem === 'string' ? payload.problem : undefined,
        observedContext:
          typeof payload.observedContext === 'string'
            ? payload.observedContext
            : undefined,
        desiredBehavior:
          typeof payload.desiredBehavior === 'string'
            ? payload.desiredBehavior
            : undefined,
        userValue: typeof payload.userValue === 'string' ? payload.userValue : undefined,
        acceptanceCriteria: Array.isArray(payload.acceptanceCriteria)
          ? payload.acceptanceCriteria
              .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
              .filter(Boolean)
          : undefined,
        suggestedSurface:
          typeof payload.suggestedSurface === 'string'
            ? payload.suggestedSurface
            : undefined,
        suggestedSubsystem:
          typeof payload.suggestedSubsystem === 'string'
            ? payload.suggestedSubsystem
            : undefined,
        notes: typeof payload.notes === 'string' ? payload.notes : undefined,
      }),
    });
    return;
  }

  if (
    deps.personalOps &&
    url.pathname.startsWith('/api/memory/') &&
    (url.pathname.endsWith('/accept') || url.pathname.endsWith('/reject'))
  ) {
    const accepted = url.pathname.endsWith('/accept');
    const encodedId = url.pathname
      .replace('/api/memory/', '')
      .replace(accepted ? '/accept' : '/reject', '');
    const id = decodeURIComponent(encodedId);
    if (!id) {
      writeJson(res, 400, { ok: false, error: 'Memory id is required.' });
      return;
    }
    if (accepted) {
      deps.personalOps.acceptMemoryFact(id);
    } else {
      deps.personalOps.rejectMemoryFact(id);
    }
    writeJson(res, 200, { ok: true });
    return;
  }

  if (
    deps.personalOps &&
    url.pathname.startsWith('/api/queue/') &&
    (url.pathname.endsWith('/approve') ||
      url.pathname.endsWith('/reject') ||
      url.pathname.endsWith('/edit'))
  ) {
    const action = url.pathname.endsWith('/approve')
      ? 'approve'
      : url.pathname.endsWith('/reject')
        ? 'reject'
        : 'edit';
    const encodedId = url.pathname
      .replace('/api/queue/', '')
      .replace(`/${action}`, '');
    const id = decodeURIComponent(encodedId);
    if (!id) {
      writeJson(res, 400, { ok: false, error: 'Queue id is required.' });
      return;
    }
    if (action === 'approve') {
      writeJson(res, 200, { ok: true, item: deps.personalOps.approveQueueItem(id) });
      return;
    }
    if (action === 'reject') {
      writeJson(res, 200, { ok: true, item: deps.personalOps.rejectQueueItem(id) });
      return;
    }
    writeJson(res, 200, {
      ok: true,
      item: deps.personalOps.editQueueItem(id, {
        title: typeof payload.title === 'string' ? payload.title : undefined,
        summary: typeof payload.summary === 'string' ? payload.summary : undefined,
        body: typeof payload.body === 'string' ? payload.body : undefined,
        reason: typeof payload.reason === 'string' ? payload.reason : undefined,
      }),
    });
    return;
  }

  if (deps.personalOps && url.pathname.startsWith('/api/contacts/')) {
    const contactId = decodeURIComponent(url.pathname.replace('/api/contacts/', '').replace('/link', ''));
    if (!contactId || !url.pathname.endsWith('/link')) {
      writeJson(res, 400, { ok: false, error: 'Contact id is required.' });
      return;
    }
    const contact = deps.personalOps.linkContact({
      contactId,
      clientId:
        typeof payload.clientId === 'string' ? payload.clientId.trim() || null : undefined,
      projectId:
        typeof payload.projectId === 'string' ? payload.projectId.trim() || null : undefined,
      likelyRole:
        typeof payload.likelyRole === 'string' ? payload.likelyRole.trim() || null : undefined,
      importance:
        payload.importance === 'low' ||
        payload.importance === 'normal' ||
        payload.importance === 'high' ||
        payload.importance === 'critical'
          ? payload.importance
          : undefined,
      notes:
        typeof payload.notes === 'string' ? payload.notes.trim() || null : undefined,
      identity:
        payload.identity && typeof payload.identity === 'object'
          ? {
              type: (payload.identity as Record<string, unknown>).type as ContactIdentity['type'],
              provider: (payload.identity as Record<string, unknown>).provider as ContactIdentity['provider'],
              value: String((payload.identity as Record<string, unknown>).value || ''),
              label:
                typeof (payload.identity as Record<string, unknown>).label === 'string'
                  ? ((payload.identity as Record<string, unknown>).label as string)
                  : undefined,
            }
          : undefined,
    });
    writeJson(res, 200, { ok: true, contact });
    return;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (
    deps.personalOps &&
    parts[0] === 'api' &&
    parts[1] === 'connections' &&
    parts[2]
  ) {
    const provider = decodeURIComponent(parts[2]) as PersonalOpsProvider;
    if (
      provider !== 'google' &&
      provider !== 'microsoft' &&
      provider !== 'jira' &&
      provider !== 'slack'
    ) {
      writeJson(res, 400, { ok: false, error: 'Unsupported provider.' });
      return;
    }
    if (parts[3] === 'start') {
      const authUrl = deps.personalOps.beginOAuth(provider, getOperatorUiBaseUrl());
      writeJson(res, 200, { ok: true, url: authUrl });
      return;
    }
    const accountId = parts[3] ? decodeURIComponent(parts[3]) : '';
    const action = parts[4] || '';
    if (!accountId || !action) {
      writeJson(res, 400, { ok: false, error: 'Account id and action are required.' });
      return;
    }
    if (action === 'disconnect') {
      deps.personalOps.disconnect({ provider, accountId });
      writeJson(res, 200, { ok: true });
      return;
    }
    if (action === 'settings') {
      const settings =
        payload.settings && typeof payload.settings === 'object'
          ? (payload.settings as PersonalOpsConnectionSettings)
          : {};
      const connection = deps.personalOps.updateConnectionSettings({
        provider,
        accountId,
        settings,
      });
      writeJson(res, 200, { ok: true, connection });
      return;
    }
    if (action === 'sync') {
      await deps.personalOps.syncProvider({ provider, accountId });
      writeJson(res, 200, { ok: true });
      return;
    }
  }
  if (
    deps.personalOps &&
    parts[0] === 'api' &&
    parts[1] === 'reports' &&
    parts[2] &&
    parts[3] === 'generate'
  ) {
    const reportType = decodeURIComponent(parts[2]) as 'morning' | 'standup' | 'wrap';
    if (reportType !== 'morning' && reportType !== 'standup' && reportType !== 'wrap') {
      writeJson(res, 400, { ok: false, error: 'Unsupported report type.' });
      return;
    }
    const report = await deps.personalOps.generateReport(reportType);
    writeJson(res, 200, { ok: true, report });
    return;
  }
  if (parts[0] === 'api' && parts[1] === 'tasks' && parts[2] && parts[3]) {
    const taskId = decodeURIComponent(parts[2]);
    const action = parts[3];
    const result =
      action === 'update'
        ? (() => {
            const validation = validateTaskInput(payload);
            if (!validation.ok) {
              return validation;
            }
            return deps.updateTask({
              taskId,
              prompt: validation.prompt,
              scheduleType: validation.scheduleType,
              scheduleValue: validation.scheduleValue,
              contextMode: validation.contextMode,
            });
          })()
        : action === 'pause'
        ? deps.pauseTask(taskId)
        : action === 'resume'
          ? deps.resumeTask(taskId)
          : action === 'cancel'
            ? deps.cancelTask(taskId)
            : { ok: false as const, error: 'Unsupported task action.' };
    writeJson(res, result.ok ? 200 : 400, result);
    return;
  }

  writeJson(res, 404, { ok: false, error: 'Not found.' });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const deps = operatorUiState.dependencies;
  if (!deps) {
    writeJson(res, 500, { ok: false, error: 'Operator UI dependencies unavailable.' });
    return;
  }

  const url = new URL(req.url || '/', `http://${OPERATOR_UI_HOST}`);
  const routeParts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/admin/legacy') {
    applySecurityHeaders(res, { cache: 'no-store', html: true });
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(legacyHtml());
    return;
  }

  if (
    req.method === 'GET' &&
    deps.personalOps &&
    routeParts[0] === 'oauth' &&
    routeParts[1]
  ) {
    const provider = routeParts[1] as PersonalOpsProvider;
    if (
      provider !== 'google' &&
      provider !== 'microsoft' &&
      provider !== 'jira' &&
      provider !== 'slack'
    ) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    if (routeParts[2] === 'start') {
      if (url.searchParams.get('token') !== ensureOperatorUiAuthToken()) {
        res.statusCode = 403;
        res.end('Operator UI session token is required.');
        return;
      }
      const authUrl = deps.personalOps.beginOAuth(provider, getOperatorUiBaseUrl());
      res.statusCode = 302;
      res.setHeader('location', authUrl);
      res.end();
      return;
    }
    if (routeParts[2] === 'callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) {
        res.statusCode = 400;
        res.end('Missing OAuth callback parameters.');
        return;
      }
      await deps.personalOps.handleOAuthCallback(
        provider,
        code,
        state,
        getOperatorUiBaseUrl(),
      );
      res.statusCode = 302;
      res.setHeader('location', '/?connected=' + encodeURIComponent(provider));
      res.end();
      return;
    }
  }

  if (url.pathname.startsWith('/api/')) {
    await handleApiRequest(deps, req, res);
    return;
  }

  if (req.method === 'GET' && hasBuiltUi()) {
    if (url.pathname !== '/') {
      const filePath = resolveStaticPath(url.pathname.slice(1));
      if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        serveStaticFile(res, filePath);
        return;
      }
    }

    serveAppIndex(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    applySecurityHeaders(res, { cache: 'no-store', html: true });
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(legacyHtml());
    return;
  }

  res.statusCode = 404;
  res.end('Not found');
}

function listenServer(server: Server, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('error', onError);
      reject(err);
    };

    server.once('error', onError);
    server.listen(port, OPERATOR_UI_HOST, () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to determine operator UI address.'));
        return;
      }
      resolve(address as AddressInfo);
    });
  });
}

export async function startOperatorUi(
  dependencies: OperatorUiDependencies,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!OPERATOR_UI_ENABLED) {
    return { ok: false, error: 'Operator UI is disabled.' };
  }

  if (operatorUiState.server && operatorUiState.url) {
    operatorUiState.dependencies = dependencies;
    return { ok: true, url: operatorUiState.url };
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error({ err }, 'Operator UI request failed');
      writeJson(res, 500, { ok: false, error: 'Internal server error.' });
    });
  });

  try {
    const address = await listenServer(server, OPERATOR_UI_PORT);
    operatorUiState.server = server;
    operatorUiState.dependencies = dependencies;
    operatorUiState.url = `http://${OPERATOR_UI_HOST}:${address.port}`;
    logger.info({ url: operatorUiState.url }, 'Operator UI listening');
    return { ok: true, url: operatorUiState.url };
  } catch (err) {
    server.close();
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ error }, 'Failed to start Operator UI');
    return { ok: false, error };
  }
}

export async function stopOperatorUi(): Promise<void> {
  if (!operatorUiState.server) {
    operatorUiState.dependencies = null;
    operatorUiState.url = null;
    operatorUiState.authToken = null;
    return;
  }

  await new Promise<void>((resolve) => operatorUiState.server!.close(() => resolve()));
  operatorUiState.server = null;
  operatorUiState.dependencies = null;
  operatorUiState.url = null;
  operatorUiState.authToken = null;
}

export function getOperatorUiUrl(): string | null {
  return operatorUiState.url;
}

/** @internal */
export function _getOperatorUiAuthTokenForTesting(): string {
  return ensureOperatorUiAuthToken();
}

/** @internal */
export async function _resetOperatorUiForTesting(): Promise<void> {
  await stopOperatorUi();
}

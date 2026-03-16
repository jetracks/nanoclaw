import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = '/tmp/nanoclaw-operator-ui-test';
fs.mkdirSync(path.join(dataDir, 'local-channel'), { recursive: true });

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  DATA_DIR: '/tmp/nanoclaw-operator-ui-test',
  OPERATOR_UI_ENABLED: true,
  OPERATOR_UI_HOST: '127.0.0.1',
  OPERATOR_UI_PORT: 0,
  PERSONAL_OPS_STORE_DIR: '/tmp/nanoclaw-operator-ui-test/personal-ops',
  TIMEZONE: 'America/Los_Angeles',
}));

import {
  _getOperatorUiAuthTokenForTesting,
  _resetOperatorUiForTesting,
  getOperatorUiUrl,
  startOperatorUi,
  stopOperatorUi,
} from './operator-ui.js';

describe('operator-ui', () => {
  const transcriptPath = path.join(dataDir, 'transcript.jsonl');
  const injectMessage = vi.fn(() => ({
    ok: true as const,
    messageId: 'msg_123',
  }));
  const sendInput = vi.fn(() => true);
  const sendOutbound = vi.fn(async () => ({ ok: true as const }));
  const createTask = vi.fn(() => ({ ok: true as const, taskId: 'task_123' }));
  const updateTask = vi.fn(() => ({ ok: true as const }));
  const pauseTask = vi.fn(() => ({ ok: true as const }));
  const resumeTask = vi.fn(() => ({ ok: true as const }));
  const cancelTask = vi.fn(() => ({ ok: true as const }));
  const syncProvider = vi.fn(async () => undefined);
  const disconnect = vi.fn(() => undefined);
  const getConnectionCatalog = vi.fn(async () => ({
    provider: 'google' as const,
    accountId: 'acct_1',
    accountLabel: 'jerry@example.com',
    mailLabels: [
      { id: 'INBOX', label: 'Inbox', isDefault: true },
      { id: 'IMPORTANT', label: 'Important' },
    ],
    mailFolders: [],
    calendars: [{ id: 'primary', label: 'Primary', isDefault: true }],
    projects: [],
    channels: [],
  }));
  const updateConnectionSettings = vi.fn(() => ({
    connectionKey: 'google:acct_1',
    provider: 'google' as const,
    status: 'connected' as const,
    accountLabel: 'jerry@example.com',
    accountId: 'acct_1',
    baseUrl: null,
    scopes: [],
    expiresAt: null,
    lastSyncAt: '2026-03-14T18:00:00.000Z',
    lastSyncStatus: 'success' as const,
    lastSyncError: null,
    resourceId: null,
    settings: { googleMailQuery: 'category:primary' },
    createdAt: '2026-03-14T18:00:00.000Z',
    updatedAt: '2026-03-14T18:00:00.000Z',
  }));
  const upsertRepository = vi.fn(() => ({
    id: 'repo_1',
    clientId: 'client_1',
    projectId: 'project_1',
    name: 'nanoclaw',
    localPath: '/Users/j.csandoval/OpenClaw/nanoclaw',
    remoteUrl: 'git@github.com:jetracks/nanoclaw.git',
    defaultBranch: 'main',
    lastCommitAt: '2026-03-14T17:30:00.000Z',
    notes: 'Primary repo',
    createdAt: '2026-03-14T18:00:00.000Z',
    updatedAt: '2026-03-14T18:00:00.000Z',
  }));
  const discoverRepositories = vi.fn(() => [
    {
      id: 'repo_2',
      clientId: null,
      projectId: null,
      name: 'wabash',
      localPath: '/Users/j.csandoval/Downloads/wabash',
      remoteUrl: 'git@github.com:jetracks/wabash.git',
      defaultBranch: 'main',
      lastCommitAt: '2026-03-13T18:00:00.000Z',
      notes: '',
      createdAt: '2026-03-14T18:00:00.000Z',
      updatedAt: '2026-03-14T18:00:00.000Z',
    },
  ]);
  const generateReport = vi.fn(async () => ({
    id: 'report_1',
    reportType: 'standup' as const,
    generatedAt: '2026-03-14T18:05:00.000Z',
    rangeStart: '2026-03-14T00:00:00.000Z',
    rangeEnd: '2026-03-14T18:05:00.000Z',
    groupedOutput: 'Standup body',
    sourceReferences: ['google:email:msg-1'],
    model: 'deterministic',
  }));

  beforeEach(() => {
    injectMessage.mockClear();
    sendInput.mockClear();
    sendOutbound.mockClear();
    createTask.mockClear();
    updateTask.mockClear();
    pauseTask.mockClear();
    resumeTask.mockClear();
    cancelTask.mockClear();
    syncProvider.mockClear();
    disconnect.mockClear();
    getConnectionCatalog.mockClear();
    updateConnectionSettings.mockClear();
    upsertRepository.mockClear();
    discoverRepositories.mockClear();
    generateReport.mockClear();

    fs.rmSync(path.join(dataDir, 'personal-ops'), {
      recursive: true,
      force: true,
    });
    fs.mkdirSync(path.join(dataDir, 'local-channel'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'local-channel', 'outbox.jsonl'),
      JSON.stringify({
        jid: 'local:main',
        text: 'Operator UI reply',
        sentAt: '2026-03-14T18:00:05.000Z',
      }) + '\n',
    );
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          ts: '2026-03-14T18:00:00.000Z',
          kind: 'user_prompt',
          prompt:
            '<messages>\n<message sender="Local User" time="Mar 14, 2026, 11:00 AM">hello</message>\n</messages>',
        }),
        JSON.stringify({
          ts: '2026-03-14T18:00:01.000Z',
          kind: 'tool',
          tool_type: 'function_call',
          name: 'send_message',
          payload: { ok: true },
        }),
      ].join('\n') + '\n',
    );
  });

  afterEach(async () => {
    await stopOperatorUi();
    await _resetOperatorUiForTesting();
  });

  function authorizedHeaders(
    extraHeaders?: Record<string, string>,
  ): Record<string, string> {
    return {
      'x-nanoclaw-operator-token': _getOperatorUiAuthTokenForTesting(),
      ...(extraHeaders || {}),
    };
  }

  it('serves dashboard state and accepts message/task actions', async () => {
    const started = await startOperatorUi({
      getGroups: () => [
        {
          chatJid: 'local:main',
          name: 'Local Main',
          folder: 'main',
          trigger: '@Andy',
          addedAt: '2026-03-14T18:00:00.000Z',
          requiresTrigger: false,
          isMain: true,
          active: true,
          idleWaiting: false,
          lastMessageTime: '2026-03-14T18:00:00.000Z',
          channel: 'local',
          session: {
            provider: 'openai',
            previousResponseId: 'resp_123',
            transcriptPath,
            summaryPath: '/tmp/summary.md',
            compactionCount: 0,
          },
          transcriptPath,
        },
      ],
      getMessages: () => [
        {
          id: 'msg_1',
          chat_jid: 'local:main',
          sender: 'local:user',
          sender_name: 'Local User',
          content: 'hello',
          timestamp: '2026-03-14T18:00:00.000Z',
          is_from_me: false,
        },
      ],
      getTasks: () => [
        {
          id: 'task_1',
          group_folder: 'main',
          chat_jid: 'local:main',
          prompt: 'Daily check-in',
          schedule_type: 'cron',
          schedule_value: '0 9 * * *',
          context_mode: 'group',
          next_run: '2026-03-15T16:00:00.000Z',
          last_run: null,
          last_result: null,
          status: 'active',
          created_at: '2026-03-14T18:00:00.000Z',
        },
      ],
      getTaskRuns: () => [
        {
          task_id: 'task_1',
          run_at: '2026-03-14T17:00:00.000Z',
          duration_ms: 1234,
          status: 'success',
          result: 'ok',
          error: null,
        },
      ],
      injectMessage,
      sendInput,
      sendOutbound,
      createTask,
      updateTask,
      pauseTask,
      resumeTask,
      cancelTask,
      personalOps: {
        listConnections: () => [
          {
            connectionKey: 'google:acct_1',
            provider: 'google',
            status: 'connected',
            accountLabel: 'jerry@example.com',
            accountId: 'acct_1',
            baseUrl: null,
            scopes: [],
            expiresAt: null,
            lastSyncAt: '2026-03-14T18:00:00.000Z',
            lastSyncStatus: 'success',
            lastSyncError: null,
            resourceId: null,
            settings: {},
            createdAt: '2026-03-14T18:00:00.000Z',
            updatedAt: '2026-03-14T18:00:00.000Z',
            syncJobs: [
              {
                sourceKind: 'email',
                cursor: null,
                lastRunAt: '2026-03-14T18:00:00.000Z',
                nextRunAt: '2026-03-14T18:05:00.000Z',
                backoffUntil: null,
                status: 'idle',
                error: null,
              },
            ],
          },
          {
            connectionKey: 'google:acct_2',
            provider: 'google',
            status: 'connected',
            accountLabel: 'ops@example.com',
            accountId: 'acct_2',
            baseUrl: null,
            scopes: [],
            expiresAt: null,
            lastSyncAt: '2026-03-14T18:01:00.000Z',
            lastSyncStatus: 'success',
            lastSyncError: null,
            resourceId: null,
            settings: {},
            createdAt: '2026-03-14T18:01:00.000Z',
            updatedAt: '2026-03-14T18:01:00.000Z',
            syncJobs: [
              {
                connectionKey: 'google:acct_2',
                sourceKind: 'calendar_event',
                accountId: 'acct_2',
                accountLabel: 'ops@example.com',
                cursor: null,
                lastRunAt: '2026-03-14T18:01:00.000Z',
                nextRunAt: '2026-03-14T18:16:00.000Z',
                backoffUntil: null,
                status: 'idle',
                error: null,
              },
            ],
          },
        ],
        getToday: () => ({
          generatedAt: '2026-03-14T18:00:00.000Z',
          meetings: [],
          priorities: [],
          overdue: [],
          followUps: [],
          blockers: [],
          inbox: [],
          approvalQueue: [],
          workstreams: [],
          suggestedPlan: ['Start with the contract review'],
          draftStandup: 'Standup draft',
        }),
        getInbox: () => [],
        getCalendar: () => [],
        getWorkboard: () => [],
        getHistory: () => [],
        getHistoryWorkstreams: () => [],
        getReports: () => [
          {
            id: 'report_0',
            reportType: 'standup',
            generatedAt: '2026-03-14T18:00:00.000Z',
            rangeStart: '2026-03-14T00:00:00.000Z',
            rangeEnd: '2026-03-14T18:00:00.000Z',
            groupedOutput: 'Existing standup',
            sourceReferences: ['google:email:msg-1'],
            model: 'deterministic',
          },
        ],
        generateReport,
        getCorrections: () => [],
        getContacts: () => ({
          contacts: [],
          identities: [],
          suggestions: [],
          accountHints: [],
          operatorProfile: {
            roleSummary: 'Operator',
            workHoursStart: 6,
            workHoursEnd: 22,
            reportingPreferences: 'Concise',
            escalationPreferences: 'Escalate risk',
            assistantStyle: 'Clear',
            updatedAt: '2026-03-14T18:00:00.000Z',
          },
        }),
        linkContact: vi.fn(),
        getOpenLoops: () => [],
        getAssistantQuestions: (input) =>
          input?.surface === 'connections'
            ? [
                {
                  id: 'question_setup_1',
                  dedupeKey: 'question_setup_1',
                  status: 'pending',
                  surface: 'connections',
                  targetType: 'connection',
                  targetId: 'google:acct_1',
                  urgency: 'inline',
                  prompt: 'Which account should be tuned next?',
                  rationale:
                    'A connected account is still missing defaults or triage guidance.',
                  recommendedOptionId: null,
                  options: [],
                  freeformAllowed: false,
                  effectPreview: 'Open setup',
                  createdFrom: 'setup_fallback_connections',
                  answerOptionId: null,
                  answerValue: null,
                  snoozeUntil: null,
                  createdAt: '2026-03-14T18:00:00.000Z',
                  updatedAt: '2026-03-14T18:00:00.000Z',
                  answeredAt: null,
                },
              ]
            : [],
        answerAssistantQuestion: vi.fn(),
        dismissAssistantQuestion: vi.fn(),
        getApprovalQueue: () => [],
        approveQueueItem: vi.fn(),
        rejectQueueItem: vi.fn(),
        editQueueItem: vi.fn(),
        getMemoryFacts: () => [],
        acceptMemoryFact: vi.fn(),
        rejectMemoryFact: vi.fn(),
        getReviewQueue: () => [],
        getImprovementTickets: () => [],
        approveImprovementTicket: vi.fn(),
        rejectImprovementTicket: vi.fn(),
        editImprovementTicket: vi.fn(),
        reviewAccept: vi.fn(),
        reviewReject: vi.fn(),
        getOperatorProfile: () => ({
          roleSummary: 'Operator',
          workHoursStart: 6,
          workHoursEnd: 22,
          reportingPreferences: 'Concise',
          escalationPreferences: 'Escalate risk',
          assistantStyle: 'Clear',
          updatedAt: '2026-03-14T18:00:00.000Z',
        }),
        updateOperatorProfile: vi.fn((input) => ({
          roleSummary: input.roleSummary || 'Operator',
          workHoursStart: 6,
          workHoursEnd: 22,
          reportingPreferences: 'Concise',
          escalationPreferences: 'Escalate risk',
          assistantStyle: 'Clear',
          updatedAt: '2026-03-14T18:05:00.000Z',
        })),
        getClients: () => [
          {
            id: 'client_1',
            name: 'Client A',
            parentClientId: null,
            roles: [],
            status: 'active',
            notes: '',
            communicationPreferences: '',
            createdAt: '2026-03-14T18:00:00.000Z',
            updatedAt: '2026-03-14T18:00:00.000Z',
          },
        ],
        getProjects: () => [
          {
            id: 'project_1',
            clientId: 'client_1',
            name: 'Project X',
            status: 'active',
            priority: 'high',
            deadline: null,
            notes: '',
            tags: [],
            createdAt: '2026-03-14T18:00:00.000Z',
            updatedAt: '2026-03-14T18:00:00.000Z',
          },
        ],
        getRepositories: () => [
          {
            id: 'repo_1',
            clientId: 'client_1',
            projectId: 'project_1',
            name: 'nanoclaw',
            localPath: '/Users/j.csandoval/OpenClaw/nanoclaw',
            remoteUrl: 'git@github.com:jetracks/nanoclaw.git',
            defaultBranch: 'main',
            lastCommitAt: '2026-03-14T17:30:00.000Z',
            notes: 'Primary repo',
            createdAt: '2026-03-14T18:00:00.000Z',
            updatedAt: '2026-03-14T18:00:00.000Z',
          },
        ],
        beginOAuth: () => 'https://example.com/oauth/start',
        handleOAuthCallback: vi.fn(async () => undefined),
        disconnect,
        getConnectionCatalog,
        updateConnectionSettings,
        syncProvider,
        createManualTask: vi.fn(),
        createManualNote: vi.fn(),
        upsertClient: vi.fn(),
        upsertProject: vi.fn(),
        upsertRepository,
        discoverRepositories,
        recordCorrection: vi.fn(),
      },
    });

    expect(started.ok).toBe(true);
    const baseUrl = getOperatorUiUrl();
    expect(baseUrl).toBeTruthy();

    const dashboardRes = await fetch(`${baseUrl}/api/dashboard`, {
      headers: authorizedHeaders(),
    });
    const dashboard: any = await dashboardRes.json();
    expect(dashboard.ok).toBe(true);
    expect(dashboard.groups[0].chatJid).toBe('local:main');
    expect(dashboard.detail.conversation[0].text).toBe('hello');
    expect(dashboard.detail.conversation[1].text).toBe('Operator UI reply');
    expect(dashboard.detail.events[0].name).toBe('send_message');

    const bootstrapRes = await fetch(`${baseUrl}/api/app/bootstrap`, {
      headers: authorizedHeaders(),
    });
    const bootstrap: any = await bootstrapRes.json();
    expect(bootstrap.ok).toBe(true);
    expect(bootstrap.legacyUrl).toBe('/admin/legacy');
    expect(bootstrap.primaryCounts.review).toBeGreaterThanOrEqual(0);
    expect(typeof bootstrap.recommendedNextAction).toBe('string');
    expect(Array.isArray(bootstrap.setupChecklist.checklist)).toBe(true);
    expect(Array.isArray(bootstrap.setupChecklist.questions)).toBe(true);
    expect(bootstrap.setupChecklist.questions.length).toBeGreaterThan(0);
    expect(bootstrap.registry.clients[0].name).toBe('Client A');
    expect(bootstrap.registry.repositories[0].name).toBe('nanoclaw');

    const setupRes = await fetch(`${baseUrl}/api/setup`, {
      headers: authorizedHeaders(),
    });
    const setupPayload: any = await setupRes.json();
    expect(setupPayload.ok).toBe(true);
    expect(Array.isArray(setupPayload.setup.checklist)).toBe(true);
    expect(Array.isArray(setupPayload.setup.questions)).toBe(true);
    expect(typeof setupPayload.setup.recommendedNextAction).toBe('string');

    const adminGroupsRes = await fetch(`${baseUrl}/api/admin/groups`, {
      headers: authorizedHeaders(),
    });
    const adminGroups: any = await adminGroupsRes.json();
    expect(adminGroups.ok).toBe(true);
    expect(adminGroups.groups[0].chatJid).toBe('local:main');

    const reviewRes = await fetch(`${baseUrl}/api/review`, {
      headers: authorizedHeaders(),
    });
    const review: any = await reviewRes.json();
    expect(review.ok).toBe(true);
    expect(Array.isArray(review.review)).toBe(true);

    const contactsRes = await fetch(`${baseUrl}/api/contacts`, {
      headers: authorizedHeaders(),
    });
    const contacts: any = await contactsRes.json();
    expect(contacts.ok).toBe(true);
    expect(Array.isArray(contacts.contacts)).toBe(true);
    expect(contacts.operatorProfile.roleSummary).toBe('Operator');

    const openLoopsRes = await fetch(`${baseUrl}/api/open-loops`, {
      headers: authorizedHeaders(),
    });
    const openLoops: any = await openLoopsRes.json();
    expect(openLoops.ok).toBe(true);
    expect(Array.isArray(openLoops.openLoops)).toBe(true);

    const operatorProfileRes = await fetch(`${baseUrl}/api/operator-profile`, {
      headers: authorizedHeaders(),
    });
    const operatorProfile: any = await operatorProfileRes.json();
    expect(operatorProfile.ok).toBe(true);
    expect(operatorProfile.profile.workHoursStart).toBe(6);

    const adminDetailRes = await fetch(
      `${baseUrl}/api/admin/groups/${encodeURIComponent('local:main')}`,
      {
        headers: authorizedHeaders(),
      },
    );
    const adminDetail: any = await adminDetailRes.json();
    expect(adminDetail.ok).toBe(true);
    expect(adminDetail.detail.group.chatJid).toBe('local:main');

    const adminTasksRes = await fetch(`${baseUrl}/api/admin/tasks`, {
      headers: authorizedHeaders(),
    });
    const adminTasks: any = await adminTasksRes.json();
    expect(adminTasks.ok).toBe(true);
    expect(adminTasks.tasks[0].groupName).toBe('Local Main');

    const reportRes = await fetch(`${baseUrl}/api/reports/standup`, {
      headers: authorizedHeaders(),
    });
    const reportPayload: any = await reportRes.json();
    expect(reportPayload.ok).toBe(true);
    expect(reportPayload.report.reportType).toBe('standup');

    const generateReportRes = await fetch(
      `${baseUrl}/api/reports/standup/generate`,
      {
        method: 'POST',
        headers: authorizedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({}),
      },
    );
    const generatedReportPayload: any = await generateReportRes.json();
    expect(generatedReportPayload.ok).toBe(true);
    expect(generateReport).toHaveBeenCalledWith('standup');

    const correctionsRes = await fetch(`${baseUrl}/api/corrections`, {
      headers: authorizedHeaders(),
    });
    const correctionsPayload: any = await correctionsRes.json();
    expect(correctionsPayload.ok).toBe(true);
    expect(correctionsPayload.clients).toHaveLength(1);
    expect(correctionsPayload.projects).toHaveLength(1);
    expect(correctionsPayload.repositories).toHaveLength(1);

    const connectionsRes = await fetch(`${baseUrl}/api/connections`, {
      headers: authorizedHeaders(),
    });
    const connectionsPayload: any = await connectionsRes.json();
    expect(connectionsPayload.ok).toBe(true);
    expect(connectionsPayload.connections).toHaveLength(2);
    expect(
      connectionsPayload.connections.map((entry: any) => entry.accountLabel),
    ).toEqual(['jerry@example.com', 'ops@example.com']);

    const connectionCatalogRes = await fetch(
      `${baseUrl}/api/connections/google/acct_1/catalog`,
      {
        headers: authorizedHeaders(),
      },
    );
    const connectionCatalogPayload: any = await connectionCatalogRes.json();
    expect(connectionCatalogPayload.ok).toBe(true);
    expect(getConnectionCatalog).toHaveBeenCalledWith({
      provider: 'google',
      accountId: 'acct_1',
    });

    const connectionSettingsRes = await fetch(
      `${baseUrl}/api/connections/google/acct_1/settings`,
      {
        method: 'POST',
        headers: authorizedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          settings: {
            googleMailQuery: 'category:primary',
            googleCalendarIds: ['primary'],
          },
        }),
      },
    );
    const connectionSettingsPayload: any = await connectionSettingsRes.json();
    expect(connectionSettingsPayload.ok).toBe(true);
    expect(updateConnectionSettings).toHaveBeenCalledWith({
      provider: 'google',
      accountId: 'acct_1',
      settings: {
        googleMailQuery: 'category:primary',
        googleCalendarIds: ['primary'],
      },
    });

    const syncConnectionRes = await fetch(
      `${baseUrl}/api/connections/google/acct_2/sync`,
      {
        method: 'POST',
        headers: authorizedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({}),
      },
    );
    const syncConnectionPayload: any = await syncConnectionRes.json();
    expect(syncConnectionPayload.ok).toBe(true);
    expect(syncProvider).toHaveBeenCalledWith({
      provider: 'google',
      accountId: 'acct_2',
    });

    const disconnectConnectionRes = await fetch(
      `${baseUrl}/api/connections/google/acct_1/disconnect`,
      {
        method: 'POST',
        headers: authorizedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({}),
      },
    );
    const disconnectConnectionPayload: any =
      await disconnectConnectionRes.json();
    expect(disconnectConnectionPayload.ok).toBe(true);
    expect(disconnect).toHaveBeenCalledWith({
      provider: 'google',
      accountId: 'acct_1',
    });

    const legacyRes = await fetch(`${baseUrl}/admin/legacy`);
    const legacyHtml = await legacyRes.text();
    expect(legacyHtml).toContain('NanoClaw Operator');

    const messageRes = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: authorizedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ chatJid: 'local:main', text: 'hi from ui' }),
    });
    const messagePayload: any = await messageRes.json();
    expect(messagePayload.ok).toBe(true);
    expect(injectMessage).toHaveBeenCalledWith(
      'local:main',
      'hi from ui',
      undefined,
      undefined,
    );

    const inputRes = await fetch(`${baseUrl}/api/input`, {
      method: 'POST',
      headers: authorizedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ chatJid: 'local:main', text: 'follow up' }),
    });
    const inputPayload: any = await inputRes.json();
    expect(inputPayload.ok).toBe(true);
    expect(sendInput).toHaveBeenCalledWith('local:main', 'follow up');

    const outboundRes = await fetch(`${baseUrl}/api/outbound`, {
      method: 'POST',
      headers: authorizedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ chatJid: 'local:main', text: 'ship it' }),
    });
    const outboundPayload: any = await outboundRes.json();
    expect(outboundPayload.ok).toBe(true);
    expect(sendOutbound).toHaveBeenCalledWith('local:main', 'ship it');

    const adminMessageRes = await fetch(`${baseUrl}/api/admin/messages`, {
      method: 'POST',
      headers: authorizedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ chatJid: 'local:main', text: 'admin hi' }),
    });
    const adminMessagePayload: any = await adminMessageRes.json();
    expect(adminMessagePayload.ok).toBe(true);
    expect(injectMessage).toHaveBeenCalledWith(
      'local:main',
      'admin hi',
      undefined,
      undefined,
    );

    const taskRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: authorizedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        chatJid: 'local:main',
        groupFolder: 'main',
        prompt: 'Check logs',
        scheduleType: 'interval',
        scheduleValue: '60000',
        contextMode: 'group',
      }),
    });
    const taskPayload: any = await taskRes.json();
    expect(taskPayload.ok).toBe(true);
    expect(createTask).toHaveBeenCalled();

    const repositoryRes = await fetch(`${baseUrl}/api/repositories`, {
      method: 'POST',
      headers: authorizedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        localPath: '/Users/j.csandoval/OpenClaw/nanoclaw',
        projectId: 'project_1',
      }),
    });
    const repositoryPayload: any = await repositoryRes.json();
    expect(repositoryPayload.ok).toBe(true);
    expect(upsertRepository).toHaveBeenCalledWith({
      id: undefined,
      name: undefined,
      localPath: '/Users/j.csandoval/OpenClaw/nanoclaw',
      clientId: undefined,
      projectId: 'project_1',
      notes: undefined,
    });

    const discoverReposRes = await fetch(
      `${baseUrl}/api/repositories/discover`,
      {
        method: 'POST',
        headers: authorizedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ rootPath: '~', maxDepth: 5 }),
      },
    );
    const discoverReposPayload: any = await discoverReposRes.json();
    expect(discoverReposPayload.ok).toBe(true);
    expect(discoverReposPayload.count).toBe(1);
    expect(discoverRepositories).toHaveBeenCalledWith({
      rootPath: '~',
      maxDepth: 5,
    });

    const updateRes = await fetch(`${baseUrl}/api/tasks/task_1/update`, {
      method: 'POST',
      headers: authorizedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        chatJid: 'local:main',
        groupFolder: 'main',
        prompt: 'Updated task',
        scheduleType: 'cron',
        scheduleValue: '0 10 * * *',
        contextMode: 'isolated',
      }),
    });
    const updatePayload: any = await updateRes.json();
    expect(updatePayload.ok).toBe(true);
    expect(updateTask).toHaveBeenCalledWith({
      taskId: 'task_1',
      prompt: 'Updated task',
      scheduleType: 'cron',
      scheduleValue: '0 10 * * *',
      contextMode: 'isolated',
    });
  });

  it('merges newer transcript assistant output after stored assistant messages exist', async () => {
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          ts: '2026-03-14T18:00:00.000Z',
          kind: 'user_prompt',
          prompt:
            '<messages>\n<message sender="Local User" time="Mar 14, 2026, 11:00 AM">hello</message>\n</messages>',
        }),
        JSON.stringify({
          ts: '2026-03-14T18:00:02.000Z',
          kind: 'response',
          output_text: 'Newer transcript response',
        }),
      ].join('\n') + '\n',
    );

    const started = await startOperatorUi({
      getGroups: () => [
        {
          chatJid: 'tg:123',
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          addedAt: '2026-03-14T18:00:00.000Z',
          requiresTrigger: false,
          isMain: true,
          active: false,
          idleWaiting: true,
          lastMessageTime: '2026-03-14T18:00:02.000Z',
          channel: 'telegram',
          session: {
            provider: 'openai',
            previousResponseId: 'resp_123',
            transcriptPath,
            summaryPath: '/tmp/summary.md',
            compactionCount: 0,
          },
          transcriptPath,
        },
      ],
      getMessages: () => [
        {
          id: 'msg_1',
          chat_jid: 'tg:123',
          sender: 'user1',
          sender_name: 'Local User',
          content: 'hello',
          timestamp: '2026-03-14T18:00:00.000Z',
          is_from_me: false,
        },
        {
          id: 'msg_2',
          chat_jid: 'tg:123',
          sender: 'nanoclaw:andy',
          sender_name: 'Andy',
          content: 'Older stored reply',
          timestamp: '2026-03-14T18:00:01.000Z',
          is_from_me: true,
          is_bot_message: true,
        },
      ],
      getTasks: () => [],
      getTaskRuns: () => [],
      injectMessage,
      sendInput,
      sendOutbound,
      createTask,
      updateTask,
      pauseTask,
      resumeTask,
      cancelTask,
    });

    expect(started.ok).toBe(true);
    const baseUrl = getOperatorUiUrl();
    expect(baseUrl).toBeTruthy();

    const adminDetailRes = await fetch(
      `${baseUrl}/api/admin/groups/${encodeURIComponent('tg:123')}`,
      {
        headers: authorizedHeaders(),
      },
    );
    const adminDetail: any = await adminDetailRes.json();
    expect(adminDetail.ok).toBe(true);
    expect(
      adminDetail.detail.conversation.map((item: any) => item.text),
    ).toEqual(['hello', 'Older stored reply', 'Newer transcript response']);
    expect(
      adminDetail.detail.conversation.map((item: any) => item.source),
    ).toEqual(['messages', 'messages', 'transcript']);
  });

  it('dedupes Today waiting cards, aligns bootstrap inbox counts, and returns clearer surfaced reasons', async () => {
    const started = await startOperatorUi({
      getGroups: () => [],
      getMessages: () => [],
      getTasks: () => [],
      getTaskRuns: () => [],
      injectMessage,
      sendInput,
      sendOutbound,
      createTask,
      updateTask,
      pauseTask,
      resumeTask,
      cancelTask,
      personalOps: {
        listConnections: () => [
          {
            connectionKey: 'microsoft:acct_bm',
            provider: 'microsoft',
            status: 'connected',
            accountLabel: 'jerry@bettymills.com',
            accountId: 'acct_bm',
            baseUrl: null,
            scopes: [],
            expiresAt: null,
            lastSyncAt: '2026-03-15T19:00:00.000Z',
            lastSyncStatus: 'success',
            lastSyncError: null,
            resourceId: null,
            settings: {
              defaultClientId: 'client_bm',
              defaultProjectId: 'project_coo',
            },
            createdAt: '2026-03-15T19:00:00.000Z',
            updatedAt: '2026-03-15T19:00:00.000Z',
            syncJobs: [],
          },
        ],
        getToday: () => ({
          generatedAt: '2026-03-15T19:00:00.000Z',
          meetings: [],
          priorities: [],
          overdue: [],
          followUps: [],
          blockers: [
            {
              id: 'work_1',
              title:
                'Investigate SPS Commerce FTP connection failure impacting EDI transfer',
              sourceKind: 'email',
              sourceProvider: 'microsoft',
              sourceRecordKey: 'microsoft:acct_bm:email:incident_1',
              clientId: 'client_bm',
              projectId: 'project_platform',
              dueDate: null,
              priority: 'urgent',
              status: 'blocked',
              confidence: 0.91,
              needsReview: false,
              linkedContactIds: [],
              openLoopState: 'blocked',
              notes:
                'Same obligation should not appear twice in Today waiting lane.',
              createdAt: '2026-03-15T18:55:00.000Z',
              updatedAt: '2026-03-15T19:00:00.000Z',
            },
          ],
          awareness: [],
          inbox: [],
          openLoops: [
            {
              id: 'loop_1',
              kind: 'work_item',
              state: 'blocked',
              title:
                'Investigate SPS Commerce FTP connection failure impacting EDI transfer',
              summary: 'Same incident represented as an open loop.',
              priority: 'urgent',
              confidence: 0.88,
              clientId: 'client_bm',
              projectId: 'project_platform',
              workItemId: 'work_1',
              sourceRecordKey: 'microsoft:acct_bm:email:incident_1',
              workstreamKey: 'stream_platform',
              linkedContactIds: [],
              needsReview: false,
              dueAt: null,
              lastUpdatedAt: '2026-03-15T19:00:00.000Z',
            },
          ],
          approvalQueue: [],
          workstreams: [
            {
              key: 'stream_platform',
              client: {
                id: 'client_bm',
                name: 'Betty Mills',
                parentClientId: null,
                roles: ['COO'],
                status: 'active',
                notes: '',
                communicationPreferences: '',
                createdAt: '2026-03-15T18:00:00.000Z',
                updatedAt: '2026-03-15T18:00:00.000Z',
              },
              project: {
                id: 'project_platform',
                clientId: 'client_bm',
                name: 'Platform',
                status: 'active',
                priority: 'high',
                deadline: null,
                notes: '',
                tags: [],
                createdAt: '2026-03-15T18:00:00.000Z',
                updatedAt: '2026-03-15T18:00:00.000Z',
              },
              items: [],
              sourceRecords: [],
              recentActivity: [],
              repositories: [],
              linkedContacts: [],
              links: [],
              lastUpdatedAt: '2026-03-15T19:00:00.000Z',
              nextDueAt: null,
              blockerCount: 1,
              waitingCount: 0,
              openLoopCount: 1,
              needsReviewCount: 0,
              signals: ['SPS Commerce incident is still unresolved'],
            },
          ],
          suggestedPlan: ['Handle the SPS Commerce incident first.'],
          draftStandup: '',
        }),
        getInbox: () => [
          {
            provider: 'microsoft',
            accountId: 'acct_bm',
            accountLabel: 'jerry@bettymills.com',
            kind: 'email',
            externalId: 'incident_1',
            title: 'SPS Commerce FTP connection failure',
            summary: 'The connection is failing and needs intervention.',
            body: 'FTP connection is failing and orders are blocked.',
            participants: ['support@bettymills.com'],
            occurredAt: '2026-03-15T18:50:00.000Z',
            syncedAt: '2026-03-15T19:00:00.000Z',
            priority: 'urgent',
            clientId: 'client_bm',
            projectId: 'project_platform',
            attention: {
              awarenessOnly: false,
              actionRequired: true,
              operationalRisk: true,
              reportWorthy: true,
              directness: 'shared',
              importanceReason: 'Operational risk to order flow',
              actionConfidence: 0.92,
              mappingConfidence: 0.89,
            },
            reviewState: null,
            linkedContactIds: [],
          },
          {
            provider: 'microsoft',
            accountId: 'acct_bm',
            accountLabel: 'jerry@bettymills.com',
            kind: 'email',
            externalId: 'digest_1',
            title: 'Tips for using your new inbox',
            summary:
              'A passive onboarding digest that should not appear as action work.',
            body: 'Here are a few suggestions to help you organize your inbox.',
            participants: ['notifications@example.com'],
            occurredAt: '2026-03-15T18:40:00.000Z',
            syncedAt: '2026-03-15T19:00:00.000Z',
            priority: 'high',
            clientId: null,
            projectId: null,
            attention: {
              awarenessOnly: false,
              actionRequired: false,
              operationalRisk: false,
              reportWorthy: false,
              directness: 'ambient',
              importanceReason: 'Passive product education',
              actionConfidence: 0.21,
              mappingConfidence: 0.12,
            },
            reviewState: null,
            linkedContactIds: [],
          },
        ],
        getCalendar: () => [],
        getWorkboard: () => [
          {
            key: 'stream_platform',
            client: {
              id: 'client_bm',
              name: 'Betty Mills',
              parentClientId: null,
              roles: ['COO'],
              status: 'active',
              notes: '',
              communicationPreferences: '',
              createdAt: '2026-03-15T18:00:00.000Z',
              updatedAt: '2026-03-15T18:00:00.000Z',
            },
            project: {
              id: 'project_platform',
              clientId: 'client_bm',
              name: 'Platform',
              status: 'active',
              priority: 'high',
              deadline: null,
              notes: '',
              tags: [],
              createdAt: '2026-03-15T18:00:00.000Z',
              updatedAt: '2026-03-15T18:00:00.000Z',
            },
            items: [],
            sourceRecords: [],
            recentActivity: [],
            repositories: [],
            linkedContacts: [],
            links: [],
            lastUpdatedAt: '2026-03-15T19:00:00.000Z',
            nextDueAt: null,
            blockerCount: 1,
            waitingCount: 0,
            openLoopCount: 1,
            needsReviewCount: 0,
            signals: ['SPS Commerce incident is still unresolved'],
          },
        ],
        getHistory: () => [],
        getHistoryWorkstreams: () => [],
        getReports: () => [],
        generateReport,
        getCorrections: () => [],
        getClients: () => [
          {
            id: 'client_bm',
            name: 'Betty Mills',
            parentClientId: null,
            roles: ['COO'],
            status: 'active',
            notes: '',
            communicationPreferences: '',
            createdAt: '2026-03-15T18:00:00.000Z',
            updatedAt: '2026-03-15T18:00:00.000Z',
          },
        ],
        getProjects: () => [
          {
            id: 'project_coo',
            clientId: 'client_bm',
            name: 'General / COO',
            status: 'active',
            priority: 'high',
            deadline: null,
            notes: '',
            tags: [],
            createdAt: '2026-03-15T18:00:00.000Z',
            updatedAt: '2026-03-15T18:00:00.000Z',
          },
          {
            id: 'project_platform',
            clientId: 'client_bm',
            name: 'Platform',
            status: 'active',
            priority: 'high',
            deadline: null,
            notes: '',
            tags: [],
            createdAt: '2026-03-15T18:00:00.000Z',
            updatedAt: '2026-03-15T18:00:00.000Z',
          },
        ],
        getRepositories: () => [],
        getContacts: () => ({
          contacts: [],
          identities: [],
          suggestions: [],
          accountHints: [],
          operatorProfile: {
            roleSummary: 'Operator',
            workHoursStart: 6,
            workHoursEnd: 22,
            reportingPreferences: 'Concise',
            escalationPreferences: 'Escalate risk',
            assistantStyle: 'Clear',
            updatedAt: '2026-03-15T18:00:00.000Z',
          },
        }),
        linkContact: vi.fn(),
        getOpenLoops: () => [],
        getAssistantQuestions: () => [],
        answerAssistantQuestion: vi.fn(),
        dismissAssistantQuestion: vi.fn(),
        getApprovalQueue: () => [],
        approveQueueItem: vi.fn(),
        rejectQueueItem: vi.fn(),
        editQueueItem: vi.fn(),
        getMemoryFacts: () => [],
        acceptMemoryFact: vi.fn(),
        rejectMemoryFact: vi.fn(),
        getReviewQueue: () => [],
        getImprovementTickets: () => [],
        approveImprovementTicket: vi.fn(),
        rejectImprovementTicket: vi.fn(),
        editImprovementTicket: vi.fn(),
        reviewAccept: vi.fn(),
        reviewReject: vi.fn(),
        getOperatorProfile: () => ({
          roleSummary: 'Operator',
          workHoursStart: 6,
          workHoursEnd: 22,
          reportingPreferences: 'Concise',
          escalationPreferences: 'Escalate risk',
          assistantStyle: 'Clear',
          updatedAt: '2026-03-15T18:00:00.000Z',
        }),
        updateOperatorProfile: vi.fn(),
        beginOAuth: () => 'https://example.com/oauth/start',
        handleOAuthCallback: vi.fn(async () => undefined),
        disconnect,
        getConnectionCatalog,
        updateConnectionSettings,
        syncProvider,
        createManualTask: vi.fn(),
        createManualNote: vi.fn(),
        upsertClient: vi.fn(),
        upsertProject: vi.fn(),
        upsertRepository,
        discoverRepositories,
        recordCorrection: vi.fn(),
      },
    });

    expect(started.ok).toBe(true);
    const baseUrl = getOperatorUiUrl();
    expect(baseUrl).toBeTruthy();

    const todayRes = await fetch(`${baseUrl}/api/today`, {
      headers: authorizedHeaders(),
    });
    const todayPayload: any = await todayRes.json();
    expect(todayPayload.ok).toBe(true);
    expect(todayPayload.today.waiting).toHaveLength(1);
    expect(todayPayload.today.waiting[0].surfacedReasonSummary).toBe(
      'Blocked and needs your attention',
    );

    const bootstrapRes = await fetch(`${baseUrl}/api/app/bootstrap`, {
      headers: authorizedHeaders(),
    });
    const bootstrapPayload: any = await bootstrapRes.json();
    expect(bootstrapPayload.ok).toBe(true);
    expect(bootstrapPayload.primaryCounts.inbox).toBe(1);

    const inboxRes = await fetch(`${baseUrl}/api/inbox`, {
      headers: authorizedHeaders(),
    });
    const inboxPayload: any = await inboxRes.json();
    expect(inboxPayload.ok).toBe(true);
    expect(inboxPayload.lanes.needsAction).toHaveLength(1);
    expect(inboxPayload.lanes.lowSignal).toHaveLength(1);
    expect(inboxPayload.lanes.lowSignal[0].title).toBe(
      'Tips for using your new inbox',
    );

    const workboardRes = await fetch(`${baseUrl}/api/workboard`, {
      headers: authorizedHeaders(),
    });
    const workboardPayload: any = await workboardRes.json();
    expect(workboardPayload.ok).toBe(true);
    expect(
      workboardPayload.sections.find(
        (section: any) => section.key === 'blocked',
      ).items[0].surfacedReasonSummary,
    ).toBe('1 blocker needs attention');
  });

  it('keeps Today focused by dropping automated platform email work from the main lane', async () => {
    const started = await startOperatorUi({
      getGroups: () => [],
      getMessages: () => [],
      getTasks: () => [],
      getTaskRuns: () => [],
      injectMessage,
      sendInput,
      sendOutbound,
      createTask,
      updateTask,
      pauseTask,
      resumeTask,
      cancelTask,
      personalOps: {
        listConnections: () => [],
        getToday: () => ({
          generatedAt: '2026-03-15T19:00:00.000Z',
          meetings: [],
          priorities: [
            {
              id: 'work_fb',
              title: 'Review Facebook rejected items',
              sourceKind: 'email',
              sourceProvider: 'microsoft',
              sourceRecordKey:
                'microsoft:acct_bm:email:missing_facebook_today_1',
              clientId: 'client_bm',
              projectId: 'project_coo',
              dueDate: null,
              priority: 'medium',
              status: 'open',
              confidence: 0.9,
              needsReview: false,
              linkedContactIds: [],
              openLoopState: 'action',
              notes: 'Automated Facebook alert',
              createdAt: '2026-03-15T18:31:00.000Z',
              updatedAt: '2026-03-15T18:31:00.000Z',
            },
            {
              id: 'work_manual',
              title: 'Call supplier about under-shipped PO',
              sourceKind: 'manual_task',
              sourceProvider: 'manual',
              sourceRecordKey: null,
              clientId: 'client_bm',
              projectId: 'project_coo',
              dueDate: null,
              priority: 'high',
              status: 'open',
              confidence: 1,
              needsReview: false,
              linkedContactIds: [],
              openLoopState: 'action',
              notes: 'Direct operational follow-up',
              createdAt: '2026-03-15T18:20:00.000Z',
              updatedAt: '2026-03-15T18:20:00.000Z',
            },
          ],
          overdue: [],
          followUps: [],
          blockers: [],
          awareness: [],
          inbox: [],
          openLoops: [],
          approvalQueue: [],
          workstreams: [],
          suggestedPlan: ['Call supplier about under-shipped PO'],
          draftStandup: '',
        }),
        getInbox: () => [],
        getCalendar: () => [],
        getWorkboard: () => [],
        getHistory: () => [],
        getHistoryWorkstreams: () => [],
        getReports: () => [],
        generateReport,
        getCorrections: () => [],
        getClients: () => [],
        getProjects: () => [],
        getRepositories: () => [],
        getContacts: () => ({
          contacts: [],
          identities: [],
          suggestions: [],
          accountHints: [],
          operatorProfile: {
            roleSummary: 'Operator',
            workHoursStart: 6,
            workHoursEnd: 22,
            reportingPreferences: 'Concise',
            escalationPreferences: 'Escalate risk',
            assistantStyle: 'Clear',
            updatedAt: '2026-03-15T19:00:00.000Z',
          },
        }),
        linkContact: vi.fn(),
        getOpenLoops: () => [],
        getAssistantQuestions: () => [],
        answerAssistantQuestion: vi.fn(),
        dismissAssistantQuestion: vi.fn(),
        getApprovalQueue: () => [],
        approveQueueItem: vi.fn(),
        rejectQueueItem: vi.fn(),
        editQueueItem: vi.fn(),
        getMemoryFacts: () => [],
        acceptMemoryFact: vi.fn(),
        rejectMemoryFact: vi.fn(),
        getReviewQueue: () => [],
        getImprovementTickets: () => [],
        approveImprovementTicket: vi.fn(),
        rejectImprovementTicket: vi.fn(),
        editImprovementTicket: vi.fn(),
        reviewAccept: vi.fn(),
        reviewReject: vi.fn(),
        getOperatorProfile: () => ({
          roleSummary: 'Operator',
          workHoursStart: 6,
          workHoursEnd: 22,
          reportingPreferences: 'Concise',
          escalationPreferences: 'Escalate risk',
          assistantStyle: 'Clear',
          updatedAt: '2026-03-15T19:00:00.000Z',
        }),
        updateOperatorProfile: vi.fn(),
        beginOAuth: () => 'https://example.com/oauth/start',
        handleOAuthCallback: vi.fn(async () => undefined),
        disconnect,
        getConnectionCatalog,
        updateConnectionSettings,
        syncProvider,
        createManualTask: vi.fn(),
        createManualNote: vi.fn(),
        upsertClient: vi.fn(),
        upsertProject: vi.fn(),
        upsertRepository,
        discoverRepositories,
        recordCorrection: vi.fn(),
      },
    });

    expect(started.ok).toBe(true);
    const baseUrl = getOperatorUiUrl();
    const todayRes = await fetch(`${baseUrl}/api/today`, {
      headers: authorizedHeaders(),
    });
    const todayPayload: any = await todayRes.json();
    expect(todayPayload.ok).toBe(true);
    expect(todayPayload.today.now.map((item: any) => item.title)).toContain(
      'Call supplier about under-shipped PO',
    );
    expect(todayPayload.today.now.map((item: any) => item.title)).not.toContain(
      'Review Facebook rejected items',
    );
  });

  it('rejects API calls without the operator session token', async () => {
    const started = await startOperatorUi({
      getGroups: () => [],
      getMessages: () => [],
      getTasks: () => [],
      getTaskRuns: () => [],
      injectMessage,
      sendInput,
      sendOutbound,
      createTask,
      updateTask,
      pauseTask,
      resumeTask,
      cancelTask,
    });

    expect(started.ok).toBe(true);
    const baseUrl = getOperatorUiUrl();
    expect(baseUrl).toBeTruthy();

    const res = await fetch(`${baseUrl}/api/app/bootstrap`);
    const payload: any = await res.json();
    expect(res.status).toBe(403);
    expect(payload.ok).toBe(false);
  });
});

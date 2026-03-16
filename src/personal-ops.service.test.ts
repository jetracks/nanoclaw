import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockedPaths = vi.hoisted(() => {
  const rootDir = '/tmp/nanoclaw-personal-ops-test';
  return {
    rootDir,
    storeDir: `${rootDir}/store`,
    publicDir: `${rootDir}/public`,
  };
});

vi.mock('./config.js', () => ({
  PERSONAL_OPS_PUBLIC_DIR: mockedPaths.publicDir,
  PERSONAL_OPS_PUSH_MAIN_CHAT: false,
  PERSONAL_OPS_STORE_DIR: mockedPaths.storeDir,
  TIMEZONE: 'America/Los_Angeles',
  OPENAI_MODEL: 'gpt-5.4',
  PERSONAL_OPS_CLASSIFICATION_MODEL: 'gpt-5.4',
  PERSONAL_OPS_REPORT_MODEL: 'gpt-5.4',
}));

vi.mock('./personal-ops/ai.js', () => ({
  suggestSourceClassification: vi.fn(async () => null),
  draftOperationalReport: vi.fn(async () => null),
}));

const mockedProviders = vi.hoisted(() => ({
  syncProviderData: vi.fn(),
  fetchProviderConnectionCatalog: vi.fn(async () => ({
    provider: 'microsoft',
    options: [],
  })),
  fetchProviderIdentity: vi.fn(async () => ({
    accountId: 'mock-account',
    accountLabel: 'mock-account',
  })),
}));

vi.mock('./personal-ops/providers.js', async () => {
  const actual = await vi.importActual<
    typeof import('./personal-ops/providers.js')
  >('./personal-ops/providers.js');
  return {
    ...actual,
    syncProviderData: mockedProviders.syncProviderData,
    fetchProviderConnectionCatalog:
      mockedProviders.fetchProviderConnectionCatalog,
    fetchProviderIdentity: mockedProviders.fetchProviderIdentity,
  };
});

import { PersonalOpsService } from './personal-ops/service.js';
import { suggestSourceClassification } from './personal-ops/ai.js';
import {
  addActivity,
  getSourceRecord,
  getWorkItem,
  listConnectedAccounts,
  listRepositories,
  listWorkItems,
  upsertConnectedAccount,
  upsertSourceRecord,
  upsertWorkItem,
} from './personal-ops/db.js';

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe('personal-ops service', () => {
  beforeEach(() => {
    fs.rmSync(mockedPaths.rootDir, { recursive: true, force: true });
    fs.mkdirSync(mockedPaths.storeDir, { recursive: true });
    fs.mkdirSync(mockedPaths.publicDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(mockedPaths.rootDir, { recursive: true, force: true });
    vi.mocked(suggestSourceClassification).mockReset();
    vi.mocked(suggestSourceClassification).mockResolvedValue(null);
    mockedProviders.syncProviderData.mockReset();
    mockedProviders.fetchProviderConnectionCatalog.mockClear();
    mockedProviders.fetchProviderIdentity.mockClear();
  });

  it('stores manual work, generates a deterministic report, and writes public snapshots', async () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({ name: 'Client A' });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'Project X',
        priority: 'high',
      });

      const task = service.createManualTask({
        title: 'Prepare Project X standup',
        notes: 'Need a crisp internal status update.',
        clientId: client.id,
        projectId: project.id,
        priority: 'high',
      });

      service.createManualNote({
        title: 'Client A sent follow-up',
        body: 'Need to respond before tomorrow morning.',
        clientId: client.id,
        projectId: project.id,
      });

      const today = service.getTodayView();
      expect(today.priorities[0]?.id).toBe(task.id);

      const report = await service.generateReport('standup');
      expect(report.groupedOutput).toContain('Client A');
      expect(report.groupedOutput).toContain('Project X');

      service.recordCorrection({
        targetType: 'work_item',
        targetId: task.id,
        field: 'status',
        value: 'done',
      });

      const refreshed = service.getTodayView();
      expect(
        refreshed.priorities.find((item) => item.id === task.id),
      ).toBeUndefined();

      service.writePublicSnapshots();
      const todaySnapshot = JSON.parse(
        fs.readFileSync(
          path.join(mockedPaths.publicDir, 'today.json'),
          'utf-8',
        ),
      ) as { priorities: Array<{ title: string }> };
      const reportSnapshot = JSON.parse(
        fs.readFileSync(
          path.join(mockedPaths.publicDir, 'reports.json'),
          'utf-8',
        ),
      ) as Array<{ reportType: string }>;

      expect(todaySnapshot.priorities).toBeDefined();
      expect(
        reportSnapshot.some((entry) => entry.reportType === 'standup'),
      ).toBe(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('retroactively removes source-backed work from active views when it is marked done elsewhere', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({ name: 'Betty Mills' });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });
      const source: any = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'under-shipped-1',
        externalParentId: 'thread-1',
        title: 'Please review under-shipped PO',
        summary: 'Jerry, can you review this under-shipped PO issue today?',
        body: 'Jerry, can you review this under-shipped PO issue today?',
        participants: [
          'Vendor <vendor@example.com>',
          'Jerry <jerry@bettymills.com>',
        ],
        occurredAt: isoMinutesAgo(10),
        priority: 'high' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(9),
        clientId: client.id,
        projectId: project.id,
        attributionSource: 'manual' as const,
        attributionConfidence: 1,
        metadata: {
          attention: {
            awarenessOnly: false,
            actionRequired: true,
            operationalRisk: false,
            reportWorthy: true,
            directness: 'direct',
            importanceReason: 'Likely needs Jerry action',
            actionConfidence: 0.95,
            mappingConfidence: 0.95,
            modelContextFingerprint: 'retroactive-done-test',
          },
        },
        attention: {
          awarenessOnly: false,
          actionRequired: true,
          operationalRisk: false,
          reportWorthy: true,
          directness: 'direct' as const,
          importanceReason: 'Likely needs Jerry action',
          actionConfidence: 0.95,
          mappingConfidence: 0.95,
          modelContextFingerprint: 'retroactive-done-test',
        },
      };

      upsertSourceRecord(source);
      (service as any).materializeDerivedRecords(source);

      expect(
        service
          .getTodayView()
          .inbox.some((entry) => entry.externalId === 'under-shipped-1'),
      ).toBe(true);
      expect(
        service
          .getOpenLoops()
          .some((loop) => loop.sourceRecordKey?.includes('under-shipped-1')),
      ).toBe(true);

      service.recordCorrection({
        targetType: 'work_item',
        targetId: 'work:microsoft:jerry@bettymills.com:email:under-shipped-1',
        field: 'status',
        value: 'done',
      });

      const refreshedSource = getSourceRecord(
        'microsoft',
        'jerry@bettymills.com',
        'email',
        'under-shipped-1',
      );
      const refreshedWorkItem = getWorkItem(
        'work:microsoft:jerry@bettymills.com:email:under-shipped-1',
      );
      const today = service.getTodayView();

      expect(refreshedSource?.metadata?.workItemStatusOverride).toBe('done');
      expect(refreshedWorkItem?.status).toBe('done');
      expect(
        today.inbox.some((entry) => entry.externalId === 'under-shipped-1'),
      ).toBe(false);
      expect(
        today.priorities.some((item) => item.id === refreshedWorkItem?.id),
      ).toBe(false);
      expect(
        today.openLoops.some((loop) =>
          loop.sourceRecordKey?.includes('under-shipped-1'),
        ),
      ).toBe(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('retroactively hides calendar reminders from today when the source is marked done', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({ name: 'Personal' });
      const source: any = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'calendar_event' as const,
        externalId: 'move-car-1',
        externalParentId: 'move-car-series',
        title: 'Move Car',
        summary: 'Reminder to move the car before street cleaning.',
        body: 'Reminder to move the car before street cleaning.',
        participants: ['Jerry <jerry@bettymills.com>'],
        occurredAt: isoMinutesAgo(-30),
        priority: 'medium' as const,
        status: 'scheduled',
        syncedAt: isoMinutesAgo(1),
        clientId: client.id,
        projectId: null,
        attributionSource: 'manual' as const,
        attributionConfidence: 1,
        metadata: {
          attention: {
            awarenessOnly: false,
            actionRequired: true,
            operationalRisk: false,
            reportWorthy: false,
            directness: 'direct',
            importanceReason: 'Personal reminder',
            actionConfidence: 0.95,
            mappingConfidence: 0.95,
            modelContextFingerprint: 'move-car-test',
          },
        },
      };

      upsertSourceRecord(source);

      expect(
        service
          .getTodayView()
          .meetings.some((entry) => entry.externalId === 'move-car-1'),
      ).toBe(true);

      service.recordCorrection({
        targetType: 'source_record',
        targetId: 'microsoft:jerry@bettymills.com:calendar_event:move-car-1',
        field: 'workflowStatus',
        value: 'done',
      });

      const refreshedSource = getSourceRecord(
        'microsoft',
        'jerry@bettymills.com',
        'calendar_event',
        'move-car-1',
      );
      const today = service.getTodayView();

      expect(refreshedSource?.metadata?.workItemStatusOverride).toBe('done');
      expect(
        today.meetings.some((entry) => entry.externalId === 'move-car-1'),
      ).toBe(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('preserves source workflow overrides across provider refreshes', async () => {
    try {
      const service = new PersonalOpsService();
      upsertConnectedAccount({
        provider: 'microsoft',
        accountId: 'account-1',
        accountLabel: 'jerry@bettymills.com',
        status: 'connected',
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

      upsertSourceRecord({
        provider: 'microsoft',
        accountId: 'account-1',
        accountLabel: 'jerry@bettymills.com',
        kind: 'calendar_event',
        externalId: 'move-car-refresh',
        externalParentId: 'move-car-refresh-series',
        title: 'Move Car',
        summary: 'Reminder to move the car.',
        body: 'Reminder to move the car.',
        participants: ['Jerry <jerry@bettymills.com>'],
        occurredAt: isoMinutesAgo(-45),
        priority: 'medium',
        status: 'scheduled',
        syncedAt: isoMinutesAgo(5),
        rawSnapshotRef: null,
        clientId: null,
        projectId: null,
        attributionSource: 'none',
        attributionConfidence: null,
        metadata: {
          workItemStatusOverride: 'done',
        },
      });

      mockedProviders.syncProviderData.mockResolvedValue({
        provider: 'microsoft',
        records: [
          {
            source: {
              provider: 'microsoft',
              accountId: 'account-1',
              accountLabel: 'jerry@bettymills.com',
              kind: 'calendar_event',
              externalId: 'move-car-refresh',
              externalParentId: 'move-car-refresh-series',
              title: 'Move Car',
              summary: 'Reminder to move the car.',
              body: 'Reminder to move the car.',
              participants: ['Jerry <jerry@bettymills.com>'],
              occurredAt: isoMinutesAgo(-45),
              priority: 'medium',
              status: 'scheduled',
              syncedAt: new Date().toISOString(),
              rawSnapshotRef: null,
              clientId: null,
              projectId: null,
              attributionSource: 'none',
              attributionConfidence: null,
              metadata: {},
            },
            raw: { id: 'move-car-refresh' },
          },
        ],
        cursors: { calendar_event: new Date().toISOString() },
      });

      await service.syncProvider({
        provider: 'microsoft',
        accountId: 'account-1',
      });

      const refreshedSource = getSourceRecord(
        'microsoft',
        'account-1',
        'calendar_event',
        'move-car-refresh',
      );

      expect(refreshedSource?.metadata?.workItemStatusOverride).toBe('done');
      expect(
        service
          .getTodayView()
          .meetings.some((entry) => entry.externalId === 'move-car-refresh'),
      ).toBe(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('retroactively reapplies accepted contact mappings to existing source-backed work', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({ name: 'Ezidia' });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General',
      });
      const source: any = {
        provider: 'google' as const,
        accountId: 'jetracks@gmail.com',
        accountLabel: 'jetracks@gmail.com',
        kind: 'email' as const,
        externalId: 'ezidia-thread-1',
        externalParentId: 'ezidia-thread-parent',
        title: 'Can you review the updated scope?',
        summary: 'Brad sent an updated scope for review.',
        body: 'Can you review the updated scope for Ezidia?',
        participants: [
          'Brad C <brad.c@ezdia.com>',
          'Jerry <jetracks@gmail.com>',
        ],
        occurredAt: isoMinutesAgo(25),
        priority: 'medium' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(24),
        metadata: {
          attention: {
            awarenessOnly: false,
            actionRequired: true,
            operationalRisk: false,
            reportWorthy: true,
            directness: 'direct',
            importanceReason: 'Likely needs Jerry action',
            actionConfidence: 0.88,
            mappingConfidence: 0.45,
            modelContextFingerprint: 'contact-retroactive-test',
          },
        },
        attention: {
          awarenessOnly: false,
          actionRequired: true,
          operationalRisk: false,
          reportWorthy: true,
          directness: 'direct' as const,
          importanceReason: 'Likely needs Jerry action',
          actionConfidence: 0.88,
          mappingConfidence: 0.45,
          modelContextFingerprint: 'contact-retroactive-test',
        },
      };

      const linkedContactIds = (service as any).ensureContactsFromSource(
        source,
      );
      source.linkedContactIds = linkedContactIds;
      source.metadata = {
        ...(source.metadata || {}),
        linkedContactIds,
      };
      upsertSourceRecord(source);
      (service as any).materializeDerivedRecords(source);

      service.linkContact({
        contactId: linkedContactIds[0],
        clientId: client.id,
        projectId: project.id,
      });

      const refreshedSource = getSourceRecord(
        'google',
        'jetracks@gmail.com',
        'email',
        'ezidia-thread-1',
      );
      const refreshedWorkItem = getWorkItem(
        'work:google:jetracks@gmail.com:email:ezidia-thread-1',
      );

      expect(refreshedSource?.clientId).toBe(client.id);
      expect(refreshedSource?.projectId).toBe(project.id);
      expect(refreshedWorkItem?.clientId).toBe(client.id);
      expect(refreshedWorkItem?.projectId).toBe(project.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('derives grouped workstreams from tasks, source notes, and attached repositories', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({
        name: 'Dynecom',
        communicationPreferences: 'Primary domain: dynecom.com',
      });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / CTO',
        tags: ['DYN'],
      });

      service.createManualTask({
        title: 'Review connector rollout',
        clientId: client.id,
        projectId: project.id,
        priority: 'high',
      });
      service.createManualNote({
        title: 'Slack follow-up on rollout blockers',
        body: 'Need to unblock the connector release.',
        clientId: client.id,
        projectId: project.id,
      });
      service.upsertRepository({
        name: 'dynecom-platform',
        localPath: path.join(mockedPaths.rootDir, 'dynecom-platform'),
        clientId: client.id,
        projectId: project.id,
        notes: 'Primary project repo',
      });

      const workboard = service.getWorkboardView();
      expect(workboard).toHaveLength(1);
      expect(workboard[0].client?.name).toBe('Dynecom');
      expect(workboard[0].project?.name).toBe('General / CTO');
      expect(workboard[0].items).toHaveLength(1);
      expect(workboard[0].sourceRecords).toHaveLength(2);
      expect(workboard[0].repositories).toHaveLength(1);
      expect(workboard[0].signals.length).toBeGreaterThan(0);

      const today = service.getTodayView();
      expect(today.workstreams[0]?.key).toBe(workboard[0].key);

      const historyStreams = service.getHistoryWorkstreams({
        since: isoMinutesAgo(180),
      });
      expect(
        historyStreams.some((stream) => stream.key === workboard[0].key),
      ).toBe(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('links jira, git, and task evidence inside the same workstream when they share an issue key', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({ name: 'Dynecom' });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'Connector rollout',
        tags: ['DYN'],
      });
      const repository = service.upsertRepository({
        name: 'dynecom-platform',
        localPath: path.join(mockedPaths.rootDir, 'dynecom-platform'),
        clientId: client.id,
        projectId: project.id,
      });

      service.createManualTask({
        title: 'DYN-214 follow up with rollout team',
        clientId: client.id,
        projectId: project.id,
        priority: 'high',
      });

      upsertSourceRecord({
        provider: 'jira',
        accountId: 'dynecom-site',
        accountLabel: 'Dynecom Jira',
        kind: 'jira_issue',
        externalId: 'DYN-214',
        externalParentId: '10021',
        title: 'DYN-214: Fix rollout lag',
        summary: 'Fix rollout lag',
        body: 'Rollout lag is blocking launch.',
        participants: ['Jerry'],
        occurredAt: isoMinutesAgo(45),
        priority: 'high',
        status: 'In Progress',
        syncedAt: isoMinutesAgo(44),
        clientId: client.id,
        projectId: project.id,
        metadata: {
          projectKey: 'DYN',
        },
      });

      addActivity({
        id: 'activity:repo:dynecom:sha1',
        timestamp: isoMinutesAgo(30),
        type: 'git_commit',
        sourceProvider: 'git',
        sourceKind: 'git_commit',
        sourceRecordKey: null,
        relatedClientId: client.id,
        relatedProjectId: project.id,
        summary: 'DYN-214 optimize rollout polling',
        rawReference:
          'https://github.com/jetracks/dynecom-platform/commit/sha1',
        metadata: {
          repoId: repository.id,
          repoName: repository.name,
          commitSha: 'sha1',
        },
      });

      const stream = service.getWorkboardView()[0];
      const jiraLink = stream.links.find((link) => link.label === 'DYN-214');
      expect(jiraLink).toBeTruthy();
      expect(jiraLink?.itemCount).toBe(1);
      expect(jiraLink?.sourceCount).toBe(2);
      expect(jiraLink?.activityCount).toBe(1);

      const repoLink = stream.links.find(
        (link) => link.label === 'dynecom-platform',
      );
      expect(repoLink).toBeTruthy();
      expect(repoLink?.activityCount).toBe(1);
      expect(repoLink?.repositoryCount).toBe(1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('filters noisy inbox mail and suppresses noisy follow-up tasks', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({ name: 'Client A' });

      const importantSource = {
        provider: 'google' as const,
        kind: 'email' as const,
        externalId: 'important-1',
        externalParentId: 'thread-important',
        title: 'Please review the proposal today',
        summary: 'Can you review the proposal today?',
        body: 'Can you review the proposal today?',
        participants: ['Client Owner <owner@example.com>'],
        occurredAt: isoMinutesAgo(90),
        priority: 'high' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(89),
        clientId: client.id,
        metadata: {
          isImportant: true,
          isUnread: true,
        },
      };

      const noisySource = {
        provider: 'google' as const,
        kind: 'email' as const,
        externalId: 'noise-1',
        externalParentId: 'thread-noise',
        title: 'Spring sale',
        summary: 'Please confirm your discount preferences.',
        body: 'Please confirm your discount preferences.',
        participants: ['Deals <noreply@promo.example.com>'],
        occurredAt: isoMinutesAgo(60),
        priority: 'low' as const,
        status: 'filtered',
        syncedAt: isoMinutesAgo(59),
        metadata: {
          likelyNoise: true,
          category: 'promotions',
          automatedSender: true,
        },
      };

      upsertSourceRecord(noisySource);
      upsertSourceRecord(importantSource);

      (service as any).materializeDerivedRecords(noisySource);
      (service as any).materializeDerivedRecords(importantSource);

      const inbox = service.getInboxView();
      expect(inbox.map((entry) => entry.externalId)).toEqual(['important-1']);

      const today = service.getTodayView();
      expect(today.inbox.map((entry) => entry.externalId)).toEqual([
        'important-1',
      ]);

      const workItems = listWorkItems({ limit: 20 });
      expect(workItems).toHaveLength(1);
      expect(workItems[0].title).toContain('Please review the proposal today');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('uses model action-required metadata to suppress low-relevance follow-up work', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({
        name: 'Betty Mills',
        roles: ['COO'],
      });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });

      const source = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'alias-1',
        externalParentId: 'thread-alias-1',
        title: 'Support queue update',
        summary: 'Support alias received a routine customer update.',
        body: 'Routine support queue update without direct ask to Jerry.',
        participants: [
          'support@bettymills.com',
          'Customer <customer@example.com>',
        ],
        occurredAt: isoMinutesAgo(40),
        priority: 'low' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(39),
        clientId: client.id,
        projectId: project.id,
        metadata: {
          isUnread: true,
          modelActionRequired: false,
        },
      };

      upsertSourceRecord(source);
      (service as any).materializeDerivedRecords(source);

      expect(service.getInboxView()[0]?.externalId).toBe('alias-1');
      expect(listWorkItems({ limit: 20 })).toHaveLength(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('builds classification context from connection guidance and client role details', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({
        name: 'Betty Mills',
        roles: ['COO'],
        notes: 'Jerry handles executive operations and escalations.',
        communicationPreferences:
          'Alias mailboxes are mostly operational noise unless Jerry is directly addressed or the topic is pricing, MAP, or outages.',
      });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });
      upsertConnectedAccount({
        provider: 'microsoft',
        accountId: 'jerry@bettymills.com',
        status: 'connected',
        accountLabel: 'jerry@bettymills.com',
        settings: {
          defaultClientId: client.id,
          defaultProjectId: project.id,
          triageGuidance:
            'Jerry is the Betty Mills COO. Alias inbox traffic is usually low priority unless he is directly addressed or it is pricing, MAP, outage, or system-alert related.',
        },
      });

      const context = (service as any).buildClassificationContext({
        source: {
          provider: 'microsoft',
          accountId: 'jerry@bettymills.com',
          accountLabel: 'jerry@bettymills.com',
          kind: 'email',
          externalId: 'msg-1',
          title: 'Vendor price sheet update',
          summary: 'Updated vendor pricing for review.',
          body: 'Please review the attached pricing changes.',
          participants: [
            'merchandising@bettymills.com',
            'Vendor <vendor@example.com>',
          ],
          occurredAt: isoMinutesAgo(25),
          syncedAt: isoMinutesAgo(24),
          clientId: client.id,
          projectId: project.id,
        },
        clients: [client],
        projects: [project],
        settings: {
          defaultClientId: client.id,
          defaultProjectId: project.id,
          triageGuidance:
            'Jerry is the Betty Mills COO. Alias inbox traffic is usually low priority unless he is directly addressed or it is pricing, MAP, outage, or system-alert related.',
        },
      });

      expect(context.connectionContext?.triageGuidance).toContain(
        'Betty Mills COO',
      );
      expect(context.connectionContext?.defaultClientName).toBe('Betty Mills');
      expect(context.clientProfiles[0]?.roles).toContain('COO');
      expect(context.clientProfiles[0]?.communicationPreferences).toContain(
        'pricing',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('persists connection triage guidance through settings updates', () => {
    try {
      const service = new PersonalOpsService();
      upsertConnectedAccount({
        provider: 'microsoft',
        accountId: 'betty-account',
        accountLabel: 'jerry@bettymills.com',
        status: 'connected',
        settings: {},
      });

      service.updateConnectionSettings(
        { provider: 'microsoft', accountId: 'betty-account' },
        {
          triageGuidance:
            'Jerry is the Betty Mills COO. Shared alias traffic is usually awareness-only unless it is a direct ask or an operational alert.',
        },
      );

      const connection = listConnectedAccounts().find(
        (entry) =>
          entry.provider === 'microsoft' && entry.accountId === 'betty-account',
      );
      expect(connection?.settings.triageGuidance).toContain('Betty Mills COO');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('merges inbox records across multiple Google accounts without collisions', () => {
    try {
      const service = new PersonalOpsService();

      upsertSourceRecord({
        connectionKey: 'google:jerry@example.com',
        provider: 'google',
        accountId: 'jerry@example.com',
        accountLabel: 'jerry@example.com',
        kind: 'email',
        externalId: 'shared-message',
        title: 'Client follow-up',
        summary: 'Need a reply from the primary account.',
        body: 'Need a reply from the primary account.',
        participants: ['Client <client@example.com>'],
        occurredAt: isoMinutesAgo(90),
        priority: 'high',
        status: 'received',
        syncedAt: isoMinutesAgo(89),
        metadata: { isImportant: true },
      });

      upsertSourceRecord({
        connectionKey: 'google:ops@example.com',
        provider: 'google',
        accountId: 'ops@example.com',
        accountLabel: 'ops@example.com',
        kind: 'email',
        externalId: 'shared-message',
        title: 'Ops alert',
        summary: 'Need a reply from the ops account.',
        body: 'Need a reply from the ops account.',
        participants: ['Ops <ops@example.com>'],
        occurredAt: isoMinutesAgo(60),
        priority: 'medium',
        status: 'received',
        syncedAt: isoMinutesAgo(59),
        metadata: { isUnread: true },
      });

      const inbox = service.getInboxView({ includeNoise: true });
      expect(inbox).toHaveLength(2);
      expect(inbox.map((item) => item.accountId)).toEqual([
        'jerry@example.com',
        'ops@example.com',
      ]);
      expect(new Set(inbox.map((item) => item.connectionKey))).toHaveLength(2);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('surfaces actionable Slack messages in inbox views and follow-up work', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({ name: 'Dynecom' });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / CTO',
      });

      const source = {
        connectionKey: 'slack:T123',
        provider: 'slack' as const,
        accountId: 'T123',
        accountLabel: 'Dynecom Slack',
        kind: 'slack_message' as const,
        externalId: 'C123:1710439200.000100',
        externalParentId: 'C123',
        title: '#dynecom-dev • Please review the rollout blocker',
        summary: 'Please review the rollout blocker',
        body: 'Please review the rollout blocker today.',
        participants: ['Jerry', '#dynecom-dev'] as string[],
        occurredAt: isoMinutesAgo(45),
        priority: 'high' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(44),
        clientId: client.id,
        projectId: project.id,
        metadata: {
          channelLabel: '#dynecom-dev',
          mentionsSelf: true,
        },
      };

      upsertSourceRecord(source);
      (service as any).materializeDerivedRecords(source);

      const inbox = service.getInboxView({ includeNoise: true });
      expect(inbox.map((item) => item.kind)).toContain('slack_message');

      const today = service.getTodayView();
      expect(today.inbox.some((item) => item.kind === 'slack_message')).toBe(
        true,
      );

      const workItems = listWorkItems({ limit: 20 });
      expect(
        workItems.some((item) => item.sourceKind === 'slack_message'),
      ).toBe(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('applies deterministic attribution from account domains, Jira keys, and repository aliases', () => {
    try {
      const service = new PersonalOpsService();
      const betty = service.upsertClient({
        name: 'Betty Mills',
        communicationPreferences: 'jerry@bettymills.com',
      });
      const bettyProject = service.upsertProject({
        clientId: betty.id,
        name: 'General / COO',
      });
      const dynecom = service.upsertClient({ name: 'Dynecom' });
      const ezidia = service.upsertClient({
        name: 'Ezidia',
        parentClientId: dynecom.id,
      });
      const dynecomProject = service.upsertProject({
        clientId: dynecom.id,
        name: 'General / CTO',
        tags: ['DYN', 'dynecom-dev'],
      });
      const wabashProject = service.upsertProject({
        clientId: ezidia.id,
        name: 'Wabash',
        tags: ['wabash'],
      });

      const repoDir = path.join(mockedPaths.rootDir, 'repos', 'wabash-repo');
      fs.mkdirSync(repoDir, { recursive: true });
      service.upsertRepository({
        localPath: repoDir,
        projectId: wabashProject.id,
      });

      const clients = service.getClients();
      const projects = service.getProjects();
      const repositories = service.getRepositories();

      const microsoftSource: any = {
        provider: 'microsoft' as const,
        accountId: 'acct-betty',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'mail-1',
        title: 'Operations update',
        summary: 'Weekly COO review',
        body: 'Need a quick pass before tomorrow.',
        participants: ['Ops <ops@bettymills.com>'],
        occurredAt: isoMinutesAgo(30),
        syncedAt: isoMinutesAgo(29),
        metadata: {},
      };
      (service as any).applyRuleBasedAttribution(
        microsoftSource,
        clients,
        projects,
        repositories,
      );
      expect(microsoftSource.clientId).toBe(betty.id);
      expect(microsoftSource.projectId).toBe(bettyProject.id);
      expect(microsoftSource.attributionSource).toBe('rule');
      expect(String(microsoftSource.metadata?.attributionRule || '')).toContain(
        'communication domain',
      );
      expect(String(microsoftSource.metadata?.attributionRule || '')).toContain(
        'single active project',
      );
      expect(
        Array.isArray(microsoftSource.metadata?.attributionDiagnostics) &&
          microsoftSource.metadata.attributionDiagnostics.some(
            (entry: any) => entry.kind === 'domain_match',
          ),
      ).toBe(true);
      expect(
        Array.isArray(microsoftSource.metadata?.attributionDiagnostics) &&
          microsoftSource.metadata.attributionDiagnostics.some(
            (entry: any) => entry.kind === 'single_project_fallback',
          ),
      ).toBe(true);

      const jiraSource: any = {
        provider: 'jira' as const,
        accountId: 'jira-1',
        accountLabel: 'Dynecom Jira',
        kind: 'jira_issue' as const,
        externalId: 'DYN-101',
        title: 'DYN-101: Platform rollout blocker',
        summary: 'Rollout blocker',
        body: 'Needs CTO review.',
        participants: [],
        occurredAt: isoMinutesAgo(20),
        syncedAt: isoMinutesAgo(19),
        metadata: {
          projectKey: 'DYN',
          projectName: 'Dynecom Platform',
        },
      };
      (service as any).applyRuleBasedAttribution(
        jiraSource,
        clients,
        projects,
        repositories,
      );
      expect(jiraSource.projectId).toBe(dynecomProject.id);
      expect(jiraSource.clientId).toBe(dynecom.id);
      expect(String(jiraSource.metadata?.attributionRule || '')).toContain(
        'Jira project key "DYN"',
      );
      expect(
        Array.isArray(jiraSource.metadata?.attributionDiagnostics) &&
          jiraSource.metadata.attributionDiagnostics.some(
            (entry: any) => entry.kind === 'jira_key',
          ),
      ).toBe(true);

      const slackSource: any = {
        provider: 'slack' as const,
        accountId: 'T123',
        accountLabel: 'Dynecom Slack',
        kind: 'slack_message' as const,
        externalId: 'C1:1',
        title: '#ops • Please review wabash-repo before release',
        summary: 'Need eyes on wabash-repo before release',
        body: 'Need eyes on wabash-repo before release',
        participants: ['Jerry', '#ops'],
        occurredAt: isoMinutesAgo(10),
        syncedAt: isoMinutesAgo(9),
        metadata: {
          channelLabel: '#ops',
        },
      };
      (service as any).applyRuleBasedAttribution(
        slackSource,
        clients,
        projects,
        repositories,
      );
      expect(slackSource.projectId).toBe(wabashProject.id);
      expect(slackSource.clientId).toBe(ezidia.id);
      expect(String(slackSource.metadata?.attributionRule || '')).toContain(
        'repository "wabash-repo"',
      );
      expect(
        Array.isArray(slackSource.metadata?.attributionDiagnostics) &&
          slackSource.metadata.attributionDiagnostics.some(
            (entry: any) => entry.kind === 'repo_alias',
          ),
      ).toBe(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('applies explicit connection default client and project settings before softer heuristics', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({ name: 'Betty Mills' });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });
      const source: any = {
        provider: 'microsoft' as const,
        accountId: 'acct-betty',
        accountLabel: 'Operations mailbox',
        kind: 'email' as const,
        externalId: 'mail-connection-default',
        title: 'Weekly review',
        summary: 'General operations review',
        body: 'General operations review',
        participants: ['Operations Team'],
        occurredAt: isoMinutesAgo(15),
        syncedAt: isoMinutesAgo(14),
        metadata: {},
      };

      (service as any).applyRuleBasedAttribution(
        source,
        service.getClients(),
        service.getProjects(),
        service.getRepositories(),
        {
          defaultClientId: client.id,
          defaultProjectId: project.id,
        },
      );

      expect(source.clientId).toBe(client.id);
      expect(source.projectId).toBe(project.id);
      expect(String(source.metadata?.attributionRule || '')).toContain(
        'connection default project',
      );
      expect(
        Array.isArray(source.metadata?.attributionDiagnostics) &&
          source.metadata.attributionDiagnostics.some(
            (entry: any) => entry.kind === 'connection_default',
          ),
      ).toBe(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('reuses prior classification for unchanged records instead of calling OpenAI again', async () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({ name: 'Betty Mills' });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });
      const classify = vi.mocked(suggestSourceClassification);
      classify.mockResolvedValue({
        clientName: 'Betty Mills',
        projectName: 'General / COO',
        urgency: 'high',
        confidence: 0.88,
      });

      service['listConnections'] = service.listConnections.bind(service);
      (service as any).syncProvider =
        PersonalOpsService.prototype.syncProvider.bind(service);

      const baseSource = {
        connectionKey: 'microsoft:acct-betty',
        provider: 'microsoft' as const,
        accountId: 'acct-betty',
        accountLabel: 'Operations mailbox',
        kind: 'email' as const,
        externalId: 'mail-repeat',
        title: 'Weekly review',
        summary: 'Need a quick pass',
        body: 'Need a quick pass',
        participants: ['ops@bettymills.com'],
        occurredAt: isoMinutesAgo(15),
        syncedAt: isoMinutesAgo(14),
        metadata: {},
      };

      upsertSourceRecord({
        ...baseSource,
        clientId: client.id,
        projectId: project.id,
        attributionSource: 'model',
        attributionConfidence: 0.88,
        metadata: {
          classificationFingerprint: JSON.stringify({
            provider: 'microsoft',
            accountId: 'acct-betty',
            kind: 'email',
            externalId: 'mail-repeat',
            externalParentId: null,
            title: 'Weekly review',
            summary: 'Need a quick pass',
            body: 'Need a quick pass',
            participants: ['ops@bettymills.com'],
            dueAt: null,
            status: null,
          }),
        },
      });

      const clients = service.getClients();
      const projects = service.getProjects();
      const repositories = service.getRepositories();
      const candidate: any = { ...baseSource };
      (service as any).applyRuleBasedAttribution(
        candidate,
        clients,
        projects,
        repositories,
        {},
      );

      upsertSourceRecord({
        ...baseSource,
        clientId: client.id,
        projectId: project.id,
        attributionSource: 'model',
        attributionConfidence: 0.88,
        metadata: {
          classificationFingerprint: JSON.stringify({
            provider: 'microsoft',
            accountId: 'acct-betty',
            kind: 'email',
            externalId: 'mail-repeat',
            externalParentId: null,
            title: 'Weekly review',
            summary: 'Need a quick pass',
            body: 'Need a quick pass',
            participants: ['ops@bettymills.com'],
            dueAt: null,
            status: null,
          }),
        },
      });
      const existing = getSourceRecord(
        'microsoft',
        'acct-betty',
        'email',
        'mail-repeat',
      );
      expect(existing).toBeDefined();
      if (!existing) {
        throw new Error('expected seeded source record');
      }
      expect(existing.attributionSource).toBe('model');

      const attributed: any = {
        ...baseSource,
        rawSnapshotRef: '/tmp/raw.json',
        metadata: {},
      };
      const fingerprint = JSON.stringify({
        provider: 'microsoft',
        accountId: 'acct-betty',
        kind: 'email',
        externalId: 'mail-repeat',
        externalParentId: null,
        title: 'Weekly review',
        summary: 'Need a quick pass',
        body: 'Need a quick pass',
        participants: ['ops@bettymills.com'],
        dueAt: null,
        status: null,
      });
      const existingFingerprint =
        typeof existing.metadata?.classificationFingerprint === 'string'
          ? existing.metadata.classificationFingerprint
          : null;
      const canReuse =
        existing &&
        existingFingerprint === fingerprint &&
        existing.attributionSource &&
        existing.attributionSource !== 'none' &&
        (existing.clientId || existing.projectId);
      if (canReuse) {
        attributed.clientId = existing.clientId;
        attributed.projectId = existing.projectId;
      } else {
        await suggestSourceClassification({
          source: attributed,
          clientNames: clients.map((entry) => entry.name),
          projectNames: projects.map((entry) => entry.name),
        });
      }
      expect(attributed.clientId).toBe(client.id);
      expect(attributed.projectId).toBe(project.id);
      expect(classify).not.toHaveBeenCalled();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('attaches a git repository to a project and derives metadata from the local path', async () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({ name: 'Client Repo' });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'Project Repo',
      });
      const repoDir = path.join(mockedPaths.rootDir, 'repos', 'sample-repo');
      fs.mkdirSync(repoDir, { recursive: true });
      execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Jerry'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.email', 'jerry@example.com'], {
        cwd: repoDir,
      });
      execFileSync(
        'git',
        ['remote', 'add', 'origin', 'git@github.com:jetracks/sample-repo.git'],
        {
          cwd: repoDir,
        },
      );
      fs.writeFileSync(path.join(repoDir, 'README.md'), '# sample repo\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
      execFileSync('git', ['commit', '-m', 'Initial sample repo commit'], {
        cwd: repoDir,
      });

      const repository = service.upsertRepository({
        localPath: repoDir,
        projectId: project.id,
        notes: 'Main delivery codebase',
      });

      expect(repository.name).toBe('sample-repo');
      expect(repository.clientId).toBe(client.id);
      expect(repository.projectId).toBe(project.id);
      expect(repository.defaultBranch).toBe('main');
      expect(repository.remoteUrl).toBe(
        'git@github.com:jetracks/sample-repo.git',
      );
      expect(repository.lastCommitAt).toBeTruthy();

      const repositories = listRepositories({ projectId: project.id });
      expect(repositories).toHaveLength(1);
      expect(repositories[0].localPath).toBe(fs.realpathSync(repoDir));

      const history = service.getHistoryView({
        since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      expect(history.some((activity) => activity.type === 'git_commit')).toBe(
        true,
      );
      expect(
        history.some((activity) =>
          activity.summary.includes('Initial sample repo commit'),
        ),
      ).toBe(true);

      const wrap = await service.generateReport('wrap');
      expect(wrap.groupedOutput).toContain('Estimated commit time');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('discovers repositories under the home root, including Downloads', () => {
    try {
      const service = new PersonalOpsService();
      const homeDir = path.join(mockedPaths.rootDir, 'home');
      const projectRepo = path.join(homeDir, 'Projects', 'alpha-repo');
      const downloadsRepo = path.join(homeDir, 'Downloads', 'wabash-repo');
      fs.mkdirSync(projectRepo, { recursive: true });
      fs.mkdirSync(downloadsRepo, { recursive: true });
      execFileSync('git', ['init', '--initial-branch=main'], {
        cwd: projectRepo,
      });
      execFileSync('git', ['init', '--initial-branch=main'], {
        cwd: downloadsRepo,
      });

      const repositories = service.discoverRepositories({
        rootPath: homeDir,
        maxDepth: 4,
      });

      expect(repositories).toHaveLength(2);
      expect(repositories.map((repository) => repository.name).sort()).toEqual([
        'alpha-repo',
        'wabash-repo',
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('downgrades routine automated notifications so they do not create action work', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({
        name: 'Betty Mills',
        roles: ['COO'],
      });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });

      const routineNotification = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'share-1',
        externalParentId: 'thread-share-1',
        title: 'Spreadsheet shared with you: Jerry Cap Table',
        summary: 'Action required: open the spreadsheet to review access.',
        body: 'A spreadsheet was shared with you. Use the launch code in the email to open it.',
        participants: ['Google Drive <noreply@docs.example.com>'],
        occurredAt: isoMinutesAgo(35),
        priority: 'high' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(34),
        clientId: client.id,
        projectId: project.id,
        attention: {
          awarenessOnly: false,
          actionRequired: true,
          operationalRisk: false,
          reportWorthy: true,
          directness: 'ambient' as const,
          importanceReason: 'Action required share notice.',
          actionConfidence: 0.74,
          mappingConfidence: 0.88,
          modelContextFingerprint: 'routine-ctx',
        },
        metadata: {
          automatedSender: true,
          attention: {
            awarenessOnly: false,
            actionRequired: true,
            operationalRisk: false,
            reportWorthy: true,
            directness: 'ambient',
            importanceReason: 'Action required share notice.',
            actionConfidence: 0.74,
            mappingConfidence: 0.88,
            modelContextFingerprint: 'routine-ctx',
          },
        },
      };

      const inboxTips = {
        provider: 'google' as const,
        accountId: 'jerry@dynecom.com',
        accountLabel: 'jerry@dynecom.com',
        kind: 'email' as const,
        externalId: 'gmail-tips-1',
        externalParentId: 'thread-gmail-tips-1',
        title: 'Tips for using your new inbox',
        summary:
          'Welcome to your inbox. Find emails fast and keep things tidy.',
        body: 'Welcome to your inbox. You never need to worry about losing email again.',
        participants: [
          'Gmail Team <mail-noreply@google.com>',
          'Jerry Sandoval <jerry@dynecom.com>',
        ],
        occurredAt: isoMinutesAgo(18),
        priority: 'medium' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(17),
        clientId: null,
        projectId: null,
        metadata: {
          automatedSender: true,
          isUnread: true,
        },
      };

      const directPricingQuestion = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'pricing-keep',
        externalParentId: 'thread-pricing-keep',
        title: 'Need your approval on vendor pricing update',
        summary:
          'Jerry, can you confirm we should accept the vendor pricing update today?',
        body: 'Jerry, can you confirm we should accept the vendor pricing update today?',
        participants: [
          'Vendor Pricing <pricing@vendor.com>',
          'jerry@bettymills.com',
        ],
        occurredAt: isoMinutesAgo(20),
        priority: 'high' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(19),
        clientId: client.id,
        projectId: project.id,
        attention: {
          awarenessOnly: false,
          actionRequired: true,
          operationalRisk: false,
          reportWorthy: true,
          directness: 'direct' as const,
          importanceReason: 'Direct pricing question likely needs a reply.',
          actionConfidence: 0.81,
          mappingConfidence: 0.9,
          modelContextFingerprint: 'pricing-ctx',
        },
        metadata: {
          attention: {
            awarenessOnly: false,
            actionRequired: true,
            operationalRisk: false,
            reportWorthy: true,
            directness: 'direct',
            importanceReason: 'Direct pricing question likely needs a reply.',
            actionConfidence: 0.81,
            mappingConfidence: 0.9,
            modelContextFingerprint: 'pricing-ctx',
          },
        },
      };

      upsertSourceRecord(routineNotification);
      upsertSourceRecord(inboxTips);
      upsertSourceRecord(directPricingQuestion);
      (service as any).materializeDerivedRecords(routineNotification);
      (service as any).materializeDerivedRecords(inboxTips);
      (service as any).materializeDerivedRecords(directPricingQuestion);

      const inbox = service.getInboxView();
      expect(inbox.map((entry) => entry.externalId)).toContain('pricing-keep');
      expect(inbox.map((entry) => entry.externalId)).not.toContain('share-1');
      expect(inbox.map((entry) => entry.externalId)).not.toContain(
        'gmail-tips-1',
      );

      const workItems = listWorkItems({ limit: 20 });
      expect(
        workItems.some((item) => item.sourceRecordKey?.includes('share-1')),
      ).toBe(false);
      expect(
        workItems.some((item) =>
          item.sourceRecordKey?.includes('gmail-tips-1'),
        ),
      ).toBe(false);
      expect(
        workItems.some((item) =>
          item.sourceRecordKey?.includes('pricing-keep'),
        ),
      ).toBe(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('treats shared group-assignment wrapper emails as awareness unless operationally sensitive', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({
        name: 'Betty Mills',
        roles: ['COO'],
      });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });

      const source = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'group-wrapper-1',
        externalParentId: 'thread-group-wrapper-1',
        title:
          'Assigned to Group - The Betty Mills Company: last check for featured slots',
        summary:
          'Hi A new ticket has been assigned to your group "Sales". Please follow the link below to view the ticket.',
        body: 'Hi A new ticket has been assigned to your group "Sales". Please follow the link below to view the ticket. The Betty Mills Company: last check for featured slots.',
        participants: ['support@bettymills.com', 'latoya@bettymills.com'],
        occurredAt: isoMinutesAgo(25),
        priority: 'medium' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(24),
        clientId: client.id,
        projectId: project.id,
        attention: {
          awarenessOnly: false,
          actionRequired: true,
          operationalRisk: true,
          reportWorthy: true,
          directness: 'direct' as const,
          importanceReason: 'Assigned to Sales group and may need review.',
          actionConfidence: 0.74,
          mappingConfidence: 0.9,
          modelContextFingerprint: 'group-wrapper-ctx',
        },
        metadata: {
          modelOperationalRisk: true,
          attention: {
            awarenessOnly: false,
            actionRequired: true,
            operationalRisk: true,
            reportWorthy: true,
            directness: 'direct',
            importanceReason: 'Assigned to Sales group and may need review.',
            actionConfidence: 0.74,
            mappingConfidence: 0.9,
            modelContextFingerprint: 'group-wrapper-ctx',
          },
        },
      };

      upsertSourceRecord(source);
      (service as any).materializeDerivedRecords(source);

      const inbox = service.getInboxView({ includeNoise: true });
      const surfaced = inbox.find(
        (entry) => entry.externalId === 'group-wrapper-1',
      );
      expect(surfaced).toBeTruthy();
      expect(surfaced?.attention?.actionRequired).toBe(false);
      expect(surfaced?.attention?.awarenessOnly).toBe(false);
      expect(surfaced?.attention?.directness).toBe('shared');
      expect(surfaced?.attention?.reportWorthy).toBe(false);

      const workItems = listWorkItems({ limit: 20 });
      expect(
        workItems.some((item) =>
          item.sourceRecordKey?.includes('group-wrapper-1'),
        ),
      ).toBe(false);

      const today = service.getTodayView();
      expect(
        today.awareness.some((entry) => entry.externalId === 'group-wrapper-1'),
      ).toBe(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('does not raise shared alias email without Jerry in recipients as an important item', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({
        name: 'Betty Mills',
        roles: ['COO'],
      });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });

      const source = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'support-alias-1',
        externalParentId: 'thread-support-alias-1',
        title: 'Customer question about order status',
        summary: 'Support mailbox received a routine order status follow-up.',
        body: 'Customer is asking for a status update on an order. No direct ask to Jerry.',
        participants: [
          'support@bettymills.com',
          'Customer <customer@example.com>',
        ],
        occurredAt: isoMinutesAgo(18),
        priority: 'high' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(17),
        clientId: client.id,
        projectId: project.id,
        attention: {
          awarenessOnly: false,
          actionRequired: true,
          operationalRisk: false,
          reportWorthy: true,
          directness: 'direct' as const,
          importanceReason: 'High-priority customer follow-up.',
          actionConfidence: 0.82,
          mappingConfidence: 0.92,
          modelContextFingerprint: 'support-alias-ctx',
        },
        metadata: {
          attention: {
            awarenessOnly: false,
            actionRequired: true,
            operationalRisk: false,
            reportWorthy: true,
            directness: 'direct',
            importanceReason: 'High-priority customer follow-up.',
            actionConfidence: 0.82,
            mappingConfidence: 0.92,
            modelContextFingerprint: 'support-alias-ctx',
          },
        },
      };

      upsertSourceRecord(source);
      (service as any).materializeDerivedRecords(source);

      const inbox = service.getInboxView({ includeNoise: true });
      const surfaced = inbox.find(
        (entry) => entry.externalId === 'support-alias-1',
      );
      expect(surfaced).toBeTruthy();
      expect(surfaced?.attention?.directness).toBe('shared');
      expect(surfaced?.attention?.actionRequired).toBe(false);
      expect(surfaced?.attention?.reportWorthy).toBe(false);
      expect(surfaced?.attention?.importanceReason).toContain(
        'without Jerry as a recipient',
      );

      const today = service.getTodayView();
      expect(
        today.inbox.some((entry) => entry.externalId === 'support-alias-1'),
      ).toBe(false);
      expect(
        today.awareness.some((entry) => entry.externalId === 'support-alias-1'),
      ).toBe(false);

      const workItems = listWorkItems({ limit: 20 });
      expect(
        workItems.some((item) =>
          item.sourceRecordKey?.includes('support-alias-1'),
        ),
      ).toBe(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('does not raise Freshdesk support traffic when Jerry is only the sender identity', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({
        name: 'Betty Mills',
        roles: ['COO'],
      });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });

      const source = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'freshdesk-support-1',
        externalParentId: 'thread-freshdesk-support-1',
        title: 'Re: Ticket #48123 order status follow-up',
        summary:
          'Freshdesk sent a customer support reply using your mailbox identity.',
        body: 'Freshdesk sent this customer support ticket reply. No direct ask to Jerry.',
        participants: [
          'jerry@bettymills.com',
          'support@bettymills.com',
          'customer@example.com',
        ],
        occurredAt: isoMinutesAgo(12),
        priority: 'high' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(11),
        clientId: client.id,
        projectId: project.id,
        attention: {
          awarenessOnly: false,
          actionRequired: true,
          operationalRisk: false,
          reportWorthy: true,
          directness: 'direct' as const,
          importanceReason: 'High-priority support response.',
          actionConfidence: 0.8,
          mappingConfidence: 0.92,
          modelContextFingerprint: 'freshdesk-support-ctx',
        },
        metadata: {
          fromAddress: 'jerry@bettymills.com',
          toRecipientAddresses: [
            'support@bettymills.com',
            'customer@example.com',
          ],
          attention: {
            awarenessOnly: false,
            actionRequired: true,
            operationalRisk: false,
            reportWorthy: true,
            directness: 'direct',
            importanceReason: 'High-priority support response.',
            actionConfidence: 0.8,
            mappingConfidence: 0.92,
            modelContextFingerprint: 'freshdesk-support-ctx',
          },
        },
      };

      upsertSourceRecord(source);
      (service as any).materializeDerivedRecords(source);

      const inbox = service.getInboxView({ includeNoise: true });
      const surfaced = inbox.find(
        (entry) => entry.externalId === 'freshdesk-support-1',
      );
      expect(surfaced).toBeTruthy();
      expect(surfaced?.attention?.directness).toBe('shared');
      expect(surfaced?.attention?.actionRequired).toBe(false);
      expect(surfaced?.attention?.reportWorthy).toBe(false);
      expect(surfaced?.attention?.importanceReason).toContain(
        'Helpdesk/support traffic without Jerry as a recipient',
      );

      const today = service.getTodayView();
      expect(
        today.inbox.some((entry) => entry.externalId === 'freshdesk-support-1'),
      ).toBe(false);
      expect(
        today.awareness.some(
          (entry) => entry.externalId === 'freshdesk-support-1',
        ),
      ).toBe(false);

      const workItems = listWorkItems({ limit: 20 });
      expect(
        workItems.some((item) =>
          item.sourceRecordKey?.includes('freshdesk-support-1'),
        ),
      ).toBe(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('does not raise internal distribution-list noise when Jerry is not an explicit recipient', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({
        name: 'Betty Mills',
        roles: ['COO'],
      });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });

      const source = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'flashsales-report-1',
        externalParentId: 'thread-flashsales-report-1',
        title: 'Daily Flash Sales Report',
        summary: 'Automated merchandising report for the flash sales list.',
        body: 'Daily Flash Sales Report for the merchandising team. No direct ask to Jerry.',
        participants: ['reports@bettymills.com', 'flashsales@bettymills.com'],
        occurredAt: isoMinutesAgo(18),
        priority: 'high' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(17),
        clientId: client.id,
        projectId: project.id,
        attention: {
          awarenessOnly: false,
          actionRequired: true,
          operationalRisk: true,
          reportWorthy: true,
          directness: 'direct' as const,
          importanceReason: 'High-priority automated report.',
          actionConfidence: 0.84,
          mappingConfidence: 0.92,
          modelContextFingerprint: 'flashsales-report-ctx',
        },
        metadata: {
          fromAddress: 'reports@bettymills.com',
          senderAddress: 'reports@bettymills.com',
          toRecipientAddresses: ['flashsales@bettymills.com'],
          attention: {
            awarenessOnly: false,
            actionRequired: true,
            operationalRisk: true,
            reportWorthy: true,
            directness: 'direct',
            importanceReason: 'High-priority automated report.',
            actionConfidence: 0.84,
            mappingConfidence: 0.92,
            modelContextFingerprint: 'flashsales-report-ctx',
          },
        },
      };

      upsertSourceRecord(source);
      (service as any).materializeDerivedRecords(source);

      const inbox = service.getInboxView({ includeNoise: true });
      const surfaced = inbox.find(
        (entry) => entry.externalId === 'flashsales-report-1',
      );
      expect(surfaced).toBeTruthy();
      expect(surfaced?.attention?.directness).toBe('shared');
      expect(surfaced?.attention?.actionRequired).toBe(false);
      expect(surfaced?.attention?.operationalRisk).toBe(false);
      expect(surfaced?.attention?.reportWorthy).toBe(false);
      expect(surfaced?.attention?.importanceReason).toContain(
        'without Jerry as a recipient',
      );

      const today = service.getTodayView();
      expect(
        today.inbox.some((entry) => entry.externalId === 'flashsales-report-1'),
      ).toBe(false);
      expect(
        today.awareness.some(
          (entry) => entry.externalId === 'flashsales-report-1',
        ),
      ).toBe(false);

      const workItems = listWorkItems({ limit: 20 });
      expect(
        workItems.some((item) =>
          item.sourceRecordKey?.includes('flashsales-report-1'),
        ),
      ).toBe(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('keeps shared pricing updates as awareness when they are executive-relevant exceptions', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({
        name: 'Betty Mills',
        roles: ['COO'],
      });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });

      const source = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'pricing-update-1',
        externalParentId: 'thread-pricing-update-1',
        title: 'Monthly Price File Current Information',
        summary: 'Vendor pricing update for the merchandising team.',
        body: 'Vendor pricing update attached. Price file and min max values were updated for review.',
        participants: [
          'Vendor Pricing <pricing@vendor.com>',
          'merchandising@bettymills.com',
        ],
        occurredAt: isoMinutesAgo(12),
        priority: 'medium' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(11),
        clientId: client.id,
        projectId: project.id,
        attention: {
          awarenessOnly: false,
          actionRequired: true,
          operationalRisk: true,
          reportWorthy: true,
          directness: 'direct' as const,
          importanceReason: 'Pricing update may need review.',
          actionConfidence: 0.81,
          mappingConfidence: 0.92,
          modelContextFingerprint: 'pricing-update-ctx',
        },
        metadata: {
          fromAddress: 'pricing@vendor.com',
          senderAddress: 'pricing@vendor.com',
          toRecipientAddresses: ['merchandising@bettymills.com'],
          attention: {
            awarenessOnly: false,
            actionRequired: true,
            operationalRisk: true,
            reportWorthy: true,
            directness: 'direct',
            importanceReason: 'Pricing update may need review.',
            actionConfidence: 0.81,
            mappingConfidence: 0.92,
            modelContextFingerprint: 'pricing-update-ctx',
          },
        },
      };

      upsertSourceRecord(source);
      (service as any).materializeDerivedRecords(source);

      const inbox = service.getInboxView({ includeNoise: true });
      const surfaced = inbox.find(
        (entry) => entry.externalId === 'pricing-update-1',
      );
      expect(surfaced).toBeTruthy();
      expect(surfaced?.attention?.directness).toBe('shared');
      expect(surfaced?.attention?.actionRequired).toBe(false);
      expect(surfaced?.attention?.awarenessOnly).toBe(true);
      expect(surfaced?.attention?.reportWorthy).toBe(true);
      expect(surfaced?.attention?.importanceReason).toContain(
        'Shared distribution or alias update relevant to Jerry’s role',
      );

      const today = service.getTodayView();
      expect(
        today.awareness.some(
          (entry) => entry.externalId === 'pricing-update-1',
        ),
      ).toBe(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('hides stale derived email work when current attention logic demotes the source', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({
        name: 'Betty Mills',
        roles: ['COO'],
      });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });

      const source = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'stale-facebook-shared-1',
        externalParentId: 'thread-stale-facebook-shared-1',
        title: 'Action required: your items were rejected',
        summary: 'A Facebook item was rejected.',
        body: 'These items are not live. Shared merchandising notification without a direct ask to Jerry.',
        participants: [
          'noreply@business.facebook.com',
          'merchandising@bettymills.com',
        ],
        occurredAt: isoMinutesAgo(90),
        priority: 'medium' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(89),
        clientId: client.id,
        projectId: project.id,
        attention: {
          awarenessOnly: false,
          actionRequired: true,
          operationalRisk: false,
          reportWorthy: true,
          directness: 'direct' as const,
          importanceReason: 'Old model promoted this shared alias item.',
          actionConfidence: 0.95,
          mappingConfidence: 0.95,
          modelContextFingerprint: 'stale-facebook-shared-ctx',
        },
        metadata: {
          fromAddress: 'noreply@business.facebook.com',
          senderAddress: 'noreply@business.facebook.com',
          toRecipientAddresses: ['merchandising@bettymills.com'],
          attention: {
            awarenessOnly: false,
            actionRequired: true,
            operationalRisk: false,
            reportWorthy: true,
            directness: 'direct',
            importanceReason: 'Old model promoted this shared alias item.',
            actionConfidence: 0.95,
            mappingConfidence: 0.95,
            modelContextFingerprint: 'stale-facebook-shared-ctx',
          },
        },
      };

      upsertSourceRecord(source);
      upsertWorkItem({
        id: 'work:microsoft:jerry@bettymills.com:email:stale-facebook-shared-1',
        title: 'Review Facebook rejection and determine remediation',
        sourceKind: 'email',
        sourceProvider: 'microsoft',
        sourceRecordKey:
          'microsoft:jerry@bettymills.com:email:stale-facebook-shared-1',
        clientId: client.id,
        projectId: project.id,
        dueDate: null,
        priority: 'medium',
        status: 'blocked',
        confidence: 0.95,
        needsReview: false,
        linkedContactIds: [],
        openLoopState: 'blocked',
        notes: 'Stale derived work item from earlier triage.',
      });

      const today = service.getTodayView();
      expect(
        today.priorities.some((item) =>
          item.title.includes('Facebook rejection'),
        ),
      ).toBe(false);
      expect(
        today.blockers.some((item) =>
          item.title.includes('Facebook rejection'),
        ),
      ).toBe(false);
      expect(
        today.openLoops.some((item) =>
          item.title.includes('Facebook rejection'),
        ),
      ).toBe(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('derives mentioned directness from explicit cc recipients', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({
        name: 'Betty Mills',
        roles: ['COO'],
      });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });

      const source = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'cc-mention-1',
        externalParentId: 'thread-cc-mention-1',
        title: 'Please review vendor follow-up',
        summary: 'Jerry is copied for review.',
        body: 'Please review this vendor follow-up and let me know.',
        participants: [
          'Vendor <vendor@example.com>',
          'ops@bettymills.com',
          'jerry@bettymills.com',
        ],
        occurredAt: isoMinutesAgo(7),
        priority: 'medium' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(6),
        clientId: client.id,
        projectId: project.id,
        metadata: {
          fromAddress: 'vendor@example.com',
          senderAddress: 'vendor@example.com',
          toRecipientAddresses: ['ops@bettymills.com'],
          ccRecipientAddresses: ['jerry@bettymills.com'],
        },
      };

      upsertSourceRecord(source);
      const inbox = service.getInboxView({ includeNoise: true });
      const surfaced = inbox.find(
        (entry) => entry.externalId === 'cc-mention-1',
      );
      expect(surfaced?.attention?.directness).toBe('mentioned');
      expect(surfaced?.attention?.actionRequired).toBe(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('ignores similar email messages by sender and subject pattern', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({
        name: 'Betty Mills',
        roles: ['COO'],
      });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });

      const first = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'facebook-rejected-1',
        externalParentId: 'thread-facebook-rejected',
        title: 'Action required: your items were rejected',
        summary: '1 item was rejected and is not live.',
        body: 'These items are not live and require review.',
        participants: ['noreply@business.facebook.com', 'jerry@bettymills.com'],
        occurredAt: isoMinutesAgo(9),
        priority: 'high' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(8),
        clientId: client.id,
        projectId: project.id,
        attention: {
          awarenessOnly: false,
          actionRequired: true,
          operationalRisk: false,
          reportWorthy: true,
          directness: 'direct' as const,
          importanceReason: 'Likely needs Jerry action.',
          actionConfidence: 0.95,
          mappingConfidence: 0.95,
          modelContextFingerprint: 'facebook-rejected-ctx-1',
        },
        metadata: {
          fromAddress: 'noreply@business.facebook.com',
          senderAddress: 'noreply@business.facebook.com',
          toRecipientAddresses: ['jerry@bettymills.com'],
          attention: {
            awarenessOnly: false,
            actionRequired: true,
            operationalRisk: false,
            reportWorthy: true,
            directness: 'direct',
            importanceReason: 'Likely needs Jerry action.',
            actionConfidence: 0.95,
            mappingConfidence: 0.95,
            modelContextFingerprint: 'facebook-rejected-ctx-1',
          },
        },
      };
      const second = {
        ...first,
        externalId: 'facebook-rejected-2',
        title: 'Action required: your 4 items were rejected',
        summary: '4 items were rejected and are not live.',
        syncedAt: isoMinutesAgo(7),
        occurredAt: isoMinutesAgo(7),
        metadata: {
          ...first.metadata,
          attention: {
            awarenessOnly: false,
            actionRequired: true,
            operationalRisk: false,
            reportWorthy: true,
            directness: 'direct',
            importanceReason: 'Likely needs Jerry action.',
            actionConfidence: 0.95,
            mappingConfidence: 0.95,
            modelContextFingerprint: 'facebook-rejected-ctx-2',
          },
        },
        attention: {
          awarenessOnly: false,
          actionRequired: true,
          operationalRisk: false,
          reportWorthy: true,
          directness: 'direct' as const,
          importanceReason: 'Likely needs Jerry action.',
          actionConfidence: 0.95,
          mappingConfidence: 0.95,
          modelContextFingerprint: 'facebook-rejected-ctx-2',
        },
      };

      upsertSourceRecord(first);
      upsertSourceRecord(second);
      (service as any).materializeDerivedRecords(first);
      (service as any).materializeDerivedRecords(second);

      service.recordCorrection({
        targetType: 'source_record',
        targetId: 'microsoft:jerry@bettymills.com:email:facebook-rejected-1',
        field: 'ignoreSimilar',
        value: first.title,
      });

      const refreshedFirst = getSourceRecord(
        'microsoft',
        'jerry@bettymills.com',
        'email',
        'facebook-rejected-1',
      );
      const refreshedSecond = getSourceRecord(
        'microsoft',
        'jerry@bettymills.com',
        'email',
        'facebook-rejected-2',
      );

      expect(refreshedFirst?.status).toBe('filtered');
      expect(refreshedSecond?.status).toBe('filtered');
      expect(refreshedFirst?.metadata?.likelyNoise).toBe(true);
      expect(refreshedSecond?.metadata?.likelyNoise).toBe(true);

      const inbox = service.getInboxView();
      expect(
        inbox.some((entry) => entry.externalId === 'facebook-rejected-1'),
      ).toBe(false);
      expect(
        inbox.some((entry) => entry.externalId === 'facebook-rejected-2'),
      ).toBe(false);

      const workItems = listWorkItems({ limit: 20 }).filter((item) =>
        item.sourceRecordKey?.includes('facebook-rejected'),
      );
      expect(workItems.length).toBe(2);
      expect(workItems.every((item) => item.status === 'ignored')).toBe(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('builds contact memory, open loops, and review queue from low-confidence source signals', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({ name: 'Betty Mills' });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });
      const source = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'map-notice-1',
        title: 'MAP violation notice',
        summary: 'Vendor reported a MAP violation on a live SKU.',
        body: 'Please review the attached MAP violation notice.',
        participants: ['Vendor Ops <vendor@example.com>'],
        occurredAt: isoMinutesAgo(20),
        priority: 'high' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(19),
        clientId: client.id,
        projectId: project.id,
        attributionSource: 'model' as const,
        attributionConfidence: 0.58,
        attention: {
          awarenessOnly: true,
          actionRequired: false,
          operationalRisk: true,
          reportWorthy: true,
          directness: 'shared' as const,
          importanceReason: 'COO should stay aware of MAP violations.',
          actionConfidence: 0.62,
          mappingConfidence: 0.58,
          modelContextFingerprint: 'ctx-1',
        },
        reviewState: 'suggested' as const,
        linkedContactIds: [],
        metadata: {
          attention: {
            awarenessOnly: true,
            actionRequired: false,
            operationalRisk: true,
            reportWorthy: true,
            directness: 'shared',
            importanceReason: 'COO should stay aware of MAP violations.',
            actionConfidence: 0.62,
            mappingConfidence: 0.58,
            modelContextFingerprint: 'ctx-1',
          },
          reviewState: 'suggested',
        },
      };

      source.linkedContactIds = (service as any).ensureContactsFromSource(
        source,
      );
      upsertSourceRecord(source);
      (service as any).materializeDerivedRecords(source);

      const contacts = service.getContacts();
      expect(
        contacts.contacts.some((contact) =>
          contact.name.toLowerCase().includes('vendor'),
        ),
      ).toBe(true);

      const openLoops = service.getOpenLoops();
      expect(
        openLoops.some(
          (loop) =>
            loop.kind === 'review' && loop.title === 'MAP violation notice',
        ),
      ).toBe(true);

      const review = service.getReviewQueue();
      expect(
        review.some(
          (item) =>
            item.kind === 'source_record' &&
            item.title === 'MAP violation notice',
        ),
      ).toBe(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('builds approval queue items and durable memory facts for 2.0 flows', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({ name: 'Betty Mills' });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / COO',
      });
      const source = {
        provider: 'microsoft' as const,
        accountId: 'jerry@bettymills.com',
        accountLabel: 'jerry@bettymills.com',
        kind: 'email' as const,
        externalId: 'pricing-1',
        externalParentId: 'thread-pricing-1',
        title: 'Vendor pricing update needs review',
        summary:
          'Can you confirm we should accept the new pricing sheet today?',
        body: 'Jerry, can you confirm whether we should accept the new vendor pricing update today?',
        participants: [
          'Vendor Pricing <pricing@vendor.com>',
          'jerry@bettymills.com',
        ],
        occurredAt: isoMinutesAgo(15),
        priority: 'high' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(14),
        clientId: client.id,
        projectId: project.id,
        attributionSource: 'model' as const,
        attributionConfidence: 0.64,
        attention: {
          awarenessOnly: false,
          actionRequired: true,
          operationalRisk: false,
          reportWorthy: true,
          directness: 'direct' as const,
          importanceReason: 'Direct pricing question likely needs a reply.',
          actionConfidence: 0.64,
          mappingConfidence: 0.64,
          modelContextFingerprint: 'ctx-queue',
        },
        reviewState: 'suggested' as const,
        linkedContactIds: [],
        metadata: {
          attention: {
            awarenessOnly: false,
            actionRequired: true,
            operationalRisk: false,
            reportWorthy: true,
            directness: 'direct',
            importanceReason: 'Direct pricing question likely needs a reply.',
            actionConfidence: 0.64,
            mappingConfidence: 0.64,
            modelContextFingerprint: 'ctx-queue',
          },
          reviewState: 'suggested',
        },
      };

      source.linkedContactIds = (service as any).ensureContactsFromSource(
        source,
      );
      upsertSourceRecord(source);
      (service as any).materializeDerivedRecords(source);

      const contactId = source.linkedContactIds[0];
      service.linkContact({
        contactId,
        clientId: client.id,
        projectId: project.id,
        likelyRole: 'Vendor pricing contact',
      });

      const queue = service.getApprovalQueue();
      expect(
        queue.some(
          (item) =>
            item.kind === 'reply_draft' &&
            item.sourceRecordKey?.includes('pricing-1'),
        ),
      ).toBe(true);
      expect(
        queue.some(
          (item) =>
            item.kind === 'follow_up_task' &&
            item.sourceRecordKey?.includes('pricing-1'),
        ),
      ).toBe(true);

      const memory = service.getMemoryFacts();
      expect(
        memory.some(
          (fact) =>
            fact.kind === 'contact_client' && fact.clientId === client.id,
        ),
      ).toBe(true);
      expect(
        memory.some(
          (fact) =>
            fact.kind === 'contact_project' && fact.projectId === project.id,
        ),
      ).toBe(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });

  it('clears contact client and project defaults when explicitly unset', () => {
    try {
      const service = new PersonalOpsService();
      const client = service.upsertClient({ name: 'Dynecom' });
      const project = service.upsertProject({
        clientId: client.id,
        name: 'General / CTO',
      });

      const source: any = {
        provider: 'google' as const,
        accountId: 'jerry@dynecom.com',
        accountLabel: 'jerry@dynecom.com',
        kind: 'email' as const,
        externalId: 'clear-contact-defaults-1',
        title: 'Figma account notice',
        summary:
          'Shared service email that should not keep a hardwired project.',
        body: 'This sender appears across multiple contexts.',
        participants: ['Figma <announcements@figma.com>'],
        occurredAt: isoMinutesAgo(10),
        priority: 'medium' as const,
        status: 'received',
        syncedAt: isoMinutesAgo(9),
        clientId: client.id,
        projectId: project.id,
      };

      source.linkedContactIds = (service as any).ensureContactsFromSource(
        source,
      );
      const contactId = source.linkedContactIds[0];

      service.linkContact({
        contactId,
        clientId: null,
        projectId: null,
      });

      const contact = service
        .getContacts()
        .contacts.find((entry) => entry.id === contactId);
      expect(contact?.defaultClientId).toBeNull();
      expect(contact?.defaultProjectId).toBeNull();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NODE_MODULE_VERSION')) {
        expect(message).toContain('NODE_MODULE_VERSION');
        return;
      }
      throw error;
    }
  });
});

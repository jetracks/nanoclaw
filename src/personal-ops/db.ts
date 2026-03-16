import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { PERSONAL_OPS_STORE_DIR } from '../config.js';
import {
  AccountScopedContactHint,
  ApprovalQueueItem,
  AssistantQuestion,
  AssistantQuestionOption,
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
  OperatorProfile,
  PersonalOpsApprovalActionKind,
  PersonalOpsApprovalStatus,
  PersonalOpsConnectionSettings,
  PersonalOpsContactIdentityType,
  PersonalOpsContactImportance,
  PersonalOpsImprovementStatus,
  PersonalOpsMemoryFactKind,
  PersonalOpsPreference,
  PersonalOpsPriority,
  PersonalOpsProvider,
  PersonalOpsQuestionStatus,
  PersonalOpsQuestionSurface,
  PersonalOpsQuestionTargetType,
  PersonalOpsQuestionUrgency,
  PersonalOpsReportType,
  PersonalOpsSourceKind,
  PersonalOpsSuggestionStatus,
  Project,
  ReportSnapshot,
  SourceRecord,
  SyncJobState,
  WorkItem,
} from '../types.js';

interface ConnectedAccountRow {
  connection_key: string;
  provider: PersonalOpsProvider;
  status: 'disconnected' | 'connected' | 'degraded';
  account_label: string | null;
  account_id: string;
  base_url: string | null;
  scopes: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  resource_id: string | null;
  last_sync_at: string | null;
  last_sync_status: 'success' | 'error' | 'never';
  last_sync_error: string | null;
  settings: string;
  created_at: string;
  updated_at: string;
}

export interface ConnectedAccountRecord extends ConnectedAccount {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
}

interface OAuthStateRecord {
  provider: PersonalOpsProvider;
  state: string;
  code_verifier: string;
  redirect_uri: string;
  created_at: string;
}

let db: Database.Database;

const SOURCE_KINDS = new Set<PersonalOpsSourceKind>([
  'email',
  'calendar_event',
  'git_commit',
  'jira_issue',
  'slack_message',
  'manual_note',
  'manual_task',
  'report',
]);

function ensureDb(): Database.Database {
  if (!db) {
    initPersonalOpsDatabase();
  }
  return db;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeAccountId(value: string | null | undefined): string {
  return value?.trim() || '';
}

export function getConnectionKey(
  provider: SourceRecord['provider'],
  accountId: string | null | undefined,
): string {
  const normalized = normalizeAccountId(accountId);
  if (provider === 'manual') {
    return 'manual';
  }
  return normalized ? `${provider}:${normalized}` : `${provider}:default`;
}

function tableColumns(
  database: Database.Database,
  tableName: string,
): Array<{
  name: string;
  pk: number;
}> {
  try {
    return database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
      pk: number;
    }>;
  } catch {
    return [];
  }
}

function tableExists(database: Database.Database, tableName: string): boolean {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
  return Boolean(row);
}

function createConnectedAccountsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS connected_accounts (
      connection_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      account_label TEXT,
      account_id TEXT NOT NULL,
      base_url TEXT,
      scopes TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TEXT,
      resource_id TEXT,
      last_sync_at TEXT,
      last_sync_status TEXT NOT NULL DEFAULT 'never',
      last_sync_error TEXT,
      settings TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (provider, account_id)
    );
    CREATE INDEX IF NOT EXISTS idx_connected_accounts_provider ON connected_accounts(provider);
  `);
}

function createSyncJobsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sync_jobs (
      connection_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_label TEXT,
      source_kind TEXT NOT NULL,
      cursor TEXT,
      last_run_at TEXT,
      next_run_at TEXT,
      backoff_until TEXT,
      status TEXT NOT NULL,
      error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (connection_key, source_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_jobs_provider_account ON sync_jobs(provider, account_id);
  `);
}

function createSourceRecordsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS source_records (
      connection_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_label TEXT,
      kind TEXT NOT NULL,
      external_id TEXT NOT NULL,
      external_parent_id TEXT,
      source_url TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      body TEXT NOT NULL,
      participants TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      due_at TEXT,
      priority TEXT,
      status TEXT,
      synced_at TEXT NOT NULL,
      raw_snapshot_ref TEXT,
      client_id TEXT,
      project_id TEXT,
      attribution_source TEXT,
      attribution_confidence REAL,
      metadata TEXT NOT NULL,
      PRIMARY KEY (connection_key, kind, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_source_records_occurred_at ON source_records(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_source_records_client_project ON source_records(client_id, project_id);
    CREATE INDEX IF NOT EXISTS idx_source_records_provider_account ON source_records(provider, account_id);
  `);
}

function migrateConnectedAccounts(database: Database.Database): void {
  if (!tableExists(database, 'connected_accounts')) {
    return;
  }
  const columns = tableColumns(database, 'connected_accounts');
  const hasNewKey = columns.some((column) => column.name === 'connection_key');
  if (hasNewKey) {
    return;
  }

  const legacyName = `connected_accounts_legacy_${Date.now()}`;
  database.exec(`ALTER TABLE connected_accounts RENAME TO ${legacyName}`);
  createConnectedAccountsTable(database);

  const rows = database.prepare(`SELECT * FROM ${legacyName}`).all() as Array<{
    provider: PersonalOpsProvider;
    status: ConnectedAccount['status'];
    account_label: string | null;
    account_id: string | null;
    base_url: string | null;
    scopes: string;
    access_token: string | null;
    refresh_token: string | null;
    expires_at: string | null;
    resource_id: string | null;
    last_sync_at: string | null;
    last_sync_status: ConnectedAccount['lastSyncStatus'];
    last_sync_error: string | null;
    created_at: string;
    updated_at: string;
  }>;

  const insert = database.prepare(`
    INSERT INTO connected_accounts (
      connection_key, provider, status, account_label, account_id, base_url, scopes,
      access_token, refresh_token, expires_at, resource_id, last_sync_at,
      last_sync_status, last_sync_error, created_at, updated_at
    ) VALUES (
      @connection_key, @provider, @status, @account_label, @account_id, @base_url, @scopes,
      @access_token, @refresh_token, @expires_at, @resource_id, @last_sync_at,
      @last_sync_status, @last_sync_error, @created_at, @updated_at
    )
  `);

  for (const row of rows) {
    const accountId =
      normalizeAccountId(row.account_id) || `${row.provider}:legacy`;
    insert.run({
      ...row,
      connection_key: getConnectionKey(row.provider, accountId),
      account_id: accountId,
      account_label: row.account_label || row.account_id || null,
    });
  }

  database.exec(`DROP TABLE ${legacyName}`);
}

function resolveMigratedAccount(
  database: Database.Database,
  provider: PersonalOpsProvider,
): { accountId: string; accountLabel: string | null; connectionKey: string } {
  const account = database
    .prepare(
      `SELECT connection_key, account_id, account_label FROM connected_accounts WHERE provider = ? ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(provider) as
    | {
        connection_key: string;
        account_id: string;
        account_label: string | null;
      }
    | undefined;
  if (account) {
    return {
      accountId: account.account_id,
      accountLabel: account.account_label,
      connectionKey: account.connection_key,
    };
  }
  const accountId = `${provider}:legacy`;
  return {
    accountId,
    accountLabel: null,
    connectionKey: getConnectionKey(provider, accountId),
  };
}

function migrateSyncJobs(database: Database.Database): void {
  if (!tableExists(database, 'sync_jobs')) {
    return;
  }
  const columns = tableColumns(database, 'sync_jobs');
  const hasNewKey = columns.some((column) => column.name === 'connection_key');
  if (hasNewKey) {
    return;
  }

  const legacyName = `sync_jobs_legacy_${Date.now()}`;
  database.exec(`ALTER TABLE sync_jobs RENAME TO ${legacyName}`);
  createSyncJobsTable(database);

  const rows = database.prepare(`SELECT * FROM ${legacyName}`).all() as Array<{
    provider: PersonalOpsProvider;
    source_kind: PersonalOpsSourceKind;
    cursor: string | null;
    last_run_at: string | null;
    next_run_at: string | null;
    backoff_until: string | null;
    status: SyncJobState['status'];
    error: string | null;
    updated_at: string;
  }>;
  const insert = database.prepare(`
    INSERT INTO sync_jobs (
      connection_key, provider, account_id, account_label, source_kind, cursor, last_run_at,
      next_run_at, backoff_until, status, error, updated_at
    ) VALUES (
      @connection_key, @provider, @account_id, @account_label, @source_kind, @cursor, @last_run_at,
      @next_run_at, @backoff_until, @status, @error, @updated_at
    )
  `);

  for (const row of rows) {
    const account = resolveMigratedAccount(database, row.provider);
    insert.run({
      ...row,
      connection_key: account.connectionKey,
      account_id: account.accountId,
      account_label: account.accountLabel,
    });
  }

  database.exec(`DROP TABLE ${legacyName}`);
}

function migrateSourceRecords(database: Database.Database): void {
  if (!tableExists(database, 'source_records')) {
    return;
  }
  const columns = tableColumns(database, 'source_records');
  const hasNewKey = columns.some((column) => column.name === 'connection_key');
  if (hasNewKey) {
    return;
  }

  const legacyName = `source_records_legacy_${Date.now()}`;
  database.exec(`ALTER TABLE source_records RENAME TO ${legacyName}`);
  createSourceRecordsTable(database);

  const rows = database.prepare(`SELECT * FROM ${legacyName}`).all() as Array<{
    provider: SourceRecord['provider'];
    kind: PersonalOpsSourceKind;
    external_id: string;
    external_parent_id: string | null;
    source_url: string | null;
    title: string;
    summary: string;
    body: string;
    participants: string;
    occurred_at: string;
    due_at: string | null;
    priority: string | null;
    status: string | null;
    synced_at: string;
    raw_snapshot_ref: string | null;
    client_id: string | null;
    project_id: string | null;
    attribution_source: string | null;
    attribution_confidence: number | null;
    metadata: string;
  }>;
  const insert = database.prepare(`
    INSERT INTO source_records (
      connection_key, provider, account_id, account_label, kind, external_id, external_parent_id,
      source_url, title, summary, body, participants, occurred_at, due_at, priority, status,
      synced_at, raw_snapshot_ref, client_id, project_id, attribution_source,
      attribution_confidence, metadata
    ) VALUES (
      @connection_key, @provider, @account_id, @account_label, @kind, @external_id, @external_parent_id,
      @source_url, @title, @summary, @body, @participants, @occurred_at, @due_at, @priority, @status,
      @synced_at, @raw_snapshot_ref, @client_id, @project_id, @attribution_source,
      @attribution_confidence, @metadata
    )
  `);

  for (const row of rows) {
    const account =
      row.provider === 'manual'
        ? {
            accountId: '',
            accountLabel: null,
            connectionKey: getConnectionKey('manual', null),
          }
        : resolveMigratedAccount(database, row.provider);
    insert.run({
      ...row,
      connection_key: account.connectionKey,
      account_id: account.accountId,
      account_label: account.accountLabel,
    });
  }

  database.exec(`DROP TABLE ${legacyName}`);
}

function migrateLegacySchema(database: Database.Database): void {
  migrateConnectedAccounts(database);
  migrateSyncJobs(database);
  migrateSourceRecords(database);
  if (
    tableExists(database, 'connected_accounts') &&
    !tableColumns(database, 'connected_accounts').some(
      (column) => column.name === 'settings',
    )
  ) {
    database.exec(
      `ALTER TABLE connected_accounts ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'`,
    );
  }
  if (
    tableExists(database, 'clients') &&
    !tableColumns(database, 'clients').some(
      (column) => column.name === 'parent_client_id',
    )
  ) {
    database.exec(`ALTER TABLE clients ADD COLUMN parent_client_id TEXT`);
  }
  if (
    tableExists(database, 'clients') &&
    !tableColumns(database, 'clients').some((column) => column.name === 'roles')
  ) {
    database.exec(
      `ALTER TABLE clients ADD COLUMN roles TEXT NOT NULL DEFAULT '[]'`,
    );
  }
  if (
    tableExists(database, 'repositories') &&
    !tableColumns(database, 'repositories').some(
      (column) => column.name === 'last_commit_at',
    )
  ) {
    database.exec(`ALTER TABLE repositories ADD COLUMN last_commit_at TEXT`);
  }
  if (
    tableExists(database, 'work_items') &&
    !tableColumns(database, 'work_items').some(
      (column) => column.name === 'needs_review',
    )
  ) {
    database.exec(
      `ALTER TABLE work_items ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (
    tableExists(database, 'work_items') &&
    !tableColumns(database, 'work_items').some(
      (column) => column.name === 'linked_contact_ids',
    )
  ) {
    database.exec(
      `ALTER TABLE work_items ADD COLUMN linked_contact_ids TEXT NOT NULL DEFAULT '[]'`,
    );
  }
  if (
    tableExists(database, 'work_items') &&
    !tableColumns(database, 'work_items').some(
      (column) => column.name === 'open_loop_state',
    )
  ) {
    database.exec(
      `ALTER TABLE work_items ADD COLUMN open_loop_state TEXT NOT NULL DEFAULT 'action'`,
    );
  }
}

function createSchema(database: Database.Database): void {
  createConnectedAccountsTable(database);
  createSyncJobsTable(database);
  createSourceRecordsTable(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      parent_client_id TEXT,
      roles TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      notes TEXT NOT NULL,
      communication_preferences TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clients_parent_client_id ON clients(parent_client_id);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      deadline TEXT,
      notes TEXT NOT NULL,
      tags TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (client_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_projects_client_id ON projects(client_id);

    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      project_id TEXT,
      name TEXT NOT NULL,
      local_path TEXT NOT NULL UNIQUE,
      remote_url TEXT,
      default_branch TEXT,
      last_commit_at TEXT,
      notes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repositories_client_id ON repositories(client_id);
    CREATE INDEX IF NOT EXISTS idx_repositories_project_id ON repositories(project_id);

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      organization_hint TEXT,
      likely_role TEXT,
      importance TEXT NOT NULL,
      notes TEXT NOT NULL,
      last_seen_at TEXT,
      default_client_id TEXT,
      default_project_id TEXT,
      source_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(LOWER(name));
    CREATE INDEX IF NOT EXISTS idx_contacts_client_project ON contacts(default_client_id, default_project_id);

    CREATE TABLE IF NOT EXISTS contact_identities (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      type TEXT NOT NULL,
      provider TEXT NOT NULL,
      value TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (type, provider, value)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_identities_contact_id ON contact_identities(contact_id);

    CREATE TABLE IF NOT EXISTS contact_mapping_suggestions (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      client_id TEXT,
      project_id TEXT,
      basis TEXT NOT NULL,
      confidence REAL NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_mapping_suggestions_status ON contact_mapping_suggestions(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contact_mapping_suggestions_contact ON contact_mapping_suggestions(contact_id);

    CREATE TABLE IF NOT EXISTS memory_facts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      label TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL,
      status TEXT NOT NULL,
      provenance TEXT NOT NULL,
      source_record_key TEXT,
      contact_id TEXT,
      client_id TEXT,
      project_id TEXT,
      last_observed_at TEXT,
      stale_after TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (kind, subject_type, subject_id, value)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_facts_status ON memory_facts(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_facts_subject ON memory_facts(subject_type, subject_id);

    CREATE TABLE IF NOT EXISTS account_scoped_contact_hints (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      contact_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_label TEXT,
      identity_value TEXT NOT NULL,
      client_id TEXT,
      project_id TEXT,
      basis TEXT NOT NULL,
      confidence REAL NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_account_scoped_contact_hints_status ON account_scoped_contact_hints(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_account_scoped_contact_hints_contact ON account_scoped_contact_hints(contact_id);
    CREATE INDEX IF NOT EXISTS idx_account_scoped_contact_hints_account ON account_scoped_contact_hints(provider, account_id);

    CREATE TABLE IF NOT EXISTS assistant_questions (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      surface TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      urgency TEXT NOT NULL,
      prompt TEXT NOT NULL,
      rationale TEXT NOT NULL,
      recommended_option_id TEXT,
      options TEXT NOT NULL,
      freeform_allowed INTEGER NOT NULL DEFAULT 0,
      effect_preview TEXT NOT NULL,
      created_from TEXT NOT NULL,
      answer_option_id TEXT,
      answer_value TEXT,
      snooze_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      answered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_questions_status ON assistant_questions(status, urgency, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assistant_questions_surface ON assistant_questions(surface, urgency, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assistant_questions_target ON assistant_questions(target_type, target_id);

    CREATE TABLE IF NOT EXISTS improvement_tickets (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      problem TEXT NOT NULL,
      observed_context TEXT NOT NULL,
      desired_behavior TEXT NOT NULL,
      user_value TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      evidence_refs TEXT NOT NULL,
      suggested_surface TEXT,
      suggested_subsystem TEXT,
      created_from TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_improvement_tickets_status ON improvement_tickets(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_provider TEXT NOT NULL,
      source_record_key TEXT,
      client_id TEXT,
      project_id TEXT,
      due_date TEXT,
      priority TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL,
      needs_review INTEGER NOT NULL DEFAULT 0,
      linked_contact_ids TEXT NOT NULL DEFAULT '[]',
      open_loop_state TEXT NOT NULL DEFAULT 'action',
      notes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_items_due_date ON work_items(due_date);
    CREATE INDEX IF NOT EXISTS idx_work_items_client_project ON work_items(client_id, project_id);
    CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      source_provider TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_record_key TEXT,
      related_client_id TEXT,
      related_project_id TEXT,
      summary TEXT NOT NULL,
      raw_reference TEXT,
      metadata TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON activities(timestamp);
    CREATE INDEX IF NOT EXISTS idx_activities_client_project ON activities(related_client_id, related_project_id);

    CREATE TABLE IF NOT EXISTS report_snapshots (
      id TEXT PRIMARY KEY,
      report_type TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      range_start TEXT NOT NULL,
      range_end TEXT NOT NULL,
      grouped_output TEXT NOT NULL,
      source_references TEXT NOT NULL,
      model TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_report_snapshots_report_type ON report_snapshots(report_type, generated_at DESC);

    CREATE TABLE IF NOT EXISTS approval_queue_items (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      body TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence REAL,
      client_id TEXT,
      project_id TEXT,
      source_record_key TEXT,
      work_item_id TEXT,
      report_type TEXT,
      linked_contact_ids TEXT NOT NULL,
      evidence TEXT NOT NULL,
      artifact_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approval_queue_items_status ON approval_queue_items(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_approval_queue_items_source ON approval_queue_items(source_record_key, work_item_id);

    CREATE TABLE IF NOT EXISTS corrections (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_corrections_target ON corrections(target_type, target_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function mapConnectedAccount(row: ConnectedAccountRow): ConnectedAccountRecord {
  return {
    connectionKey: row.connection_key,
    provider: row.provider,
    status: row.status,
    accountLabel: row.account_label,
    accountId: row.account_id || null,
    baseUrl: row.base_url,
    scopes: parseJson<string[]>(row.scopes, []),
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    resourceId: row.resource_id,
    lastSyncAt: row.last_sync_at,
    lastSyncStatus: row.last_sync_status,
    lastSyncError: row.last_sync_error,
    settings: parseJson<PersonalOpsConnectionSettings>(row.settings, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSyncJob(row: any): SyncJobState {
  return {
    connectionKey: row.connection_key,
    provider: row.provider,
    accountId: row.account_id || null,
    accountLabel: row.account_label || null,
    sourceKind: row.source_kind,
    cursor: row.cursor,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    backoffUntil: row.backoff_until,
    status: row.status,
    error: row.error,
    updatedAt: row.updated_at,
  };
}

function mapSourceRecord(row: any): SourceRecord {
  const metadata = parseJson<Record<string, unknown>>(row.metadata, {});
  const attention =
    metadata.attention && typeof metadata.attention === 'object'
      ? (metadata.attention as SourceRecord['attention'])
      : null;
  const linkedContactIds = Array.isArray(metadata.linkedContactIds)
    ? (metadata.linkedContactIds as unknown[]).filter(
        (entry): entry is string =>
          typeof entry === 'string' && Boolean(entry.trim()),
      )
    : [];
  const threadState =
    metadata.threadState && typeof metadata.threadState === 'object'
      ? (metadata.threadState as SourceRecord['threadState'])
      : null;
  const reviewState =
    metadata.reviewState === 'suggested' ||
    metadata.reviewState === 'accepted' ||
    metadata.reviewState === 'rejected'
      ? (metadata.reviewState as PersonalOpsSuggestionStatus)
      : null;
  return {
    connectionKey: row.connection_key,
    provider: row.provider,
    accountId: row.account_id || null,
    accountLabel: row.account_label || null,
    kind: row.kind,
    externalId: row.external_id,
    externalParentId: row.external_parent_id,
    sourceUrl: row.source_url,
    title: row.title,
    summary: row.summary,
    body: row.body,
    participants: parseJson<string[]>(row.participants, []),
    occurredAt: row.occurred_at,
    dueAt: row.due_at,
    priority: row.priority,
    status: row.status,
    syncedAt: row.synced_at,
    rawSnapshotRef: row.raw_snapshot_ref,
    clientId: row.client_id,
    projectId: row.project_id,
    attributionSource: row.attribution_source || 'none',
    attributionConfidence: row.attribution_confidence,
    attention,
    threadState,
    linkedContactIds,
    reviewState,
    metadata,
  };
}

function mapClient(row: any): Client {
  return {
    id: row.id,
    name: row.name,
    parentClientId: row.parent_client_id ?? null,
    roles: parseJson<string[]>(row.roles, []),
    status: row.status,
    notes: row.notes,
    communicationPreferences: row.communication_preferences,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProject(row: any): Project {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    status: row.status,
    priority: row.priority,
    deadline: row.deadline,
    notes: row.notes,
    tags: parseJson<string[]>(row.tags, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapGitRepository(row: any): GitRepository {
  return {
    id: row.id,
    clientId: row.client_id,
    projectId: row.project_id,
    name: row.name,
    localPath: row.local_path,
    remoteUrl: row.remote_url,
    defaultBranch: row.default_branch,
    lastCommitAt: row.last_commit_at ?? null,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContact(row: any): Contact {
  return {
    id: row.id,
    name: row.name,
    organizationHint: row.organization_hint ?? null,
    likelyRole: row.likely_role ?? null,
    importance: row.importance as PersonalOpsContactImportance,
    notes: row.notes,
    lastSeenAt: row.last_seen_at ?? null,
    defaultClientId: row.default_client_id ?? null,
    defaultProjectId: row.default_project_id ?? null,
    sourceCount: Number(row.source_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContactIdentity(row: any): ContactIdentity {
  return {
    id: row.id,
    contactId: row.contact_id,
    type: row.type as PersonalOpsContactIdentityType,
    provider: row.provider,
    value: row.value,
    label: row.label ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContactMappingSuggestion(row: any): ContactMappingSuggestion {
  return {
    id: row.id,
    contactId: row.contact_id,
    clientId: row.client_id ?? null,
    projectId: row.project_id ?? null,
    basis: row.basis,
    confidence: Number(row.confidence || 0),
    occurrenceCount: Number(row.occurrence_count || 0),
    status: row.status as PersonalOpsSuggestionStatus,
    lastSeenAt: row.last_seen_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMemoryFact(row: any): MemoryFact {
  return {
    id: row.id,
    kind: row.kind as PersonalOpsMemoryFactKind,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    label: row.label,
    value: row.value,
    confidence: Number(row.confidence || 0),
    status: row.status,
    provenance: parseJson<string[]>(row.provenance, []),
    sourceRecordKey: row.source_record_key ?? null,
    contactId: row.contact_id ?? null,
    clientId: row.client_id ?? null,
    projectId: row.project_id ?? null,
    lastObservedAt: row.last_observed_at ?? null,
    staleAfter: row.stale_after ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAccountScopedContactHint(row: any): AccountScopedContactHint {
  return {
    id: row.id,
    contactId: row.contact_id,
    provider: row.provider as PersonalOpsProvider,
    accountId: row.account_id,
    accountLabel: row.account_label ?? null,
    identityValue: row.identity_value,
    clientId: row.client_id ?? null,
    projectId: row.project_id ?? null,
    basis: row.basis,
    confidence: Number(row.confidence || 0),
    occurrenceCount: Number(row.occurrence_count || 0),
    status: row.status as PersonalOpsSuggestionStatus,
    lastSeenAt: row.last_seen_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAssistantQuestion(row: any): AssistantQuestion {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    status: row.status as PersonalOpsQuestionStatus,
    surface: row.surface as PersonalOpsQuestionSurface,
    targetType:
      (row.target_type as PersonalOpsQuestionTargetType | null) ?? null,
    targetId: row.target_id ?? null,
    urgency: row.urgency as PersonalOpsQuestionUrgency,
    prompt: row.prompt,
    rationale: row.rationale,
    recommendedOptionId: row.recommended_option_id ?? null,
    options: parseJson<AssistantQuestionOption[]>(row.options, []),
    freeformAllowed: row.freeform_allowed === 1,
    effectPreview: row.effect_preview,
    createdFrom: row.created_from,
    answerOptionId: row.answer_option_id ?? null,
    answerValue: row.answer_value ?? null,
    snoozeUntil: row.snooze_until ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    answeredAt: row.answered_at ?? null,
  };
}

function mapImprovementTicket(row: any): ImprovementTicket {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    status: row.status as PersonalOpsImprovementStatus,
    title: row.title,
    problem: row.problem,
    observedContext: row.observed_context,
    desiredBehavior: row.desired_behavior,
    userValue: row.user_value,
    acceptanceCriteria: parseJson<string[]>(row.acceptance_criteria, []),
    evidenceRefs: parseJson<string[]>(row.evidence_refs, []),
    suggestedSurface: row.suggested_surface ?? null,
    suggestedSubsystem: row.suggested_subsystem ?? null,
    createdFrom: row.created_from,
    notes: row.notes ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? null,
  };
}

function mapWorkItem(row: any): WorkItem {
  return {
    id: row.id,
    title: row.title,
    sourceKind: row.source_kind,
    sourceProvider: row.source_provider,
    sourceRecordKey: row.source_record_key,
    clientId: row.client_id,
    projectId: row.project_id,
    dueDate: row.due_date,
    priority: row.priority,
    status: row.status,
    confidence: row.confidence,
    needsReview: row.needs_review === 1,
    linkedContactIds: parseJson<string[]>(row.linked_contact_ids, []),
    openLoopState: row.open_loop_state || 'action',
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapActivity(row: any): Activity {
  return {
    id: row.id,
    timestamp: row.timestamp,
    type: row.type,
    sourceProvider: row.source_provider,
    sourceKind: row.source_kind,
    sourceRecordKey: row.source_record_key,
    relatedClientId: row.related_client_id,
    relatedProjectId: row.related_project_id,
    summary: row.summary,
    rawReference: row.raw_reference,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
  };
}

function mapReport(row: any): ReportSnapshot {
  return {
    id: row.id,
    reportType: row.report_type,
    generatedAt: row.generated_at,
    rangeStart: row.range_start,
    rangeEnd: row.range_end,
    groupedOutput: row.grouped_output,
    sourceReferences: parseJson<string[]>(row.source_references, []),
    model: row.model,
  };
}

function mapApprovalQueueItem(row: any): ApprovalQueueItem {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    kind: row.kind as PersonalOpsApprovalActionKind,
    status: row.status as PersonalOpsApprovalStatus,
    title: row.title,
    summary: row.summary,
    body: row.body,
    reason: row.reason,
    confidence:
      typeof row.confidence === 'number'
        ? row.confidence
        : row.confidence == null
          ? null
          : Number(row.confidence),
    clientId: row.client_id ?? null,
    projectId: row.project_id ?? null,
    sourceRecordKey: row.source_record_key ?? null,
    workItemId: row.work_item_id ?? null,
    reportType: row.report_type ?? null,
    linkedContactIds: parseJson<string[]>(row.linked_contact_ids, []),
    evidence: parseJson<string[]>(row.evidence, []),
    artifactRef: row.artifact_ref ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? null,
  };
}

function mapCorrection(row: any): Correction {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    field: row.field,
    value: row.value,
    createdAt: row.created_at,
  };
}

export function initPersonalOpsDatabase(
  storeDir = PERSONAL_OPS_STORE_DIR,
): void {
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(storeDir, 0o700);
  } catch {
    // ignore
  }
  const dbPath = path.join(storeDir, 'personal_ops.db');
  db = new Database(dbPath);
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    // ignore
  }
  migrateLegacySchema(db);
  createSchema(db);
}

export function _initTestPersonalOpsDatabase(databasePath = ':memory:'): void {
  db = new Database(databasePath);
  migrateLegacySchema(db);
  createSchema(db);
}

export function getSourceRecordKey(
  provider: SourceRecord['provider'],
  accountId: string | null | undefined,
  kind: PersonalOpsSourceKind,
  externalId: string,
): string {
  const normalizedKind = SOURCE_KINDS.has(kind) ? kind : 'report';
  if (provider === 'manual') {
    return `manual:${normalizedKind}:${externalId}`;
  }
  return `${provider}:${normalizeAccountId(accountId) || 'default'}:${normalizedKind}:${externalId}`;
}

export function parseSourceRecordKey(key: string): {
  provider: SourceRecord['provider'];
  accountId: string | null;
  kind: PersonalOpsSourceKind;
  externalId: string;
} | null {
  const parts = key.split(':');
  if (parts.length < 3) {
    return null;
  }
  const provider = parts[0] as SourceRecord['provider'];
  if (provider === 'manual') {
    const [manualProvider, kind, ...external] = parts;
    if (
      !SOURCE_KINDS.has(kind as PersonalOpsSourceKind) ||
      external.length === 0
    ) {
      return null;
    }
    return {
      provider: manualProvider as SourceRecord['provider'],
      accountId: null,
      kind: kind as PersonalOpsSourceKind,
      externalId: external.join(':'),
    };
  }
  if (SOURCE_KINDS.has(parts[1] as PersonalOpsSourceKind)) {
    const [legacyProvider, kind, ...external] = parts;
    return {
      provider: legacyProvider as SourceRecord['provider'],
      accountId: null,
      kind: kind as PersonalOpsSourceKind,
      externalId: external.join(':'),
    };
  }
  const [scopedProvider, accountId, kind, ...external] = parts;
  if (
    !SOURCE_KINDS.has(kind as PersonalOpsSourceKind) ||
    external.length === 0
  ) {
    return null;
  }
  return {
    provider: scopedProvider as SourceRecord['provider'],
    accountId: accountId === 'default' ? null : accountId,
    kind: kind as PersonalOpsSourceKind,
    externalId: external.join(':'),
  };
}

export function listConnectedAccounts(): ConnectedAccount[] {
  return ensureDb()
    .prepare(
      `SELECT * FROM connected_accounts ORDER BY provider, LOWER(COALESCE(account_label, account_id))`,
    )
    .all()
    .map((row) => {
      const mapped = mapConnectedAccount(row as ConnectedAccountRow);
      const {
        accessToken: _accessToken,
        refreshToken: _refreshToken,
        ...rest
      } = mapped;
      return rest;
    });
}

export function listConnectedAccountRecords(): ConnectedAccountRecord[] {
  return ensureDb()
    .prepare(
      `SELECT * FROM connected_accounts ORDER BY provider, LOWER(COALESCE(account_label, account_id))`,
    )
    .all()
    .map((row) => mapConnectedAccount(row as ConnectedAccountRow));
}

export function getConnectedAccountRecord(
  provider: PersonalOpsProvider,
  accountId: string,
): ConnectedAccountRecord | undefined {
  const row = ensureDb()
    .prepare(
      `SELECT * FROM connected_accounts WHERE provider = ? AND account_id = ?`,
    )
    .get(provider, normalizeAccountId(accountId)) as
    | ConnectedAccountRow
    | undefined;
  return row ? mapConnectedAccount(row) : undefined;
}

export function getConnectedAccountRecordByConnectionKey(
  connectionKey: string,
): ConnectedAccountRecord | undefined {
  const row = ensureDb()
    .prepare(`SELECT * FROM connected_accounts WHERE connection_key = ?`)
    .get(connectionKey) as ConnectedAccountRow | undefined;
  return row ? mapConnectedAccount(row) : undefined;
}

export function upsertConnectedAccount(input: {
  provider: PersonalOpsProvider;
  accountId: string;
  status: ConnectedAccount['status'];
  accountLabel?: string | null;
  baseUrl?: string | null;
  scopes?: string[];
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: string | null;
  resourceId?: string | null;
  settings?: PersonalOpsConnectionSettings;
  lastSyncAt?: string | null;
  lastSyncStatus?: ConnectedAccount['lastSyncStatus'];
  lastSyncError?: string | null;
}): void {
  const normalizedAccountId =
    normalizeAccountId(input.accountId) || `${input.provider}:default`;
  const connectionKey = getConnectionKey(input.provider, normalizedAccountId);
  const existing = getConnectedAccountRecord(
    input.provider,
    normalizedAccountId,
  );
  const now = new Date().toISOString();
  ensureDb()
    .prepare(
      `INSERT INTO connected_accounts (
        connection_key, provider, status, account_label, account_id, base_url, scopes, access_token,
        refresh_token, expires_at, resource_id, last_sync_at, last_sync_status,
        last_sync_error, settings, created_at, updated_at
      ) VALUES (
        @connection_key, @provider, @status, @account_label, @account_id, @base_url, @scopes, @access_token,
        @refresh_token, @expires_at, @resource_id, @last_sync_at, @last_sync_status,
        @last_sync_error, @settings, @created_at, @updated_at
      )
      ON CONFLICT(connection_key) DO UPDATE SET
        status = excluded.status,
        account_label = excluded.account_label,
        account_id = excluded.account_id,
        base_url = excluded.base_url,
        scopes = excluded.scopes,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        resource_id = excluded.resource_id,
        last_sync_at = excluded.last_sync_at,
        last_sync_status = excluded.last_sync_status,
        last_sync_error = excluded.last_sync_error,
        settings = excluded.settings,
        updated_at = excluded.updated_at`,
    )
    .run({
      connection_key: connectionKey,
      provider: input.provider,
      status: input.status,
      account_label: input.accountLabel ?? existing?.accountLabel ?? null,
      account_id: normalizedAccountId,
      base_url: input.baseUrl ?? existing?.baseUrl ?? null,
      scopes: JSON.stringify(input.scopes ?? existing?.scopes ?? []),
      access_token:
        input.accessToken !== undefined
          ? input.accessToken
          : (existing?.accessToken ?? null),
      refresh_token:
        input.refreshToken !== undefined
          ? input.refreshToken
          : (existing?.refreshToken ?? null),
      expires_at:
        input.expiresAt !== undefined
          ? input.expiresAt
          : (existing?.expiresAt ?? null),
      resource_id: input.resourceId ?? existing?.resourceId ?? null,
      settings: JSON.stringify(input.settings ?? existing?.settings ?? {}),
      last_sync_at: input.lastSyncAt ?? existing?.lastSyncAt ?? null,
      last_sync_status:
        input.lastSyncStatus ?? existing?.lastSyncStatus ?? 'never',
      last_sync_error:
        input.lastSyncError !== undefined
          ? input.lastSyncError
          : (existing?.lastSyncError ?? null),
      created_at: existing?.createdAt ?? now,
      updated_at: now,
    });
}

export function disconnectConnectedAccount(
  provider: PersonalOpsProvider,
  accountId: string,
): void {
  const existing = getConnectedAccountRecord(provider, accountId);
  if (!existing) return;
  ensureDb()
    .prepare(`DELETE FROM connected_accounts WHERE connection_key = ?`)
    .run(existing.connectionKey);
  ensureDb()
    .prepare(`DELETE FROM sync_jobs WHERE connection_key = ?`)
    .run(existing.connectionKey);
}

export function upsertSyncJob(input: {
  connectionKey: string;
  provider: PersonalOpsProvider;
  accountId: string;
  accountLabel?: string | null;
  sourceKind: PersonalOpsSourceKind;
  cursor?: string | null;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  backoffUntil?: string | null;
  status: SyncJobState['status'];
  error?: string | null;
}): void {
  const now = new Date().toISOString();
  ensureDb()
    .prepare(
      `INSERT INTO sync_jobs (
        connection_key, provider, account_id, account_label, source_kind, cursor,
        last_run_at, next_run_at, backoff_until, status, error, updated_at
      ) VALUES (
        @connection_key, @provider, @account_id, @account_label, @source_kind, @cursor,
        @last_run_at, @next_run_at, @backoff_until, @status, @error, @updated_at
      )
      ON CONFLICT(connection_key, source_kind) DO UPDATE SET
        cursor = excluded.cursor,
        last_run_at = excluded.last_run_at,
        next_run_at = excluded.next_run_at,
        backoff_until = excluded.backoff_until,
        status = excluded.status,
        error = excluded.error,
        account_label = excluded.account_label,
        updated_at = excluded.updated_at`,
    )
    .run({
      connection_key: input.connectionKey,
      provider: input.provider,
      account_id: normalizeAccountId(input.accountId),
      account_label: input.accountLabel ?? null,
      source_kind: input.sourceKind,
      cursor: input.cursor ?? null,
      last_run_at: input.lastRunAt ?? null,
      next_run_at: input.nextRunAt ?? null,
      backoff_until: input.backoffUntil ?? null,
      status: input.status,
      error: input.error ?? null,
      updated_at: now,
    });
}

export function getSyncJob(
  connectionKey: string,
  sourceKind: PersonalOpsSourceKind,
): SyncJobState | undefined {
  const row = ensureDb()
    .prepare(
      `SELECT * FROM sync_jobs WHERE connection_key = ? AND source_kind = ?`,
    )
    .get(connectionKey, sourceKind);
  return row ? mapSyncJob(row) : undefined;
}

export function listSyncJobs(): SyncJobState[] {
  return ensureDb()
    .prepare(
      `SELECT * FROM sync_jobs ORDER BY provider, LOWER(COALESCE(account_label, account_id)), source_kind`,
    )
    .all()
    .map(mapSyncJob);
}

export function addOAuthState(input: {
  provider: PersonalOpsProvider;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}): void {
  ensureDb()
    .prepare(
      `INSERT OR REPLACE INTO oauth_states (
        state, provider, code_verifier, redirect_uri, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.state,
      input.provider,
      input.codeVerifier,
      input.redirectUri,
      new Date().toISOString(),
    );
}

export function consumeOAuthState(state: string): OAuthStateRecord | undefined {
  const database = ensureDb();
  const row = database
    .prepare(`SELECT * FROM oauth_states WHERE state = ?`)
    .get(state) as OAuthStateRecord | undefined;
  if (row) {
    database.prepare(`DELETE FROM oauth_states WHERE state = ?`).run(state);
  }
  return row;
}

export function upsertSourceRecord(source: SourceRecord): void {
  const accountId = normalizeAccountId(source.accountId);
  const connectionKey =
    source.connectionKey || getConnectionKey(source.provider, accountId);
  ensureDb()
    .prepare(
      `INSERT INTO source_records (
        connection_key, provider, account_id, account_label, kind, external_id, external_parent_id,
        source_url, title, summary, body, participants, occurred_at, due_at, priority, status,
        synced_at, raw_snapshot_ref, client_id, project_id, attribution_source,
        attribution_confidence, metadata
      ) VALUES (
        @connection_key, @provider, @account_id, @account_label, @kind, @external_id, @external_parent_id,
        @source_url, @title, @summary, @body, @participants, @occurred_at, @due_at, @priority, @status,
        @synced_at, @raw_snapshot_ref, @client_id, @project_id, @attribution_source,
        @attribution_confidence, @metadata
      )
      ON CONFLICT(connection_key, kind, external_id) DO UPDATE SET
        external_parent_id = excluded.external_parent_id,
        source_url = excluded.source_url,
        title = excluded.title,
        summary = excluded.summary,
        body = excluded.body,
        participants = excluded.participants,
        occurred_at = excluded.occurred_at,
        due_at = excluded.due_at,
        priority = excluded.priority,
        status = excluded.status,
        synced_at = excluded.synced_at,
        raw_snapshot_ref = excluded.raw_snapshot_ref,
        account_label = excluded.account_label,
        client_id = COALESCE(excluded.client_id, source_records.client_id),
        project_id = COALESCE(excluded.project_id, source_records.project_id),
        attribution_source = COALESCE(excluded.attribution_source, source_records.attribution_source),
        attribution_confidence = COALESCE(excluded.attribution_confidence, source_records.attribution_confidence),
        metadata = excluded.metadata`,
    )
    .run({
      connection_key: connectionKey,
      provider: source.provider,
      account_id: accountId,
      account_label: source.accountLabel ?? null,
      kind: source.kind,
      external_id: source.externalId,
      external_parent_id: source.externalParentId ?? null,
      source_url: source.sourceUrl ?? null,
      title: source.title,
      summary: source.summary,
      body: source.body,
      participants: JSON.stringify(source.participants),
      occurred_at: source.occurredAt,
      due_at: source.dueAt ?? null,
      priority: source.priority ?? null,
      status: source.status ?? null,
      synced_at: source.syncedAt,
      raw_snapshot_ref: source.rawSnapshotRef ?? null,
      client_id: source.clientId ?? null,
      project_id: source.projectId ?? null,
      attribution_source: source.attributionSource ?? null,
      attribution_confidence: source.attributionConfidence ?? null,
      metadata: JSON.stringify(source.metadata ?? {}),
    });
}

export function getSourceRecord(
  provider: SourceRecord['provider'],
  accountId: string | null | undefined,
  kind: PersonalOpsSourceKind,
  externalId: string,
): SourceRecord | undefined {
  const connectionKey = getConnectionKey(provider, accountId);
  const row = ensureDb()
    .prepare(
      `SELECT * FROM source_records WHERE connection_key = ? AND kind = ? AND external_id = ?`,
    )
    .get(connectionKey, kind, externalId);
  return row ? mapSourceRecord(row) : undefined;
}

export function listSourceRecords(filters?: {
  provider?: SourceRecord['provider'];
  accountId?: string | null;
  kind?: PersonalOpsSourceKind;
  clientId?: string | null;
  projectId?: string | null;
  since?: string;
  until?: string;
  limit?: number;
}): SourceRecord[] {
  const clauses: string[] = [];
  const values: Array<string | number | null> = [];
  if (filters?.provider) {
    clauses.push(`provider = ?`);
    values.push(filters.provider);
  }
  if (filters?.accountId !== undefined) {
    clauses.push(`account_id = ?`);
    values.push(normalizeAccountId(filters.accountId));
  }
  if (filters?.kind) {
    clauses.push(`kind = ?`);
    values.push(filters.kind);
  }
  if (filters?.clientId !== undefined) {
    clauses.push(`client_id ${filters.clientId ? '= ?' : 'IS NULL'}`);
    if (filters.clientId) values.push(filters.clientId);
  }
  if (filters?.projectId !== undefined) {
    clauses.push(`project_id ${filters.projectId ? '= ?' : 'IS NULL'}`);
    if (filters.projectId) values.push(filters.projectId);
  }
  if (filters?.since) {
    clauses.push(`occurred_at >= ?`);
    values.push(filters.since);
  }
  if (filters?.until) {
    clauses.push(`occurred_at <= ?`);
    values.push(filters.until);
  }
  const limit = filters?.limit ?? 200;
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return ensureDb()
    .prepare(
      `SELECT * FROM source_records ${where} ORDER BY occurred_at DESC LIMIT ?`,
    )
    .all(...values, limit)
    .map(mapSourceRecord);
}

export function upsertClient(input: {
  id?: string;
  name: string;
  parentClientId?: string | null;
  roles?: string[];
  status?: Client['status'];
  notes?: string;
  communicationPreferences?: string;
}): Client {
  const existing = ensureDb()
    .prepare(`SELECT * FROM clients WHERE id = ? OR name = ?`)
    .get(input.id ?? '', input.name) as any;
  const now = new Date().toISOString();
  const id = existing?.id || input.id || `client_${randomUUID()}`;
  ensureDb()
    .prepare(
      `INSERT INTO clients (
        id, name, parent_client_id, roles, status, notes, communication_preferences, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        parent_client_id = excluded.parent_client_id,
        roles = excluded.roles,
        status = excluded.status,
        notes = excluded.notes,
        communication_preferences = excluded.communication_preferences,
        updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.name,
      input.parentClientId ?? existing?.parent_client_id ?? null,
      JSON.stringify(input.roles ?? parseJson<string[]>(existing?.roles, [])),
      input.status || existing?.status || 'active',
      input.notes || existing?.notes || '',
      input.communicationPreferences ||
        existing?.communication_preferences ||
        '',
      existing?.created_at || now,
      now,
    );
  return getClient(id)!;
}

export function getClient(id: string): Client | undefined {
  const row = ensureDb().prepare(`SELECT * FROM clients WHERE id = ?`).get(id);
  return row ? mapClient(row) : undefined;
}

export function listClients(): Client[] {
  return ensureDb()
    .prepare(`SELECT * FROM clients ORDER BY name`)
    .all()
    .map(mapClient);
}

export function upsertProject(input: {
  id?: string;
  clientId?: string | null;
  name: string;
  status?: Project['status'];
  priority?: PersonalOpsPriority;
  deadline?: string | null;
  notes?: string;
  tags?: string[];
}): Project {
  const existing = ensureDb()
    .prepare(`SELECT * FROM projects WHERE id = ?`)
    .get(input.id ?? '') as any;
  const now = new Date().toISOString();
  const id = existing?.id || input.id || `project_${randomUUID()}`;
  ensureDb()
    .prepare(
      `INSERT INTO projects (
        id, client_id, name, status, priority, deadline, notes, tags, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        client_id = excluded.client_id,
        name = excluded.name,
        status = excluded.status,
        priority = excluded.priority,
        deadline = excluded.deadline,
        notes = excluded.notes,
        tags = excluded.tags,
        updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.clientId ?? existing?.client_id ?? null,
      input.name,
      input.status || existing?.status || 'active',
      input.priority || existing?.priority || 'medium',
      input.deadline ?? existing?.deadline ?? null,
      input.notes || existing?.notes || '',
      JSON.stringify(input.tags ?? parseJson<string[]>(existing?.tags, [])),
      existing?.created_at || now,
      now,
    );
  return getProject(id)!;
}

export function getProject(id: string): Project | undefined {
  const row = ensureDb().prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
  return row ? mapProject(row) : undefined;
}

export function listProjects(clientId?: string | null): Project[] {
  if (clientId) {
    return ensureDb()
      .prepare(`SELECT * FROM projects WHERE client_id = ? ORDER BY name`)
      .all(clientId)
      .map(mapProject);
  }
  return ensureDb()
    .prepare(`SELECT * FROM projects ORDER BY name`)
    .all()
    .map(mapProject);
}

export function upsertRepository(input: {
  id?: string;
  clientId?: string | null;
  projectId?: string | null;
  name: string;
  localPath: string;
  remoteUrl?: string | null;
  defaultBranch?: string | null;
  lastCommitAt?: string | null;
  notes?: string;
}): GitRepository {
  const existing = ensureDb()
    .prepare(`SELECT * FROM repositories WHERE id = ? OR local_path = ?`)
    .get(input.id ?? '', input.localPath) as any;
  const now = new Date().toISOString();
  const id = existing?.id || input.id || `repo_${randomUUID()}`;
  ensureDb()
    .prepare(
      `INSERT INTO repositories (
        id, client_id, project_id, name, local_path, remote_url, default_branch, last_commit_at, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        client_id = excluded.client_id,
        project_id = excluded.project_id,
        name = excluded.name,
        local_path = excluded.local_path,
        remote_url = excluded.remote_url,
        default_branch = excluded.default_branch,
        last_commit_at = excluded.last_commit_at,
        notes = excluded.notes,
        updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.clientId ?? existing?.client_id ?? null,
      input.projectId ?? existing?.project_id ?? null,
      input.name,
      input.localPath,
      input.remoteUrl ?? existing?.remote_url ?? null,
      input.defaultBranch ?? existing?.default_branch ?? null,
      input.lastCommitAt ?? existing?.last_commit_at ?? null,
      input.notes || existing?.notes || '',
      existing?.created_at || now,
      now,
    );
  return getRepository(id)!;
}

export function getRepository(id: string): GitRepository | undefined {
  const row = ensureDb()
    .prepare(`SELECT * FROM repositories WHERE id = ?`)
    .get(id);
  return row ? mapGitRepository(row) : undefined;
}

export function listRepositories(filters?: {
  clientId?: string | null;
  projectId?: string | null;
}): GitRepository[] {
  const clauses: string[] = [];
  const values: Array<string | number | null> = [];

  if (filters?.clientId !== undefined) {
    clauses.push(`client_id ${filters.clientId ? '= ?' : 'IS NULL'}`);
    if (filters.clientId) values.push(filters.clientId);
  }
  if (filters?.projectId !== undefined) {
    clauses.push(`project_id ${filters.projectId ? '= ?' : 'IS NULL'}`);
    if (filters.projectId) values.push(filters.projectId);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return ensureDb()
    .prepare(
      `SELECT * FROM repositories ${where} ORDER BY COALESCE(last_commit_at, '') DESC, LOWER(name), LOWER(local_path)`,
    )
    .all(...values)
    .map(mapGitRepository);
}

export function upsertContact(input: {
  id?: string;
  name: string;
  organizationHint?: string | null;
  likelyRole?: string | null;
  importance?: PersonalOpsContactImportance;
  notes?: string;
  lastSeenAt?: string | null;
  defaultClientId?: string | null;
  defaultProjectId?: string | null;
  sourceCount?: number;
}): Contact {
  const existing = input.id
    ? (ensureDb()
        .prepare(`SELECT * FROM contacts WHERE id = ?`)
        .get(input.id) as any)
    : (ensureDb()
        .prepare(`SELECT * FROM contacts WHERE LOWER(name) = LOWER(?) LIMIT 1`)
        .get(input.name) as any);
  const now = new Date().toISOString();
  const id = existing?.id || input.id || `contact_${randomUUID()}`;
  ensureDb()
    .prepare(
      `INSERT INTO contacts (
        id, name, organization_hint, likely_role, importance, notes, last_seen_at,
        default_client_id, default_project_id, source_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        organization_hint = excluded.organization_hint,
        likely_role = excluded.likely_role,
        importance = excluded.importance,
        notes = excluded.notes,
        last_seen_at = excluded.last_seen_at,
        default_client_id = excluded.default_client_id,
        default_project_id = excluded.default_project_id,
        source_count = excluded.source_count,
        updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.name,
      input.organizationHint ?? existing?.organization_hint ?? null,
      input.likelyRole ?? existing?.likely_role ?? null,
      input.importance ?? existing?.importance ?? 'normal',
      input.notes ?? existing?.notes ?? '',
      input.lastSeenAt ?? existing?.last_seen_at ?? null,
      input.defaultClientId !== undefined
        ? input.defaultClientId
        : (existing?.default_client_id ?? null),
      input.defaultProjectId !== undefined
        ? input.defaultProjectId
        : (existing?.default_project_id ?? null),
      input.sourceCount ?? existing?.source_count ?? 0,
      existing?.created_at || now,
      now,
    );
  return getContact(id)!;
}

export function getContact(id: string): Contact | undefined {
  const row = ensureDb().prepare(`SELECT * FROM contacts WHERE id = ?`).get(id);
  return row ? mapContact(row) : undefined;
}

export function listContacts(filters?: {
  clientId?: string | null;
  projectId?: string | null;
  limit?: number;
}): Contact[] {
  const clauses: string[] = [];
  const values: Array<string | number | null> = [];
  if (filters?.clientId !== undefined) {
    clauses.push(`default_client_id ${filters.clientId ? '= ?' : 'IS NULL'}`);
    if (filters.clientId) values.push(filters.clientId);
  }
  if (filters?.projectId !== undefined) {
    clauses.push(`default_project_id ${filters.projectId ? '= ?' : 'IS NULL'}`);
    if (filters.projectId) values.push(filters.projectId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters?.limit ?? 200;
  return ensureDb()
    .prepare(
      `SELECT * FROM contacts ${where} ORDER BY COALESCE(last_seen_at, updated_at) DESC, LOWER(name) LIMIT ?`,
    )
    .all(...values, limit)
    .map(mapContact);
}

export function upsertContactIdentity(input: {
  id?: string;
  contactId: string;
  type: PersonalOpsContactIdentityType;
  provider: PersonalOpsProvider | 'manual' | 'git';
  value: string;
  label?: string | null;
}): ContactIdentity {
  const existing = ensureDb()
    .prepare(
      `SELECT * FROM contact_identities WHERE type = ? AND provider = ? AND value = ?`,
    )
    .get(input.type, input.provider, input.value) as any;
  const now = new Date().toISOString();
  const id = existing?.id || input.id || `identity_${randomUUID()}`;
  ensureDb()
    .prepare(
      `INSERT INTO contact_identities (
        id, contact_id, type, provider, value, label, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        contact_id = excluded.contact_id,
        type = excluded.type,
        provider = excluded.provider,
        value = excluded.value,
        label = excluded.label,
        updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.contactId,
      input.type,
      input.provider,
      input.value,
      input.label ?? existing?.label ?? null,
      existing?.created_at || now,
      now,
    );
  return getContactIdentity(id)!;
}

export function getContactIdentity(id: string): ContactIdentity | undefined {
  const row = ensureDb()
    .prepare(`SELECT * FROM contact_identities WHERE id = ?`)
    .get(id);
  return row ? mapContactIdentity(row) : undefined;
}

export function findContactIdentity(
  type: PersonalOpsContactIdentityType,
  provider: PersonalOpsProvider | 'manual' | 'git',
  value: string,
): ContactIdentity | undefined {
  const row = ensureDb()
    .prepare(
      `SELECT * FROM contact_identities WHERE type = ? AND provider = ? AND value = ?`,
    )
    .get(type, provider, value);
  return row ? mapContactIdentity(row) : undefined;
}

export function listContactIdentities(contactId?: string): ContactIdentity[] {
  if (contactId) {
    return ensureDb()
      .prepare(
        `SELECT * FROM contact_identities WHERE contact_id = ? ORDER BY type, value`,
      )
      .all(contactId)
      .map(mapContactIdentity);
  }
  return ensureDb()
    .prepare(`SELECT * FROM contact_identities ORDER BY type, value`)
    .all()
    .map(mapContactIdentity);
}

export function upsertContactMappingSuggestion(input: {
  id?: string;
  contactId: string;
  clientId?: string | null;
  projectId?: string | null;
  basis: string;
  confidence?: number;
  occurrenceCount?: number;
  status?: PersonalOpsSuggestionStatus;
  lastSeenAt?: string | null;
}): ContactMappingSuggestion {
  const existing = ensureDb()
    .prepare(
      `SELECT * FROM contact_mapping_suggestions
       WHERE contact_id = ? AND IFNULL(client_id, '') = IFNULL(?, '') AND IFNULL(project_id, '') = IFNULL(?, '') AND basis = ?
       LIMIT 1`,
    )
    .get(
      input.contactId,
      input.clientId ?? null,
      input.projectId ?? null,
      input.basis,
    ) as any;
  const now = new Date().toISOString();
  const id = existing?.id || input.id || `contact_map_${randomUUID()}`;
  ensureDb()
    .prepare(
      `INSERT INTO contact_mapping_suggestions (
        id, contact_id, client_id, project_id, basis, confidence, occurrence_count,
        status, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        contact_id = excluded.contact_id,
        client_id = excluded.client_id,
        project_id = excluded.project_id,
        basis = excluded.basis,
        confidence = excluded.confidence,
        occurrence_count = excluded.occurrence_count,
        status = excluded.status,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.contactId,
      input.clientId ?? null,
      input.projectId ?? null,
      input.basis,
      input.confidence ?? existing?.confidence ?? 0.5,
      input.occurrenceCount ?? existing?.occurrence_count ?? 1,
      input.status ?? existing?.status ?? 'suggested',
      input.lastSeenAt ?? existing?.last_seen_at ?? null,
      existing?.created_at || now,
      now,
    );
  return getContactMappingSuggestion(id)!;
}

export function getContactMappingSuggestion(
  id: string,
): ContactMappingSuggestion | undefined {
  const row = ensureDb()
    .prepare(`SELECT * FROM contact_mapping_suggestions WHERE id = ?`)
    .get(id);
  return row ? mapContactMappingSuggestion(row) : undefined;
}

export function listContactMappingSuggestions(filters?: {
  status?: PersonalOpsSuggestionStatus;
  contactId?: string;
  limit?: number;
}): ContactMappingSuggestion[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (filters?.status) {
    clauses.push(`status = ?`);
    values.push(filters.status);
  }
  if (filters?.contactId) {
    clauses.push(`contact_id = ?`);
    values.push(filters.contactId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters?.limit ?? 200;
  return ensureDb()
    .prepare(
      `SELECT * FROM contact_mapping_suggestions ${where} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...values, limit)
    .map(mapContactMappingSuggestion);
}

export function upsertMemoryFact(input: {
  id?: string;
  kind: PersonalOpsMemoryFactKind;
  subjectType: MemoryFact['subjectType'];
  subjectId: string;
  label: string;
  value: string;
  confidence?: number;
  status?: MemoryFact['status'];
  provenance?: string[];
  sourceRecordKey?: string | null;
  contactId?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  lastObservedAt?: string | null;
  staleAfter?: string | null;
}): MemoryFact {
  const existing = ensureDb()
    .prepare(
      `SELECT * FROM memory_facts
       WHERE kind = ? AND subject_type = ? AND subject_id = ? AND value = ?
       LIMIT 1`,
    )
    .get(input.kind, input.subjectType, input.subjectId, input.value) as any;
  const now = new Date().toISOString();
  const id = existing?.id || input.id || `memory_${randomUUID()}`;
  ensureDb()
    .prepare(
      `INSERT INTO memory_facts (
        id, kind, subject_type, subject_id, label, value, confidence, status,
        provenance, source_record_key, contact_id, client_id, project_id,
        last_observed_at, stale_after, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        subject_type = excluded.subject_type,
        subject_id = excluded.subject_id,
        label = excluded.label,
        value = excluded.value,
        confidence = excluded.confidence,
        status = excluded.status,
        provenance = excluded.provenance,
        source_record_key = excluded.source_record_key,
        contact_id = excluded.contact_id,
        client_id = excluded.client_id,
        project_id = excluded.project_id,
        last_observed_at = excluded.last_observed_at,
        stale_after = excluded.stale_after,
        updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.kind,
      input.subjectType,
      input.subjectId,
      input.label,
      input.value,
      input.confidence ?? existing?.confidence ?? 0.8,
      input.status ?? existing?.status ?? 'suggested',
      JSON.stringify(
        input.provenance ?? parseJson<string[]>(existing?.provenance, []),
      ),
      input.sourceRecordKey ?? existing?.source_record_key ?? null,
      input.contactId ?? existing?.contact_id ?? null,
      input.clientId ?? existing?.client_id ?? null,
      input.projectId ?? existing?.project_id ?? null,
      input.lastObservedAt ?? existing?.last_observed_at ?? null,
      input.staleAfter ?? existing?.stale_after ?? null,
      existing?.created_at || now,
      now,
    );
  return getMemoryFact(id)!;
}

export function getMemoryFact(id: string): MemoryFact | undefined {
  const row = ensureDb()
    .prepare(`SELECT * FROM memory_facts WHERE id = ?`)
    .get(id);
  return row ? mapMemoryFact(row) : undefined;
}

export function listMemoryFacts(filters?: {
  status?: MemoryFact['status'];
  subjectType?: MemoryFact['subjectType'];
  subjectId?: string;
  contactId?: string;
  limit?: number;
}): MemoryFact[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (filters?.status) {
    clauses.push(`status = ?`);
    values.push(filters.status);
  }
  if (filters?.subjectType) {
    clauses.push(`subject_type = ?`);
    values.push(filters.subjectType);
  }
  if (filters?.subjectId) {
    clauses.push(`subject_id = ?`);
    values.push(filters.subjectId);
  }
  if (filters?.contactId) {
    clauses.push(`contact_id = ?`);
    values.push(filters.contactId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters?.limit ?? 300;
  return ensureDb()
    .prepare(
      `SELECT * FROM memory_facts ${where} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...values, limit)
    .map(mapMemoryFact);
}

export function upsertAccountScopedContactHint(input: {
  id?: string;
  dedupeKey: string;
  contactId: string;
  provider: PersonalOpsProvider;
  accountId: string;
  accountLabel?: string | null;
  identityValue: string;
  clientId?: string | null;
  projectId?: string | null;
  basis: string;
  confidence?: number;
  occurrenceCount?: number;
  status?: PersonalOpsSuggestionStatus;
  lastSeenAt?: string | null;
}): AccountScopedContactHint {
  const existing = ensureDb()
    .prepare(
      `SELECT * FROM account_scoped_contact_hints WHERE dedupe_key = ? LIMIT 1`,
    )
    .get(input.dedupeKey) as any;
  const now = new Date().toISOString();
  const id = existing?.id || input.id || `account_hint_${randomUUID()}`;
  ensureDb()
    .prepare(
      `INSERT INTO account_scoped_contact_hints (
        id, dedupe_key, contact_id, provider, account_id, account_label, identity_value,
        client_id, project_id, basis, confidence, occurrence_count, status, last_seen_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dedupe_key = excluded.dedupe_key,
        contact_id = excluded.contact_id,
        provider = excluded.provider,
        account_id = excluded.account_id,
        account_label = excluded.account_label,
        identity_value = excluded.identity_value,
        client_id = excluded.client_id,
        project_id = excluded.project_id,
        basis = excluded.basis,
        confidence = excluded.confidence,
        occurrence_count = excluded.occurrence_count,
        status = excluded.status,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.dedupeKey,
      input.contactId,
      input.provider,
      input.accountId,
      input.accountLabel ?? existing?.account_label ?? null,
      input.identityValue,
      input.clientId ?? null,
      input.projectId ?? null,
      input.basis,
      input.confidence ?? existing?.confidence ?? 0.75,
      input.occurrenceCount ?? existing?.occurrence_count ?? 1,
      input.status ?? existing?.status ?? 'suggested',
      input.lastSeenAt ?? existing?.last_seen_at ?? null,
      existing?.created_at || now,
      now,
    );
  return getAccountScopedContactHint(id)!;
}

export function getAccountScopedContactHint(
  id: string,
): AccountScopedContactHint | undefined {
  const row = ensureDb()
    .prepare(`SELECT * FROM account_scoped_contact_hints WHERE id = ?`)
    .get(id);
  return row ? mapAccountScopedContactHint(row) : undefined;
}

export function listAccountScopedContactHints(filters?: {
  status?: PersonalOpsSuggestionStatus;
  contactId?: string;
  provider?: PersonalOpsProvider;
  accountId?: string;
  limit?: number;
}): AccountScopedContactHint[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (filters?.status) {
    clauses.push(`status = ?`);
    values.push(filters.status);
  }
  if (filters?.contactId) {
    clauses.push(`contact_id = ?`);
    values.push(filters.contactId);
  }
  if (filters?.provider) {
    clauses.push(`provider = ?`);
    values.push(filters.provider);
  }
  if (filters?.accountId) {
    clauses.push(`account_id = ?`);
    values.push(filters.accountId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters?.limit ?? 300;
  return ensureDb()
    .prepare(
      `SELECT * FROM account_scoped_contact_hints ${where} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...values, limit)
    .map(mapAccountScopedContactHint);
}

export function upsertAssistantQuestion(input: {
  id?: string;
  dedupeKey: string;
  status?: PersonalOpsQuestionStatus;
  surface: PersonalOpsQuestionSurface;
  targetType?: PersonalOpsQuestionTargetType | null;
  targetId?: string | null;
  urgency: PersonalOpsQuestionUrgency;
  prompt: string;
  rationale: string;
  recommendedOptionId?: string | null;
  options: AssistantQuestionOption[];
  freeformAllowed?: boolean;
  effectPreview: string;
  createdFrom: string;
  answerOptionId?: string | null;
  answerValue?: string | null;
  snoozeUntil?: string | null;
  answeredAt?: string | null;
}): AssistantQuestion {
  const existing = ensureDb()
    .prepare(`SELECT * FROM assistant_questions WHERE dedupe_key = ? LIMIT 1`)
    .get(input.dedupeKey) as any;
  const now = new Date().toISOString();
  const id = existing?.id || input.id || `question_${randomUUID()}`;
  ensureDb()
    .prepare(
      `INSERT INTO assistant_questions (
        id, dedupe_key, status, surface, target_type, target_id, urgency,
        prompt, rationale, recommended_option_id, options, freeform_allowed,
        effect_preview, created_from, answer_option_id, answer_value, snooze_until,
        created_at, updated_at, answered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dedupe_key = excluded.dedupe_key,
        status = excluded.status,
        surface = excluded.surface,
        target_type = excluded.target_type,
        target_id = excluded.target_id,
        urgency = excluded.urgency,
        prompt = excluded.prompt,
        rationale = excluded.rationale,
        recommended_option_id = excluded.recommended_option_id,
        options = excluded.options,
        freeform_allowed = excluded.freeform_allowed,
        effect_preview = excluded.effect_preview,
        created_from = excluded.created_from,
        answer_option_id = excluded.answer_option_id,
        answer_value = excluded.answer_value,
        snooze_until = excluded.snooze_until,
        updated_at = excluded.updated_at,
        answered_at = excluded.answered_at`,
    )
    .run(
      id,
      input.dedupeKey,
      input.status ?? existing?.status ?? 'pending',
      input.surface,
      input.targetType ?? null,
      input.targetId ?? null,
      input.urgency,
      input.prompt,
      input.rationale,
      input.recommendedOptionId ?? null,
      JSON.stringify(input.options),
      input.freeformAllowed === true ? 1 : 0,
      input.effectPreview,
      input.createdFrom,
      input.answerOptionId ?? existing?.answer_option_id ?? null,
      input.answerValue ?? existing?.answer_value ?? null,
      input.snoozeUntil ?? existing?.snooze_until ?? null,
      existing?.created_at || now,
      now,
      input.answeredAt ?? existing?.answered_at ?? null,
    );
  return getAssistantQuestion(id)!;
}

export function getAssistantQuestion(
  id: string,
): AssistantQuestion | undefined {
  const row = ensureDb()
    .prepare(`SELECT * FROM assistant_questions WHERE id = ?`)
    .get(id);
  return row ? mapAssistantQuestion(row) : undefined;
}

export function listAssistantQuestions(filters?: {
  status?: PersonalOpsQuestionStatus;
  surface?: PersonalOpsQuestionSurface;
  targetType?: PersonalOpsQuestionTargetType;
  targetId?: string;
  urgency?: PersonalOpsQuestionUrgency;
  includeSnoozed?: boolean;
  limit?: number;
}): AssistantQuestion[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (filters?.status) {
    clauses.push(`status = ?`);
    values.push(filters.status);
  } else if (!filters?.includeSnoozed) {
    clauses.push(`status != 'dismissed'`);
  }
  if (filters?.surface) {
    clauses.push(`surface = ?`);
    values.push(filters.surface);
  }
  if (filters?.targetType) {
    clauses.push(`target_type = ?`);
    values.push(filters.targetType);
  }
  if (filters?.targetId) {
    clauses.push(`target_id = ?`);
    values.push(filters.targetId);
  }
  if (filters?.urgency) {
    clauses.push(`urgency = ?`);
    values.push(filters.urgency);
  }
  if (!filters?.includeSnoozed) {
    clauses.push(
      `(status != 'snoozed' OR snooze_until IS NULL OR snooze_until <= ?)`,
    );
    values.push(new Date().toISOString());
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters?.limit ?? 300;
  return ensureDb()
    .prepare(
      `SELECT * FROM assistant_questions ${where} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...values, limit)
    .map(mapAssistantQuestion);
}

export function upsertImprovementTicket(input: {
  id?: string;
  dedupeKey: string;
  status?: PersonalOpsImprovementStatus;
  title: string;
  problem: string;
  observedContext: string;
  desiredBehavior: string;
  userValue: string;
  acceptanceCriteria: string[];
  evidenceRefs?: string[];
  suggestedSurface?: string | null;
  suggestedSubsystem?: string | null;
  createdFrom: string;
  notes?: string | null;
  resolvedAt?: string | null;
}): ImprovementTicket {
  const existing = ensureDb()
    .prepare(`SELECT * FROM improvement_tickets WHERE dedupe_key = ? LIMIT 1`)
    .get(input.dedupeKey) as any;
  const now = new Date().toISOString();
  const id = existing?.id || input.id || `improvement_${randomUUID()}`;
  ensureDb()
    .prepare(
      `INSERT INTO improvement_tickets (
        id, dedupe_key, status, title, problem, observed_context, desired_behavior,
        user_value, acceptance_criteria, evidence_refs, suggested_surface,
        suggested_subsystem, created_from, notes, created_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dedupe_key = excluded.dedupe_key,
        status = excluded.status,
        title = excluded.title,
        problem = excluded.problem,
        observed_context = excluded.observed_context,
        desired_behavior = excluded.desired_behavior,
        user_value = excluded.user_value,
        acceptance_criteria = excluded.acceptance_criteria,
        evidence_refs = excluded.evidence_refs,
        suggested_surface = excluded.suggested_surface,
        suggested_subsystem = excluded.suggested_subsystem,
        created_from = excluded.created_from,
        notes = excluded.notes,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at`,
    )
    .run(
      id,
      input.dedupeKey,
      input.status ?? existing?.status ?? 'draft',
      input.title,
      input.problem,
      input.observedContext,
      input.desiredBehavior,
      input.userValue,
      JSON.stringify(input.acceptanceCriteria),
      JSON.stringify(input.evidenceRefs || []),
      input.suggestedSurface ?? existing?.suggested_surface ?? null,
      input.suggestedSubsystem ?? existing?.suggested_subsystem ?? null,
      input.createdFrom,
      input.notes ?? existing?.notes ?? null,
      existing?.created_at || now,
      now,
      input.resolvedAt ?? existing?.resolved_at ?? null,
    );
  return getImprovementTicket(id)!;
}

export function getImprovementTicket(
  id: string,
): ImprovementTicket | undefined {
  const row = ensureDb()
    .prepare(`SELECT * FROM improvement_tickets WHERE id = ?`)
    .get(id);
  return row ? mapImprovementTicket(row) : undefined;
}

export function listImprovementTickets(filters?: {
  status?: PersonalOpsImprovementStatus;
  limit?: number;
}): ImprovementTicket[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (filters?.status) {
    clauses.push(`status = ?`);
    values.push(filters.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters?.limit ?? 200;
  return ensureDb()
    .prepare(
      `SELECT * FROM improvement_tickets ${where} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...values, limit)
    .map(mapImprovementTicket);
}

export function upsertWorkItem(input: {
  id?: string;
  title: string;
  sourceKind: PersonalOpsSourceKind;
  sourceProvider: WorkItem['sourceProvider'];
  sourceRecordKey?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  dueDate?: string | null;
  priority?: PersonalOpsPriority;
  status?: WorkItem['status'];
  confidence?: number | null;
  needsReview?: boolean;
  linkedContactIds?: string[];
  openLoopState?: WorkItem['openLoopState'];
  notes?: string;
}): WorkItem {
  const existing = input.id
    ? (ensureDb()
        .prepare(`SELECT * FROM work_items WHERE id = ?`)
        .get(input.id) as any)
    : null;
  const now = new Date().toISOString();
  const id = existing?.id || input.id || `work_${randomUUID()}`;
  ensureDb()
    .prepare(
      `INSERT INTO work_items (
        id, title, source_kind, source_provider, source_record_key, client_id, project_id,
        due_date, priority, status, confidence, needs_review, linked_contact_ids, open_loop_state,
        notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        source_kind = excluded.source_kind,
        source_provider = excluded.source_provider,
        source_record_key = excluded.source_record_key,
        client_id = excluded.client_id,
        project_id = excluded.project_id,
        due_date = excluded.due_date,
        priority = excluded.priority,
        status = excluded.status,
        confidence = excluded.confidence,
        needs_review = excluded.needs_review,
        linked_contact_ids = excluded.linked_contact_ids,
        open_loop_state = excluded.open_loop_state,
        notes = excluded.notes,
        updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.title,
      input.sourceKind,
      input.sourceProvider,
      input.sourceRecordKey ?? existing?.source_record_key ?? null,
      input.clientId ?? existing?.client_id ?? null,
      input.projectId ?? existing?.project_id ?? null,
      input.dueDate ?? existing?.due_date ?? null,
      input.priority || existing?.priority || 'medium',
      input.status || existing?.status || 'open',
      input.confidence ?? existing?.confidence ?? null,
      input.needsReview === undefined
        ? (existing?.needs_review ?? 0)
        : input.needsReview
          ? 1
          : 0,
      JSON.stringify(
        input.linkedContactIds ??
          parseJson<string[]>(existing?.linked_contact_ids, []),
      ),
      input.openLoopState ?? existing?.open_loop_state ?? 'action',
      input.notes || existing?.notes || '',
      existing?.created_at || now,
      now,
    );
  return getWorkItem(id)!;
}

export function getWorkItem(id: string): WorkItem | undefined {
  const row = ensureDb()
    .prepare(`SELECT * FROM work_items WHERE id = ?`)
    .get(id);
  return row ? mapWorkItem(row) : undefined;
}

export function listWorkItems(filters?: {
  status?: WorkItem['status'];
  clientId?: string | null;
  projectId?: string | null;
  dueBefore?: string;
  dueAfter?: string;
  limit?: number;
}): WorkItem[] {
  const clauses: string[] = [];
  const values: Array<string | number | null> = [];
  if (filters?.status) {
    clauses.push(`status = ?`);
    values.push(filters.status);
  }
  if (filters?.clientId !== undefined) {
    clauses.push(`client_id ${filters.clientId ? '= ?' : 'IS NULL'}`);
    if (filters.clientId) values.push(filters.clientId);
  }
  if (filters?.projectId !== undefined) {
    clauses.push(`project_id ${filters.projectId ? '= ?' : 'IS NULL'}`);
    if (filters.projectId) values.push(filters.projectId);
  }
  if (filters?.dueBefore) {
    clauses.push(`COALESCE(due_date, '') <= ?`);
    values.push(filters.dueBefore);
  }
  if (filters?.dueAfter) {
    clauses.push(`COALESCE(due_date, '') >= ?`);
    values.push(filters.dueAfter);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters?.limit ?? 200;
  return ensureDb()
    .prepare(
      `SELECT * FROM work_items ${where} ORDER BY COALESCE(due_date, updated_at) ASC LIMIT ?`,
    )
    .all(...values, limit)
    .map(mapWorkItem);
}

export function addActivity(
  input: Omit<Activity, 'id'> & { id?: string },
): Activity {
  const id = input.id || `activity_${randomUUID()}`;
  ensureDb()
    .prepare(
      `INSERT OR REPLACE INTO activities (
        id, timestamp, type, source_provider, source_kind, source_record_key,
        related_client_id, related_project_id, summary, raw_reference, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.timestamp,
      input.type,
      input.sourceProvider,
      input.sourceKind,
      input.sourceRecordKey ?? null,
      input.relatedClientId ?? null,
      input.relatedProjectId ?? null,
      input.summary,
      input.rawReference ?? null,
      JSON.stringify(input.metadata ?? {}),
    );
  return getActivity(id)!;
}

export function getActivity(id: string): Activity | undefined {
  const row = ensureDb()
    .prepare(`SELECT * FROM activities WHERE id = ?`)
    .get(id);
  return row ? mapActivity(row) : undefined;
}

export function listActivities(filters?: {
  since?: string;
  until?: string;
  clientId?: string | null;
  projectId?: string | null;
  limit?: number;
}): Activity[] {
  const clauses: string[] = [];
  const values: Array<string | number | null> = [];
  if (filters?.since) {
    clauses.push(`timestamp >= ?`);
    values.push(filters.since);
  }
  if (filters?.until) {
    clauses.push(`timestamp <= ?`);
    values.push(filters.until);
  }
  if (filters?.clientId !== undefined) {
    clauses.push(`related_client_id ${filters.clientId ? '= ?' : 'IS NULL'}`);
    if (filters.clientId) values.push(filters.clientId);
  }
  if (filters?.projectId !== undefined) {
    clauses.push(`related_project_id ${filters.projectId ? '= ?' : 'IS NULL'}`);
    if (filters.projectId) values.push(filters.projectId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters?.limit ?? 200;
  return ensureDb()
    .prepare(
      `SELECT * FROM activities ${where} ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(...values, limit)
    .map(mapActivity);
}

export function addReportSnapshot(
  input: Omit<ReportSnapshot, 'id'> & { id?: string },
): ReportSnapshot {
  const id = input.id || `report_${randomUUID()}`;
  ensureDb()
    .prepare(
      `INSERT OR REPLACE INTO report_snapshots (
        id, report_type, generated_at, range_start, range_end, grouped_output,
        source_references, model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.reportType,
      input.generatedAt,
      input.rangeStart,
      input.rangeEnd,
      input.groupedOutput,
      JSON.stringify(input.sourceReferences),
      input.model,
    );
  return getReportSnapshot(id)!;
}

export function getReportSnapshot(id: string): ReportSnapshot | undefined {
  const row = ensureDb()
    .prepare(`SELECT * FROM report_snapshots WHERE id = ?`)
    .get(id);
  return row ? mapReport(row) : undefined;
}

export function getLatestReportSnapshot(
  reportType: PersonalOpsReportType,
): ReportSnapshot | undefined {
  const row = ensureDb()
    .prepare(
      `SELECT * FROM report_snapshots WHERE report_type = ? ORDER BY generated_at DESC LIMIT 1`,
    )
    .get(reportType);
  return row ? mapReport(row) : undefined;
}

export function listReportSnapshots(
  reportType?: PersonalOpsReportType,
  limit = 20,
): ReportSnapshot[] {
  if (reportType) {
    return ensureDb()
      .prepare(
        `SELECT * FROM report_snapshots WHERE report_type = ? ORDER BY generated_at DESC LIMIT ?`,
      )
      .all(reportType, limit)
      .map(mapReport);
  }
  return ensureDb()
    .prepare(
      `SELECT * FROM report_snapshots ORDER BY generated_at DESC LIMIT ?`,
    )
    .all(limit)
    .map(mapReport);
}

export function upsertApprovalQueueItem(input: {
  id?: string;
  dedupeKey: string;
  kind: PersonalOpsApprovalActionKind;
  status?: PersonalOpsApprovalStatus;
  title: string;
  summary: string;
  body: string;
  reason: string;
  confidence?: number | null;
  clientId?: string | null;
  projectId?: string | null;
  sourceRecordKey?: string | null;
  workItemId?: string | null;
  reportType?: PersonalOpsReportType | null;
  linkedContactIds?: string[];
  evidence?: string[];
  artifactRef?: string | null;
  resolvedAt?: string | null;
}): ApprovalQueueItem {
  const existing = ensureDb()
    .prepare(`SELECT * FROM approval_queue_items WHERE dedupe_key = ? LIMIT 1`)
    .get(input.dedupeKey) as any;
  const now = new Date().toISOString();
  const id = existing?.id || input.id || `approval_${randomUUID()}`;
  ensureDb()
    .prepare(
      `INSERT INTO approval_queue_items (
        id, dedupe_key, kind, status, title, summary, body, reason, confidence,
        client_id, project_id, source_record_key, work_item_id, report_type,
        linked_contact_ids, evidence, artifact_ref, created_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dedupe_key = excluded.dedupe_key,
        kind = excluded.kind,
        status = excluded.status,
        title = excluded.title,
        summary = excluded.summary,
        body = excluded.body,
        reason = excluded.reason,
        confidence = excluded.confidence,
        client_id = excluded.client_id,
        project_id = excluded.project_id,
        source_record_key = excluded.source_record_key,
        work_item_id = excluded.work_item_id,
        report_type = excluded.report_type,
        linked_contact_ids = excluded.linked_contact_ids,
        evidence = excluded.evidence,
        artifact_ref = excluded.artifact_ref,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at`,
    )
    .run(
      id,
      input.dedupeKey,
      input.kind,
      input.status ?? existing?.status ?? 'pending',
      input.title,
      input.summary,
      input.body,
      input.reason,
      input.confidence ?? existing?.confidence ?? null,
      input.clientId ?? existing?.client_id ?? null,
      input.projectId ?? existing?.project_id ?? null,
      input.sourceRecordKey ?? existing?.source_record_key ?? null,
      input.workItemId ?? existing?.work_item_id ?? null,
      input.reportType ?? existing?.report_type ?? null,
      JSON.stringify(
        input.linkedContactIds ??
          parseJson<string[]>(existing?.linked_contact_ids, []),
      ),
      JSON.stringify(
        input.evidence ?? parseJson<string[]>(existing?.evidence, []),
      ),
      input.artifactRef ?? existing?.artifact_ref ?? null,
      existing?.created_at || now,
      now,
      input.resolvedAt ?? existing?.resolved_at ?? null,
    );
  return getApprovalQueueItem(id)!;
}

export function getApprovalQueueItem(
  id: string,
): ApprovalQueueItem | undefined {
  const row = ensureDb()
    .prepare(`SELECT * FROM approval_queue_items WHERE id = ?`)
    .get(id);
  return row ? mapApprovalQueueItem(row) : undefined;
}

export function listApprovalQueueItems(filters?: {
  status?: PersonalOpsApprovalStatus;
  sourceRecordKey?: string;
  limit?: number;
}): ApprovalQueueItem[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (filters?.status) {
    clauses.push(`status = ?`);
    values.push(filters.status);
  }
  if (filters?.sourceRecordKey) {
    clauses.push(`source_record_key = ?`);
    values.push(filters.sourceRecordKey);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters?.limit ?? 300;
  return ensureDb()
    .prepare(
      `SELECT * FROM approval_queue_items ${where} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...values, limit)
    .map(mapApprovalQueueItem);
}

export function addCorrection(
  input: Omit<Correction, 'id' | 'createdAt'>,
): Correction {
  const id = `correction_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  ensureDb()
    .prepare(
      `INSERT INTO corrections (id, target_type, target_id, field, value, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.targetType,
      input.targetId,
      input.field,
      input.value,
      createdAt,
    );
  return getCorrection(id)!;
}

export function getCorrection(id: string): Correction | undefined {
  const row = ensureDb()
    .prepare(`SELECT * FROM corrections WHERE id = ?`)
    .get(id);
  return row ? mapCorrection(row) : undefined;
}

export function listCorrections(limit = 100): Correction[] {
  return ensureDb()
    .prepare(`SELECT * FROM corrections ORDER BY created_at DESC LIMIT ?`)
    .all(limit)
    .map(mapCorrection);
}

export function setPreference(key: string, value: string): void {
  ensureDb()
    .prepare(
      `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, new Date().toISOString());
}

export function getPreference(key: string): PersonalOpsPreference | undefined {
  const row = ensureDb()
    .prepare(`SELECT * FROM preferences WHERE key = ?`)
    .get(key) as any;
  if (!row) return undefined;
  return {
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at,
  };
}

export function listPreferences(): PersonalOpsPreference[] {
  return ensureDb()
    .prepare(`SELECT * FROM preferences ORDER BY key`)
    .all()
    .map((row: any) => ({
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at,
    }));
}

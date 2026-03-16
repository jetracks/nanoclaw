import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  PERSONAL_OPS_PUBLIC_DIR,
  PERSONAL_OPS_PUSH_MAIN_CHAT,
  PERSONAL_OPS_STORE_DIR,
  TIMEZONE,
} from '../config.js';
import { logger } from '../logger.js';
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
  OpenLoop,
  OperatorProfile,
  PersonalOpsAttributionDiagnostic,
  PersonalOpsApprovalActionKind,
  PersonalOpsContactImportance,
  PersonalOpsConnectionCatalog,
  PersonalOpsConnectionSettings,
  PersonalOpsImprovementStatus,
  PersonalOpsOpenLoopState,
  PersonalOpsPriority,
  PersonalOpsProvider,
  PersonalOpsQuestionStatus,
  PersonalOpsQuestionSurface,
  PersonalOpsQuestionTargetType,
  PersonalOpsQuestionUrgency,
  PersonalOpsReportType,
  PersonalOpsSuggestionStatus,
  PersonalOpsWorkstream,
  PersonalOpsWorkstreamLink,
  Project,
  ReviewQueueItem,
  SourceRecord,
  SyncJobState,
  ThreadState,
  WorkItem,
} from '../types.js';
import { draftOperationalReport, suggestSourceClassification } from './ai.js';
import type {
  SourceClassificationClientContext,
  SourceClassificationContactContext,
  SourceClassificationConnectionContext,
  SourceClassificationOperatorContext,
  SourceClassificationProjectContext,
} from './ai.js';
import {
  addActivity,
  addCorrection,
  addOAuthState,
  listApprovalQueueItems,
  listAssistantQuestions,
  listAccountScopedContactHints,
  addReportSnapshot,
  ConnectedAccountRecord,
  consumeOAuthState,
  disconnectConnectedAccount,
  findContactIdentity,
  getConnectionKey,
  getConnectedAccountRecord,
  getAssistantQuestion,
  getContact,
  getLatestReportSnapshot,
  getPreference,
  getProject,
  getSourceRecord,
  getSourceRecordKey,
  getSyncJob,
  getWorkItem,
  initPersonalOpsDatabase,
  listActivities,
  listClients,
  listConnectedAccounts,
  listContactIdentities,
  listContactMappingSuggestions,
  listContacts,
  listCorrections,
  listImprovementTickets,
  listMemoryFacts,
  listPreferences,
  listProjects,
  listRepositories,
  listReportSnapshots,
  listSourceRecords,
  listSyncJobs,
  listWorkItems,
  parseSourceRecordKey,
  setPreference,
  upsertApprovalQueueItem,
  upsertAssistantQuestion,
  upsertAccountScopedContactHint,
  upsertContact,
  upsertContactIdentity,
  upsertContactMappingSuggestion,
  upsertClient,
  upsertConnectedAccount,
  upsertImprovementTicket,
  upsertMemoryFact,
  upsertProject,
  upsertRepository,
  upsertSourceRecord,
  upsertSyncJob,
  upsertWorkItem,
} from './db.js';
import {
  buildAuthorizeUrl,
  buildOAuthRedirectUri,
  createPkcePair,
  exchangeAuthCode,
  refreshAccessToken,
} from './oauth.js';
import {
  fetchProviderConnectionCatalog,
  fetchProviderIdentity,
  providerRawSnapshotPath,
  syncProviderData,
} from './providers.js';
import { loadPersonalOpsSecrets } from './secrets.js';

const CONNECTED_PROVIDERS: PersonalOpsProvider[] = ['google', 'microsoft', 'jira', 'slack'];
const SYNC_INTERVAL_MS: Record<PersonalOpsProvider, Partial<Record<SourceRecord['kind'], number>>> = {
  google: { email: 5 * 60_000, calendar_event: 15 * 60_000 },
  microsoft: { email: 5 * 60_000, calendar_event: 15 * 60_000 },
  jira: { jira_issue: 10 * 60_000 },
  slack: { slack_message: 5 * 60_000 },
};
const SKIPPED_DISCOVERY_DIRS = new Set([
  '.git',
  'Library',
  'Applications',
  'Movies',
  'Music',
  'Pictures',
  'Public',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.Trash',
  '.npm',
  '.pnpm-store',
  '.yarn',
  '.gradle',
  '.cargo',
  '.rustup',
  '.android',
  '.vscode',
  '.idea',
  '__pycache__',
  '.venv',
  'venv',
]);

const OPERATOR_PROFILE_PREFERENCE_KEY = 'operator_profile';
const SOURCE_IGNORE_RULES_PREFERENCE_KEY = 'source_ignore_rules';
const DEFAULT_OPERATOR_PROFILE: Omit<OperatorProfile, 'updatedAt'> = {
  roleSummary:
    'Jerry is a multi-client operator, CTO, developer, and COO depending on the client relationship. Prioritize work that materially affects commitments, operations, delivery, or stakeholder communication.',
  workHoursStart: 6,
  workHoursEnd: 22,
  reportingPreferences:
    'Prefer concise, evidence-backed internal summaries that group work by client and project and distinguish awareness from action.',
  escalationPreferences:
    'Escalate operational risk, direct asks, blockers, pricing changes, MAP violations, outages, and issues likely to affect client commitments or executive decision-making.',
  assistantStyle:
    'Reduce noise, preserve traceability, and surface what Jerry actually needs to do next.',
  clientOperatingPosture:
    'Default to account-aware reasoning for shared services and mixed-use tools. Prefer client-level attribution unless there is strong project-specific evidence.',
};

type AssistantQuestionCandidate = {
  dedupeKey: string;
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
};

type SourceIgnoreRule = {
  id: string;
  provider: SourceRecord['provider'];
  accountId: string | null;
  kind: SourceRecord['kind'];
  senderAddress: string | null;
  subjectSignature: string;
  sampleTitle: string;
  createdAt: string;
};

function startOfDay(date = new Date()): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date = new Date()): Date {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function plusDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US', { timeZone: TIMEZONE });
}

function looksActionable(
  text: string,
  input?: {
    directness?: 'direct' | 'mentioned' | 'shared' | 'ambient';
    automated?: boolean;
  },
): boolean {
  const lower = text.toLowerCase();
  if (
    /\b(please review|please approve|please confirm|please respond|please advise|follow up|can you|could you|would you|need you to|needs your approval|needs your review)\b/i.test(
      lower,
    )
  ) {
    return true;
  }
  if (
    (input?.directness === 'direct' || input?.directness === 'mentioned') &&
    /\b(please|review|approve|confirm|reply|respond|send|update|let me know)\b/i.test(lower)
  ) {
    return true;
  }
  if (!input?.automated && /\b(action required|needs action)\b/i.test(lower)) {
    return true;
  }
  if (
    (input?.directness === 'direct' || input?.directness === 'mentioned') &&
    /\bneed(?:s)? (?:you|jerry)? ?to\b/i.test(lower)
  ) {
    return true;
  }
  return lower.includes('todo');
}

function clampPriority(priority: string | null | undefined): PersonalOpsPriority {
  if (priority === 'low' || priority === 'medium' || priority === 'high' || priority === 'urgent') {
    return priority;
  }
  const lower = (priority || '').toLowerCase();
  if (lower.includes('highest') || lower.includes('urgent') || lower.includes('blocker')) {
    return 'urgent';
  }
  if (lower.includes('high')) return 'high';
  if (lower.includes('low')) return 'low';
  return 'medium';
}

function normalizeList(value: string[] | undefined): string[] | undefined {
  const normalized = (value || []).map((entry) => entry.trim()).filter(Boolean);
  return normalized.length ? normalized : undefined;
}

function latestIso(...values: Array<string | null | undefined>): string | null {
  const valid = values
    .filter((value): value is string => Boolean(value))
    .filter((value) => !Number.isNaN(new Date(value).getTime()))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
  return valid[0] || null;
}

function earliestFutureIso(...values: Array<string | null | undefined>): string | null {
  const now = Date.now();
  const valid = values
    .filter((value): value is string => Boolean(value))
    .filter((value) => {
      const time = new Date(value).getTime();
      return !Number.isNaN(time) && time >= now;
    })
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  return valid[0] || null;
}

function sourceNeedsAttention(source: SourceRecord): boolean {
  const attention = sourceAttention(source);
  return attention.actionRequired || attention.operationalRisk || attention.reportWorthy;
}

function sourceWorkItemStatusOverride(source: SourceRecord): WorkItem['status'] | null {
  const value = sourceMetadataString(source, 'workItemStatusOverride');
  if (
    value === 'open' ||
    value === 'in_progress' ||
    value === 'blocked' ||
    value === 'waiting' ||
    value === 'done' ||
    value === 'on_hold' ||
    value === 'ignored'
  ) {
    return value;
  }
  return null;
}

function workItemStateFromStatus(status: WorkItem['status']): PersonalOpsOpenLoopState {
  if (status === 'done' || status === 'ignored') return 'closed';
  if (status === 'blocked') return 'blocked';
  if (status === 'waiting' || status === 'on_hold') return 'waiting';
  return 'action';
}

function normalizeIdentityValue(value: string): string {
  return value.trim().toLowerCase();
}

function operatorProfileFallback(): OperatorProfile {
  return {
    ...DEFAULT_OPERATOR_PROFILE,
    updatedAt: new Date(0).toISOString(),
  };
}

function parseJsonPreference<T>(key: string, fallback: T): T {
  const pref = getPreference(key);
  if (!pref?.value) return fallback;
  try {
    return JSON.parse(pref.value) as T;
  } catch {
    return fallback;
  }
}

function extractIssueKeys(...values: Array<string | null | undefined>): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const match of value.toUpperCase().matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)) {
      keys.add(match[0]);
    }
  }
  return [...keys];
}

function buildClassificationFingerprint(source: SourceRecord): string {
  return JSON.stringify({
    provider: source.provider,
    accountId: source.accountId || null,
    kind: source.kind,
    externalId: source.externalId,
    externalParentId: source.externalParentId || null,
    title: source.title,
    summary: source.summary,
    body: source.body,
    participants: [...source.participants].sort(),
    dueAt: source.dueAt || null,
    status: source.status || null,
  });
}

function normalizeConnectionSettings(
  settings: PersonalOpsConnectionSettings | undefined,
): PersonalOpsConnectionSettings {
  if (!settings) {
    return {};
  }
  const normalized: PersonalOpsConnectionSettings = {};
  const defaultClientId = settings.defaultClientId?.trim();
  const defaultProjectId = settings.defaultProjectId?.trim();
  const preferClientOnlyMapping = settings.preferClientOnlyMapping === true;
  const triageGuidance = settings.triageGuidance?.trim();
  const googleMailQuery = settings.googleMailQuery?.trim();
  const jiraJql = settings.jiraJql?.trim();
  if (defaultClientId) normalized.defaultClientId = defaultClientId;
  if (defaultProjectId) normalized.defaultProjectId = defaultProjectId;
  if (preferClientOnlyMapping) normalized.preferClientOnlyMapping = true;
  if (triageGuidance) normalized.triageGuidance = triageGuidance;
  if (googleMailQuery) normalized.googleMailQuery = googleMailQuery;
  if (jiraJql) normalized.jiraJql = jiraJql;
  const googleCalendarIds = normalizeList(settings.googleCalendarIds);
  const microsoftMailFolderIds = normalizeList(settings.microsoftMailFolderIds);
  const microsoftCalendarIds = normalizeList(settings.microsoftCalendarIds);
  const jiraProjectKeys = normalizeList(settings.jiraProjectKeys)?.map((key) =>
    key.toUpperCase(),
  );
  const slackIncludedChannelIds = normalizeList(settings.slackIncludedChannelIds);
  const slackExcludedChannelIds = normalizeList(settings.slackExcludedChannelIds);
  if (googleCalendarIds) normalized.googleCalendarIds = googleCalendarIds;
  if (microsoftMailFolderIds) {
    normalized.microsoftMailFolderIds = microsoftMailFolderIds;
  }
  if (microsoftCalendarIds) {
    normalized.microsoftCalendarIds = microsoftCalendarIds;
  }
  if (jiraProjectKeys) normalized.jiraProjectKeys = jiraProjectKeys;
  if (slackIncludedChannelIds) {
    normalized.slackIncludedChannelIds = slackIncludedChannelIds;
  }
  if (slackExcludedChannelIds) {
    normalized.slackExcludedChannelIds = slackExcludedChannelIds;
  }
  return normalized;
}

function normalizeMatchText(value: string | null | undefined): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function extractEmails(value: string): string[] {
  return Array.from(
    value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi),
    (match) => match[0].toLowerCase(),
  );
}

function extractDomains(values: string[]): string[] {
  const domains = new Set<string>();
  for (const value of values) {
    for (const email of extractEmails(value)) {
      const domain = email.split('@')[1];
      if (domain) {
        domains.add(domain.toLowerCase());
      }
    }
  }
  return [...domains];
}

function extractExplicitDomains(value: string | null | undefined): string[] {
  return extractEmails(value || '').map((email) => email.split('@')[1]).filter(Boolean) as string[];
}

const SHARED_ALIAS_LOCAL_PARTS = new Set([
  'amazon',
  'accounting',
  'admin',
  'ap',
  'ar',
  'billing',
  'buyers',
  'buying',
  'customerservice',
  'estaff',
  'finance',
  'flashsales',
  'help',
  'hr',
  'info',
  'inventory',
  'marketplace',
  'marketing',
  'merchandising',
  'operations',
  'ops',
  'orders',
  'purchasing',
  'rx',
  'sales',
  'service',
  'support',
  'team',
  'warehouse',
]);

function sourceParticipantEmails(source: SourceRecord): string[] {
  const emails = new Set<string>();
  for (const participant of source.participants) {
    for (const email of extractEmails(participant)) {
      emails.add(email.toLowerCase());
    }
  }
  return [...emails];
}

function accountMailboxEmail(source: SourceRecord): string | null {
  const fromLabel = extractEmails(source.accountLabel || '')[0];
  if (fromLabel) return fromLabel.toLowerCase();
  const fromId = extractEmails(source.accountId || '')[0];
  return fromId ? fromId.toLowerCase() : null;
}

function sourceSenderAddress(source: SourceRecord): string | null {
  const senderAddress =
    sourceMetadataString(source, 'senderAddress') || sourceMetadataString(source, 'fromAddress');
  if (senderAddress) {
    return senderAddress.toLowerCase();
  }
  return sourceParticipantEmails(source)[0] || null;
}

function sourceExplicitToRecipientEmails(source: SourceRecord): string[] {
  return sourceMetadataStringArray(source, 'toRecipientAddresses')
    .map((value) => value.toLowerCase())
    .filter(Boolean);
}

function sourceExplicitCcRecipientEmails(source: SourceRecord): string[] {
  return sourceMetadataStringArray(source, 'ccRecipientAddresses')
    .map((value) => value.toLowerCase())
    .filter(Boolean);
}

function sourceExplicitBccRecipientEmails(source: SourceRecord): string[] {
  return sourceMetadataStringArray(source, 'bccRecipientAddresses')
    .map((value) => value.toLowerCase())
    .filter(Boolean);
}

function sourceExplicitRecipientEmails(source: SourceRecord): string[] {
  const metadataRecipients = [
    ...sourceExplicitToRecipientEmails(source),
    ...sourceExplicitCcRecipientEmails(source),
    ...sourceExplicitBccRecipientEmails(source),
  ].filter(Boolean);
  if (metadataRecipients.length) {
    return [...new Set(metadataRecipients)];
  }
  const senderAddress = sourceMetadataString(source, 'fromAddress')?.toLowerCase() || null;
  return sourceParticipantEmails(source).filter((email) => email !== senderAddress);
}

function normalizeIgnoredSubjectSignature(value: string): string {
  return value
    .toLowerCase()
    .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/g, '')
    .replace(/\b(?:case|ticket|order|po)\s*#?\s*[a-z0-9-]+\b/g, '$1')
    .replace(/\$?\d+(?:[.,]\d+)?%?/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function preservedSourceMetadata(existing?: SourceRecord): Record<string, unknown> {
  const metadata = existing?.metadata || {};
  const preserved: Record<string, unknown> = {};
  for (const key of [
    'workItemStatusOverride',
    'likelyNoise',
    'ignoredPatternRuleId',
    'reviewState',
  ] as const) {
    if (metadata[key] !== undefined) {
      preserved[key] = metadata[key];
    }
  }
  return preserved;
}

function listSourceIgnoreRules(): SourceIgnoreRule[] {
  return parseJsonPreference<SourceIgnoreRule[]>(SOURCE_IGNORE_RULES_PREFERENCE_KEY, []).filter(
    (rule) =>
      Boolean(rule?.id) &&
      Boolean(rule?.provider) &&
      Boolean(rule?.kind) &&
      typeof rule?.subjectSignature === 'string',
  );
}

function saveSourceIgnoreRules(rules: SourceIgnoreRule[]): void {
  setPreference(SOURCE_IGNORE_RULES_PREFERENCE_KEY, JSON.stringify(rules));
}

function buildSourceIgnoreRule(source: SourceRecord): SourceIgnoreRule | null {
  if (source.kind !== 'email') return null;
  const subjectSignature = normalizeIgnoredSubjectSignature(source.title || source.summary || '');
  const senderAddress = sourceSenderAddress(source);
  if (!subjectSignature) return null;
  return {
    id: `ignore_${randomUUID()}`,
    provider: source.provider,
    accountId: source.accountId ?? null,
    kind: source.kind,
    senderAddress,
    subjectSignature,
    sampleTitle: source.title,
    createdAt: new Date().toISOString(),
  };
}

function sourceMatchesIgnoreRule(source: SourceRecord, rule: SourceIgnoreRule): boolean {
  if (rule.provider !== source.provider) return false;
  if ((rule.accountId || null) !== (source.accountId || null)) return false;
  if (rule.kind !== source.kind) return false;
  if (rule.senderAddress && rule.senderAddress !== sourceSenderAddress(source)) return false;
  return normalizeIgnoredSubjectSignature(source.title || source.summary || '') === rule.subjectSignature;
}

function applySourceIgnoreRule(source: SourceRecord, rule: SourceIgnoreRule): void {
  const existingAttention = source.attention || sourceAttention(source);
  source.status = 'filtered';
  source.attention = {
    ...existingAttention,
    awarenessOnly: false,
    actionRequired: false,
    operationalRisk: false,
    reportWorthy: false,
    importanceReason: 'Ignored similar message pattern',
  };
  source.metadata = {
    ...(source.metadata || {}),
    likelyNoise: true,
    ignoredPatternRuleId: rule.id,
    attention: source.attention,
    modelActionRequired: false,
    modelOperationalRisk: false,
  };
}

function isSharedAliasLocalPart(localPart: string): boolean {
  return SHARED_ALIAS_LOCAL_PARTS.has(
    localPart.toLowerCase().replace(/[^a-z0-9]+/g, ''),
  );
}

function isSharedAliasMailboxTrafficWithoutAccountRecipient(source: SourceRecord): boolean {
  if (source.kind !== 'email') return false;
  const accountEmail = accountMailboxEmail(source);
  if (!accountEmail) return false;
  const participantEmails = sourceParticipantEmails(source);
  const recipientEmails = sourceExplicitRecipientEmails(source);
  if (recipientEmails.includes(accountEmail)) return false;
  const accountDomain = accountEmail.split('@')[1];
  if (!accountDomain) return false;
  return participantEmails.some((email) => {
    const [localPart, domain] = email.split('@');
    return domain === accountDomain && isSharedAliasLocalPart(localPart || '');
  });
}

function isInternalDistributionTrafficWithoutAccountRecipient(source: SourceRecord): boolean {
  if (source.kind !== 'email') return false;
  const accountEmail = accountMailboxEmail(source);
  if (!accountEmail) return false;
  const recipientEmails = sourceExplicitRecipientEmails(source);
  if (!recipientEmails.length || recipientEmails.includes(accountEmail)) return false;
  const accountDomain = accountEmail.split('@')[1];
  if (!accountDomain) return false;
  return recipientEmails.some((email) => {
    const [localPart, domain] = email.split('@');
    if (!localPart || domain !== accountDomain || email === accountEmail) return false;
    return isSharedAliasLocalPart(localPart) || recipientEmails.length > 1;
  });
}

function emailDirectnessForAccount(
  source: SourceRecord,
): 'direct' | 'mentioned' | 'shared' | 'ambient' | null {
  if (source.kind !== 'email') return null;
  const accountEmail = accountMailboxEmail(source);
  if (!accountEmail) return null;
  if (sourceExplicitToRecipientEmails(source).includes(accountEmail)) return 'direct';
  if (
    sourceExplicitCcRecipientEmails(source).includes(accountEmail) ||
    sourceExplicitBccRecipientEmails(source).includes(accountEmail)
  ) {
    return 'mentioned';
  }
  if (sourceMetadataBoolean(source, 'mentionsSelf')) return 'mentioned';
  const recipientEmails = sourceExplicitRecipientEmails(source);
  if (!recipientEmails.length) return null;
  if (
    isSharedAliasMailboxTrafficWithoutAccountRecipient(source) ||
    isHelpdeskSupportTrafficWithoutAccountRecipient(source) ||
    isInternalDistributionTrafficWithoutAccountRecipient(source)
  ) {
    return 'shared';
  }
  return 'ambient';
}

function repositoryAliases(repository: GitRepository): string[] {
  const aliases = new Set<string>();
  const add = (value: string | null | undefined) => {
    const cleaned = value?.trim();
    if (cleaned && cleaned.length >= 3) {
      aliases.add(cleaned.toLowerCase());
    }
  };
  add(repository.name);
  add(path.basename(repository.localPath));
  if (repository.remoteUrl) {
    const match = repository.remoteUrl.match(/\/([^/]+?)(?:\.git)?$/i) ||
      repository.remoteUrl.match(/:([^/]+?)(?:\.git)?$/i);
    add(match?.[1]);
  }
  return [...aliases];
}

function collectSourceSignals(source: SourceRecord): {
  fields: string[];
  haystack: string;
  normalizedHaystack: string;
  domains: string[];
} {
  const metadata = source.metadata || {};
  const fields = [
    source.title,
    source.summary,
    source.body,
    source.sourceUrl || '',
    source.accountLabel || '',
    source.accountId || '',
    ...source.participants,
    typeof metadata.channelLabel === 'string' ? metadata.channelLabel : '',
    typeof metadata.calendarLabel === 'string' ? metadata.calendarLabel : '',
    typeof metadata.mailFolderLabel === 'string' ? metadata.mailFolderLabel : '',
    typeof metadata.projectKey === 'string' ? metadata.projectKey : '',
    typeof metadata.projectName === 'string' ? metadata.projectName : '',
  ].filter(Boolean);
  const haystack = fields.join('\n').toLowerCase();
  return {
    fields,
    haystack,
    normalizedHaystack: normalizeMatchText(haystack),
    domains: extractDomains(fields),
  };
}

function includesAlias(
  haystack: string,
  normalizedHaystack: string,
  alias: string,
): boolean {
  const trimmed = alias.trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed.length >= 4 && haystack.includes(trimmed)) return true;
  const normalizedAlias = normalizeMatchText(trimmed);
  return normalizedAlias.length >= 5 && normalizedHaystack.includes(normalizedAlias);
}

function attributionConfidence(score: number): number {
  return Math.min(0.95, Math.max(0.68, 0.55 + score * 0.04));
}

function createAttributionDiagnostic(
  kind: PersonalOpsAttributionDiagnostic['kind'],
  detail?: string | null,
): PersonalOpsAttributionDiagnostic {
  if (kind === 'connection_default') {
    return { kind, label: 'Connection default', detail: detail || null };
  }
  if (kind === 'domain_match') {
    return { kind, label: 'Domain match', detail: detail || null };
  }
  if (kind === 'workspace_match') {
    return { kind, label: 'Workspace/account match', detail: detail || null };
  }
  if (kind === 'jira_key') {
    return { kind, label: 'Jira key', detail: detail || null };
  }
  if (kind === 'repo_alias') {
    return { kind, label: 'Repo alias', detail: detail || null };
  }
  if (kind === 'project_match') {
    return { kind, label: 'Project match', detail: detail || null };
  }
  if (kind === 'client_match') {
    return { kind, label: 'Client match', detail: detail || null };
  }
  return { kind, label: 'Single active project', detail: detail || null };
}

function appendAttributionDiagnostic(
  diagnostics: PersonalOpsAttributionDiagnostic[],
  diagnostic: PersonalOpsAttributionDiagnostic,
): void {
  const exists = diagnostics.some(
    (entry) => entry.kind === diagnostic.kind && entry.detail === diagnostic.detail,
  );
  if (!exists) {
    diagnostics.push(diagnostic);
  }
}

function workItemStatusFromSource(source: SourceRecord): WorkItem['status'] {
  const status = (source.status || '').toLowerCase();
  if (status.includes('done') || status.includes('closed') || status.includes('resolved')) {
    return 'done';
  }
  if (status.includes('progress')) return 'in_progress';
  if (status.includes('block')) return 'blocked';
  if (status.includes('wait')) return 'waiting';
  if (status.includes('hold')) return 'on_hold';
  return 'open';
}

function chooseSourceWindow(job: SyncJobState | undefined): string {
  if (job?.cursor) {
    const overlap = new Date(job.cursor);
    overlap.setHours(overlap.getHours() - 12);
    return overlap.toISOString();
  }
  return plusDays(new Date(), -30).toISOString();
}

function sanitizeSourceRef(source: SourceRecord): string {
  return getSourceRecordKey(
    source.provider,
    source.accountId ?? null,
    source.kind,
    source.externalId,
  );
}

function sourceMetadataBoolean(source: SourceRecord, key: string): boolean {
  return source.metadata?.[key] === true;
}

function sourceMetadataString(source: SourceRecord, key: string): string | null {
  const value = source.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sourceMetadataStringArray(source: SourceRecord, key: string): string[] {
  const value = source.metadata?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    : [];
}

function isEmailAccountScopedLearningSource(source: SourceRecord): boolean {
  return source.kind === 'email' && Boolean(source.accountId) && source.provider !== 'manual';
}

function sourceIdentityValues(source: SourceRecord): string[] {
  const values = new Set<string>();
  for (const participant of source.participants) {
    for (const email of extractEmails(participant)) {
      values.add(normalizeIdentityValue(email));
    }
    const slackId = participant.match(/<@([A-Z0-9_]+)>/i)?.[1];
    if (slackId) {
      values.add(slackId);
    }
  }
  return [...values];
}

function accountScopedHintDedupeKey(input: {
  contactId: string;
  provider: PersonalOpsProvider;
  accountId: string;
  identityValue: string;
  clientId?: string | null;
  projectId?: string | null;
  basis: string;
}): string {
  return [
    input.contactId,
    input.provider,
    input.accountId,
    input.identityValue,
    input.clientId || '',
    input.projectId || '',
    input.basis,
  ].join('::');
}

function sourceAttention(source: SourceRecord): NonNullable<SourceRecord['attention']> {
  const metadata = source.metadata || {};
  const attention =
    (source.attention as Record<string, unknown> | undefined) ||
    (metadata.attention as Record<string, unknown> | undefined);
  const workStatusOverride = sourceWorkItemStatusOverride(source);
  const explicitEmailDirectness = emailDirectnessForAccount(source);
  const directnessValue =
    explicitEmailDirectness ||
    (typeof attention?.directness === 'string'
      ? attention.directness
      : metadata.mentionsSelf === true
        ? 'mentioned'
        : metadata.isDirectMessage === true
          ? 'direct'
          : source.kind === 'slack_message'
            ? 'shared'
            : 'ambient');
  let directness: 'direct' | 'mentioned' | 'shared' | 'ambient' =
    directnessValue === 'direct' ||
    directnessValue === 'mentioned' ||
    directnessValue === 'shared'
      ? directnessValue
      : 'ambient';
  const sharedAliasWithoutAccountRecipient =
    isSharedAliasMailboxTrafficWithoutAccountRecipient(source);
  const helpdeskSupportWithoutAccountRecipient =
    isHelpdeskSupportTrafficWithoutAccountRecipient(source);
  const internalDistributionWithoutAccountRecipient =
    isInternalDistributionTrafficWithoutAccountRecipient(source);
  const text = `${source.title}\n${source.summary}\n${source.body}`;
  const executiveOperationalUpdate = looksExecutiveOperationalUpdate(text);
  const severeExecutiveOperationalAlert = looksSevereExecutiveOperationalAlert(text);
  if (
    isGroupAssignmentWrapperNotification(source) &&
    metadata.mentionsSelf !== true &&
    metadata.isDirectMessage !== true
  ) {
    directness = 'shared';
  }
  if (
    (
      sharedAliasWithoutAccountRecipient ||
      helpdeskSupportWithoutAccountRecipient ||
      internalDistributionWithoutAccountRecipient
    ) &&
    directness !== 'mentioned'
  ) {
    directness = 'shared';
  }
  const priority = clampPriority(
    (typeof attention?.urgency === 'string' ? attention.urgency : source.priority) || 'medium',
  );
  let awarenessOnly =
    typeof attention?.awarenessOnly === 'boolean'
      ? attention.awarenessOnly
      : metadata.modelActionRequired === false;
  const automated =
    source.kind === 'email' &&
    (sourceMetadataBoolean(source, 'automatedSender') || participantLooksAutomated(source));
  let actionRequired =
    typeof attention?.actionRequired === 'boolean'
      ? attention.actionRequired
      : metadata.modelActionRequired === true ||
        looksActionable(text, {
          directness,
          automated,
        });
  let operationalRisk =
    typeof attention?.operationalRisk === 'boolean'
      ? attention.operationalRisk
      : metadata.modelOperationalRisk === true ||
        looksOperationallySensitiveText(text);
  if (awarenessOnly && !operationalRisk) {
    actionRequired = false;
  }
  if (
    actionRequired &&
    !operationalRisk &&
    /\bno action required\b/i.test(`${source.title}\n${source.summary}\n${source.body}`)
  ) {
    actionRequired = false;
    awarenessOnly = false;
  }
  if (
    actionRequired &&
    !operationalRisk &&
    isLikelyRoutineNotificationSource(source, {
      directness,
      automated,
    })
  ) {
    actionRequired = false;
    awarenessOnly = false;
  }
  if (
    actionRequired &&
    !operationalRisk &&
    isGroupAssignmentWrapperNotification(source) &&
    directness === 'shared'
  ) {
    actionRequired = false;
    awarenessOnly = true;
  }
  if (
    isGroupAssignmentWrapperNotification(source) &&
    directness === 'shared' &&
    !isOperationalGroupAssignmentWrapper(source)
  ) {
    actionRequired = false;
    operationalRisk = false;
    awarenessOnly = false;
  }
  if (
    actionRequired &&
    !operationalRisk &&
    sharedAliasWithoutAccountRecipient &&
    directness !== 'mentioned'
  ) {
    actionRequired = false;
    awarenessOnly = false;
  }
  if (
    actionRequired &&
    !operationalRisk &&
    helpdeskSupportWithoutAccountRecipient &&
    directness !== 'mentioned'
  ) {
    actionRequired = false;
    awarenessOnly = false;
  }
  const sharedTrafficWithoutAccountRecipient =
    sharedAliasWithoutAccountRecipient ||
    helpdeskSupportWithoutAccountRecipient ||
    internalDistributionWithoutAccountRecipient;
  if (sharedTrafficWithoutAccountRecipient && directness !== 'mentioned') {
    if (executiveOperationalUpdate) {
      actionRequired = false;
      awarenessOnly = true;
      operationalRisk = severeExecutiveOperationalAlert;
    } else {
      actionRequired = false;
      awarenessOnly = false;
      operationalRisk = false;
    }
  }
  let reportWorthy =
    typeof attention?.reportWorthy === 'boolean'
      ? attention.reportWorthy
      : operationalRisk || actionRequired || priority === 'high' || priority === 'urgent';
  if (sharedTrafficWithoutAccountRecipient && executiveOperationalUpdate && directness !== 'mentioned') {
    reportWorthy = true;
  }
  if (
    isGroupAssignmentWrapperNotification(source) &&
    directness === 'shared' &&
    !isOperationalGroupAssignmentWrapper(source)
  ) {
    reportWorthy = false;
  }
  if (
    reportWorthy &&
    !operationalRisk &&
    !actionRequired &&
    isLikelyRoutineNotificationSource(source, {
      directness,
      automated,
    })
  ) {
    reportWorthy = false;
  }
  if (
    reportWorthy &&
    !operationalRisk &&
    sharedTrafficWithoutAccountRecipient &&
    !executiveOperationalUpdate &&
    directness !== 'mentioned'
  ) {
    reportWorthy = false;
  }
  let importanceReason =
    (typeof attention?.importanceReason === 'string' && attention.importanceReason.trim()) ||
    sourceMetadataString(source, 'modelImportanceReason') ||
    (isLikelyRoutineNotificationSource(source, { directness, automated })
      ? 'Routine notification'
      : operationalRisk
      ? 'Operationally important'
      : actionRequired
        ? 'Likely needs Jerry action'
        : awarenessOnly
          ? 'Useful awareness'
          : 'General triage signal');
  if (sharedTrafficWithoutAccountRecipient && executiveOperationalUpdate && directness !== 'mentioned') {
    importanceReason = severeExecutiveOperationalAlert
      ? 'Shared distribution or alias alert with executive operational impact'
      : 'Shared distribution or alias update relevant to Jerry’s role';
  } else if (
    helpdeskSupportWithoutAccountRecipient &&
    !operationalRisk &&
    directness !== 'mentioned'
  ) {
    importanceReason = 'Helpdesk/support traffic without Jerry as a recipient';
  } else if (
    sharedAliasWithoutAccountRecipient &&
    !operationalRisk &&
    directness !== 'mentioned'
  ) {
    importanceReason = 'Shared alias traffic without Jerry as a recipient';
  } else if (
    internalDistributionWithoutAccountRecipient &&
    !operationalRisk &&
    directness !== 'mentioned'
  ) {
    importanceReason = 'Internal distribution traffic without Jerry as a recipient';
  }
  if (workStatusOverride === 'done' || workStatusOverride === 'ignored') {
    awarenessOnly = false;
    actionRequired = false;
    operationalRisk = false;
    reportWorthy = false;
    importanceReason =
      workStatusOverride === 'done'
        ? 'Handled already'
        : 'Suppressed from active views';
  }
  return {
    awarenessOnly,
    actionRequired,
    operationalRisk,
    reportWorthy,
    directness,
    importanceReason,
    actionConfidence:
      typeof attention?.actionConfidence === 'number'
        ? attention.actionConfidence
        : typeof metadata.modelActionConfidence === 'number'
          ? (metadata.modelActionConfidence as number)
          : source.attributionConfidence ?? null,
    mappingConfidence:
      typeof attention?.mappingConfidence === 'number'
        ? attention.mappingConfidence
        : source.attributionConfidence ?? null,
    modelContextFingerprint:
      (typeof attention?.modelContextFingerprint === 'string' &&
        attention.modelContextFingerprint) ||
      sourceMetadataString(source, 'modelContextFingerprint'),
  };
}

function sourceThreadState(source: SourceRecord): ThreadState {
  if (source.threadState) return source.threadState;
  const metadata = source.metadata || {};
  const existing = metadata.threadState as Record<string, unknown> | undefined;
  if (existing && typeof existing.state === 'string' && typeof existing.summary === 'string') {
    return {
      state: existing.state as ThreadState['state'],
      summary: existing.summary,
      lastActor:
        existing.lastActor === 'self' || existing.lastActor === 'other'
          ? existing.lastActor
          : 'unknown',
      confidence:
        typeof existing.confidence === 'number' ? existing.confidence : null,
    };
  }
  const workStatusOverride = sourceWorkItemStatusOverride(source);
  if (workStatusOverride === 'done') {
    return {
      state: 'resolved',
      summary: 'Handled already.',
      lastActor: 'self',
      confidence: 0.98,
    };
  }
  if (workStatusOverride === 'ignored') {
    return {
      state: 'awareness',
      summary: 'Suppressed from active views.',
      lastActor: 'self',
      confidence: 0.98,
    };
  }
  if (workStatusOverride === 'blocked') {
    return {
      state: 'blocked',
      summary: 'Marked blocked on the Work board.',
      lastActor: 'self',
      confidence: 0.96,
    };
  }
  if (workStatusOverride === 'waiting' || workStatusOverride === 'on_hold') {
    return {
      state: 'waiting_for_response',
      summary: 'Marked waiting on the Work board.',
      lastActor: 'self',
      confidence: 0.96,
    };
  }
  const attention = sourceAttention(source);
  const text = `${source.title}\n${source.summary}\n${source.body}`;
  if (
    /\b(done|resolved|closed|fixed)\b/i.test(text) ||
    /(done|resolved|closed)/i.test(source.status || '')
  ) {
    return {
      state: 'resolved',
      summary: 'This thread looks resolved or closed.',
      lastActor: 'other',
      confidence: 0.7,
    };
  }
  if (attention.operationalRisk || /\b(blocked|outage|website down|system down|incident)\b/i.test(text)) {
    return {
      state: 'blocked',
      summary: 'This looks like a blocker or operational risk.',
      lastActor: 'other',
      confidence: 0.78,
    };
  }
  if ((source.status || '').toLowerCase().includes('waiting') || /\bwaiting on\b/i.test(text)) {
    return {
      state: 'waiting_for_response',
      summary: 'Waiting on an external response or next step.',
      lastActor: 'other',
      confidence: 0.68,
    };
  }
  if (attention.actionRequired && (attention.directness === 'direct' || attention.directness === 'mentioned')) {
    return {
      state: 'direct_ask',
      summary: 'Looks like a direct ask or mention that needs Jerry.',
      lastActor: 'other',
      confidence: attention.actionConfidence ?? 0.72,
    };
  }
  if (attention.directness === 'shared') {
    return {
      state: 'shared_alias',
      summary: 'Shared inbox or channel awareness item.',
      lastActor: 'other',
      confidence: attention.actionConfidence ?? 0.66,
    };
  }
  return {
    state: 'awareness',
    summary: attention.importanceReason || 'Awareness item',
    lastActor: 'unknown',
    confidence: attention.actionConfidence ?? attention.mappingConfidence ?? null,
  };
}

function threadStateTone(state: ThreadState['state']): PersonalOpsOpenLoopState {
  if (state === 'blocked') return 'blocked';
  if (state === 'waiting_for_response' || state === 'already_replied') return 'waiting';
  if (state === 'resolved') return 'closed';
  if (state === 'awareness' || state === 'shared_alias') return 'awareness';
  return 'action';
}

function sourceReviewState(source: SourceRecord): PersonalOpsSuggestionStatus | null {
  if (source.reviewState) return source.reviewState;
  const metadata = source.metadata || {};
  return metadata.reviewState === 'suggested' ||
      metadata.reviewState === 'accepted' ||
      metadata.reviewState === 'rejected'
    ? (metadata.reviewState as PersonalOpsSuggestionStatus)
    : null;
}

function sourceNeedsReview(source: SourceRecord): boolean {
  const attention = sourceAttention(source);
  if (sourceReviewState(source) === 'suggested') return true;
  const actionConfidence = attention.actionConfidence ?? 1;
  const mappingConfidence = attention.mappingConfidence ?? 1;
  return actionConfidence < 0.7 || mappingConfidence < 0.7;
}

function sourceWhyReview(source: SourceRecord): string[] {
  const attention = sourceAttention(source);
  const reasons: string[] = [];
  if ((attention.mappingConfidence ?? 1) < 0.7) {
    reasons.push('Client/project mapping confidence is low');
  }
  if ((attention.actionConfidence ?? 1) < 0.7) {
    reasons.push('Action judgment confidence is low');
  }
  if (sourceReviewState(source) === 'suggested') {
    reasons.push('Needs confirmation before becoming durable memory');
  }
  return reasons.length ? reasons : ['Needs review'];
}

function workItemOpenLoopState(item: WorkItem): PersonalOpsOpenLoopState {
  if (item.status === 'done' || item.status === 'ignored') return 'closed';
  if (item.status === 'blocked') return 'blocked';
  if (item.status === 'waiting' || item.status === 'on_hold') return 'waiting';
  return item.openLoopState || 'action';
}

function participantLooksAutomated(source: SourceRecord): boolean {
  return source.participants.some((participant) =>
    /(^|[._-])(no-?reply|donotreply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounce|noreply)([._+-]|@|$)/i.test(
      participant.toLowerCase(),
    ),
  );
}

function looksOperationallySensitiveText(text: string): boolean {
  return /\b(outage|website down|system down|incident|map violation|pricing|blocked?|under shipped|ship request|alarm|rejected items?)\b/i.test(
    text,
  );
}

function looksExecutiveOperationalUpdate(text: string): boolean {
  return /\b(vendor pricing|pricing update|price file|price is less than cost|min max values?|map violation|website down|site down|system down|outage|incident|security alert|breach|bank data import failed|edi transfer failed|cloudwatch alarm|gateway .* down)\b/i.test(
    text,
  );
}

function looksSevereExecutiveOperationalAlert(text: string): boolean {
  return /\b(website down|site down|system down|outage|incident|security alert|breach|bank data import failed|edi transfer failed|cloudwatch alarm|gateway .* down)\b/i.test(
    text,
  );
}

function isGroupAssignmentWrapperNotification(source: SourceRecord): boolean {
  if (source.kind !== 'email') return false;
  const text = `${source.title}\n${source.summary}\n${source.body}`;
  return (
    /^assigned to group\b/i.test(source.title.trim()) ||
    /\ba new ticket has been assigned to your group\b/i.test(text)
  );
}

function looksPromotional(text: string): boolean {
  return /\b(sale|discount|promo|promotion|deal|unsubscribe|newsletter|digest|webinar)\b/i.test(
    text,
  );
}

function looksRoutineNotificationText(text: string): boolean {
  return /\b(verification code|security code|one[- ]time code|launch code|passcode|login code|sign[- ]in code|shared with you|shared a file|shared a spreadsheet|invited you|access request|commented on|credit score|credit report|fico|equifax|experian|transunion|top stories|headlines|local news|daily digest|tips for using your new inbox|welcome to your inbox|no action required at this time)\b/i.test(
    text,
  );
}

function isOperationalGroupAssignmentWrapper(source: SourceRecord): boolean {
  if (!isGroupAssignmentWrapperNotification(source)) return false;
  return looksOperationallySensitiveText(`${source.title}\n${source.summary}\n${source.body}`);
}

function isHelpdeskSupportTrafficWithoutAccountRecipient(source: SourceRecord): boolean {
  if (source.kind !== 'email') return false;
  const accountEmail = accountMailboxEmail(source);
  if (!accountEmail) return false;
  const recipientEmails = sourceExplicitRecipientEmails(source);
  if (recipientEmails.includes(accountEmail)) return false;
  const participantEmails = sourceParticipantEmails(source);
  const accountDomain = accountEmail.split('@')[1];
  const text = `${source.title}\n${source.summary}\n${source.body}`;
  const mentionsHelpdesk =
    /\b(freshdesk|help ?desk|ticket(?:\s*#|\s+id)?|support queue|customer support)\b/i.test(
      text,
    ) || source.sourceUrl?.toLowerCase().includes('freshdesk.com');
  const mentionsSupportAlias = participantEmails.some((email) => {
    const [localPart, domain] = email.split('@');
    if (!localPart || !domain) return false;
    if (accountDomain && domain === accountDomain && ['support', 'help', 'service'].includes(localPart)) {
      return true;
    }
    return /^(support|help|service)@/i.test(email);
  });
  return mentionsHelpdesk || mentionsSupportAlias;
}

function isLikelyRoutineNotificationSource(
  source: SourceRecord,
  input?: {
    directness?: 'direct' | 'mentioned' | 'shared' | 'ambient';
    automated?: boolean;
  },
): boolean {
  if (source.kind !== 'email') return false;
  if (input?.directness === 'direct' || input?.directness === 'mentioned') {
    return false;
  }
  const automated =
    typeof input?.automated === 'boolean'
      ? input.automated
      : sourceMetadataBoolean(source, 'automatedSender') || participantLooksAutomated(source);
  if (!automated) return false;
  const text = `${source.title}\n${source.summary}\n${source.body}`;
  if (looksOperationallySensitiveText(text)) return false;
  return looksRoutineNotificationText(text);
}

function isLikelyNoiseEmail(source: SourceRecord): boolean {
  if (source.kind !== 'email') return false;
  if (source.status === 'filtered' || sourceMetadataBoolean(source, 'likelyNoise')) {
    return true;
  }
  const automated =
    sourceMetadataBoolean(source, 'automatedSender') || participantLooksAutomated(source);
  const text = `${source.title}\n${source.summary}\n${source.body}`;
  if (automated && looksOperationallySensitiveText(text)) {
    return false;
  }
  return automated && (looksPromotional(text) || looksRoutineNotificationText(text));
}

function inboxPriorityRank(priority: PersonalOpsPriority | null | undefined): number {
  switch (priority) {
    case 'urgent':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
}

function inboxSortScore(source: SourceRecord): number {
  let score = inboxPriorityRank(source.priority) * 100;
  if (sourceMetadataBoolean(source, 'isImportant')) score += 120;
  if (sourceMetadataBoolean(source, 'isStarred')) score += 90;
  if (sourceMetadataBoolean(source, 'isUnread')) score += 40;
  if (sourceMetadataBoolean(source, 'mentionsSelf')) score += 90;
  if (sourceMetadataBoolean(source, 'isDirectMessage')) score += 70;
  if (sourceMetadataBoolean(source, 'isPrivateChannel')) score += 20;
  if (source.clientId || source.projectId) score += 25;
  if (
    sourceMetadataBoolean(source, 'automatedSender') ||
    participantLooksAutomated(source)
  ) {
    score -= 15;
  }
  if (source.metadata?.modelActionRequired === false) {
    score -= 110;
  }
  if (source.metadata?.modelActionRequired === true) {
    score += 85;
  }
  if (isLikelyNoiseEmail(source)) score -= 400;
  return score;
}

function normalizeSourceForView(source: SourceRecord): SourceRecord {
  return {
    ...source,
    attention: sourceAttention(source),
    threadState: sourceThreadState(source),
    reviewState: sourceReviewState(source),
    linkedContactIds:
      source.linkedContactIds || sourceMetadataStringArray(source, 'linkedContactIds'),
  };
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore
  }
}

function writePrivateFile(filePath: string, value: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
}

function shouldSkipDiscoveryDir(name: string): boolean {
  if (SKIPPED_DISCOVERY_DIRS.has(name)) return true;
  if (name.startsWith('.')) return true;
  return false;
}

function expandHomePath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function inspectGitRepository(inputPath: string): {
  localPath: string;
  name: string;
  remoteUrl: string | null;
  defaultBranch: string | null;
  lastCommitAt: string | null;
} {
  const expanded = expandHomePath(inputPath.trim());
  const resolved = path.resolve(expanded);
  let repoRoot = resolved;
  let remoteUrl: string | null = null;
  let defaultBranch: string | null = null;
  let lastCommitAt: string | null = null;

  try {
    repoRoot = execFileSync('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    repoRoot = resolved;
  }

  try {
    const branch = execFileSync('git', ['-C', repoRoot, 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    defaultBranch = branch && branch !== 'HEAD' ? branch : null;
  } catch {
    defaultBranch = null;
  }

  try {
    const value = execFileSync(
      'git',
      ['-C', repoRoot, 'config', '--get', 'remote.origin.url'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    remoteUrl = value || null;
  } catch {
    remoteUrl = null;
  }

  try {
    const value = execFileSync(
      'git',
      ['-C', repoRoot, 'log', '-1', '--format=%cI'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    lastCommitAt = value || null;
  } catch {
    lastCommitAt = null;
  }

  return {
    localPath: repoRoot,
    name: path.basename(repoRoot),
    remoteUrl,
    defaultBranch,
    lastCommitAt,
  };
}

export interface PersonalOpsConnectionSummary extends ConnectedAccount {
  syncJobs: SyncJobState[];
}

export interface PersonalOpsTodaySummary {
  generatedAt: string;
  meetings: SourceRecord[];
  priorities: WorkItem[];
  overdue: WorkItem[];
  followUps: WorkItem[];
  blockers: WorkItem[];
  awareness: SourceRecord[];
  inbox: SourceRecord[];
  openLoops: OpenLoop[];
  approvalQueue: ApprovalQueueItem[];
  workstreams: PersonalOpsWorkstream[];
  suggestedPlan: string[];
  draftStandup: string;
}

interface PersonalOpsConnectionRef {
  provider: PersonalOpsProvider;
  accountId: string;
}

export class PersonalOpsService {
  private lastRepositoryActivityRefreshAt = 0;

  constructor() {
    initPersonalOpsDatabase(PERSONAL_OPS_STORE_DIR);
    ensureDir(PERSONAL_OPS_STORE_DIR);
    ensureDir(PERSONAL_OPS_PUBLIC_DIR);
  }

  listConnections(): PersonalOpsConnectionSummary[] {
    const accounts = listConnectedAccounts();
    const jobs = listSyncJobs();
    const summaries: PersonalOpsConnectionSummary[] = [];
    const now = new Date().toISOString();

    for (const provider of CONNECTED_PROVIDERS) {
      const providerAccounts = accounts.filter(
        (entry) => entry.provider === provider && entry.status !== 'disconnected',
      );
      if (providerAccounts.length === 0) {
        summaries.push({
          connectionKey: getConnectionKey(provider, null),
          provider,
          status: 'disconnected',
          accountLabel: null,
          accountId: null,
          baseUrl: null,
          scopes: [],
          expiresAt: null,
          lastSyncAt: null,
          lastSyncStatus: 'never',
          lastSyncError: null,
          resourceId: null,
          settings: {},
          createdAt: now,
          updatedAt: now,
          syncJobs: [],
        });
        continue;
      }

      for (const account of providerAccounts) {
        summaries.push({
          ...account,
          syncJobs: jobs.filter((job) => job.connectionKey === account.connectionKey),
        });
      }
    }

    return summaries;
  }

  beginOAuth(provider: PersonalOpsProvider, appBaseUrl: string): string {
    const secrets = loadPersonalOpsSecrets();
    const redirectUri = buildOAuthRedirectUri(appBaseUrl, provider);
    const { state, codeVerifier, codeChallenge } = createPkcePair();
    addOAuthState({
      provider,
      state,
      codeVerifier,
      redirectUri,
    });
    return buildAuthorizeUrl({
      provider,
      redirectUri,
      state,
      codeChallenge,
      secrets,
    });
  }

  async handleOAuthCallback(
    provider: PersonalOpsProvider,
    code: string,
    state: string,
    appBaseUrl: string,
  ): Promise<void> {
    const oauthState = consumeOAuthState(state);
    if (!oauthState || oauthState.provider !== provider) {
      throw new Error('Invalid or expired OAuth state.');
    }
    const secrets = loadPersonalOpsSecrets();
    const token = await exchangeAuthCode({
      provider,
      code,
      redirectUri: buildOAuthRedirectUri(appBaseUrl, provider),
      codeVerifier: oauthState.code_verifier,
      secrets,
    });
    const identity = await fetchProviderIdentity(provider, token.accessToken);
    upsertConnectedAccount({
      provider,
      accountId: identity.accountId,
      status: 'connected',
      accountLabel: identity.accountLabel,
      baseUrl: identity.baseUrl ?? null,
      resourceId: identity.resourceId ?? null,
      scopes: token.scope,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      settings: {},
      lastSyncStatus: 'never',
      lastSyncError: null,
    });
    const connection = { provider, accountId: identity.accountId };
    this.ensureSyncJobs(connection);
    await this.syncProvider(connection);
  }

  disconnect(input: PersonalOpsConnectionRef): void {
    disconnectConnectedAccount(input.provider, input.accountId);
  }

  updateConnectionSettings(
    input: PersonalOpsConnectionRef,
    settings: PersonalOpsConnectionSettings,
  ): ConnectedAccount {
    const account = getConnectedAccountRecord(input.provider, input.accountId);
    if (!account) {
      throw new Error(`${input.provider} (${input.accountId}) is not connected.`);
    }
    upsertConnectedAccount({
      provider: input.provider,
      accountId: input.accountId,
      status: account.status,
      settings: normalizeConnectionSettings(settings),
      lastSyncAt: account.lastSyncAt,
      lastSyncStatus: account.lastSyncStatus,
      lastSyncError: account.lastSyncError,
    });
    this.reprocessStoredSources({
      provider: input.provider,
      accountId: input.accountId,
    });
    return listConnectedAccounts().find(
      (entry) => entry.connectionKey === account.connectionKey,
    )!;
  }

  async getConnectionCatalog(
    input: PersonalOpsConnectionRef,
  ): Promise<PersonalOpsConnectionCatalog> {
    const account = await this.ensureFreshToken(input);
    return fetchProviderConnectionCatalog({ account });
  }

  private ensureSyncJobs(input: PersonalOpsConnectionRef): void {
    const connectionKey = getConnectionKey(input.provider, input.accountId);
    const account = getConnectedAccountRecord(input.provider, input.accountId);
    const intervalMap = SYNC_INTERVAL_MS[input.provider];
    for (const [kind, intervalMs] of Object.entries(intervalMap) as Array<
      [SourceRecord['kind'], number]
    >) {
      const job = getSyncJob(connectionKey, kind);
      if (!job) {
        upsertSyncJob({
          connectionKey,
          provider: input.provider,
          accountId: input.accountId,
          accountLabel: account?.accountLabel ?? null,
          sourceKind: kind,
          status: 'idle',
          nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
        });
      }
    }
  }

  private async ensureFreshToken(
    input: PersonalOpsConnectionRef,
  ): Promise<ConnectedAccountRecord> {
    const account = getConnectedAccountRecord(input.provider, input.accountId);
    if (!account || !account.accessToken) {
      throw new Error(`${input.provider} (${input.accountId}) is not connected.`);
    }
    if (!account.expiresAt) {
      return account;
    }
    const expiresAt = new Date(account.expiresAt).getTime();
    if (Number.isNaN(expiresAt) || expiresAt - Date.now() > 120_000) {
      return account;
    }
    if (!account.refreshToken) {
      throw new Error(
        `${input.provider} (${input.accountId}) token expired and no refresh token is stored.`,
      );
    }
    const secrets = loadPersonalOpsSecrets();
    const refreshed = await refreshAccessToken({
      provider: input.provider,
      refreshToken: account.refreshToken,
      secrets,
    });
    upsertConnectedAccount({
      provider: input.provider,
      accountId: account.accountId || input.accountId,
      status: 'connected',
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      scopes: refreshed.scope,
      lastSyncError: null,
    });
    return getConnectedAccountRecord(input.provider, input.accountId)!;
  }

  async syncProvider(input: PersonalOpsConnectionRef): Promise<void> {
    this.ensureSyncJobs(input);
    const account = await this.ensureFreshToken(input);
    const connectionKey = getConnectionKey(input.provider, input.accountId);
    const sourceKinds = Object.keys(SYNC_INTERVAL_MS[input.provider]) as SourceRecord['kind'][];
    const primaryJob = getSyncJob(connectionKey, sourceKinds[0]);
    const since = chooseSourceWindow(primaryJob);

    try {
      for (const kind of sourceKinds) {
        upsertSyncJob({
          connectionKey,
          provider: input.provider,
          accountId: input.accountId,
          accountLabel: account.accountLabel,
          sourceKind: kind,
          status: 'running',
          cursor: getSyncJob(connectionKey, kind)?.cursor ?? null,
          lastRunAt: new Date().toISOString(),
        });
      }

      const batch = await syncProviderData({
        account,
        since,
        settings: account.settings,
      });

      const clients = listClients();
      const projects = listProjects();
      const repositories = listRepositories();
      const candidateCount = Math.min(batch.records.length, 10);
      let classifiedCount = 0;

      for (const record of batch.records) {
        const rawPath = providerRawSnapshotPath(
          PERSONAL_OPS_STORE_DIR,
          batch.provider,
          account.accountId,
          record.source.kind,
          record.source.externalId,
        );
        writePrivateFile(rawPath, JSON.stringify(record.raw, null, 2));

        const attributed = {
          ...record.source,
          rawSnapshotRef: rawPath,
          metadata: { ...(record.source.metadata || {}) },
        };
        const existing = getSourceRecord(
          record.source.provider,
          record.source.accountId ?? null,
          record.source.kind as SourceRecord['kind'],
          record.source.externalId,
        );
        attributed.metadata = {
          ...(attributed.metadata || {}),
          ...preservedSourceMetadata(existing),
        };
        const classificationFingerprint = buildClassificationFingerprint(attributed);

        if (existing?.attributionSource === 'manual') {
          attributed.clientId = existing.clientId || attributed.clientId || null;
          attributed.projectId = existing.projectId || attributed.projectId || null;
          attributed.priority = attributed.priority || existing.priority || null;
          attributed.attributionSource = 'manual';
          attributed.attributionConfidence = 1;
          attributed.metadata = {
            ...(existing.metadata || {}),
            ...(attributed.metadata || {}),
            classificationFingerprint,
            manualAttributionPreserved: true,
          };
        }

        const likelyNoise = attributed.metadata?.likelyNoise === true;
        if (!attributed.clientId || !attributed.projectId) {
          this.applyRuleBasedAttribution(
            attributed,
            clients,
            projects,
            repositories,
            account.settings,
          );
        }

        let linkedContactIds =
          attributed.linkedContactIds ||
          (existing?.linkedContactIds && existing.linkedContactIds.length
            ? existing.linkedContactIds
            : []);
        if (attributed.participants.length) {
          linkedContactIds = this.ensureContactsFromSource(attributed);
          attributed.linkedContactIds = linkedContactIds;
          attributed.metadata = {
            ...(attributed.metadata || {}),
            linkedContactIds,
          };
        }

        const classificationContext = this.buildClassificationContext({
          source: attributed,
          clients,
          projects,
          settings: account.settings,
        });
        const existingFingerprint =
          typeof existing?.metadata?.classificationFingerprint === 'string'
            ? existing.metadata.classificationFingerprint
            : null;
        const existingModelContextFingerprint =
          typeof existing?.metadata?.modelContextFingerprint === 'string'
            ? existing.metadata.modelContextFingerprint
            : null;
        const canReuseExistingClassification =
          existing &&
          existingFingerprint === classificationFingerprint &&
          (existing.attributionSource !== 'model' ||
            existingModelContextFingerprint === classificationContext.fingerprint) &&
          existing.attributionSource &&
          existing.attributionSource !== 'none' &&
          (existing.clientId || existing.projectId);
        const canReuseExistingModelTriage =
          existing &&
          existingFingerprint === classificationFingerprint &&
          existingModelContextFingerprint === classificationContext.fingerprint &&
          this.hasStoredModelTriage(existing);

        if (
          canReuseExistingClassification &&
          (!attributed.clientId || !attributed.projectId)
        ) {
          attributed.clientId = attributed.clientId || existing.clientId || null;
          attributed.projectId = attributed.projectId || existing.projectId || null;
          attributed.priority = attributed.priority || existing.priority || null;
          attributed.attributionSource = existing.attributionSource;
          attributed.attributionConfidence =
            existing.attributionConfidence ?? attributed.attributionConfidence ?? null;
          if (
            !attributed.metadata?.attributionRule &&
            typeof existing.metadata?.attributionRule === 'string'
          ) {
            attributed.metadata = {
              ...(attributed.metadata || {}),
              attributionRule: existing.metadata.attributionRule,
            };
          }
          if (
            !Array.isArray(attributed.metadata?.attributionDiagnostics) &&
            Array.isArray(existing.metadata?.attributionDiagnostics)
          ) {
            attributed.metadata = {
              ...(attributed.metadata || {}),
              attributionDiagnostics: existing.metadata.attributionDiagnostics,
            };
          }
        }

        if (canReuseExistingModelTriage) {
          this.copyStoredModelTriage(attributed, existing);
        }

        const needsModelAttribution =
          !canReuseExistingClassification &&
          (!attributed.clientId || !attributed.projectId);
        const needsRoleAwareTriage =
          !canReuseExistingModelTriage &&
          (classificationContext.hasTriageGuidance ||
            classificationContext.contactProfiles.length > 0) &&
          (attributed.kind === 'email' || attributed.kind === 'slack_message');

        if (
          !likelyNoise &&
          (needsModelAttribution || needsRoleAwareTriage) &&
          classifiedCount < candidateCount
        ) {
          const suggestion = await suggestSourceClassification({
            source: attributed,
            clientNames: clients.map((client) => client.name),
            projectNames: projects.map((project) => project.name),
            operatorContext: classificationContext.operatorContext,
            connectionContext: classificationContext.connectionContext,
            clientProfiles: classificationContext.clientProfiles,
            projectProfiles: classificationContext.projectProfiles,
            contactProfiles: classificationContext.contactProfiles,
          });
          classifiedCount += 1;
          if (suggestion) {
            if (!attributed.clientId && suggestion.clientName) {
              attributed.clientId =
                clients.find((client) => client.name === suggestion.clientName)?.id || null;
            }
            if (!attributed.projectId && suggestion.projectName) {
              attributed.projectId =
                projects.find((project) => project.name === suggestion.projectName)?.id || null;
            }
            if (!attributed.priority && suggestion.urgency) {
              attributed.priority = suggestion.urgency;
            }
            const mappingConfidence =
              suggestion.mappingConfidence ??
              suggestion.confidence ??
              attributed.attributionConfidence ??
              null;
            const nextAttention = {
              awarenessOnly: suggestion.awarenessOnly ?? false,
              actionRequired: suggestion.actionRequired ?? false,
              operationalRisk: suggestion.operationalRisk ?? false,
              reportWorthy:
                suggestion.reportWorthy ??
                suggestion.operationalRisk ??
                suggestion.actionRequired ??
                false,
              directness:
                suggestion.directness === 'direct' ||
                suggestion.directness === 'mentioned' ||
                suggestion.directness === 'shared'
                  ? suggestion.directness
                  : 'ambient',
              importanceReason:
                suggestion.importanceReason?.trim() ||
                (suggestion.operationalRisk
                  ? 'Operationally important'
                  : suggestion.actionRequired
                    ? 'Likely needs Jerry action'
                    : 'Useful awareness'),
              actionConfidence:
                typeof suggestion.actionConfidence === 'number'
                  ? suggestion.actionConfidence
                  : suggestion.confidence ?? null,
              mappingConfidence,
              modelContextFingerprint: classificationContext.fingerprint,
            } as const;
            attributed.metadata = {
              ...(attributed.metadata || {}),
              modelContextFingerprint: classificationContext.fingerprint,
              attention: nextAttention,
              reviewState:
                (nextAttention.actionConfidence ?? 1) < 0.7 ||
                (nextAttention.mappingConfidence ?? 1) < 0.7
                  ? 'suggested'
                  : null,
              ...(suggestion.actionRequired !== undefined
                ? { modelActionRequired: suggestion.actionRequired }
                : {}),
              ...(suggestion.blocker !== undefined
                ? { modelBlocker: suggestion.blocker }
                : {}),
              ...(suggestion.followUpTitle
                ? { modelFollowUpTitle: suggestion.followUpTitle }
                : {}),
              ...(suggestion.urgency ? { modelUrgency: suggestion.urgency } : {}),
              ...(suggestion.importanceReason
                ? { modelImportanceReason: suggestion.importanceReason }
                : {}),
              ...(typeof nextAttention.actionConfidence === 'number'
                ? { modelActionConfidence: nextAttention.actionConfidence }
                : {}),
              ...(typeof nextAttention.mappingConfidence === 'number'
                ? { modelMappingConfidence: nextAttention.mappingConfidence }
                : {}),
              ...(nextAttention.operationalRisk
                ? { modelOperationalRisk: true }
                : {}),
            };
            attributed.attention = nextAttention;
            attributed.reviewState =
              attributed.metadata.reviewState === 'suggested' ? 'suggested' : null;
            attributed.attributionSource =
              needsModelAttribution && (attributed.clientId || attributed.projectId)
                ? 'model'
                : attributed.attributionSource;
            if (needsModelAttribution && (attributed.clientId || attributed.projectId)) {
              attributed.attributionConfidence = mappingConfidence ?? 0.65;
            }
          }
        }

        if (!attributed.attention) {
          attributed.attention = sourceAttention(attributed);
        }
        if (!attributed.reviewState) {
          attributed.reviewState = sourceReviewState(attributed);
        }
        attributed.threadState = sourceThreadState(attributed);

        attributed.metadata = {
          ...(attributed.metadata || {}),
          classificationFingerprint,
          linkedContactIds: attributed.linkedContactIds || [],
          reviewState: attributed.reviewState,
          attention: attributed.attention,
          threadState: attributed.threadState,
        };

        const ignoreRule = listSourceIgnoreRules().find((rule) =>
          sourceMatchesIgnoreRule(attributed, rule),
        );
        if (ignoreRule) {
          applySourceIgnoreRule(attributed, ignoreRule);
        }

        upsertSourceRecord(attributed);
        this.materializeDerivedRecords(attributed);
      }

      for (const [kind, cursor] of Object.entries(batch.cursors) as Array<
        [SourceRecord['kind'], string]
      >) {
        const nextRunAt = new Date(
          Date.now() + (SYNC_INTERVAL_MS[input.provider][kind] || 5 * 60_000),
        ).toISOString();
        upsertSyncJob({
          connectionKey,
          provider: input.provider,
          accountId: input.accountId,
          accountLabel: account.accountLabel,
          sourceKind: kind,
          cursor,
          status: 'idle',
          error: null,
          lastRunAt: new Date().toISOString(),
          nextRunAt,
          backoffUntil: null,
        });
      }

      upsertConnectedAccount({
        provider: input.provider,
        accountId: account.accountId || input.accountId,
        status: 'connected',
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: 'success',
        lastSyncError: null,
      });
      this.writePublicSnapshots();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const backoffUntil = new Date(Date.now() + 15 * 60_000).toISOString();
      for (const kind of sourceKinds) {
        const existing = getSyncJob(connectionKey, kind);
        upsertSyncJob({
          connectionKey,
          provider: input.provider,
          accountId: input.accountId,
          accountLabel: account.accountLabel,
          sourceKind: kind,
          cursor: existing?.cursor ?? null,
          status: 'error',
          error,
          lastRunAt: new Date().toISOString(),
          nextRunAt: backoffUntil,
          backoffUntil,
        });
      }
      upsertConnectedAccount({
        provider: input.provider,
        accountId: account.accountId || input.accountId,
        status: 'degraded',
        lastSyncStatus: 'error',
        lastSyncError: error,
      });
      throw err;
    }
  }

  async syncDueProviders(): Promise<void> {
    const now = Date.now();
    for (const connection of this.listConnections()) {
      if (connection.status === 'disconnected' || !connection.accountId) continue;
      const shouldRun = connection.syncJobs.some((job) => {
        const nextRun = job.nextRunAt ? new Date(job.nextRunAt).getTime() : 0;
        const backoff = job.backoffUntil ? new Date(job.backoffUntil).getTime() : 0;
        return nextRun <= now && backoff <= now && job.status !== 'running';
      });
      if (shouldRun) {
        try {
          await this.syncProvider({
            provider: connection.provider,
            accountId: connection.accountId,
          });
        } catch (err) {
          logger.warn(
            { provider: connection.provider, accountId: connection.accountId, err },
            'Personal ops provider sync failed',
          );
        }
      }
    }
  }

  private readGitConfigValue(repoPath: string, args: string[]): string | null {
    try {
      const value = execFileSync('git', ['-C', repoPath, 'config', ...args], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return value || null;
    } catch {
      return null;
    }
  }

  private collectGitIdentityHints(repoPath: string): {
    emails: Set<string>;
    names: Set<string>;
  } {
    const emails = new Set<string>();
    const names = new Set<string>();

    for (const connection of this.listConnections()) {
      const label = connection.accountLabel || connection.accountId || '';
      if (label.includes('@')) {
        emails.add(label.toLowerCase());
      }
    }

    const candidateEmails = [
      this.readGitConfigValue(repoPath, ['--global', 'user.email']),
      this.readGitConfigValue(repoPath, ['user.email']),
    ];
    const candidateNames = [
      this.readGitConfigValue(repoPath, ['--global', 'user.name']),
      this.readGitConfigValue(repoPath, ['user.name']),
    ];

    for (const email of candidateEmails) {
      if (email) emails.add(email.toLowerCase());
    }
    for (const name of candidateNames) {
      if (name) names.add(name.trim().toLowerCase());
    }

    return { emails, names };
  }

  private shouldIncludeCommit(
    authorName: string,
    authorEmail: string,
    identities: { emails: Set<string>; names: Set<string> },
  ): boolean {
    if (identities.emails.size === 0 && identities.names.size === 0) {
      return true;
    }
    const normalizedEmail = authorEmail.trim().toLowerCase();
    const normalizedName = authorName.trim().toLowerCase();
    return (
      identities.emails.has(normalizedEmail) ||
      identities.names.has(normalizedName)
    );
  }

  private buildCommitReference(repository: GitRepository, commitSha: string): string | null {
    if (repository.remoteUrl) {
      const githubSsh = repository.remoteUrl.match(/^git@github\.com:(.+?)(?:\.git)?$/i);
      if (githubSsh?.[1]) {
        return `https://github.com/${githubSsh[1]}/commit/${commitSha}`;
      }
      const githubHttps = repository.remoteUrl.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/i);
      if (githubHttps?.[1]) {
        return `https://github.com/${githubHttps[1]}/commit/${commitSha}`;
      }
    }
    return repository.localPath;
  }

  private refreshRepositoryActivityIfDue(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastRepositoryActivityRefreshAt < 5 * 60_000) {
      return;
    }

    const since = plusDays(new Date(), -30).toISOString();
    for (const repository of listRepositories()) {
      const identities = this.collectGitIdentityHints(repository.localPath);
      let logOutput = '';
      try {
        logOutput = execFileSync(
          'git',
          [
            '-C',
            repository.localPath,
            'log',
            '--since',
            since,
            '--date=iso-strict',
            '--pretty=format:%H%x1f%cI%x1f%an%x1f%ae%x1f%s',
          ],
          {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        );
      } catch {
        continue;
      }

      for (const line of logOutput.split('\n')) {
        if (!line.trim()) continue;
        const [commitSha, committedAt, authorName, authorEmail, subject] = line.split('\x1f');
        if (!commitSha || !committedAt || !subject) continue;
        if (!this.shouldIncludeCommit(authorName || '', authorEmail || '', identities)) {
          continue;
        }
        addActivity({
          id: `activity:repo:${repository.id}:${commitSha}`,
          timestamp: committedAt,
          type: 'git_commit',
          sourceProvider: 'git',
          sourceKind: 'git_commit',
          sourceRecordKey: null,
          relatedClientId: repository.clientId,
          relatedProjectId: repository.projectId,
          summary: `${repository.name}: ${subject}`,
          rawReference: this.buildCommitReference(repository, commitSha),
          metadata: {
            repoId: repository.id,
            repoName: repository.name,
            repoPath: repository.localPath,
            remoteUrl: repository.remoteUrl,
            defaultBranch: repository.defaultBranch,
            commitSha,
            authorName,
            authorEmail,
          },
        });
      }
    }

    this.lastRepositoryActivityRefreshAt = now;
  }

  private estimateCommitHours(activities: Activity[]): number {
    const commitTimes = activities
      .filter((activity) => activity.type === 'git_commit')
      .map((activity) => new Date(activity.timestamp).getTime())
      .filter((value) => !Number.isNaN(value))
      .sort((a, b) => a - b);

    if (commitTimes.length === 0) return 0;

    let sessionStart = commitTimes[0];
    let previous = commitTimes[0];
    let totalMinutes = 0;

    const closeSession = (start: number, end: number) => {
      const spanMinutes = Math.max(0, Math.round((end - start) / 60_000));
      totalMinutes += Math.max(30, spanMinutes + 30);
    };

    for (let index = 1; index < commitTimes.length; index += 1) {
      const current = commitTimes[index];
      if (current - previous > 90 * 60_000) {
        closeSession(sessionStart, previous);
        sessionStart = current;
      }
      previous = current;
    }

    closeSession(sessionStart, previous);
    return Math.round((totalMinutes / 60) * 10) / 10;
  }

  private compactClassificationText(
    value: string | null | undefined,
    maxLength = 280,
  ): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length <= maxLength) return trimmed;
    return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
  }

  getOperatorProfile(): OperatorProfile {
    const value = parseJsonPreference<Partial<OperatorProfile>>(
      OPERATOR_PROFILE_PREFERENCE_KEY,
      {},
    );
    return {
      roleSummary: value.roleSummary || DEFAULT_OPERATOR_PROFILE.roleSummary,
      workHoursStart:
        typeof value.workHoursStart === 'number'
          ? value.workHoursStart
          : DEFAULT_OPERATOR_PROFILE.workHoursStart,
      workHoursEnd:
        typeof value.workHoursEnd === 'number'
          ? value.workHoursEnd
          : DEFAULT_OPERATOR_PROFILE.workHoursEnd,
      reportingPreferences:
        value.reportingPreferences || DEFAULT_OPERATOR_PROFILE.reportingPreferences,
      escalationPreferences:
        value.escalationPreferences || DEFAULT_OPERATOR_PROFILE.escalationPreferences,
      assistantStyle: value.assistantStyle || DEFAULT_OPERATOR_PROFILE.assistantStyle,
      updatedAt:
        getPreference(OPERATOR_PROFILE_PREFERENCE_KEY)?.updatedAt ||
        operatorProfileFallback().updatedAt,
    };
  }

  updateOperatorProfile(input: Partial<OperatorProfile>): OperatorProfile {
    const existing = this.getOperatorProfile();
    const profile: OperatorProfile = {
      roleSummary: input.roleSummary?.trim() || existing.roleSummary,
      workHoursStart:
        typeof input.workHoursStart === 'number'
          ? input.workHoursStart
          : existing.workHoursStart,
      workHoursEnd:
        typeof input.workHoursEnd === 'number'
          ? input.workHoursEnd
          : existing.workHoursEnd,
      reportingPreferences:
        input.reportingPreferences?.trim() || existing.reportingPreferences,
      escalationPreferences:
        input.escalationPreferences?.trim() || existing.escalationPreferences,
      assistantStyle: input.assistantStyle?.trim() || existing.assistantStyle,
      clientOperatingPosture:
        input.clientOperatingPosture?.trim() || existing.clientOperatingPosture,
      updatedAt: new Date().toISOString(),
    };
    setPreference(OPERATOR_PROFILE_PREFERENCE_KEY, JSON.stringify(profile));
    this.reprocessStoredSources();
    return this.getOperatorProfile();
  }

  private resolveContactsForSource(source: SourceRecord): Contact[] {
    const contactsById = new Map<string, Contact>();
    for (const participant of source.participants) {
      for (const email of extractEmails(participant)) {
        const identity = findContactIdentity('email', source.provider, normalizeIdentityValue(email));
        if (identity) {
          const contact = getContact(identity.contactId);
          if (contact) contactsById.set(contact.id, contact);
        }
      }
      const slackId = participant.match(/<@([A-Z0-9_]+)>/i)?.[1];
      if (slackId) {
        const identity = findContactIdentity('slack', source.provider, slackId);
        if (identity) {
          const contact = getContact(identity.contactId);
          if (contact) contactsById.set(contact.id, contact);
        }
      }
    }
    return [...contactsById.values()];
  }

  private getAccountScopedHintsForSource(source: SourceRecord): AccountScopedContactHint[] {
    if (!source.accountId || source.provider === 'manual') {
      return [];
    }
    const identities = new Set(sourceIdentityValues(source));
    if (!identities.size) {
      return [];
    }
    return listAccountScopedContactHints({
      provider: source.provider,
      accountId: source.accountId,
      limit: 200,
    }).filter(
      (hint) =>
        hint.status !== 'rejected' &&
        (identities.has(hint.identityValue) ||
          this.resolveContactsForSource(source).some((contact) => contact.id === hint.contactId)),
    );
  }

  private bestAccountScopedHintForContact(
    source: SourceRecord,
    contactId: string,
  ): AccountScopedContactHint | null {
    if (!source.accountId || source.provider === 'manual') {
      return null;
    }
    return (
      listAccountScopedContactHints({
        provider: source.provider,
        accountId: source.accountId,
        contactId,
        limit: 20,
      })
        .filter((hint) => hint.status !== 'rejected')
        .sort((left, right) => {
          const occurrenceDiff = right.occurrenceCount - left.occurrenceCount;
          if (occurrenceDiff !== 0) return occurrenceDiff;
          const confidenceDiff = right.confidence - left.confidence;
          if (confidenceDiff !== 0) return confidenceDiff;
          return (right.updatedAt || '').localeCompare(left.updatedAt || '');
        })[0] || null
    );
  }

  private inferContactImportance(source: SourceRecord): PersonalOpsContactImportance {
    const attention = sourceAttention(source);
    if (attention.operationalRisk || clampPriority(source.priority) === 'urgent') {
      return 'critical';
    }
    if (attention.actionRequired || clampPriority(source.priority) === 'high') {
      return 'high';
    }
    return 'normal';
  }

  private extractContactName(participant: string): string {
    const cleaned = participant.replace(/<[^>]+>/g, '').trim();
    if (cleaned) return cleaned;
    const email = extractEmails(participant)[0];
    if (email) {
      return email.split('@')[0].replace(/[._-]+/g, ' ');
    }
    return participant.trim();
  }

  private ensureContactsFromSource(source: SourceRecord): string[] {
    const linkedIds = new Set<string>(source.linkedContactIds || sourceMetadataStringArray(source, 'linkedContactIds'));
    const accountScopedLearning = isEmailAccountScopedLearningSource(source);
    for (const participant of source.participants) {
      const emailMatches = extractEmails(participant);
      const slackId = participant.match(/<@([A-Z0-9_]+)>/i)?.[1];
      const contactName = this.extractContactName(participant);
      if (!contactName) continue;
      let contact: Contact | null = null;

      for (const email of emailMatches) {
        const identity = findContactIdentity('email', source.provider, normalizeIdentityValue(email));
        if (identity) {
          contact = getContact(identity.contactId) || null;
          break;
        }
      }
      if (!contact && slackId) {
        const identity = findContactIdentity('slack', source.provider, slackId);
        if (identity) {
          contact = getContact(identity.contactId) || null;
        }
      }
      if (!contact) {
        contact = upsertContact({
          name: contactName,
          organizationHint: extractDomains([participant])[0] || null,
          importance: this.inferContactImportance(source),
          lastSeenAt: source.occurredAt,
          defaultClientId: accountScopedLearning ? null : source.clientId ?? null,
          defaultProjectId: accountScopedLearning ? null : source.projectId ?? null,
          sourceCount: 1,
        });
      } else {
        contact = upsertContact({
          id: contact.id,
          name: contact.name,
          organizationHint: contact.organizationHint,
          likelyRole: contact.likelyRole,
          importance:
            contact.importance === 'critical' || this.inferContactImportance(source) === 'critical'
              ? 'critical'
              : contact.importance,
          notes: contact.notes,
          lastSeenAt: latestIso(contact.lastSeenAt, source.occurredAt),
          defaultClientId:
            accountScopedLearning ? contact.defaultClientId : contact.defaultClientId || source.clientId || null,
          defaultProjectId:
            accountScopedLearning ? contact.defaultProjectId : contact.defaultProjectId || source.projectId || null,
          sourceCount: contact.sourceCount + 1,
        });
      }

      for (const email of emailMatches) {
        upsertContactIdentity({
          contactId: contact.id,
          type: 'email',
          provider: source.provider,
          value: normalizeIdentityValue(email),
          label: email,
        });
      }
      if (slackId) {
        upsertContactIdentity({
          contactId: contact.id,
          type: 'slack',
          provider: source.provider,
          value: slackId,
          label: participant,
        });
      }
      linkedIds.add(contact.id);

      if (source.clientId || source.projectId) {
        if (accountScopedLearning && source.accountId) {
          const scopedProvider = source.provider as PersonalOpsProvider;
          const identityValues = emailMatches.length
            ? emailMatches.map((entry) => normalizeIdentityValue(entry))
            : slackId
              ? [slackId]
              : [];
          for (const identityValue of identityValues) {
            const existingHint = listAccountScopedContactHints({
              contactId: contact.id,
              provider: scopedProvider,
              accountId: source.accountId,
              limit: 50,
            }).find(
              (entry) =>
                entry.identityValue === identityValue &&
                entry.clientId === (source.clientId || null) &&
                entry.projectId === (source.projectId || null) &&
                entry.basis === `${source.provider}:${source.kind}:account`,
            );
            upsertAccountScopedContactHint({
              id: existingHint?.id,
              dedupeKey: accountScopedHintDedupeKey({
                contactId: contact.id,
                provider: scopedProvider,
                accountId: source.accountId,
                identityValue,
                clientId: source.clientId || null,
                projectId: source.projectId || null,
                basis: `${scopedProvider}:${source.kind}:account`,
              }),
              contactId: contact.id,
              provider: scopedProvider,
              accountId: source.accountId,
              accountLabel: source.accountLabel || null,
              identityValue,
              clientId: source.clientId || null,
              projectId: source.projectId || null,
              basis: `${scopedProvider}:${source.kind}:account`,
              confidence: Math.max(
                source.attributionConfidence ?? 0.5,
                source.attention?.mappingConfidence ??
                  source.attention?.actionConfidence ??
                  0.5,
              ),
              occurrenceCount: (existingHint?.occurrenceCount || 0) + 1,
              status: existingHint?.status || 'suggested',
              lastSeenAt: source.occurredAt,
            });
          }
        } else {
          const existingSuggestion = listContactMappingSuggestions({
            contactId: contact.id,
            limit: 50,
          }).find(
            (entry) =>
              entry.clientId === (source.clientId || null) &&
              entry.projectId === (source.projectId || null) &&
              entry.basis === `${source.provider}:${source.kind}`,
          );
          upsertContactMappingSuggestion({
            id: existingSuggestion?.id,
            contactId: contact.id,
            clientId: source.clientId || null,
            projectId: source.projectId || null,
            basis: `${source.provider}:${source.kind}`,
            confidence: Math.max(
              source.attributionConfidence ?? 0.45,
              source.attention?.actionConfidence ?? 0.45,
            ),
            occurrenceCount: (existingSuggestion?.occurrenceCount || 0) + 1,
            status: existingSuggestion?.status || 'suggested',
            lastSeenAt: source.occurredAt,
          });
        }
      }
    }
    return [...linkedIds];
  }

  private buildClassificationContext(input: {
    source: SourceRecord;
    clients: Client[];
    projects: Project[];
    settings: PersonalOpsConnectionSettings;
  }): {
    operatorContext: SourceClassificationOperatorContext | null;
    connectionContext: SourceClassificationConnectionContext | null;
    clientProfiles: SourceClassificationClientContext[];
    projectProfiles: SourceClassificationProjectContext[];
    contactProfiles: SourceClassificationContactContext[];
    fingerprint: string | null;
    hasTriageGuidance: boolean;
  } {
    const operator = this.getOperatorProfile();
    const clientsById = new Map(input.clients.map((client) => [client.id, client]));
    const primaryClientId =
      input.source.clientId || input.settings.defaultClientId || null;
    const primaryProjectId =
      input.source.projectId || input.settings.defaultProjectId || null;
    const primaryClient = primaryClientId ? clientsById.get(primaryClientId) || null : null;
    const defaultProject = primaryProjectId
      ? input.projects.find((project) => project.id === primaryProjectId) || null
      : null;
    const clientProfiles = [...input.clients]
      .sort((left, right) => {
        if (left.id === primaryClientId) return -1;
        if (right.id === primaryClientId) return 1;
        return left.name.localeCompare(right.name);
      })
      .slice(0, 12)
      .map((client) => ({
        name: client.name,
        parentClientName: client.parentClientId
          ? clientsById.get(client.parentClientId)?.name || null
          : null,
        roles: client.roles,
        notes: this.compactClassificationText(client.notes, 220),
        communicationPreferences: this.compactClassificationText(
          client.communicationPreferences,
          220,
        ),
      }));
    const projectProfiles = [...input.projects]
      .sort((left, right) => {
        if (left.id === primaryProjectId) return -1;
        if (right.id === primaryProjectId) return 1;
        return left.name.localeCompare(right.name);
      })
      .slice(0, 20)
      .map((project) => ({
        name: project.name,
        clientName: project.clientId ? clientsById.get(project.clientId)?.name || null : null,
        tags: project.tags,
        notes: this.compactClassificationText(project.notes, 180),
      }));
    const linkedContacts = this.resolveContactsForSource(input.source)
      .slice(0, 10)
      .map((contact) => {
        const scopedHint = this.bestAccountScopedHintForContact(input.source, contact.id);
        return {
          name: contact.name,
          organizationHint: contact.organizationHint,
          likelyRole: contact.likelyRole,
          importance: contact.importance,
          notes: this.compactClassificationText(contact.notes, 140),
          lastSeenAt: contact.lastSeenAt,
          defaultClientName: scopedHint?.clientId
            ? clientsById.get(scopedHint.clientId)?.name || null
            : contact.defaultClientId
              ? clientsById.get(contact.defaultClientId)?.name || null
              : null,
          defaultProjectName: scopedHint?.projectId
            ? input.projects.find((project) => project.id === scopedHint.projectId)?.name || null
            : contact.defaultProjectId
              ? input.projects.find((project) => project.id === contact.defaultProjectId)?.name || null
              : null,
          matchedIdentities: listContactIdentities(contact.id).slice(0, 4).map((identity) => identity.value),
        };
      });
    const operatorContext: SourceClassificationOperatorContext = {
      roleSummary: this.compactClassificationText(operator.roleSummary, 240),
      reportingPreferences: this.compactClassificationText(operator.reportingPreferences, 220),
      escalationPreferences: this.compactClassificationText(operator.escalationPreferences, 220),
      assistantStyle: this.compactClassificationText(operator.assistantStyle, 180),
      workHoursStart: operator.workHoursStart,
      workHoursEnd: operator.workHoursEnd,
    };
    const connectionContext: SourceClassificationConnectionContext = {
      provider: input.source.provider,
      accountLabel: input.source.accountLabel || null,
      accountId: input.source.accountId || null,
      defaultClientName: primaryClient?.name || null,
      defaultProjectName: defaultProject?.name || null,
      triageGuidance: this.compactClassificationText(
        input.settings.triageGuidance,
        900,
      ),
    };
    const payload = {
      operatorContext,
      connectionContext,
      clientProfiles,
      projectProfiles,
      contactProfiles: linkedContacts,
    };
    return {
      operatorContext,
      connectionContext,
      clientProfiles,
      projectProfiles,
      contactProfiles: linkedContacts,
      fingerprint: JSON.stringify(payload),
      hasTriageGuidance: Boolean(
        operator.roleSummary ||
        connectionContext.triageGuidance ||
          primaryClient?.roles.length ||
          primaryClient?.notes ||
          primaryClient?.communicationPreferences,
      ),
    };
  }

  private hasStoredModelTriage(source: SourceRecord | undefined | null): boolean {
    if (!source) return false;
    return (
      typeof source.metadata?.modelActionRequired === 'boolean' ||
      typeof source.metadata?.modelBlocker === 'boolean' ||
      typeof source.metadata?.modelFollowUpTitle === 'string' ||
      typeof source.metadata?.modelUrgency === 'string'
    );
  }

  private copyStoredModelTriage(target: SourceRecord, source: SourceRecord): void {
    const nextMetadata = { ...(target.metadata || {}) };
    for (const key of [
      'modelActionRequired',
      'modelBlocker',
      'modelFollowUpTitle',
      'modelUrgency',
      'modelContextFingerprint',
    ] as const) {
      if (source.metadata?.[key] !== undefined && nextMetadata[key] === undefined) {
        nextMetadata[key] = source.metadata[key];
      }
    }
    target.metadata = nextMetadata;
    const existingUrgency = sourceMetadataString(source, 'modelUrgency');
    if (!target.priority && existingUrgency) {
      target.priority = existingUrgency as PersonalOpsPriority;
    }
  }

  private applyRuleBasedAttribution(
    source: SourceRecord,
    clients: Client[],
    projects: Project[],
    repositories: GitRepository[],
    connectionSettings?: PersonalOpsConnectionSettings,
  ): void {
    const signals = collectSourceSignals(source);
    const projectScores = new Map<
      string,
      {
        score: number;
        reasons: string[];
        diagnostics: PersonalOpsAttributionDiagnostic[];
      }
    >();
    const clientScores = new Map<
      string,
      {
        score: number;
        reasons: string[];
        diagnostics: PersonalOpsAttributionDiagnostic[];
      }
    >();
    const projectsByClient = new Map<string, Project[]>();
    const addProjectScore = (
      projectId: string,
      score: number,
      reason: string,
      diagnostic: PersonalOpsAttributionDiagnostic,
    ) => {
      const current = projectScores.get(projectId) || {
        score: 0,
        reasons: [],
        diagnostics: [],
      };
      current.score += score;
      if (!current.reasons.includes(reason)) {
        current.reasons.push(reason);
      }
      appendAttributionDiagnostic(current.diagnostics, diagnostic);
      projectScores.set(projectId, current);
    };
    const addClientScore = (
      clientId: string,
      score: number,
      reason: string,
      diagnostic: PersonalOpsAttributionDiagnostic,
    ) => {
      const current = clientScores.get(clientId) || {
        score: 0,
        reasons: [],
        diagnostics: [],
      };
      current.score += score;
      if (!current.reasons.includes(reason)) {
        current.reasons.push(reason);
      }
      appendAttributionDiagnostic(current.diagnostics, diagnostic);
      clientScores.set(clientId, current);
    };
    for (const project of projects) {
      if (!project.clientId) continue;
      const clientProjects = projectsByClient.get(project.clientId) || [];
      clientProjects.push(project);
      projectsByClient.set(project.clientId, clientProjects);
    }

    if (connectionSettings?.defaultClientId) {
      addClientScore(
        connectionSettings.defaultClientId,
        16,
        'connection default client',
        createAttributionDiagnostic('connection_default', 'client default'),
      );
    }
    if (connectionSettings?.defaultProjectId) {
      addProjectScore(
        connectionSettings.defaultProjectId,
        18,
        'connection default project',
        createAttributionDiagnostic('connection_default', 'project default'),
      );
    }

    if (source.accountId && source.provider !== 'manual') {
      const hintIdentities = new Set(sourceIdentityValues(source));
      for (const hint of listAccountScopedContactHints({
        provider: source.provider,
        accountId: source.accountId,
        limit: 120,
      })) {
        if (hint.status === 'rejected') continue;
        if (!hintIdentities.has(hint.identityValue)) continue;
        if (hint.clientId) {
          addClientScore(
            hint.clientId,
            14,
            `account-scoped contact hint for ${source.accountLabel || source.accountId}`,
            createAttributionDiagnostic(
              'workspace_match',
              source.accountLabel || source.accountId || 'account hint',
            ),
          );
        }
        if (hint.projectId) {
          addProjectScore(
            hint.projectId,
            15,
            `account-scoped project hint for ${source.accountLabel || source.accountId}`,
            createAttributionDiagnostic(
              'workspace_match',
              source.accountLabel || source.accountId || 'account hint',
            ),
          );
        }
      }
    }

    for (const contact of this.resolveContactsForSource(source)) {
      if (contact.defaultClientId) {
        addClientScore(
          contact.defaultClientId,
          10,
          `contact default for ${contact.name}`,
          createAttributionDiagnostic('client_match', contact.name),
        );
      }
      if (contact.defaultProjectId) {
        addProjectScore(
          contact.defaultProjectId,
          11,
          `contact project default for ${contact.name}`,
          createAttributionDiagnostic('project_match', contact.name),
        );
      }
    }

    const sourceProjectKey =
      typeof source.metadata?.projectKey === 'string'
        ? source.metadata.projectKey.trim().toUpperCase()
        : '';
    const sourceProjectName =
      typeof source.metadata?.projectName === 'string'
        ? source.metadata.projectName.trim()
        : '';

    for (const project of projects) {
      if (includesAlias(signals.haystack, signals.normalizedHaystack, project.name)) {
        addProjectScore(
          project.id,
          8,
          `project name "${project.name}"`,
          createAttributionDiagnostic('project_match', project.name),
        );
      }
      for (const tag of project.tags) {
        if (includesAlias(signals.haystack, signals.normalizedHaystack, tag)) {
          addProjectScore(
            project.id,
            10,
            `project tag "${tag}"`,
            createAttributionDiagnostic('project_match', tag),
          );
        }
        if (sourceProjectKey && tag.trim().toUpperCase() === sourceProjectKey) {
          addProjectScore(
            project.id,
            12,
            `Jira project key "${sourceProjectKey}"`,
            createAttributionDiagnostic('jira_key', sourceProjectKey),
          );
        }
      }
      if (
        sourceProjectName &&
        includesAlias(
          sourceProjectName.toLowerCase(),
          normalizeMatchText(sourceProjectName),
          project.name,
        )
      ) {
        addProjectScore(
          project.id,
          11,
          `source project name "${sourceProjectName}"`,
          createAttributionDiagnostic('project_match', sourceProjectName),
        );
      }
    }

    for (const client of clients) {
      if (includesAlias(signals.haystack, signals.normalizedHaystack, client.name)) {
        addClientScore(
          client.id,
          7,
          `client name "${client.name}"`,
          createAttributionDiagnostic('client_match', client.name),
        );
      }
      const explicitDomains = extractExplicitDomains(client.communicationPreferences);
      for (const domain of explicitDomains) {
        if (signals.domains.some((entry) => entry === domain || entry.endsWith(`.${domain}`))) {
          addClientScore(
            client.id,
            12,
            `communication domain "${domain}"`,
            createAttributionDiagnostic('domain_match', domain),
          );
        }
      }
      const normalizedClientName = normalizeMatchText(client.name);
      if (
        normalizedClientName.length >= 5 &&
        signals.domains.some((domain) =>
          normalizeMatchText(domain).includes(normalizedClientName),
        )
      ) {
        addClientScore(
          client.id,
          9,
          `domain match for "${client.name}"`,
          createAttributionDiagnostic('domain_match', client.name),
        );
      }
      if (
        source.accountLabel &&
        includesAlias(
          source.accountLabel.toLowerCase(),
          normalizeMatchText(source.accountLabel),
          client.name,
        )
      ) {
        addClientScore(
          client.id,
          6,
          `account label "${source.accountLabel}"`,
          createAttributionDiagnostic('workspace_match', source.accountLabel),
        );
      }
    }

    for (const repository of repositories) {
      const aliases = repositoryAliases(repository);
      if (aliases.some((alias) => includesAlias(signals.haystack, signals.normalizedHaystack, alias))) {
        if (repository.projectId) {
          addProjectScore(
            repository.projectId,
            9,
            `repository "${repository.name}"`,
            createAttributionDiagnostic('repo_alias', repository.name),
          );
        }
        if (repository.clientId) {
          addClientScore(
            repository.clientId,
            6,
            `repository "${repository.name}"`,
            createAttributionDiagnostic('repo_alias', repository.name),
          );
        }
      }
    }

    for (const [clientId, result] of [...clientScores.entries()]) {
      if (result.score < 11) continue;
      const eligibleProjects = (projectsByClient.get(clientId) || []).filter(
        (project) => project.status !== 'archived' && project.status !== 'on_hold',
      );
      if (eligibleProjects.length === 1) {
        addProjectScore(
          eligibleProjects[0].id,
          9,
          `single active project for client "${clients.find((client) => client.id === clientId)?.name || clientId}"`,
          createAttributionDiagnostic(
            'single_project_fallback',
            clients.find((client) => client.id === clientId)?.name || clientId,
          ),
        );
      }
    }

    const bestProject = [...projectScores.entries()]
      .sort((a, b) => b[1].score - a[1].score)[0];
    if (bestProject && bestProject[1].score >= 8) {
      const project = projects.find((entry) => entry.id === bestProject[0]);
      if (project) {
        const relatedClientScore = project.clientId
          ? clientScores.get(project.clientId) || null
          : null;
        const combinedReasons = [...bestProject[1].reasons];
        const combinedDiagnostics = [...bestProject[1].diagnostics];
        for (const reason of relatedClientScore?.reasons || []) {
          if (!combinedReasons.includes(reason)) {
            combinedReasons.push(reason);
          }
        }
        for (const diagnostic of relatedClientScore?.diagnostics || []) {
          appendAttributionDiagnostic(combinedDiagnostics, diagnostic);
        }
        source.projectId = project.id;
        source.clientId = source.clientId || project.clientId || null;
        source.attributionSource = 'rule';
        source.attributionConfidence = attributionConfidence(bestProject[1].score);
        source.metadata = {
          ...(source.metadata || {}),
          attributionRule: combinedReasons.join(', '),
          attributionDiagnostics: combinedDiagnostics,
        };
        return;
      }
    }

    const bestClient = [...clientScores.entries()]
      .sort((a, b) => b[1].score - a[1].score)[0];
    if (bestClient && bestClient[1].score >= 7) {
      const client = clients.find((entry) => entry.id === bestClient[0]);
      if (client) {
        source.clientId = client.id;
        source.attributionSource = 'rule';
        source.attributionConfidence = attributionConfidence(bestClient[1].score);
        source.metadata = {
          ...(source.metadata || {}),
          attributionRule: bestClient[1].reasons.join(', '),
          attributionDiagnostics: bestClient[1].diagnostics,
        };
      }
    }
  }

  private currentConnectionSettingsByKey(): Map<string, PersonalOpsConnectionSettings> {
    return new Map(
      this.listConnections()
        .filter((connection) => Boolean(connection.accountId))
        .map((connection) => [connection.connectionKey, connection.settings || {}] as const),
    );
  }

  private refreshSourceMetadata(source: SourceRecord): SourceRecord {
    const next: SourceRecord = {
      ...source,
      metadata: { ...(source.metadata || {}) },
    };
    const linkedContactIds =
      next.linkedContactIds || sourceMetadataStringArray(next, 'linkedContactIds');
    next.linkedContactIds = linkedContactIds;
    next.attention = sourceAttention(next);
    next.reviewState = sourceReviewState(next);
    next.threadState = sourceThreadState(next);
    next.metadata = {
      ...(next.metadata || {}),
      linkedContactIds,
      attention: next.attention,
      reviewState: next.reviewState,
      threadState: next.threadState,
    };
    return next;
  }

  private reprocessStoredSource(
    source: SourceRecord,
    input?: {
      clients?: Client[];
      projects?: Project[];
      repositories?: GitRepository[];
      connectionSettingsByKey?: Map<string, PersonalOpsConnectionSettings>;
    },
  ): void {
    const clients = input?.clients || listClients();
    const projects = input?.projects || listProjects();
    const repositories = input?.repositories || listRepositories();
    const connectionSettingsByKey =
      input?.connectionSettingsByKey || this.currentConnectionSettingsByKey();
    const next: SourceRecord = {
      ...source,
      metadata: { ...(source.metadata || {}) },
    };
    const nextMetadata = next.metadata || {};
    next.metadata = nextMetadata;

    if (next.attributionSource !== 'manual' && next.attributionSource !== 'external') {
      const previousClientId = next.clientId || null;
      const previousProjectId = next.projectId || null;
      const previousAttributionSource =
        next.attributionSource && next.attributionSource !== 'none'
          ? next.attributionSource
          : undefined;
      const previousAttributionConfidence = next.attributionConfidence ?? null;
      const previousAttributionRule = nextMetadata.attributionRule;
      const previousAttributionDiagnostics = nextMetadata.attributionDiagnostics;
      const connectionSettings =
        connectionSettingsByKey.get(
          getConnectionKey(next.provider, next.accountId ?? null),
        ) || {};

      next.clientId = null;
      next.projectId = null;
      next.attributionSource = 'none';
      next.attributionConfidence = null;
      delete nextMetadata.attributionRule;
      delete nextMetadata.attributionDiagnostics;
      this.applyRuleBasedAttribution(
        next,
        clients,
        projects,
        repositories,
        connectionSettings,
      );
      if (!next.clientId && !next.projectId && (previousClientId || previousProjectId)) {
        next.clientId = previousClientId;
        next.projectId = previousProjectId;
        next.attributionSource = previousAttributionSource;
        next.attributionConfidence = previousAttributionConfidence;
        if (previousAttributionRule !== undefined) {
          nextMetadata.attributionRule = previousAttributionRule;
        }
        if (previousAttributionDiagnostics !== undefined) {
          nextMetadata.attributionDiagnostics = previousAttributionDiagnostics;
        }
      }
    }

    const ignoreRule = listSourceIgnoreRules().find((rule) =>
      sourceMatchesIgnoreRule(next, rule),
    );
    if (ignoreRule) {
      applySourceIgnoreRule(next, ignoreRule);
    }

    const refreshed = this.refreshSourceMetadata(next);
    upsertSourceRecord(refreshed);
    this.materializeDerivedRecords(refreshed);
  }

  private reprocessStoredSources(input?: {
    provider?: PersonalOpsProvider | 'manual';
    accountId?: string | null;
  }): void {
    const clients = listClients();
    const projects = listProjects();
    const repositories = listRepositories();
    const connectionSettingsByKey = this.currentConnectionSettingsByKey();
    const sources = listSourceRecords({ limit: 5000 }).filter((source) => {
      if (input?.provider && source.provider !== input.provider) return false;
      if (input && Object.prototype.hasOwnProperty.call(input, 'accountId')) {
        return (source.accountId || null) === (input.accountId || null);
      }
      return true;
    });

    for (const source of sources) {
      this.reprocessStoredSource(source, {
        clients,
        projects,
        repositories,
        connectionSettingsByKey,
      });
    }
  }

  private materializeDerivedRecords(source: SourceRecord): void {
    const sourceRecordKey = getSourceRecordKey(
      source.provider,
      source.accountId ?? null,
      source.kind,
      source.externalId,
    );
    const attention = sourceAttention(source);
    const threadState = sourceThreadState(source);
    const linkedContactIds =
      source.linkedContactIds || sourceMetadataStringArray(source, 'linkedContactIds');
    const needsReview = sourceNeedsReview(source);
    const workStatusOverride = sourceWorkItemStatusOverride(source);

    addActivity({
      id: `activity:${sourceRecordKey}`,
      timestamp: source.occurredAt,
      type: source.kind,
      sourceProvider: source.provider === 'manual' ? 'manual' : source.provider,
      sourceKind: source.kind,
      sourceRecordKey,
      relatedClientId: source.clientId || null,
      relatedProjectId: source.projectId || null,
      summary: source.title,
      rawReference: source.sourceUrl || source.rawSnapshotRef || null,
      metadata: source.metadata || {},
    });

    if (source.kind === 'jira_issue') {
      upsertWorkItem({
        id: `work:${sourceRecordKey}`,
        title: source.title,
        sourceKind: source.kind,
        sourceProvider: source.provider,
        sourceRecordKey,
        clientId: source.clientId || null,
        projectId: source.projectId || null,
        dueDate: source.dueAt || null,
        priority: clampPriority(source.priority),
        status: workStatusOverride || workItemStatusFromSource(source),
        confidence:
          attention.mappingConfidence ??
          attention.actionConfidence ??
          source.attributionConfidence ??
          null,
        needsReview,
        linkedContactIds,
        openLoopState: workStatusOverride
          ? workItemStateFromStatus(workStatusOverride)
          : workItemStatusFromSource(source) === 'blocked'
            ? 'blocked'
            : workItemStatusFromSource(source) === 'waiting' ||
                workItemStatusFromSource(source) === 'on_hold'
              ? 'waiting'
              : threadStateTone(threadState.state),
        notes: source.summary,
      });
      return;
    }

    if (source.kind === 'email' && isLikelyNoiseEmail(source)) {
      const existing = getWorkItem(`work:${sourceRecordKey}`);
      if (existing && existing.status !== 'done' && existing.status !== 'ignored') {
        upsertWorkItem({
          ...existing,
          status: 'ignored',
          needsReview: false,
          openLoopState: 'closed',
        });
      }
      return;
    }

    const actionable =
      source.kind === 'manual_task' ||
      attention.actionRequired ||
      attention.operationalRisk;
    const existing = getWorkItem(`work:${sourceRecordKey}`);
    if (!actionable) {
      if (existing && existing.status !== 'done' && existing.status !== 'ignored') {
        upsertWorkItem({
          ...existing,
          status: 'ignored',
          needsReview: false,
          openLoopState: 'closed',
        });
      }
      return;
    }

    if (
      (existing?.status === 'done' || existing?.status === 'ignored') &&
      !workStatusOverride
    ) {
      return;
    }

    const derivedStatus =
      source.kind === 'calendar_event'
        ? 'waiting'
        : source.metadata?.modelBlocker === true
          ? 'blocked'
          : 'open';
    const nextStatus = workStatusOverride || derivedStatus;

    upsertWorkItem({
      id: `work:${sourceRecordKey}`,
      title:
        source.kind === 'manual_task'
          ? source.title
          : sourceMetadataString(source, 'modelFollowUpTitle') ||
            (source.title.startsWith('Re:')
              ? source.title
              : `Follow up: ${source.title}`),
      sourceKind: source.kind,
      sourceProvider: source.provider,
      sourceRecordKey,
      clientId: source.clientId || null,
      projectId: source.projectId || null,
      dueDate: source.dueAt || null,
      priority: clampPriority(source.priority),
      status: nextStatus,
      confidence:
        attention.actionConfidence ??
        attention.mappingConfidence ??
        source.attributionConfidence ??
        null,
      needsReview,
      linkedContactIds,
      openLoopState: workStatusOverride
        ? workItemStateFromStatus(workStatusOverride)
        : source.kind === 'calendar_event'
          ? 'waiting'
          : source.metadata?.modelBlocker === true
            ? 'blocked'
            : threadStateTone(threadState.state),
      notes: source.summary,
    });
  }

  createManualTask(input: {
    title: string;
    notes?: string;
    clientId?: string | null;
    projectId?: string | null;
    dueDate?: string | null;
    priority?: PersonalOpsPriority;
  }): WorkItem {
    const externalId = `manual-task-${Date.now()}`;
    const source: SourceRecord = {
      connectionKey: getConnectionKey('manual', null),
      provider: 'manual',
      accountId: null,
      accountLabel: null,
      kind: 'manual_task',
      externalId,
      title: input.title,
      summary: input.notes || '',
      body: input.notes || '',
      participants: [],
      occurredAt: new Date().toISOString(),
      dueAt: input.dueDate ?? null,
      priority: input.priority || 'medium',
      status: 'open',
      syncedAt: new Date().toISOString(),
      clientId: input.clientId ?? null,
      projectId: input.projectId ?? null,
      attributionSource: 'manual',
      attributionConfidence: 1,
      metadata: {},
    };
    upsertSourceRecord(source);
    this.materializeDerivedRecords(source);
    this.writePublicSnapshots();
    return getWorkItem(`work:${getSourceRecordKey('manual', null, 'manual_task', externalId)}`)!;
  }

  createManualNote(input: {
    title: string;
    body?: string;
    clientId?: string | null;
    projectId?: string | null;
  }): SourceRecord {
    const externalId = `manual-note-${Date.now()}`;
    const source: SourceRecord = {
      connectionKey: getConnectionKey('manual', null),
      provider: 'manual',
      accountId: null,
      accountLabel: null,
      kind: 'manual_note',
      externalId,
      title: input.title,
      summary: input.body || '',
      body: input.body || '',
      participants: [],
      occurredAt: new Date().toISOString(),
      priority: 'low',
      status: 'logged',
      syncedAt: new Date().toISOString(),
      clientId: input.clientId ?? null,
      projectId: input.projectId ?? null,
      attributionSource: 'manual',
      attributionConfidence: 1,
      metadata: {},
    };
    upsertSourceRecord(source);
    this.materializeDerivedRecords(source);
    this.writePublicSnapshots();
    return source;
  }

  upsertClient(input: {
    id?: string;
    name: string;
    parentClientId?: string | null;
    roles?: string[];
    status?: Client['status'];
    notes?: string;
    communicationPreferences?: string;
  }): Client {
    const client = upsertClient(input);
    this.reprocessStoredSources();
    this.writePublicSnapshots();
    return client;
  }

  upsertProject(input: {
    id?: string;
    clientId?: string | null;
    name: string;
    status?: Project['status'];
    priority?: PersonalOpsPriority;
    deadline?: string | null;
    notes?: string;
    tags?: string[];
  }): Project {
    const project = upsertProject(input);
    this.reprocessStoredSources();
    this.writePublicSnapshots();
    return project;
  }

  upsertRepository(input: {
    id?: string;
    clientId?: string | null;
    projectId?: string | null;
    name?: string;
    localPath: string;
    notes?: string;
  }): GitRepository {
    const inspected = inspectGitRepository(input.localPath);
    const project = input.projectId ? getProject(input.projectId) : undefined;
    const repository = upsertRepository({
      id: input.id,
      clientId: project?.clientId ?? input.clientId ?? null,
      projectId: input.projectId ?? null,
      name: input.name?.trim() || inspected.name,
      localPath: inspected.localPath,
      remoteUrl: inspected.remoteUrl,
      defaultBranch: inspected.defaultBranch,
      lastCommitAt: inspected.lastCommitAt,
      notes: input.notes?.trim() || '',
    });
    this.refreshRepositoryActivityIfDue(true);
    this.reprocessStoredSources();
    this.writePublicSnapshots();
    return repository;
  }

  discoverRepositories(input?: {
    rootPath?: string;
    maxDepth?: number;
  }): GitRepository[] {
    const rootPath = expandHomePath(input?.rootPath || '~');
    const resolvedRoot = path.resolve(rootPath);
    const maxDepth = input?.maxDepth ?? 5;
    const visitedDirs = new Set<string>();
    const discoveredRoots = new Set<string>();

    const walk = (currentPath: string, depth: number) => {
      let realPath = currentPath;
      try {
        realPath = fs.realpathSync(currentPath);
      } catch {
        return;
      }
      if (visitedDirs.has(realPath)) return;
      visitedDirs.add(realPath);

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(realPath, { withFileTypes: true });
      } catch {
        return;
      }

      if (entries.some((entry) => entry.name === '.git')) {
        try {
          discoveredRoots.add(inspectGitRepository(realPath).localPath);
        } catch {
          discoveredRoots.add(realPath);
        }
        return;
      }

      if (depth >= maxDepth) return;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (shouldSkipDiscoveryDir(entry.name)) continue;
        walk(path.join(realPath, entry.name), depth + 1);
      }
    };

    walk(resolvedRoot, 0);

    const repositories = [...discoveredRoots]
      .sort((a, b) => a.localeCompare(b))
      .map((repoPath) =>
        this.upsertRepository({
          localPath: repoPath,
        }),
      );

    this.writePublicSnapshots();
    return repositories;
  }

  recordCorrection(input: {
    targetType: Correction['targetType'];
    targetId: string;
    field: string;
    value: string;
  }): Correction {
    const correction = addCorrection(input);
    if (input.targetType === 'source_record') {
      const parsedSource = parseSourceRecordKey(input.targetId);
      if (parsedSource) {
        const source = getSourceRecord(
          parsedSource.provider,
          parsedSource.accountId,
          parsedSource.kind,
          parsedSource.externalId,
        );
        if (source) {
          const nextMetadata = { ...(source.metadata || {}) };
          if (input.field === 'clientId') {
            source.clientId = input.value || null;
            source.attributionSource = 'manual';
            source.attributionConfidence = 1;
          } else if (input.field === 'projectId') {
            source.projectId = input.value || null;
            source.attributionSource = 'manual';
            source.attributionConfidence = 1;
          } else if (input.field === 'priority') {
            source.priority = clampPriority(input.value);
          } else if (input.field === 'workflowStatus') {
            if (input.value === 'open') {
              delete nextMetadata.workItemStatusOverride;
            } else {
              nextMetadata.workItemStatusOverride = input.value;
            }
          } else if (
            input.field === 'hideFromSummaries' ||
            input.field === 'noisy'
          ) {
            const hidden = input.value === 'true';
            source.status = hidden ? 'filtered' : 'received';
            nextMetadata.likelyNoise = hidden;
            if (hidden) {
              nextMetadata.workItemStatusOverride = 'ignored';
            } else if (nextMetadata.workItemStatusOverride === 'ignored') {
              delete nextMetadata.workItemStatusOverride;
            }
          } else if (input.field === 'status') {
            source.status = input.value || null;
            if (input.value === 'filtered') {
              nextMetadata.likelyNoise = true;
            }
          } else if (input.field === 'awarenessOnly') {
            const awarenessOnly = input.value === 'true';
            const existingAttention = sourceAttention(source);
            source.reviewState = awarenessOnly ? 'accepted' : source.reviewState || null;
            nextMetadata.attention = {
              ...existingAttention,
              awarenessOnly,
              actionRequired: awarenessOnly ? false : existingAttention.actionRequired,
            };
            nextMetadata.modelActionRequired = awarenessOnly ? false : existingAttention.actionRequired;
            nextMetadata.reviewState = source.reviewState;
            if (awarenessOnly) {
              nextMetadata.workItemStatusOverride = 'ignored';
            } else if (nextMetadata.workItemStatusOverride === 'ignored') {
              delete nextMetadata.workItemStatusOverride;
            }
          } else if (input.field === 'ignoreTask') {
            if (input.value === 'true') {
              nextMetadata.workItemStatusOverride = 'ignored';
            } else if (nextMetadata.workItemStatusOverride === 'ignored') {
              delete nextMetadata.workItemStatusOverride;
            }
          } else if (input.field === 'ignoreSimilar') {
            const rule = buildSourceIgnoreRule(source);
            if (rule) {
              const existingRules = listSourceIgnoreRules();
              const alreadyExists = existingRules.some((entry) =>
                sourceMatchesIgnoreRule(source, entry),
              );
              if (!alreadyExists) {
                saveSourceIgnoreRules([rule, ...existingRules].slice(0, 200));
              }
              const matchingRule = alreadyExists
                ? existingRules.find((entry) => sourceMatchesIgnoreRule(source, entry)) || rule
                : rule;
              const matchingSources = listSourceRecords({
                provider: source.provider,
                accountId: source.accountId ?? null,
                kind: source.kind,
                limit: 1000,
              }).filter((entry) => sourceMatchesIgnoreRule(entry, matchingRule));
              for (const matchingSource of matchingSources) {
                applySourceIgnoreRule(matchingSource, matchingRule);
                matchingSource.metadata = {
                  ...(matchingSource.metadata || {}),
                  workItemStatusOverride: 'ignored',
                };
                this.reprocessStoredSource(matchingSource);
              }
              applySourceIgnoreRule(source, matchingRule);
              nextMetadata.workItemStatusOverride = 'ignored';
            }
          }
          source.metadata = nextMetadata;
          this.reprocessStoredSource(source);
        }
      }
    } else if (input.targetType === 'work_item') {
      const workItem = getWorkItem(input.targetId);
      if (workItem) {
        if (input.field === 'status') {
          upsertWorkItem({ ...workItem, status: input.value as WorkItem['status'] });
        } else if (input.field === 'priority') {
          upsertWorkItem({ ...workItem, priority: clampPriority(input.value) });
        } else if (input.field === 'clientId') {
          upsertWorkItem({ ...workItem, clientId: input.value || null });
        } else if (input.field === 'projectId') {
          upsertWorkItem({ ...workItem, projectId: input.value || null });
        }
        if (workItem.sourceRecordKey) {
          const parsedSource = parseSourceRecordKey(workItem.sourceRecordKey);
          if (parsedSource) {
            const source = getSourceRecord(
              parsedSource.provider,
              parsedSource.accountId,
              parsedSource.kind,
              parsedSource.externalId,
            );
            if (source) {
              const nextMetadata = { ...(source.metadata || {}) };
              if (input.field === 'status') {
                if (input.value === 'open') {
                  delete nextMetadata.workItemStatusOverride;
                } else {
                  nextMetadata.workItemStatusOverride = input.value;
                }
              } else if (input.field === 'priority') {
                source.priority = clampPriority(input.value);
              } else if (input.field === 'clientId') {
                source.clientId = input.value || null;
                source.attributionSource = 'manual';
                source.attributionConfidence = 1;
              } else if (input.field === 'projectId') {
                source.projectId = input.value || null;
                source.attributionSource = 'manual';
                source.attributionConfidence = 1;
              }
              source.metadata = nextMetadata;
              this.reprocessStoredSource(source);
            }
          }
        }
      }
    } else if (input.targetType === 'preference') {
      setPreference(input.field, input.value);
    }
    this.writePublicSnapshots();
    return correction;
  }

  private buildWorkstreams(input?: {
    since?: string;
    until?: string;
    limit?: number;
    activeOnly?: boolean;
    includeNoise?: boolean;
  }): PersonalOpsWorkstream[] {
    this.refreshRepositoryActivityIfDue();

    const clients = listClients();
    const projects = listProjects();
    const repositories = listRepositories();
    const clientById = new Map(clients.map((client) => [client.id, client]));
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const hasExplicitRange = Boolean(input?.since || input?.until);
    const bucketLimit = Math.max((input?.limit || 20) * 12, 240);
    const bucketContactIds = new Map<string, Set<string>>();

    const resolveIds = (clientId?: string | null, projectId?: string | null) => {
      const project = projectId ? projectById.get(projectId) || null : null;
      return {
        clientId: clientId || project?.clientId || null,
        projectId: project?.id || null,
      };
    };

    const shouldKeepItem = (item: WorkItem) => {
      if (this.isNoiseDerivedWorkItem(item)) return false;
      if (input?.activeOnly && (item.status === 'done' || item.status === 'ignored')) {
        return false;
      }
      if (!hasExplicitRange) {
        return true;
      }
      const updatedAt = new Date(item.updatedAt).getTime();
      const createdAt = new Date(item.createdAt).getTime();
      const dueAt = item.dueDate ? new Date(item.dueDate).getTime() : Number.NaN;
      const since = input?.since ? new Date(input.since).getTime() : Number.NEGATIVE_INFINITY;
      const until = input?.until ? new Date(input.until).getTime() : Number.POSITIVE_INFINITY;
      const touchedInRange =
        (updatedAt >= since && updatedAt <= until) ||
        (createdAt >= since && createdAt <= until) ||
        (!Number.isNaN(dueAt) && dueAt >= since && dueAt <= until);
      if (touchedInRange) return true;
      return input?.activeOnly
        ? item.status !== 'done' && item.status !== 'ignored'
        : false;
    };

    const relevantSources = listSourceRecords({
      since: input?.since,
      until: input?.until,
      limit: bucketLimit,
    }).filter((source) => {
      if (source.kind === 'report') return false;
      if (!input?.includeNoise && isLikelyNoiseEmail(source)) return false;
      return true;
    });

    const relevantActivities = listActivities({
      since: input?.since || plusDays(new Date(), -7).toISOString(),
      until: input?.until,
      limit: bucketLimit,
    }).filter((activity) => activity.type === 'git_commit' || !activity.sourceRecordKey);

    const relevantWorkItems = listWorkItems({ limit: Math.max(bucketLimit, 400) }).filter(shouldKeepItem);

    const buckets = new Map<string, PersonalOpsWorkstream>();
    const ensureBucket = (clientId?: string | null, projectId?: string | null) => {
      const resolved = resolveIds(clientId, projectId);
      const key = `${resolved.clientId || 'none'}:${resolved.projectId || 'none'}`;
      const existing = buckets.get(key);
      if (existing) {
        return existing;
      }
      const created: PersonalOpsWorkstream = {
        key,
        client: resolved.clientId ? clientById.get(resolved.clientId) || null : null,
        project: resolved.projectId ? projectById.get(resolved.projectId) || null : null,
        items: [],
        sourceRecords: [],
        recentActivity: [],
        repositories: [],
        linkedContacts: [],
        links: [],
        lastUpdatedAt: null,
        nextDueAt: null,
        blockerCount: 0,
        waitingCount: 0,
        openLoopCount: 0,
        needsReviewCount: 0,
        signals: [],
      };
      buckets.set(key, created);
      bucketContactIds.set(key, new Set<string>());
      return created;
    };

    for (const item of relevantWorkItems) {
      const bucket = ensureBucket(item.clientId, item.projectId);
      bucket.items.push(item);
      if (item.status === 'blocked') bucket.blockerCount += 1;
      if (item.status === 'waiting' || item.status === 'on_hold') bucket.waitingCount += 1;
      bucket.lastUpdatedAt = latestIso(bucket.lastUpdatedAt, item.updatedAt, item.createdAt);
      bucket.nextDueAt = earliestFutureIso(bucket.nextDueAt, item.dueDate);
      const contactIds = bucketContactIds.get(bucket.key)!;
      for (const contactId of item.linkedContactIds || []) {
        contactIds.add(contactId);
      }
    }

    for (const source of relevantSources) {
      if (!source.clientId && !source.projectId) {
        continue;
      }
      const bucket = ensureBucket(source.clientId, source.projectId);
      if (bucket.sourceRecords.length < 8) {
        bucket.sourceRecords.push(source);
      }
      bucket.lastUpdatedAt = latestIso(
        bucket.lastUpdatedAt,
        source.occurredAt,
        source.syncedAt,
      );
      bucket.nextDueAt = earliestFutureIso(bucket.nextDueAt, source.dueAt);
      const contactIds = bucketContactIds.get(bucket.key)!;
      for (const contactId of source.linkedContactIds || sourceMetadataStringArray(source, 'linkedContactIds')) {
        contactIds.add(contactId);
      }
    }

    for (const activity of relevantActivities) {
      if (!activity.relatedClientId && !activity.relatedProjectId) {
        continue;
      }
      const bucket = ensureBucket(activity.relatedClientId, activity.relatedProjectId);
      if (bucket.recentActivity.length < 8) {
        bucket.recentActivity.push(activity);
      }
      bucket.lastUpdatedAt = latestIso(bucket.lastUpdatedAt, activity.timestamp);
    }

    for (const repository of repositories) {
      if (!repository.clientId && !repository.projectId) continue;
      const resolved = resolveIds(repository.clientId, repository.projectId);
      const existingKey = `${resolved.clientId || 'none'}:${resolved.projectId || 'none'}`;
      if (hasExplicitRange && !buckets.has(existingKey)) {
        const repoLastTouched = repository.lastCommitAt
          ? new Date(repository.lastCommitAt).getTime()
          : Number.NaN;
        const since = input?.since ? new Date(input.since).getTime() : Number.NEGATIVE_INFINITY;
        const until = input?.until ? new Date(input.until).getTime() : Number.POSITIVE_INFINITY;
        if (Number.isNaN(repoLastTouched) || repoLastTouched < since || repoLastTouched > until) {
          continue;
        }
      }
      const bucket = ensureBucket(repository.clientId, repository.projectId);
      bucket.repositories.push(repository);
      bucket.lastUpdatedAt = latestIso(
        bucket.lastUpdatedAt,
        repository.lastCommitAt,
        repository.updatedAt,
      );
    }

    const streams = [...buckets.values()]
      .map((bucket) => {
        bucket.linkedContacts = [...(bucketContactIds.get(bucket.key) || new Set<string>())]
          .map((contactId) => getContact(contactId))
          .filter((contact): contact is Contact => Boolean(contact))
          .slice(0, 8);
        bucket.items.sort((a, b) => {
          const order = { urgent: 0, high: 1, medium: 2, low: 3 };
          return order[a.priority] - order[b.priority];
        });
        bucket.sourceRecords.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
        bucket.recentActivity.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        bucket.repositories.sort((a, b) => {
          const aTime = a.lastCommitAt ? new Date(a.lastCommitAt).getTime() : 0;
          const bTime = b.lastCommitAt ? new Date(b.lastCommitAt).getTime() : 0;
          return bTime - aTime;
        });

        const links = new Map<string, PersonalOpsWorkstreamLink>();
        const touchLink = (
          key: string,
          input: {
            label: string;
            kind: PersonalOpsWorkstreamLink['kind'];
            lastUpdatedAt?: string | null;
            item?: boolean;
            source?: boolean;
            activity?: boolean;
            repository?: boolean;
          },
        ) => {
          const existing = links.get(key) || {
            key,
            label: input.label,
            kind: input.kind,
            itemCount: 0,
            sourceCount: 0,
            activityCount: 0,
            repositoryCount: 0,
            lastUpdatedAt: null,
          };
          if (input.item) existing.itemCount += 1;
          if (input.source) existing.sourceCount += 1;
          if (input.activity) existing.activityCount += 1;
          if (input.repository) existing.repositoryCount += 1;
          existing.lastUpdatedAt = latestIso(existing.lastUpdatedAt, input.lastUpdatedAt);
          links.set(key, existing);
        };

        for (const item of bucket.items) {
          for (const issueKey of extractIssueKeys(item.title, item.notes)) {
            touchLink(`jira:${issueKey}`, {
              label: issueKey,
              kind: 'jira_issue',
              lastUpdatedAt: item.updatedAt,
              item: true,
            });
          }
        }

        for (const source of bucket.sourceRecords) {
          for (const issueKey of extractIssueKeys(
            source.kind === 'jira_issue' ? source.externalId : null,
            source.title,
            source.summary,
            source.body,
          )) {
            touchLink(`jira:${issueKey}`, {
              label: issueKey,
              kind: 'jira_issue',
              lastUpdatedAt: source.occurredAt,
              source: true,
            });
          }
          if (source.kind === 'email' && source.externalParentId) {
            touchLink(`email-thread:${source.provider}:${source.externalParentId}`, {
              label: 'Email thread',
              kind: 'email_thread',
              lastUpdatedAt: source.occurredAt,
              source: true,
            });
          }
          if (source.kind === 'slack_message' && source.externalParentId) {
            const channelLabel =
              typeof source.metadata?.channelLabel === 'string'
                ? source.metadata.channelLabel
                : 'Slack thread';
            touchLink(`slack-thread:${source.externalParentId}`, {
              label: `${channelLabel} thread`,
              kind: 'slack_thread',
              lastUpdatedAt: source.occurredAt,
              source: true,
            });
          }
        }

        for (const activity of bucket.recentActivity) {
          for (const issueKey of extractIssueKeys(activity.summary, activity.rawReference)) {
            touchLink(`jira:${issueKey}`, {
              label: issueKey,
              kind: 'jira_issue',
              lastUpdatedAt: activity.timestamp,
              activity: true,
            });
          }
          if (activity.type === 'git_commit') {
            const repoId =
              typeof activity.metadata?.repoId === 'string'
                ? activity.metadata.repoId
                : null;
            const repoName =
              typeof activity.metadata?.repoName === 'string'
                ? activity.metadata.repoName
                : 'Repository';
            if (repoId) {
              touchLink(`repo:${repoId}`, {
                label: repoName,
                kind: 'repository',
                lastUpdatedAt: activity.timestamp,
                activity: true,
              });
            }
          }
        }

        for (const repository of bucket.repositories) {
          touchLink(`repo:${repository.id}`, {
            label: repository.name,
            kind: 'repository',
            lastUpdatedAt: repository.lastCommitAt || repository.updatedAt,
            repository: true,
          });
        }

        bucket.links = [...links.values()]
          .filter((link) => {
            const total =
              link.itemCount +
              link.sourceCount +
              link.activityCount +
              link.repositoryCount;
            return total > 1 || link.activityCount + link.repositoryCount > 1;
          })
          .sort((a, b) => {
            const total = (link: PersonalOpsWorkstreamLink) =>
              link.itemCount + link.sourceCount + link.activityCount + link.repositoryCount;
            const countDiff = total(b) - total(a);
            if (countDiff !== 0) return countDiff;
            return (b.lastUpdatedAt || '').localeCompare(a.lastUpdatedAt || '');
          })
          .slice(0, 6);

        const actionableSources = bucket.sourceRecords.filter(sourceNeedsAttention).length;
        const awarenessSources = bucket.sourceRecords.filter((source) => {
          const attention = sourceAttention(source);
          return attention.awarenessOnly && (attention.reportWorthy || attention.operationalRisk);
        }).length;
        const reviewSources = bucket.sourceRecords.filter(sourceNeedsReview).length;
        const activeRepos = bucket.repositories.filter((repo) => {
          if (!repo.lastCommitAt) return false;
          return new Date(repo.lastCommitAt).getTime() >= plusDays(new Date(), -14).getTime();
        }).length;
        bucket.openLoopCount =
          bucket.items.filter((item) => workItemOpenLoopState(item) !== 'closed').length +
          awarenessSources;
        bucket.needsReviewCount =
          bucket.items.filter((item) => item.needsReview).length + reviewSources;
        const signalParts = [
          bucket.blockerCount ? `${bucket.blockerCount} blocker${bucket.blockerCount === 1 ? '' : 's'}` : null,
          bucket.waitingCount ? `${bucket.waitingCount} waiting` : null,
          bucket.needsReviewCount ? `${bucket.needsReviewCount} review${bucket.needsReviewCount === 1 ? '' : 's'}` : null,
          actionableSources ? `${actionableSources} inbound signal${actionableSources === 1 ? '' : 's'}` : null,
          bucket.items.length ? `${bucket.items.length} open item${bucket.items.length === 1 ? '' : 's'}` : null,
          activeRepos ? `${activeRepos} active repo${activeRepos === 1 ? '' : 's'}` : null,
          bucket.links.length ? `${bucket.links.length} linked evidence ${bucket.links.length === 1 ? 'anchor' : 'anchors'}` : null,
          bucket.nextDueAt ? `Due ${formatDateTime(bucket.nextDueAt)}` : null,
        ].filter((entry): entry is string => Boolean(entry));
        bucket.signals = signalParts.slice(0, 4);
        return bucket;
      })
      .filter((bucket) => {
        if (input?.activeOnly) {
          return (
            bucket.items.length > 0 ||
            bucket.sourceRecords.length > 0 ||
            bucket.recentActivity.length > 0 ||
            bucket.repositories.length > 0
          );
        }
        return (
          bucket.items.length > 0 ||
          bucket.sourceRecords.length > 0 ||
          bucket.recentActivity.length > 0
        );
      })
      .sort((a, b) => {
        const score = (stream: PersonalOpsWorkstream) => {
          const urgent = stream.items.filter((item) => item.priority === 'urgent').length;
          const high = stream.items.filter((item) => item.priority === 'high').length;
          const actionableSources = stream.sourceRecords.filter(sourceNeedsAttention).length;
          const recency = stream.lastUpdatedAt
            ? Math.max(
                0,
                100 - Math.floor((Date.now() - new Date(stream.lastUpdatedAt).getTime()) / 3_600_000),
              )
            : 0;
          return (
            urgent * 12 +
            high * 6 +
            stream.blockerCount * 8 +
            stream.waitingCount * 3 +
            stream.items.length * 2 +
            actionableSources * 4 +
            stream.repositories.length +
            recency
          );
        };
        const scoreDiff = score(b) - score(a);
        if (scoreDiff !== 0) return scoreDiff;
        return (b.lastUpdatedAt || '').localeCompare(a.lastUpdatedAt || '');
      });

    return streams.slice(0, input?.limit || 20);
  }

  getTodayView(): PersonalOpsTodaySummary {
    this.refreshRepositoryActivityIfDue();
    const todayStart = startOfDay();
    const todayEnd = endOfDay();
    const tomorrow = plusDays(todayEnd, 1).toISOString();
    const workstreams = this.buildWorkstreams({
      since: plusDays(new Date(), -2).toISOString(),
      activeOnly: true,
      limit: 6,
    });
    const meetings = listSourceRecords({
      kind: 'calendar_event',
      since: todayStart.toISOString(),
      until: todayEnd.toISOString(),
      limit: 50,
    })
      .reverse()
      .map(normalizeSourceForView)
      .filter((source) => {
        const override = sourceWorkItemStatusOverride(source);
        return override !== 'done' && override !== 'ignored';
      });
    const allWork = listWorkItems({ limit: 400 }).filter(
      (item) => !this.isNoiseDerivedWorkItem(item),
    );
    const priorities = allWork
      .filter((item) => item.status !== 'done' && item.status !== 'ignored')
      .sort((a, b) => {
        const order = { urgent: 0, high: 1, medium: 2, low: 3 };
        return order[a.priority] - order[b.priority];
      })
      .slice(0, 8);
    const overdue = allWork.filter(
      (item) =>
        item.status !== 'done' &&
        item.status !== 'ignored' &&
        !!item.dueDate &&
        item.dueDate < todayStart.toISOString(),
    );
    const followUps = allWork.filter(
      (item) =>
        item.status === 'open' &&
        item.title.toLowerCase().includes('follow up'),
    ).slice(0, 8);
    const blockers = allWork.filter((item) => item.status === 'blocked').slice(0, 8);
    const inbox = this.selectInboxRecords({
      since: todayStart.toISOString(),
      until: tomorrow,
      limit: 12,
    }).filter(sourceNeedsAttention);
    const awareness = listSourceRecords({
      since: todayStart.toISOString(),
      until: tomorrow,
      limit: 120,
    })
      .map(normalizeSourceForView)
      .filter((source) => {
        if (source.kind !== 'email' && source.kind !== 'slack_message' && source.kind !== 'jira_issue') {
          return false;
        }
        if (isLikelyNoiseEmail(source)) return false;
        const attention = sourceAttention(source);
        return attention.awarenessOnly && (attention.reportWorthy || attention.operationalRisk);
      })
      .sort((a, b) => {
        const priorityDiff = inboxSortScore(b) - inboxSortScore(a);
        if (priorityDiff !== 0) return priorityDiff;
        return b.occurredAt.localeCompare(a.occurredAt);
      })
      .slice(0, 8);
    const openLoops = this.getOpenLoops().slice(0, 12);
    const approvalQueue = this.getApprovalQueue().slice(0, 8);
    const topWorkstream = workstreams[0];
    const workstreamLabel = topWorkstream
      ? [topWorkstream.client?.name || 'Unassigned client', topWorkstream.project?.name || 'General work']
          .join(' / ')
      : null;
    const suggestedPlan = [
      workstreamLabel
        ? `Start with ${workstreamLabel}`
        : priorities[0]
          ? `Start with ${priorities[0].title}`
          : 'Review the inbox and overdue items first.',
      meetings[0] ? `Prep for ${meetings[0].title}` : 'No meetings require prep this morning.',
      blockers[0] ? `Unblock ${blockers[0].title}` : 'No blockers are currently tracked.',
      approvalQueue[0]
        ? `Review ${approvalQueue[0].title} in the approval queue.`
        : null,
      openLoops[0]
        ? `Keep ${openLoops[0].title} moving.`
        : awareness[0]
          ? `Stay aware of ${awareness[0].title}.`
          : 'No special awareness items are waiting.',
    ].filter((entry): entry is string => Boolean(entry));
    const draftStandup =
      this.getLatestReport('standup')?.groupedOutput ||
      this.renderStandupFromCurrentState();

    return {
      generatedAt: new Date().toISOString(),
      meetings,
      priorities,
      overdue,
      followUps,
      blockers,
      awareness,
      inbox,
      openLoops,
      approvalQueue,
      workstreams,
      suggestedPlan,
      draftStandup,
    };
  }

  getInboxView(input?: { includeNoise?: boolean }): SourceRecord[] {
    return this.selectInboxRecords({
      limit: 80,
      includeNoise: input?.includeNoise,
    });
  }

  getCalendarView(): SourceRecord[] {
    this.refreshRepositoryActivityIfDue();
    return listSourceRecords({
      kind: 'calendar_event',
      since: startOfDay().toISOString(),
      until: plusDays(endOfDay(), 7).toISOString(),
      limit: 80,
    })
      .reverse()
      .map(normalizeSourceForView);
  }

  getClients(): Client[] {
    return listClients();
  }

  getProjects(): Project[] {
    return listProjects();
  }

  getRepositories(): GitRepository[] {
    return listRepositories();
  }

  getContacts(): {
    contacts: Contact[];
    identities: ContactIdentity[];
    suggestions: ContactMappingSuggestion[];
    accountHints: AccountScopedContactHint[];
    operatorProfile: OperatorProfile;
  } {
    return {
      contacts: listContacts(),
      identities: listContactIdentities(),
      suggestions: listContactMappingSuggestions({ limit: 300 }),
      accountHints: listAccountScopedContactHints({ limit: 400 }),
      operatorProfile: this.getOperatorProfile(),
    };
  }

  private syncMemoryFacts(): void {
    const contacts = listContacts({ limit: 400 });
    const clients = new Map(listClients().map((client) => [client.id, client]));
    const projects = new Map(listProjects().map((project) => [project.id, project]));
    for (const contact of contacts) {
      if (contact.defaultClientId) {
        const client = clients.get(contact.defaultClientId);
        if (client) {
          upsertMemoryFact({
            kind: 'contact_client',
            subjectType: 'contact',
            subjectId: contact.id,
            label: `${contact.name} maps to ${client.name}`,
            value: client.name,
            confidence: 0.96,
            status: 'accepted',
            provenance: ['Accepted contact default client'],
            contactId: contact.id,
            clientId: client.id,
            lastObservedAt: contact.lastSeenAt,
          });
        }
      }
      if (contact.defaultProjectId) {
        const project = projects.get(contact.defaultProjectId);
        if (project) {
          upsertMemoryFact({
            kind: 'contact_project',
            subjectType: 'contact',
            subjectId: contact.id,
            label: `${contact.name} usually maps to ${project.name}`,
            value: project.name,
            confidence: 0.94,
            status: 'accepted',
            provenance: ['Accepted contact default project'],
            contactId: contact.id,
            clientId: project.clientId,
            projectId: project.id,
            lastObservedAt: contact.lastSeenAt,
          });
        }
      }
      if (contact.likelyRole?.trim()) {
        upsertMemoryFact({
          kind: 'contact_role',
          subjectType: 'contact',
          subjectId: contact.id,
          label: `${contact.name} is usually ${contact.likelyRole.trim()}`,
          value: contact.likelyRole.trim(),
          confidence: 0.88,
          status: 'accepted',
          provenance: ['Contact role memory'],
          contactId: contact.id,
          clientId: contact.defaultClientId,
          projectId: contact.defaultProjectId,
          lastObservedAt: contact.lastSeenAt,
        });
      }
      if (contact.importance !== 'normal') {
        upsertMemoryFact({
          kind: 'contact_importance',
          subjectType: 'contact',
          subjectId: contact.id,
          label: `${contact.name} importance is ${contact.importance}`,
          value: contact.importance,
          confidence: 0.9,
          status: 'accepted',
          provenance: ['Contact importance memory'],
          contactId: contact.id,
          clientId: contact.defaultClientId,
          projectId: contact.defaultProjectId,
          lastObservedAt: contact.lastSeenAt,
        });
      }
    }

    for (const suggestion of listContactMappingSuggestions({ limit: 300 })) {
      const contact = getContact(suggestion.contactId);
      if (!contact) continue;
      const client = suggestion.clientId ? clients.get(suggestion.clientId) : null;
      const project = suggestion.projectId ? projects.get(suggestion.projectId) : null;
      upsertMemoryFact({
        kind: project ? 'contact_project' : 'contact_client',
        subjectType: 'contact',
        subjectId: contact.id,
        label: project
          ? `${contact.name} may map to ${project.name}`
          : `${contact.name} may map to ${client?.name || 'a client'}`,
        value: project?.name || client?.name || 'Unassigned',
        confidence: suggestion.confidence,
        status: suggestion.status === 'accepted' ? 'accepted' : suggestion.status,
        provenance: [suggestion.basis, `${suggestion.occurrenceCount} observed match${suggestion.occurrenceCount === 1 ? '' : 'es'}`],
        contactId: contact.id,
        clientId: suggestion.clientId,
        projectId: suggestion.projectId,
        lastObservedAt: suggestion.lastSeenAt,
      });
    }
  }

  getMemoryFacts(): MemoryFact[] {
    this.syncMemoryFacts();
    return listMemoryFacts({ limit: 400 });
  }

  acceptMemoryFact(id: string): void {
    const fact = listMemoryFacts({ limit: 500 }).find((entry) => entry.id === id);
    if (!fact) {
      throw new Error('Memory fact not found.');
    }
    if (fact.contactId && fact.kind === 'contact_role') {
      const contact = getContact(fact.contactId);
      if (contact) {
        upsertContact({
          id: contact.id,
          name: contact.name,
          organizationHint: contact.organizationHint,
          likelyRole: fact.value,
          importance: contact.importance,
          notes: contact.notes,
          lastSeenAt: contact.lastSeenAt,
          defaultClientId: contact.defaultClientId,
          defaultProjectId: contact.defaultProjectId,
          sourceCount: contact.sourceCount,
        });
      }
    }
    if (fact.contactId && (fact.kind === 'contact_client' || fact.kind === 'contact_project')) {
      const contact = getContact(fact.contactId);
      if (contact) {
        upsertContact({
          id: contact.id,
          name: contact.name,
          organizationHint: contact.organizationHint,
          likelyRole: contact.likelyRole,
          importance: contact.importance,
          notes: contact.notes,
          lastSeenAt: contact.lastSeenAt,
          defaultClientId: fact.clientId ?? contact.defaultClientId,
          defaultProjectId: fact.projectId ?? contact.defaultProjectId,
          sourceCount: contact.sourceCount,
        });
      }
      const matchingSuggestions = listContactMappingSuggestions({
        contactId: fact.contactId,
        limit: 100,
      }).filter(
        (suggestion) =>
          suggestion.clientId === fact.clientId &&
          suggestion.projectId === fact.projectId &&
          suggestion.status === 'suggested',
      );
      for (const suggestion of matchingSuggestions) {
        upsertContactMappingSuggestion({ ...suggestion, status: 'accepted' });
      }
    }
    upsertMemoryFact({
      id: fact.id,
      kind: fact.kind,
      subjectType: fact.subjectType,
      subjectId: fact.subjectId,
      label: fact.label,
      value: fact.value,
      confidence: fact.confidence,
      status: 'accepted',
      provenance: fact.provenance,
      sourceRecordKey: fact.sourceRecordKey,
      contactId: fact.contactId,
      clientId: fact.clientId,
      projectId: fact.projectId,
      lastObservedAt: fact.lastObservedAt,
      staleAfter: fact.staleAfter,
    });
    this.reprocessStoredSources();
    this.writePublicSnapshots();
  }

  rejectMemoryFact(id: string): void {
    const fact = listMemoryFacts({ limit: 500 }).find((entry) => entry.id === id);
    if (!fact) {
      throw new Error('Memory fact not found.');
    }
    if (fact.contactId && (fact.kind === 'contact_client' || fact.kind === 'contact_project')) {
      const matchingSuggestions = listContactMappingSuggestions({
        contactId: fact.contactId,
        limit: 100,
      }).filter(
        (suggestion) =>
          suggestion.clientId === fact.clientId &&
          suggestion.projectId === fact.projectId &&
          suggestion.status === 'suggested',
      );
      for (const suggestion of matchingSuggestions) {
        upsertContactMappingSuggestion({ ...suggestion, status: 'rejected' });
      }
    }
    upsertMemoryFact({
      id: fact.id,
      kind: fact.kind,
      subjectType: fact.subjectType,
      subjectId: fact.subjectId,
      label: fact.label,
      value: fact.value,
      confidence: fact.confidence,
      status: 'rejected',
      provenance: fact.provenance,
      sourceRecordKey: fact.sourceRecordKey,
      contactId: fact.contactId,
      clientId: fact.clientId,
      projectId: fact.projectId,
      lastObservedAt: fact.lastObservedAt,
      staleAfter: fact.staleAfter,
    });
    this.reprocessStoredSources();
    this.writePublicSnapshots();
  }

  private queueDraftSummary(source: SourceRecord): string {
    const attention = sourceAttention(source);
    const thread = sourceThreadState(source);
    const parts = [
      attention.importanceReason,
      thread.summary,
      source.summary || source.title,
    ].filter(Boolean);
    return parts.join(' ');
  }

  private buildReplyDraftAction(source: SourceRecord): ApprovalQueueItem | null {
    if (source.kind !== 'email' && source.kind !== 'slack_message') return null;
    const attention = sourceAttention(source);
    if (!attention.actionRequired || isLikelyNoiseEmail(source)) return null;
    const dedupeKey = `reply:${sanitizeSourceRef(source)}`;
    const confidence = attention.actionConfidence ?? attention.mappingConfidence ?? 0.68;
    const greeting =
      source.kind === 'email'
        ? 'Thanks for the update.'
        : 'Thanks for the context here.';
    return {
      id: '',
      dedupeKey,
      kind: 'reply_draft',
      status: 'pending',
      title: `Reply draft: ${source.title}`,
      summary: this.queueDraftSummary(source),
      body: [
        greeting,
        '',
        `I reviewed "${source.title}" and the current context.`,
        `Important point: ${sourceAttention(source).importanceReason}.`,
        '',
        'Suggested response:',
        '',
        'Hi,',
        '',
        `${source.summary || source.title}`,
        '',
        'I am reviewing this now and will follow up with the next step shortly.',
        '',
        'Thanks,',
        'Jerry',
      ].join('\n'),
      reason: `Direct or actionable ${source.kind === 'email' ? 'message' : 'Slack thread'} that likely needs a response.`,
      confidence,
      clientId: source.clientId || null,
      projectId: source.projectId || null,
      sourceRecordKey: sanitizeSourceRef(source),
      workItemId: null,
      reportType: null,
      linkedContactIds:
        source.linkedContactIds || sourceMetadataStringArray(source, 'linkedContactIds'),
      evidence: [sanitizeSourceRef(source)],
      artifactRef: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolvedAt: null,
    };
  }

  private buildFollowUpAction(source: SourceRecord): ApprovalQueueItem | null {
    const attention = sourceAttention(source);
    if (!attention.actionRequired || isLikelyNoiseEmail(source)) return null;
    const sourceRef = sanitizeSourceRef(source);
    const existingWorkItem = getWorkItem(`work:${sourceRef}`);
    if (existingWorkItem && !existingWorkItem.needsReview) return null;
    const thread = sourceThreadState(source);
    return {
      id: '',
      dedupeKey: `followup:${sourceRef}`,
      kind: 'follow_up_task',
      status: 'pending',
      title:
        sourceMetadataString(source, 'modelFollowUpTitle') ||
        `Follow up: ${source.title}`,
      summary: `${attention.importanceReason} ${thread.summary}`.trim(),
      body: [
        `Create a follow-up for "${source.title}".`,
        '',
        `Why: ${attention.importanceReason}`,
        thread.summary ? `Thread state: ${thread.summary}` : '',
        source.summary ? `Context: ${source.summary}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      reason: 'Actionable source without a durable tracked follow-up yet.',
      confidence: attention.actionConfidence ?? attention.mappingConfidence ?? 0.66,
      clientId: source.clientId || null,
      projectId: source.projectId || null,
      sourceRecordKey: sourceRef,
      workItemId: existingWorkItem?.id || null,
      reportType: null,
      linkedContactIds:
        source.linkedContactIds || sourceMetadataStringArray(source, 'linkedContactIds'),
      evidence: [sourceRef],
      artifactRef: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolvedAt: null,
    };
  }

  private buildMeetingPrepAction(source: SourceRecord): ApprovalQueueItem | null {
    if (source.kind !== 'calendar_event') return null;
    if (sourceMetadataString(source, 'calendarIntent') === 'reminder') return null;
    const occurredAt = new Date(source.occurredAt).getTime();
    if (Number.isNaN(occurredAt) || occurredAt < Date.now() || occurredAt > Date.now() + 36 * 60 * 60_000) {
      return null;
    }
    if (!source.clientId && !source.projectId) return null;
    const stream = this.buildWorkstreams({
      since: plusDays(new Date(), -7).toISOString(),
      activeOnly: true,
      limit: 30,
    }).find(
      (entry) =>
        entry.client?.id === (source.clientId || null) &&
        entry.project?.id === (source.projectId || null),
    );
    const prepLines = [
      `Meeting: ${source.title}`,
      `When: ${formatDateTime(source.occurredAt)}`,
      source.summary ? `Context: ${source.summary}` : '',
      stream?.signals.length ? `Current signals: ${stream.signals.join('; ')}` : '',
      stream?.items.length ? `Open items: ${stream.items.slice(0, 4).map((item) => item.title).join('; ')}` : '',
      stream?.links.length ? `Linked evidence: ${stream.links.slice(0, 4).map((link) => link.label).join('; ')}` : '',
    ].filter(Boolean);
    return {
      id: '',
      dedupeKey: `meeting-prep:${sanitizeSourceRef(source)}`,
      kind: 'meeting_prep',
      status: 'pending',
      title: `Prep for ${source.title}`,
      summary: 'Prepare talking points and open items before the meeting.',
      body: prepLines.join('\n'),
      reason: 'Upcoming meeting with enough context to prepare a quick internal brief.',
      confidence: 0.84,
      clientId: source.clientId || null,
      projectId: source.projectId || null,
      sourceRecordKey: sanitizeSourceRef(source),
      workItemId: null,
      reportType: null,
      linkedContactIds:
        source.linkedContactIds || sourceMetadataStringArray(source, 'linkedContactIds'),
      evidence: [
        sanitizeSourceRef(source),
        ...(stream?.links.map((link) => link.key) || []).slice(0, 4),
      ],
      artifactRef: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolvedAt: null,
    };
  }

  private buildReportDraftAction(type: 'standup' | 'wrap'): ApprovalQueueItem | null {
    const latest = this.getLatestReport(type);
    const todayStart = startOfDay().toISOString();
    if (latest && latest.generatedAt >= todayStart) {
      return null;
    }
    const title = type === 'standup' ? 'Standup draft' : 'Wrap draft';
    return {
      id: '',
      dedupeKey: `report:${type}:${todayStart}`,
      kind: 'report_draft',
      status: 'pending',
      title,
      summary: `Generate and review today's ${type} before using it.`,
      body:
        type === 'standup'
          ? this.renderStandupFromCurrentState()
          : [
              'End-of-Day Wrap',
              '',
              'Moved forward today:',
              ...this.getHistoryView({ since: todayStart })
                .slice(0, 8)
                .map((activity) => `- ${activity.summary}`),
              '',
              'Open loops to carry forward:',
              ...this.getOpenLoops()
                .slice(0, 5)
                .map((loop) => `- ${loop.title} (${loop.state})`),
            ].join('\n'),
      reason: `Keep a reviewable ${type} draft in the approval queue.`,
      confidence: 0.86,
      clientId: null,
      projectId: null,
      sourceRecordKey: null,
      workItemId: null,
      reportType: type,
      linkedContactIds: [],
      evidence: [],
      artifactRef: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolvedAt: null,
    };
  }

  private syncApprovalQueue(): void {
    const existing = new Map(
      listApprovalQueueItems({ limit: 500 }).map((item) => [item.dedupeKey, item] as const),
    );
    const candidates: ApprovalQueueItem[] = [];
    const recentSources = listSourceRecords({
      since: plusDays(new Date(), -3).toISOString(),
      limit: 260,
    });
    for (const source of recentSources) {
      const reply = this.buildReplyDraftAction(source);
      if (reply) candidates.push(reply);
      const followUp = this.buildFollowUpAction(source);
      if (followUp) candidates.push(followUp);
      const prep = this.buildMeetingPrepAction(source);
      if (prep) candidates.push(prep);
    }
    const standup = this.buildReportDraftAction('standup');
    if (standup) candidates.push(standup);
    const wrap = this.buildReportDraftAction('wrap');
    if (wrap) candidates.push(wrap);

    for (const candidate of candidates) {
      const prior = existing.get(candidate.dedupeKey);
      if (prior && prior.status !== 'pending') {
        continue;
      }
      upsertApprovalQueueItem({
        ...candidate,
        id: prior?.id,
        status: prior?.status || 'pending',
      });
    }
  }

  getApprovalQueue(): ApprovalQueueItem[] {
    this.syncApprovalQueue();
    return listApprovalQueueItems({ status: 'pending', limit: 200 });
  }

  approveQueueItem(id: string): ApprovalQueueItem {
    const item = listApprovalQueueItems({ limit: 400 }).find((entry) => entry.id === id);
    if (!item) {
      throw new Error('Approval item not found.');
    }
    let artifactRef: string | null = item.artifactRef;
    if (item.kind === 'follow_up_task') {
      const workItem = upsertWorkItem({
        id: item.workItemId || (item.sourceRecordKey ? `work:${item.sourceRecordKey}` : undefined),
        title: item.title.replace(/^Follow up:\s*/i, ''),
        sourceKind: item.sourceRecordKey ? parseSourceRecordKey(item.sourceRecordKey)?.kind || 'manual_task' : 'manual_task',
        sourceProvider: item.sourceRecordKey ? (parseSourceRecordKey(item.sourceRecordKey)?.provider || 'manual') : 'manual',
        sourceRecordKey: item.sourceRecordKey,
        clientId: item.clientId,
        projectId: item.projectId,
        priority: 'high',
        status: 'open',
        confidence: item.confidence,
        needsReview: false,
        linkedContactIds: item.linkedContactIds,
        openLoopState: 'action',
        notes: item.body,
      });
      artifactRef = workItem.id;
    } else {
      const note = this.createManualNote({
        title: item.title,
        body: item.body,
        clientId: item.clientId,
        projectId: item.projectId,
      });
      artifactRef = sanitizeSourceRef(note);
    }
    const updated = upsertApprovalQueueItem({
      ...item,
      artifactRef,
      status: 'approved',
      resolvedAt: new Date().toISOString(),
    });
    this.writePublicSnapshots();
    return updated;
  }

  rejectQueueItem(id: string): ApprovalQueueItem {
    const item = listApprovalQueueItems({ limit: 400 }).find((entry) => entry.id === id);
    if (!item) {
      throw new Error('Approval item not found.');
    }
    const updated = upsertApprovalQueueItem({
      ...item,
      status: 'rejected',
      resolvedAt: new Date().toISOString(),
    });
    this.writePublicSnapshots();
    return updated;
  }

  editQueueItem(
    id: string,
    input: Partial<Pick<ApprovalQueueItem, 'title' | 'summary' | 'body' | 'reason'>>,
  ): ApprovalQueueItem {
    const item = listApprovalQueueItems({ limit: 400 }).find((entry) => entry.id === id);
    if (!item) {
      throw new Error('Approval item not found.');
    }
    const updated = upsertApprovalQueueItem({
      ...item,
      title: input.title?.trim() || item.title,
      summary: input.summary?.trim() || item.summary,
      body: input.body?.trim() || item.body,
      reason: input.reason?.trim() || item.reason,
      status: item.status === 'pending' ? 'pending' : item.status,
      resolvedAt: item.status === 'pending' ? null : item.resolvedAt,
    });
    this.writePublicSnapshots();
    return updated;
  }

  linkContact(input: {
    contactId: string;
    clientId?: string | null;
    projectId?: string | null;
    likelyRole?: string | null;
    importance?: PersonalOpsContactImportance;
    notes?: string | null;
    identity?: {
      type: ContactIdentity['type'];
      provider: ContactIdentity['provider'];
      value: string;
      label?: string | null;
    };
  }): Contact {
    const contact = getContact(input.contactId);
    if (!contact) {
      throw new Error('Contact not found.');
    }
    const updated = upsertContact({
      id: contact.id,
      name: contact.name,
      organizationHint: contact.organizationHint,
      likelyRole: input.likelyRole ?? contact.likelyRole,
      importance: input.importance ?? contact.importance,
      notes: input.notes ?? contact.notes,
      lastSeenAt: contact.lastSeenAt,
      defaultClientId:
        input.clientId !== undefined ? input.clientId : contact.defaultClientId,
      defaultProjectId:
        input.projectId !== undefined ? input.projectId : contact.defaultProjectId,
      sourceCount: contact.sourceCount,
    });
    if (input.identity?.value?.trim()) {
      upsertContactIdentity({
        contactId: updated.id,
        type: input.identity.type,
        provider: input.identity.provider,
        value: normalizeIdentityValue(input.identity.value),
        label: input.identity.label ?? null,
      });
    }
    this.reprocessStoredSources();
    this.writePublicSnapshots();
    return updated;
  }

  private providerLabel(provider: PersonalOpsProvider): string {
    if (provider === 'google') return 'Google';
    if (provider === 'microsoft') return 'Microsoft';
    if (provider === 'jira') return 'Jira';
    if (provider === 'slack') return 'Slack';
    return 'Manual';
  }

  private accountLabelForQuestion(connection: ConnectedAccount): string {
    return connection.accountLabel || connection.accountId || connection.provider;
  }

  private inferClientForConnectionQuestion(
    connection: ConnectedAccount,
    clients: Client[],
  ): Client | null {
    const accountLabel = this.accountLabelForQuestion(connection);
    const domainPart = accountLabel.includes('@') ? accountLabel.split('@')[1] || '' : '';
    const domainToken = normalizeMatchText(domainPart.split('.')[0] || domainPart);
    if (!domainToken) return null;
    return (
      clients.find((client) => {
        const normalizedClient = normalizeMatchText(client.name);
        return (
          normalizedClient === domainToken ||
          normalizedClient.includes(domainToken) ||
          domainToken.includes(normalizedClient)
        );
      }) || null
    );
  }

  private inferProjectForConnectionQuestion(
    connection: ConnectedAccount,
    client: Client | null,
    projects: Project[],
  ): Project | null {
    if (!client) return null;
    const clientProjects = projects.filter(
      (project) => project.clientId === client.id && project.status !== 'archived',
    );
    if (clientProjects.length === 1) return clientProjects[0];
    if (!clientProjects.length) return null;
    const roleContext =
      `${client.roles.join(' ')} ${client.notes} ${connection.settings?.triageGuidance || ''}`.toLowerCase();
    const scored = clientProjects
      .map((project) => {
        const projectText = `${project.name} ${project.tags.join(' ')} ${project.notes}`.toLowerCase();
        let score = 0;
        if (projectText.includes('general')) score += 1;
        if (roleContext.includes('coo') && projectText.includes('coo')) score += 5;
        if (roleContext.includes('cto') && projectText.includes('cto')) score += 5;
        if (roleContext.includes('operations') && projectText.includes('operations')) score += 3;
        return { project, score };
      })
      .sort((left, right) => right.score - left.score);
    return scored[0] && scored[0].score > 0 ? scored[0].project : null;
  }

  private suggestedConnectionGuidance(
    connection: ConnectedAccount,
    client: Client | null,
    project: Project | null,
  ): string {
    const accountLabel = this.accountLabelForQuestion(connection);
    const clientLabel = client?.name || 'the main client for this account';
    const projectLabel = project?.name ? ` and ${project.name}` : '';
    if (connection.provider === 'jira') {
      return `Treat ${accountLabel} as ${clientLabel}${projectLabel}. Surface blockers, work assigned to Jerry, status changes on active issues, and urgent delivery risk. Downgrade routine churn unless it changes commitments or operational state.`;
    }
    if (connection.provider === 'slack') {
      return `Treat ${accountLabel} as ${clientLabel}${projectLabel}. Surface direct asks, blockers, operational risk, and decisions tied to active work. Downgrade routine chatter, automated noise, and ambient conversation unless it changes commitments.`;
    }
    return `Treat ${accountLabel} as ${clientLabel}${projectLabel}. Surface direct asks, blockers, operational risk, and messages tied to active work. Downgrade routine automated, promo, and low-signal notifications unless they imply outage, security, delivery, or executive risk.`;
  }

  private isLikelyReminderEvent(source: SourceRecord): boolean {
    if (source.kind !== 'calendar_event') return false;
    if (sourceMetadataString(source, 'calendarIntent') === 'reminder') return false;
    const text = `${source.title}\n${source.summary}`.toLowerCase();
    if (source.participants.length > 1) return false;
    return /\b(lunch|move car|reminder|pick up|drop off|call|task|todo|note to self)\b/i.test(text);
  }

  private buildSetupAssistantQuestions(): AssistantQuestionCandidate[] {
    const connections = this.listConnections().filter(
      (connection) => Boolean(connection.accountId) && connection.status !== 'disconnected',
    );
    const clients = this.getClients();
    const projects = this.getProjects();
    const repositories = this.getRepositories();
    const questions: AssistantQuestionCandidate[] = [];
    for (const connection of connections) {
      const settings = connection.settings || {};
      const inferredClient =
        (settings.defaultClientId
          ? clients.find((client) => client.id === settings.defaultClientId) || null
          : this.inferClientForConnectionQuestion(connection, clients)) || null;
      const inferredProject =
        (settings.defaultProjectId
          ? projects.find((project) => project.id === settings.defaultProjectId) || null
          : this.inferProjectForConnectionQuestion(connection, inferredClient, projects)) || null;
      if (!settings.defaultClientId && inferredClient) {
        questions.push({
          dedupeKey: `setup:default:${connection.connectionKey}:${inferredClient.id}:${inferredProject?.id || ''}`,
          surface: 'connections',
          targetType: 'connection',
          targetId: connection.connectionKey,
          urgency: 'inline',
          prompt: `Should ${this.accountLabelForQuestion(connection)} default to ${inferredClient.name}${inferredProject ? ` / ${inferredProject.name}` : ''}?`,
          rationale: 'This account is connected, but it is still missing a saved default mapping.',
          recommendedOptionId: inferredProject ? 'accept_recommended' : 'accept_client',
          options: inferredProject
            ? [
                {
                  id: 'accept_recommended',
                  label: `Use ${inferredClient.name} / ${inferredProject.name}`,
                  scope: 'account',
                  effectSummary: 'Save both the client and project as the account default.',
                },
                {
                  id: 'client_only',
                  label: `Keep ${inferredClient.name} client-only`,
                  scope: 'account',
                  effectSummary: 'Use the client by default and wait for stronger project signals.',
                },
              ]
            : [
                {
                  id: 'accept_client',
                  label: `Use ${inferredClient.name}`,
                  scope: 'account',
                  effectSummary: 'Save the client as the default for this account.',
                },
              ],
          effectPreview: inferredProject
            ? `This will tune ${this.accountLabelForQuestion(connection)} to start from ${inferredClient.name} / ${inferredProject.name}.`
            : `This will tune ${this.accountLabelForQuestion(connection)} to start from ${inferredClient.name}.`,
          createdFrom: `setup_default|${connection.connectionKey}|${inferredClient.id}|${inferredProject?.id || ''}`,
        });
      } else if (
        settings.defaultClientId &&
        !settings.defaultProjectId &&
        !settings.preferClientOnlyMapping &&
        inferredProject
      ) {
        questions.push({
          dedupeKey: `setup:project:${connection.connectionKey}:${inferredProject.id}`,
          surface: 'connections',
          targetType: 'connection',
          targetId: connection.connectionKey,
          urgency: 'inline',
          prompt: `Should ${this.accountLabelForQuestion(connection)} default to ${inferredProject.name} under ${inferredClient?.name || 'this client'}?`,
          rationale: 'This account already knows the client, but a project default may remove repetitive review.',
          recommendedOptionId: 'accept_project',
          options: [
            {
              id: 'accept_project',
              label: `Use ${inferredProject.name}`,
              scope: 'account',
              effectSummary: 'Save the project as the default for this account.',
            },
            {
              id: 'client_only',
              label: 'Stay client-only',
              scope: 'account',
              effectSummary: 'Keep relying on client-level defaults unless project signals are explicit.',
            },
          ],
          effectPreview: `This will tune ${this.accountLabelForQuestion(connection)} at the project level for faster attribution.`,
          createdFrom: `setup_project|${connection.connectionKey}|${inferredProject.id}`,
        });
      }
      if (!settings.triageGuidance) {
        questions.push({
          dedupeKey: `setup:guidance:${connection.connectionKey}`,
          surface: 'connections',
          targetType: 'connection',
          targetId: connection.connectionKey,
          urgency: 'inline',
          prompt: `How should ${this.accountLabelForQuestion(connection)} treat shared, automated, or low-signal items?`,
          rationale: 'This account is connected, but the assistant still lacks explicit triage guidance.',
          recommendedOptionId: 'apply_recommended_guidance',
          options: [
            {
              id: 'apply_recommended_guidance',
              label: 'Use the recommended guidance',
              scope: 'account',
              effectSummary: 'Save a starter triage policy for this account.',
            },
          ],
          freeformAllowed: true,
          effectPreview: this.suggestedConnectionGuidance(
            connection,
            inferredClient,
            inferredProject,
          ),
          createdFrom: `setup_guidance|${connection.connectionKey}`,
        });
      }
      if (questions.length >= 6) break;
    }
    if (!questions.length) {
      const needsConnectionTuning = connections.some((connection) => {
        const settings = connection.settings || {};
        return !settings.defaultClientId || !settings.triageGuidance;
      });
      if (needsConnectionTuning) {
        questions.push({
          dedupeKey: 'setup:fallback:connections',
          surface: 'connections',
          targetType: 'setup',
          targetId: null,
          urgency: 'queued',
          prompt: 'Which connected account should be tuned next?',
          rationale:
            'At least one connected account is still missing defaults or triage guidance.',
          recommendedOptionId: null,
          options: [],
          effectPreview:
            'Open Connections and tune the next account so future triage has clearer defaults.',
          createdFrom: 'setup_fallback_connections',
        });
      } else if (!clients.length || !projects.length) {
        questions.push({
          dedupeKey: 'setup:fallback:registry',
          surface: 'connections',
          targetType: 'setup',
          targetId: null,
          urgency: 'queued',
          prompt: 'Which clients and projects should the assistant know about first?',
          rationale:
            'The registry is still sparse, which weakens attribution and workstream grouping.',
          recommendedOptionId: null,
          options: [],
          effectPreview: 'Add the active clients and projects you work against most often.',
          createdFrom: 'setup_fallback_registry',
        });
      } else if (repositories.some((repository) => !repository.clientId && !repository.projectId)) {
        questions.push({
          dedupeKey: 'setup:fallback:repositories',
          surface: 'connections',
          targetType: 'setup',
          targetId: null,
          urgency: 'queued',
          prompt: 'Which repositories should be assigned before the assistant learns more?',
          rationale:
            'Unassigned repositories reduce standup quality and workstream evidence.',
          recommendedOptionId: null,
          options: [],
          effectPreview: 'Assign the live repositories first so repo activity maps cleanly to work.',
          createdFrom: 'setup_fallback_repositories',
        });
      }
    }
    return questions;
  }

  private buildInboxAssistantQuestions(): AssistantQuestionCandidate[] {
    return this.getInboxView({ includeNoise: false })
      .filter((source) => source.kind === 'email' || source.kind === 'slack_message')
      .filter((source) => sourceNeedsReview(source))
      .slice(0, 8)
      .map((source) => ({
        dedupeKey: `triage:${sanitizeSourceRef(source)}`,
        surface: 'inbox',
        targetType: 'source_record',
        targetId: sanitizeSourceRef(source),
        urgency: 'inline',
        prompt: `How should I treat "${source.title}"?`,
        rationale: sourceWhyReview(source).join(' • ') || 'This item is affecting triage with low confidence.',
        recommendedOptionId:
          sourceAttention(source).actionRequired || sourceAttention(source).operationalRisk
            ? 'needs_action'
            : 'awareness_only',
        options: [
          {
            id: 'needs_action',
            label: 'Keep in Needs Action',
            scope: 'current_item',
            effectSummary: 'Keep the item visible as something Jerry likely needs to handle.',
          },
          {
            id: 'awareness_only',
            label: 'Mark awareness only',
            scope: 'current_item',
            effectSummary: 'Move it out of the action lane but preserve visibility.',
          },
          {
            id: 'suppress',
            label: 'Suppress it',
            scope: 'one_off',
            effectSummary: 'Hide this specific item from summaries and triage.',
          },
        ],
        effectPreview: 'Your answer will update this item immediately and reduce future uncertainty for similar cases.',
        createdFrom: `source_triage:${sanitizeSourceRef(source)}`,
      }));
  }

  private buildWorkAssistantQuestions(): AssistantQuestionCandidate[] {
    return listWorkItems({ limit: 120 })
      .filter((item) => item.needsReview)
      .slice(0, 6)
      .map((item) => ({
        dedupeKey: `work_review:${item.id}`,
        surface: 'work',
        targetType: 'work_item',
        targetId: item.id,
        urgency: 'inline',
        prompt: `Should "${item.title}" stay on the Work board?`,
        rationale: item.notes || 'This inferred task is still marked for review.',
        recommendedOptionId: 'keep_work_item',
        options: [
          {
            id: 'keep_work_item',
            label: 'Keep it',
            scope: 'current_item',
            effectSummary: 'Accept the work item and clear its review flag.',
          },
          {
            id: 'remove_work_item',
            label: 'Remove it',
            scope: 'one_off',
            effectSummary: 'Mark it ignored so it no longer clutters active work.',
          },
        ],
        effectPreview: 'This will update the current open loop immediately.',
        createdFrom: `work_review:${item.id}`,
      }));
  }

  private buildCalendarAssistantQuestions(): AssistantQuestionCandidate[] {
    return this.getCalendarView()
      .filter((source) => this.isLikelyReminderEvent(source))
      .slice(0, 4)
      .map((source) => ({
        dedupeKey: `calendar_intent:${sanitizeSourceRef(source)}`,
        surface: 'today',
        targetType: 'calendar_event',
        targetId: sanitizeSourceRef(source),
        urgency: 'inline',
        prompt: `Is "${source.title}" a reminder or a real meeting?`,
        rationale: 'The calendar item looks ambiguous, and the answer changes whether the assistant should prep or just remind.',
        recommendedOptionId: 'reminder',
        options: [
          {
            id: 'reminder',
            label: 'It is a reminder',
            scope: 'current_item',
            effectSummary: 'Treat it like a reminder, not a meeting prep candidate.',
          },
          {
            id: 'meeting',
            label: 'It is a meeting',
            scope: 'current_item',
            effectSummary: 'Keep treating it like a meeting with prep context when relevant.',
          },
        ],
        effectPreview: 'This will update the current calendar item and future prep behavior for it.',
        createdFrom: `calendar_intent:${sanitizeSourceRef(source)}`,
      }));
  }

  private buildReviewAssistantQuestions(): AssistantQuestionCandidate[] {
    const clients = new Map(this.getClients().map((client) => [client.id, client]));
    const projects = new Map(this.getProjects().map((project) => [project.id, project]));
    const candidates: AssistantQuestionCandidate[] = [];

    for (const hint of listAccountScopedContactHints({ status: 'suggested', limit: 40 })) {
      const contact = getContact(hint.contactId);
      const client = hint.clientId ? clients.get(hint.clientId) : null;
      const project = hint.projectId ? projects.get(hint.projectId) : null;
      candidates.push({
        dedupeKey: `account_hint:${hint.id}`,
        surface: 'review',
        targetType: 'contact',
        targetId: hint.contactId,
        urgency: 'queued',
        prompt: `When ${hint.identityValue} appears in ${hint.accountLabel || hint.accountId}, should it usually map to ${project?.name || client?.name || 'this client context'}?`,
        rationale: `${hint.basis} • ${hint.occurrenceCount} observed match${hint.occurrenceCount === 1 ? '' : 'es'}`,
        recommendedOptionId: project ? 'accept_hint' : 'accept_client_hint',
        options: project
          ? [
              {
                id: 'accept_hint',
                label: `Use ${client?.name || 'client'} / ${project.name}`,
                scope: 'account_hint',
                effectSummary: 'Accept this account-scoped project hint.',
              },
              {
                id: 'client_only',
                label: `Keep ${client?.name || 'client'} client-only`,
                scope: 'account_hint',
                effectSummary: 'Use the client for this account, but do not harden a project hint yet.',
              },
              {
                id: 'reject_hint',
                label: 'Reject',
                scope: 'account_hint',
                effectSummary: 'Do not reuse this account-scoped mapping.',
              },
            ]
          : [
              {
                id: 'accept_client_hint',
                label: `Use ${client?.name || 'this client'}`,
                scope: 'account_hint',
                effectSummary: 'Accept this account-scoped client hint.',
              },
              {
                id: 'reject_hint',
                label: 'Reject',
                scope: 'account_hint',
                effectSummary: 'Do not reuse this account-scoped mapping.',
              },
            ],
        effectPreview: 'This answer will change how this sender is treated in this specific account without forcing a global cross-client default.',
        createdFrom: `account_hint:${hint.id}`,
      });
    }

    for (const suggestion of listContactMappingSuggestions({ status: 'suggested', limit: 40 })) {
      const contact = getContact(suggestion.contactId);
      const client = suggestion.clientId ? clients.get(suggestion.clientId) : null;
      const project = suggestion.projectId ? projects.get(suggestion.projectId) : null;
      candidates.push({
        dedupeKey: `contact_mapping:${suggestion.id}`,
        surface: 'review',
        targetType: 'contact',
        targetId: suggestion.contactId,
        urgency: 'queued',
        prompt: `Should ${contact?.name || 'this contact'} usually map to ${project?.name || client?.name || 'this client'}?`,
        rationale: `${suggestion.basis} • ${suggestion.occurrenceCount} observed match${suggestion.occurrenceCount === 1 ? '' : 'es'}`,
        recommendedOptionId: suggestion.confidence >= 0.8 ? 'accept_mapping' : 'reject_mapping',
        options: [
          {
            id: 'accept_mapping',
            label: 'Accept',
            scope: 'contact',
            effectSummary: 'Promote this mapping into durable contact memory.',
          },
          {
            id: 'reject_mapping',
            label: 'Reject',
            scope: 'contact',
            effectSummary: 'Keep this mapping out of future defaults.',
          },
        ],
        effectPreview: 'This will either promote or reject the suggested contact mapping.',
        createdFrom: `contact_mapping:${suggestion.id}`,
      });
    }

    for (const fact of listMemoryFacts({ status: 'suggested', limit: 40 })) {
      candidates.push({
        dedupeKey: `memory:${fact.id}`,
        surface: 'review',
        targetType: 'contact',
        targetId: fact.contactId,
        urgency: 'queued',
        prompt: `Should I keep this memory: ${fact.label}?`,
        rationale: fact.provenance.join(' • ') || 'Suggested durable memory fact.',
        recommendedOptionId: fact.confidence >= 0.82 ? 'accept_memory' : 'reject_memory',
        options: [
          {
            id: 'accept_memory',
            label: 'Accept',
            scope: 'memory_review',
            effectSummary: 'Promote this memory into accepted durable context.',
          },
          {
            id: 'reject_memory',
            label: 'Reject',
            scope: 'memory_review',
            effectSummary: 'Stop this fact from hardening into future behavior.',
          },
        ],
        effectPreview: 'This will update the memory layer and future triage behavior.',
        createdFrom: `memory:${fact.id}`,
      });
    }

    return candidates.slice(0, 80);
  }

  private buildAssistantQuestionCandidates(): AssistantQuestionCandidate[] {
    return [
      ...this.buildSetupAssistantQuestions(),
      ...this.buildInboxAssistantQuestions(),
      ...this.buildWorkAssistantQuestions(),
      ...this.buildCalendarAssistantQuestions(),
      ...this.buildReviewAssistantQuestions(),
    ];
  }

  private syncAssistantQuestions(): void {
    const existing = new Map(
      listAssistantQuestions({ includeSnoozed: true, limit: 500 }).map((question) => [
        question.dedupeKey,
        question,
      ]),
    );
    const candidates = this.buildAssistantQuestionCandidates();
    const activeKeys = new Set(candidates.map((candidate) => candidate.dedupeKey));
    for (const candidate of candidates) {
      const persisted = existing.get(candidate.dedupeKey);
      upsertAssistantQuestion({
        ...candidate,
        id: persisted?.id,
        status: persisted?.status === 'dismissed' ? 'dismissed' : persisted?.status || 'pending',
        answerOptionId: persisted?.answerOptionId ?? null,
        answerValue: persisted?.answerValue ?? null,
        snoozeUntil: persisted?.snoozeUntil ?? null,
        answeredAt: persisted?.answeredAt ?? null,
      });
    }
    for (const question of existing.values()) {
      if (question.status !== 'pending' && question.status !== 'snoozed') continue;
      if (activeKeys.has(question.dedupeKey)) continue;
      upsertAssistantQuestion({
        ...question,
        dedupeKey: question.dedupeKey,
        status: 'dismissed',
      });
    }
  }

  getAssistantQuestions(input?: {
    surface?: PersonalOpsQuestionSurface;
    targetType?: PersonalOpsQuestionTargetType;
    targetId?: string;
    urgency?: PersonalOpsQuestionUrgency;
  }): AssistantQuestion[] {
    this.syncAssistantQuestions();
    const now = Date.now();
    let questions = listAssistantQuestions({ includeSnoozed: true, limit: 500 }).filter(
      (question) => {
        if (question.status === 'answered' || question.status === 'dismissed') return false;
        if (
          question.status === 'snoozed' &&
          question.snoozeUntil &&
          new Date(question.snoozeUntil).getTime() > now
        ) {
          return false;
        }
        if (input?.surface && question.surface !== input.surface) return false;
        if (input?.targetType && question.targetType !== input.targetType) return false;
        if (input?.targetId && question.targetId !== input.targetId) return false;
        if (input?.urgency && question.urgency !== input.urgency) return false;
        return true;
      },
    );
    questions = questions.sort((left, right) => {
      if (input?.targetId) {
        const leftMatch = left.targetId === input.targetId ? 1 : 0;
        const rightMatch = right.targetId === input.targetId ? 1 : 0;
        if (leftMatch !== rightMatch) return rightMatch - leftMatch;
      }
      if (left.urgency !== right.urgency) return left.urgency === 'inline' ? -1 : 1;
      return (right.updatedAt || '').localeCompare(left.updatedAt || '');
    });
    if ((input?.urgency || null) === 'inline') {
      return questions.slice(0, 1);
    }
    return questions;
  }

  answerAssistantQuestion(input: {
    id: string;
    optionId?: string | null;
    value?: string | null;
  }): AssistantQuestion {
    const question = getAssistantQuestion(input.id);
    if (!question) {
      throw new Error('Question not found.');
    }
    const optionId = input.optionId || question.recommendedOptionId || question.options[0]?.id || null;
    const answerValue = input.value?.trim() || null;
    if (
      question.createdFrom.startsWith('setup_default|') ||
      question.createdFrom.startsWith('setup_project|')
    ) {
      const [, connectionKey, clientId, projectId] = question.createdFrom.split('|');
      const connection = this.listConnections().find((entry) => entry.connectionKey === connectionKey);
      if (!connection || !connection.accountId) {
        throw new Error('Connected account not found.');
      }
      const nextSettings = { ...(connection.settings || {}) };
      if (optionId === 'client_only') {
        nextSettings.defaultClientId = clientId || nextSettings.defaultClientId;
        nextSettings.defaultProjectId = undefined;
        nextSettings.preferClientOnlyMapping = true;
      } else {
        nextSettings.defaultClientId = clientId || nextSettings.defaultClientId;
        nextSettings.defaultProjectId = projectId || undefined;
        nextSettings.preferClientOnlyMapping = false;
      }
      this.updateConnectionSettings(
        { provider: connection.provider, accountId: connection.accountId },
        nextSettings,
      );
    } else if (question.createdFrom.startsWith('setup_guidance|')) {
      const [, connectionKey] = question.createdFrom.split('|');
      const connection = this.listConnections().find((entry) => entry.connectionKey === connectionKey);
      if (!connection || !connection.accountId) {
        throw new Error('Connected account not found.');
      }
      const nextSettings = {
        ...(connection.settings || {}),
        triageGuidance: answerValue || question.effectPreview,
      };
      this.updateConnectionSettings(
        { provider: connection.provider, accountId: connection.accountId },
        nextSettings,
      );
    } else if (question.createdFrom.startsWith('source_triage:')) {
      const sourceRef = question.createdFrom.replace('source_triage:', '');
      const parsed = parseSourceRecordKey(sourceRef);
      if (!parsed) throw new Error('Source record not found.');
      const source = getSourceRecord(parsed.provider, parsed.accountId, parsed.kind, parsed.externalId);
      if (!source) throw new Error('Source record not found.');
      const attention = sourceAttention(source);
      if (optionId === 'needs_action') {
        source.attention = {
          ...attention,
          actionRequired: true,
          awarenessOnly: false,
          reportWorthy: true,
          importanceReason: 'Confirmed as needing Jerry action',
        };
      } else if (optionId === 'awareness_only') {
        source.attention = {
          ...attention,
          actionRequired: false,
          awarenessOnly: true,
          reportWorthy: true,
          importanceReason: 'Confirmed as awareness-only',
        };
        addCorrection({
          targetType: 'source_record',
          targetId: sourceRef,
          field: 'awarenessOnly',
          value: 'true',
        });
      } else if (optionId === 'suppress') {
        source.attention = {
          ...attention,
          actionRequired: false,
          awarenessOnly: false,
          reportWorthy: false,
          importanceReason: 'Suppressed as low-value noise',
        };
        addCorrection({
          targetType: 'source_record',
          targetId: sourceRef,
          field: 'hideFromSummaries',
          value: 'true',
        });
      }
      source.reviewState = 'accepted';
      source.metadata = {
        ...(source.metadata || {}),
        attention: source.attention,
        reviewState: 'accepted',
      };
      this.reprocessStoredSource(source);
    } else if (question.createdFrom.startsWith('work_review:')) {
      const workItemId = question.createdFrom.replace('work_review:', '');
      const item = getWorkItem(workItemId);
      if (!item) throw new Error('Work item not found.');
      upsertWorkItem({
        ...item,
        needsReview: false,
        status: optionId === 'remove_work_item' ? 'ignored' : item.status,
        openLoopState: optionId === 'remove_work_item' ? 'closed' : item.openLoopState,
      });
      if (item.sourceRecordKey) {
        const parsed = parseSourceRecordKey(item.sourceRecordKey);
        if (parsed) {
          const source = getSourceRecord(parsed.provider, parsed.accountId, parsed.kind, parsed.externalId);
          if (source) {
            source.metadata = {
              ...(source.metadata || {}),
              workItemStatusOverride: optionId === 'remove_work_item' ? 'ignored' : 'open',
            };
            this.reprocessStoredSource(source);
          }
        }
      }
    } else if (question.createdFrom.startsWith('calendar_intent:')) {
      const sourceRef = question.createdFrom.replace('calendar_intent:', '');
      const parsed = parseSourceRecordKey(sourceRef);
      if (!parsed) throw new Error('Calendar event not found.');
      const source = getSourceRecord(parsed.provider, parsed.accountId, parsed.kind, parsed.externalId);
      if (!source) throw new Error('Calendar event not found.');
      source.metadata = {
        ...(source.metadata || {}),
        calendarIntent: optionId === 'meeting' ? 'meeting' : 'reminder',
      };
      source.reviewState = 'accepted';
      this.reprocessStoredSource(source);
    } else if (question.createdFrom.startsWith('account_hint:')) {
      const hintId = question.createdFrom.replace('account_hint:', '');
      const hint = listAccountScopedContactHints({ limit: 400 }).find((entry) => entry.id === hintId);
      if (!hint) throw new Error('Account-scoped hint not found.');
      upsertAccountScopedContactHint({
        ...hint,
        dedupeKey: accountScopedHintDedupeKey({
          contactId: hint.contactId,
          provider: hint.provider,
          accountId: hint.accountId,
          identityValue: hint.identityValue,
          clientId: optionId === 'reject_hint' ? null : hint.clientId,
          projectId:
            optionId === 'client_only' || optionId === 'reject_hint' ? null : hint.projectId,
          basis: hint.basis,
        }),
        clientId: optionId === 'reject_hint' ? null : hint.clientId,
        projectId:
          optionId === 'client_only' || optionId === 'reject_hint' ? null : hint.projectId,
        status: optionId === 'reject_hint' ? 'rejected' : 'accepted',
      });
      this.reprocessStoredSources({
        provider: hint.provider,
        accountId: hint.accountId,
      });
    } else if (question.createdFrom.startsWith('contact_mapping:')) {
      if (optionId === 'accept_mapping') {
        this.reviewAccept(question.createdFrom);
      } else {
        this.reviewReject(question.createdFrom);
      }
    } else if (question.createdFrom.startsWith('memory:')) {
      const memoryId = question.createdFrom.replace('memory:', '');
      if (optionId === 'accept_memory') {
        this.acceptMemoryFact(memoryId);
      } else {
        this.rejectMemoryFact(memoryId);
      }
    }
    const answered = upsertAssistantQuestion({
      ...question,
      dedupeKey: question.dedupeKey,
      status: 'answered',
      answerOptionId: optionId,
      answerValue,
      snoozeUntil: null,
      answeredAt: new Date().toISOString(),
    });
    this.writePublicSnapshots();
    return answered;
  }

  dismissAssistantQuestion(input: {
    id: string;
    reason: 'not_now' | 'resolved' | 'wrong_question';
  }): AssistantQuestion {
    const question = getAssistantQuestion(input.id);
    if (!question) {
      throw new Error('Question not found.');
    }
    const snoozeUntil =
      input.reason === 'not_now' ? new Date(Date.now() + 4 * 60 * 60_000).toISOString() : null;
    const updated = upsertAssistantQuestion({
      ...question,
      dedupeKey: question.dedupeKey,
      status: input.reason === 'not_now' ? 'snoozed' : 'dismissed',
      snoozeUntil,
      answerOptionId: question.answerOptionId,
      answerValue: question.answerValue,
      answeredAt: input.reason === 'not_now' ? question.answeredAt : new Date().toISOString(),
    });
    this.writePublicSnapshots();
    return updated;
  }

  private syncImprovementTickets(): void {
    const grouped = new Map<
      string,
      {
        field: string;
        targetType: Correction['targetType'];
        refs: string[];
        count: number;
        provider: string;
        accountId: string;
        kind: string;
      }
    >();
    for (const correction of listCorrections(300)) {
      if (correction.targetType !== 'source_record') continue;
      const parsed = parseSourceRecordKey(correction.targetId);
      if (!parsed) continue;
      const key = [
        correction.field,
        correction.targetType,
        parsed.provider,
        parsed.accountId || 'default',
        parsed.kind,
      ].join(':');
      const bucket = grouped.get(key) || {
        field: correction.field,
        targetType: correction.targetType,
        refs: [],
        count: 0,
        provider: parsed.provider,
        accountId: parsed.accountId || 'default',
        kind: parsed.kind,
      };
      bucket.count += 1;
      if (bucket.refs.length < 6) bucket.refs.push(correction.targetId);
      grouped.set(key, bucket);
    }

    for (const [key, bucket] of grouped.entries()) {
      if (bucket.count < 3) continue;
      const account = this.listConnections().find(
        (entry) => entry.provider === bucket.provider && (entry.accountId || 'default') === bucket.accountId,
      );
      const accountLabel =
        account?.accountLabel || account?.accountId || `${bucket.provider}:${bucket.accountId}`;
      const title =
        bucket.field === 'awarenessOnly'
          ? `Reduce repeated awareness-only corrections for ${accountLabel}`
          : bucket.field === 'hideFromSummaries'
            ? `Reduce repeated suppression corrections for ${accountLabel}`
            : `Reduce repeated ${bucket.field} corrections for ${accountLabel}`;
      upsertImprovementTicket({
        dedupeKey: `repeated-correction:${key}`,
        status: 'draft',
        title,
        problem: `Jerry has repeatedly corrected ${bucket.kind} items for ${accountLabel} using the "${bucket.field}" control.`,
        observedContext: `Observed ${bucket.count} corrections on ${bucket.kind} items for ${accountLabel}.`,
        desiredBehavior:
          'The assistant should learn this pattern earlier so repeated manual corrections are no longer required.',
        userValue:
          'Reduce friction in triage and make the assistant quieter and more trustworthy over time.',
        acceptanceCriteria: [
          'Repeated corrections of the same pattern generate fewer future false positives.',
          'The affected surface becomes quieter without hiding real operational risk.',
          'The implementation is evidence-backed and testable.',
        ],
        evidenceRefs: bucket.refs,
        suggestedSurface: bucket.kind === 'email' ? 'Inbox' : 'Review',
        suggestedSubsystem: 'personal-ops/service triage',
        createdFrom: 'repeated_corrections',
        notes: 'Generated from repeated correction friction.',
      });
    }
  }

  getImprovementTickets(): ImprovementTicket[] {
    this.syncImprovementTickets();
    return listImprovementTickets({ limit: 200 });
  }

  approveImprovementTicket(id: string): ImprovementTicket {
    const ticket = this.getImprovementTickets().find((entry) => entry.id === id);
    if (!ticket) {
      throw new Error('Improvement ticket not found.');
    }
    const updated = upsertImprovementTicket({
      ...ticket,
      dedupeKey: ticket.dedupeKey || `ticket:${ticket.id}`,
      status: 'approved',
      resolvedAt: new Date().toISOString(),
    });
    this.writePublicSnapshots();
    return updated;
  }

  rejectImprovementTicket(id: string): ImprovementTicket {
    const ticket = this.getImprovementTickets().find((entry) => entry.id === id);
    if (!ticket) {
      throw new Error('Improvement ticket not found.');
    }
    const updated = upsertImprovementTicket({
      ...ticket,
      dedupeKey: ticket.dedupeKey || `ticket:${ticket.id}`,
      status: 'rejected',
      resolvedAt: new Date().toISOString(),
    });
    this.writePublicSnapshots();
    return updated;
  }

  editImprovementTicket(
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
  ): ImprovementTicket {
    const ticket = this.getImprovementTickets().find((entry) => entry.id === id);
    if (!ticket) {
      throw new Error('Improvement ticket not found.');
    }
    const updated = upsertImprovementTicket({
      ...ticket,
      dedupeKey: ticket.dedupeKey || `ticket:${ticket.id}`,
      title: input.title?.trim() || ticket.title,
      problem: input.problem?.trim() || ticket.problem,
      observedContext: input.observedContext?.trim() || ticket.observedContext,
      desiredBehavior: input.desiredBehavior?.trim() || ticket.desiredBehavior,
      userValue: input.userValue?.trim() || ticket.userValue,
      acceptanceCriteria:
        input.acceptanceCriteria?.filter((entry) => entry.trim()) || ticket.acceptanceCriteria,
      suggestedSurface: input.suggestedSurface ?? ticket.suggestedSurface,
      suggestedSubsystem: input.suggestedSubsystem ?? ticket.suggestedSubsystem,
      notes: input.notes ?? ticket.notes,
      status: ticket.status,
      resolvedAt: ticket.resolvedAt,
    });
    this.writePublicSnapshots();
    return updated;
  }

  getOpenLoops(): OpenLoop[] {
    const sourceByKey = new Map<string, SourceRecord>();
    for (const source of listSourceRecords({ limit: 400 })) {
      sourceByKey.set(sanitizeSourceRef(source), source);
    }
    const workstreamKeyByRef = new Map<string, string>();
    for (const stream of this.getWorkboardView()) {
      for (const item of stream.items) {
        workstreamKeyByRef.set(item.id, stream.key);
      }
      for (const source of stream.sourceRecords) {
        workstreamKeyByRef.set(sanitizeSourceRef(source), stream.key);
      }
    }

    const loops: OpenLoop[] = [];
    for (const item of listWorkItems({ limit: 300 })) {
      if (this.isNoiseDerivedWorkItem(item)) continue;
      const state = workItemOpenLoopState(item);
      if (state === 'closed') continue;
      loops.push({
        id: `work_item:${item.id}`,
        kind: 'work_item',
        state,
        title: item.title,
        summary: item.notes || 'Open work item',
        priority: item.priority,
        confidence: item.confidence,
        clientId: item.clientId,
        projectId: item.projectId,
        workItemId: item.id,
        sourceRecordKey: item.sourceRecordKey,
        workstreamKey:
          workstreamKeyByRef.get(item.id) ||
          (item.sourceRecordKey ? workstreamKeyByRef.get(item.sourceRecordKey) || null : null),
        linkedContactIds: item.linkedContactIds,
        needsReview: item.needsReview,
        dueAt: item.dueDate,
        lastUpdatedAt: item.updatedAt,
      });
    }

    for (const source of sourceByKey.values()) {
      if (source.kind === 'calendar_event' || source.kind === 'manual_note') continue;
      const attention = sourceAttention(source);
      const reviewState = sourceReviewState(source);
      const hasWorkItem = Boolean(getWorkItem(`work:${sanitizeSourceRef(source)}`));
      if (hasWorkItem && reviewState !== 'suggested') continue;
      if (!attention.awarenessOnly && reviewState !== 'suggested') continue;
      if (!attention.reportWorthy && !attention.operationalRisk && reviewState !== 'suggested') {
        continue;
      }
      loops.push({
        id: `${reviewState === 'suggested' ? 'review' : 'awareness'}:${sanitizeSourceRef(source)}`,
        kind: reviewState === 'suggested' ? 'review' : 'awareness',
        state: reviewState === 'suggested' ? 'action' : 'awareness',
        title: source.title,
        summary: attention.importanceReason || source.summary || 'Attention item',
        priority: clampPriority(source.priority),
        confidence:
          attention.actionConfidence ??
          attention.mappingConfidence ??
          source.attributionConfidence ??
          null,
        clientId: source.clientId || null,
        projectId: source.projectId || null,
        workItemId: hasWorkItem ? `work:${sanitizeSourceRef(source)}` : null,
        sourceRecordKey: sanitizeSourceRef(source),
        workstreamKey: workstreamKeyByRef.get(sanitizeSourceRef(source)) || null,
        linkedContactIds:
          source.linkedContactIds || sourceMetadataStringArray(source, 'linkedContactIds'),
        needsReview: reviewState === 'suggested',
        dueAt: source.dueAt || null,
        lastUpdatedAt: latestIso(source.occurredAt, source.syncedAt),
      });
    }

    return loops
      .sort((a, b) => {
        const priorityDiff = inboxPriorityRank(b.priority) - inboxPriorityRank(a.priority);
        if (priorityDiff !== 0) return priorityDiff;
        if (a.needsReview !== b.needsReview) return a.needsReview ? -1 : 1;
        return (b.lastUpdatedAt || '').localeCompare(a.lastUpdatedAt || '');
      })
      .slice(0, 120);
  }

  getReviewQueue(): ReviewQueueItem[] {
    const clients = new Map(this.getClients().map((client) => [client.id, client]));
    const projects = new Map(this.getProjects().map((project) => [project.id, project]));
    const queue: ReviewQueueItem[] = [];

    for (const suggestion of listContactMappingSuggestions({ status: 'suggested', limit: 100 })) {
      const contact = getContact(suggestion.contactId);
      const client = suggestion.clientId ? clients.get(suggestion.clientId) : null;
      const project = suggestion.projectId ? projects.get(suggestion.projectId) : null;
      queue.push({
        id: `contact_mapping:${suggestion.id}`,
        kind: 'contact_mapping',
        title: contact ? contact.name : 'Contact mapping',
        summary: [client?.name || 'Unassigned client', project?.name || 'Client-level'].join(' / '),
        confidence: suggestion.confidence,
        status: suggestion.status,
        clientId: suggestion.clientId,
        projectId: suggestion.projectId,
        contactId: suggestion.contactId,
        sourceRecordKey: null,
        workItemId: null,
        reasons: [suggestion.basis, `${suggestion.occurrenceCount} observed match${suggestion.occurrenceCount === 1 ? '' : 'es'}`],
        createdAt: suggestion.createdAt,
        updatedAt: suggestion.updatedAt,
      });
    }

    for (const source of listSourceRecords({ limit: 240 })) {
      if (!sourceNeedsReview(source)) continue;
      queue.push({
        id: `source_record:${sanitizeSourceRef(source)}`,
        kind: 'source_record',
        title: source.title,
        summary: sourceAttention(source).importanceReason || source.summary || 'Low-confidence source attribution',
        confidence:
          sourceAttention(source).actionConfidence ??
          sourceAttention(source).mappingConfidence ??
          source.attributionConfidence ??
          null,
        status: sourceReviewState(source) || 'suggested',
        clientId: source.clientId || null,
        projectId: source.projectId || null,
        contactId: null,
        sourceRecordKey: sanitizeSourceRef(source),
        workItemId: null,
        reasons: sourceWhyReview(source),
        createdAt: source.occurredAt,
        updatedAt: source.syncedAt,
      });
    }

    for (const item of listWorkItems({ limit: 240 })) {
      if (!item.needsReview) continue;
      queue.push({
        id: `work_item:${item.id}`,
        kind: 'work_item',
        title: item.title,
        summary: item.notes || 'Low-confidence work item',
        confidence: item.confidence,
        status: 'suggested',
        clientId: item.clientId,
        projectId: item.projectId,
        contactId: null,
        sourceRecordKey: item.sourceRecordKey,
        workItemId: item.id,
        reasons: ['Low-confidence inferred task', `Open-loop state: ${item.openLoopState}`],
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      });
    }

    return queue
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .slice(0, 160);
  }

  reviewAccept(id: string): void {
    if (id.startsWith('contact_mapping:')) {
      const mapping = listContactMappingSuggestions({ limit: 300 }).find(
        (entry) => `contact_mapping:${entry.id}` === id,
      );
      if (!mapping) throw new Error('Review item not found.');
      upsertContactMappingSuggestion({ ...mapping, status: 'accepted' });
      const contact = getContact(mapping.contactId);
      if (contact) {
        upsertContact({
          id: contact.id,
          name: contact.name,
          organizationHint: contact.organizationHint,
          likelyRole: contact.likelyRole,
          importance: contact.importance,
          notes: contact.notes,
          lastSeenAt: contact.lastSeenAt,
          defaultClientId: mapping.clientId ?? contact.defaultClientId,
          defaultProjectId: mapping.projectId ?? contact.defaultProjectId,
          sourceCount: contact.sourceCount,
        });
      }
      this.reprocessStoredSources();
    } else if (id.startsWith('source_record:')) {
      const parsed = parseSourceRecordKey(id.replace('source_record:', ''));
      if (!parsed) throw new Error('Review item not found.');
      const source = getSourceRecord(parsed.provider, parsed.accountId, parsed.kind, parsed.externalId);
      if (!source) throw new Error('Review item not found.');
      source.reviewState = 'accepted';
      source.metadata = {
        ...(source.metadata || {}),
        reviewState: 'accepted',
        attention: sourceAttention(source),
      };
      this.reprocessStoredSource(source);
    } else if (id.startsWith('work_item:')) {
      const workItemId = id.replace('work_item:', '');
      const workItem = getWorkItem(workItemId);
      if (!workItem) throw new Error('Review item not found.');
      upsertWorkItem({ ...workItem, needsReview: false });
    } else {
      throw new Error('Unsupported review item.');
    }
    this.writePublicSnapshots();
  }

  reviewReject(id: string): void {
    if (id.startsWith('contact_mapping:')) {
      const mapping = listContactMappingSuggestions({ limit: 300 }).find(
        (entry) => `contact_mapping:${entry.id}` === id,
      );
      if (!mapping) throw new Error('Review item not found.');
      upsertContactMappingSuggestion({ ...mapping, status: 'rejected' });
      this.reprocessStoredSources();
    } else if (id.startsWith('source_record:')) {
      const parsed = parseSourceRecordKey(id.replace('source_record:', ''));
      if (!parsed) throw new Error('Review item not found.');
      const source = getSourceRecord(parsed.provider, parsed.accountId, parsed.kind, parsed.externalId);
      if (!source) throw new Error('Review item not found.');
      const attention = sourceAttention(source);
      source.reviewState = 'rejected';
      source.metadata = {
        ...(source.metadata || {}),
        reviewState: 'rejected',
        attention: {
          ...attention,
          awarenessOnly: true,
          actionRequired: false,
        },
        modelActionRequired: false,
      };
      source.metadata = {
        ...(source.metadata || {}),
        workItemStatusOverride: 'ignored',
      };
      this.reprocessStoredSource(source);
    } else if (id.startsWith('work_item:')) {
      const workItemId = id.replace('work_item:', '');
      const workItem = getWorkItem(workItemId);
      if (!workItem) throw new Error('Review item not found.');
      upsertWorkItem({
        ...workItem,
        status: 'ignored',
        needsReview: false,
        openLoopState: 'closed',
      });
    } else {
      throw new Error('Unsupported review item.');
    }
    this.writePublicSnapshots();
  }

  getCorrections(limit = 100): Correction[] {
    return listCorrections(limit);
  }

  getReports(limit = 20) {
    return listReportSnapshots(undefined, limit);
  }

  getWorkboardView(): PersonalOpsWorkstream[] {
    return this.buildWorkstreams({
      since: plusDays(new Date(), -7).toISOString(),
      activeOnly: true,
      limit: 40,
    });
  }

  private selectInboxRecords(input: {
    since?: string;
    until?: string;
    limit: number;
    includeNoise?: boolean;
  }): SourceRecord[] {
    return listSourceRecords({
      since: input.since,
      until: input.until,
      limit: Math.max(input.limit * 8, 160),
    })
      .map(normalizeSourceForView)
      .filter(
        (record) =>
          record.kind === 'email' || record.kind === 'slack_message',
      )
      .filter((record) => input.includeNoise || !isLikelyNoiseEmail(record))
      .sort((a, b) => {
        const score = inboxSortScore(b) - inboxSortScore(a);
        if (score !== 0) return score;
        return new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
      })
      .slice(0, input.limit);
  }

  private isNoiseDerivedWorkItem(item: WorkItem): boolean {
    if (!item.sourceRecordKey || item.sourceProvider === 'manual') {
      return false;
    }
    const parsed = parseSourceRecordKey(item.sourceRecordKey);
    if (!parsed) {
      return false;
    }
    const source = getSourceRecord(
      parsed.provider,
      parsed.accountId,
      parsed.kind,
      parsed.externalId,
    );
    if (!source) {
      return false;
    }
    if (isLikelyNoiseEmail(source)) {
      return true;
    }
    if (source.kind === 'email' && !sourceNeedsAttention(source)) {
      return true;
    }
    return false;
  }

  getHistoryView(input?: { since?: string; until?: string }): Activity[] {
    this.refreshRepositoryActivityIfDue();
    return listActivities({
      since: input?.since || plusDays(new Date(), -7).toISOString(),
      until: input?.until,
      limit: 200,
    });
  }

  getHistoryWorkstreams(input?: { since?: string; until?: string }): PersonalOpsWorkstream[] {
    return this.buildWorkstreams({
      since: input?.since || plusDays(new Date(), -7).toISOString(),
      until: input?.until,
      activeOnly: false,
      limit: 20,
    });
  }

  getLatestReport(type: PersonalOpsReportType) {
    return getLatestReportSnapshot(type);
  }

  async generateReport(
    reportType: PersonalOpsReportType,
    range?: { start?: string; end?: string },
  ) {
    const now = new Date();
    const rangeStart =
      range?.start ||
      (reportType === 'wrap'
        ? startOfDay(now).toISOString()
        : reportType === 'morning'
          ? startOfDay(now).toISOString()
          : plusDays(now, -1).toISOString());
    const rangeEnd = range?.end || now.toISOString();

    const facts = {
      today: this.getTodayView(),
      workboard: this.getWorkboardView().slice(0, 8),
      history: this.getHistoryView({ since: rangeStart, until: rangeEnd }).slice(0, 20),
      reports: listReportSnapshots(undefined, 6),
    };

    const deterministic = this.renderDeterministicReport(reportType, facts);
    const drafted = await draftOperationalReport({
      reportType,
      facts,
    });
    const groupedOutput = drafted || deterministic;
    const snapshot = addReportSnapshot({
      reportType,
      generatedAt: now.toISOString(),
      rangeStart,
      rangeEnd,
      groupedOutput,
      sourceReferences: this.collectReportReferences(facts),
      model: drafted ? 'openai' : 'deterministic',
    });
    this.writePublicSnapshots();
    return snapshot;
  }

  private collectReportReferences(facts: Record<string, unknown>): string[] {
    const refs = new Set<string>();
    const today = facts.today as PersonalOpsTodaySummary | undefined;
    for (const source of today?.meetings || []) refs.add(sanitizeSourceRef(source));
    for (const source of today?.inbox || []) refs.add(sanitizeSourceRef(source));
    for (const source of today?.awareness || []) refs.add(sanitizeSourceRef(source));
    for (const stream of today?.workstreams || []) {
      for (const source of stream.sourceRecords || []) {
        refs.add(sanitizeSourceRef(source));
      }
      for (const repository of stream.repositories || []) {
        refs.add(repository.localPath);
      }
    }
    for (const activity of (facts.history as Activity[] | undefined) || []) {
      if (activity.sourceRecordKey) {
        refs.add(activity.sourceRecordKey);
      } else if (activity.rawReference) {
        refs.add(activity.rawReference);
      } else if (typeof activity.metadata?.repoPath === 'string') {
        refs.add(activity.metadata.repoPath);
      }
    }
    return [...refs];
  }

  private renderStandupFromCurrentState(): string {
    const buckets = this.getWorkboardView();
    const recentHistory = this.getHistoryView({ since: plusDays(new Date(), -1).toISOString() });
    if (buckets.length === 0) return 'No current work tracked yet.';
    return buckets
      .slice(0, 8)
      .map((bucket) => {
        const header = [
          bucket.client?.name || 'Unassigned client',
          bucket.project?.name || 'General',
        ].join(' / ');
        const commitHours = this.estimateCommitHours(
          recentHistory.filter(
            (activity) =>
              activity.relatedClientId === (bucket.client?.id || null) &&
              activity.relatedProjectId === (bucket.project?.id || null),
          ),
        );
        const completed = [
          ...bucket.recentActivity
            .filter((activity) => activity.type !== 'calendar_event')
            .slice(0, 2)
            .map((activity) => `- ${activity.summary}`),
          ...bucket.sourceRecords
            .filter((source) => source.kind !== 'calendar_event')
            .slice(0, 2)
            .map((source) => `- ${source.title}`),
        ].slice(0, 3);
        const inProgress = bucket.items
          .filter((item) => item.status === 'in_progress' || item.status === 'open')
          .slice(0, 3)
          .map((item) => `- ${item.title}`);
        const blockers = bucket.items
          .filter((item) => item.status === 'blocked')
          .slice(0, 2)
          .map((item) => `- ${item.title}`);
        return [
          header,
          'Completed:',
          ...(completed.length ? completed : ['- No completed work logged.']),
          ...(commitHours > 0 ? [`Estimated commit time: ${commitHours.toFixed(1)}h`] : []),
          'In progress / next:',
          ...(inProgress.length ? inProgress : ['- Nothing active.']),
          'Blockers:',
          ...(blockers.length ? blockers : ['- None.']),
        ].join('\n');
      })
      .join('\n\n');
  }

  private renderDeterministicReport(
    reportType: PersonalOpsReportType,
    facts: Record<string, unknown>,
  ): string {
    if (reportType === 'standup') {
      return this.renderStandupFromCurrentState();
    }
    const today = facts.today as PersonalOpsTodaySummary;
    if (reportType === 'morning') {
      return [
        'Morning Brief',
        '',
        `Meetings today: ${today.meetings.length}`,
        ...today.meetings.slice(0, 5).map(
          (meeting) => `- ${meeting.title} @ ${formatDateTime(meeting.occurredAt)}`,
        ),
        '',
        'Top priorities:',
        ...today.priorities.slice(0, 5).map((item) => `- ${item.title}`),
        '',
        'Open loops:',
        ...(today.openLoops.length
          ? today.openLoops.slice(0, 5).map((loop) => `- ${loop.title} (${loop.state})`)
          : ['- None']),
        '',
        'Important awareness:',
        ...(today.awareness.length
          ? today.awareness.slice(0, 4).map((source) => `- ${source.title}`)
          : ['- None']),
        '',
        'Active workstreams:',
        ...(today.workstreams.length
          ? today.workstreams
              .slice(0, 4)
              .map((stream) => `- ${[stream.client?.name || 'Unassigned client', stream.project?.name || 'General work'].join(' / ')}${stream.signals.length ? ` (${stream.signals.join('; ')})` : ''}`)
          : ['- None yet']),
        '',
        'Overdue:',
        ...(today.overdue.length
          ? today.overdue.slice(0, 5).map((item) => `- ${item.title}`)
          : ['- None']),
        '',
        'Suggested plan:',
        ...today.suggestedPlan.map((line) => `- ${line}`),
      ].join('\n');
    }
    if (reportType === 'wrap') {
      const history = facts.history as Activity[];
      const commitHours = this.estimateCommitHours(history);
      return [
        'End-of-Day Wrap',
        '',
        'Moved forward today:',
        ...history.slice(0, 8).map((activity) => `- ${activity.summary}`),
        ...(commitHours > 0 ? ['', `Estimated commit time: ${commitHours.toFixed(1)}h`] : []),
        '',
        'Still open:',
        ...today.priorities.slice(0, 5).map((item) => `- ${item.title}`),
        '',
        'Awareness to carry forward:',
        ...(today.awareness.length
          ? today.awareness.slice(0, 4).map((source) => `- ${source.title}`)
          : ['- None']),
      ].join('\n');
    }
    if (reportType === 'history' || reportType === 'what_changed') {
      const history = facts.history as Activity[];
      return history.length
        ? history.slice(0, 20).map((activity) => `- ${formatDateTime(activity.timestamp)} ${activity.summary}`).join('\n')
        : 'No activity found for that period.';
    }
    return this.renderStandupFromCurrentState();
  }

  formatChatCommand(command: string, args: string): string {
    switch (command) {
      case '/today': {
        const view = this.getTodayView();
        return [
          'Today',
          '',
          'Meetings:',
          ...(view.meetings.length
            ? view.meetings.slice(0, 5).map((meeting) => `- ${meeting.title} @ ${formatDateTime(meeting.occurredAt)}`)
            : ['- None']),
          '',
          'Must do:',
          ...(view.priorities.length
            ? view.priorities.slice(0, 5).map((item) => `- ${item.title}`)
            : ['- No active priorities tracked.']),
          '',
          'Open loops:',
          ...(view.openLoops.length
            ? view.openLoops.slice(0, 5).map((loop) => `- ${loop.title} (${loop.state})`)
            : ['- None']),
          '',
          'Pending approvals:',
          ...(view.approvalQueue.length
            ? view.approvalQueue.slice(0, 4).map((item) => `- ${item.title} (${item.kind})`)
            : ['- None']),
          '',
          'Important awareness:',
          ...(view.awareness.length
            ? view.awareness.slice(0, 4).map((item) => `- ${item.title}`)
            : ['- None']),
          '',
          'Active workstreams:',
          ...(view.workstreams.length
            ? view.workstreams.slice(0, 4).map((stream) => {
                const label = [stream.client?.name || 'Unassigned client', stream.project?.name || 'General work']
                  .join(' / ');
                return `- ${label}${stream.signals.length ? ` (${stream.signals.join('; ')})` : ''}`;
              })
            : ['- No grouped workstreams yet.']),
          '',
          'Follow-ups:',
          ...(view.followUps.length
            ? view.followUps.slice(0, 5).map((item) => `- ${item.title}`)
            : ['- None']),
        ].join('\n');
      }
      case '/inbox': {
        const inbox = this.getInboxView().slice(0, 10);
        return [
          'Inbox',
          '',
          ...(inbox.length
            ? inbox.map((item) => {
                const account = item.accountLabel || item.accountId;
                const suffix = account ? `${item.provider}/${account}` : item.provider;
                return `- ${item.title} [${suffix}]`;
              })
            : ['No recent email items found.']),
        ].join('\n');
      }
      case '/calendar': {
        const events = this.getCalendarView().slice(0, 10);
        return [
          'Calendar',
          '',
          ...(events.length
            ? events.map((item) => {
                const account = item.accountLabel || item.accountId;
                const suffix = account ? ` [${item.provider}/${account}]` : '';
                return `- ${item.title} @ ${formatDateTime(item.occurredAt)}${suffix}`;
              })
            : ['No upcoming events found.']),
        ].join('\n');
      }
      case '/standup':
        return this.getLatestReport('standup')?.groupedOutput || this.renderStandupFromCurrentState();
      case '/wrap':
        return this.getLatestReport('wrap')?.groupedOutput || 'No end-of-day wrap has been generated yet.';
      case '/history': {
        const history = this.getHistoryView({
          since: args.trim() ? new Date(args.trim()).toISOString() : plusDays(new Date(), -1).toISOString(),
        }).slice(0, 15);
        return history.length
          ? history.map((activity) => `- ${formatDateTime(activity.timestamp)} ${activity.summary}`).join('\n')
          : 'No recent activity found.';
      }
      case '/what-changed': {
        const changes = this.getHistoryView({ since: plusDays(new Date(), -1).toISOString() }).slice(0, 12);
        return changes.length
          ? ['What changed since yesterday', '', ...changes.map((activity) => `- ${activity.summary}`)].join('\n')
          : 'No changes tracked since yesterday.';
      }
      case '/followups': {
        const followups = this.getTodayView().followUps;
        return followups.length
          ? ['Follow-ups', '', ...followups.map((item) => `- ${item.title}`)].join('\n')
          : 'No open follow-ups.';
      }
      case '/task': {
        if (!args.trim()) {
          return 'Usage: /task Title of task';
        }
        const item = this.createManualTask({ title: args.trim() });
        return `Task created: ${item.title}`;
      }
      case '/note': {
        if (!args.trim()) {
          return 'Usage: /note Note text';
        }
        const note = this.createManualNote({ title: args.trim(), body: args.trim() });
        return `Note logged: ${note.title}`;
      }
      case '/correct': {
        const [targetType, targetId, field, ...rest] = args.trim().split(/\s+/);
        const value = rest.join(' ');
        if (!targetType || !targetId || !field || !value) {
          return 'Usage: /correct <source_record|work_item|preference> <targetId> <field> <value>';
        }
        const correction = this.recordCorrection({
          targetType: targetType as Correction['targetType'],
          targetId,
          field,
          value,
        });
        return `Correction recorded: ${correction.field} -> ${correction.value}`;
      }
      default:
        return 'Unsupported personal ops command.';
    }
  }

  writePublicSnapshots(): void {
    ensureDir(PERSONAL_OPS_PUBLIC_DIR);
    this.refreshRepositoryActivityIfDue(true);
    const snapshots: Record<string, unknown> = {
      today: this.getTodayView(),
      inbox: this.getInboxView().slice(0, 50),
      calendar: this.getCalendarView().slice(0, 50),
      workboard: this.getWorkboardView().slice(0, 20),
      history: this.getHistoryView().slice(0, 50),
      reports: listReportSnapshots(undefined, 12),
      connections: this.listConnections(),
      corrections: listCorrections(50),
      clients: listClients(),
      projects: listProjects(),
      repositories: listRepositories(),
      contacts: this.getContacts(),
      memory: this.getMemoryFacts(),
      open_loops: this.getOpenLoops(),
      queue: this.getApprovalQueue(),
      review: this.getReviewQueue(),
      operator_profile: this.getOperatorProfile(),
      preferences: listPreferences(),
    };
    for (const [name, payload] of Object.entries(snapshots)) {
      writePrivateFile(
        path.join(PERSONAL_OPS_PUBLIC_DIR, `${name}.json`),
        JSON.stringify(payload, null, 2),
      );
    }
  }

  shouldPushToMainChat(): boolean {
    const pref = getPreference('push_main_chat');
    if (pref) {
      return pref.value === 'true';
    }
    return PERSONAL_OPS_PUSH_MAIN_CHAT;
  }
}

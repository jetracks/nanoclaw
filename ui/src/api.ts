export type PersonalOpsPriority = 'low' | 'medium' | 'high' | 'urgent';
export type PersonalOpsProvider = 'google' | 'microsoft' | 'jira' | 'slack' | 'manual';
export type PersonalOpsActivityProvider = PersonalOpsProvider | 'git';
export type PersonalOpsContactImportance = 'low' | 'normal' | 'high' | 'critical';
export type PersonalOpsSuggestionStatus = 'suggested' | 'accepted' | 'rejected';
export type PersonalOpsQuestionStatus =
  | 'pending'
  | 'answered'
  | 'dismissed'
  | 'snoozed';
export type PersonalOpsQuestionSurface =
  | 'today'
  | 'inbox'
  | 'work'
  | 'review'
  | 'connections'
  | 'calendar';
export type PersonalOpsQuestionUrgency = 'inline' | 'queued';
export type PersonalOpsQuestionTargetType =
  | 'source_record'
  | 'contact'
  | 'connection'
  | 'calendar_event'
  | 'work_item'
  | 'setup';
export type PersonalOpsQuestionOptionScope =
  | 'current_item'
  | 'account'
  | 'account_hint'
  | 'contact'
  | 'memory_review'
  | 'one_off'
  | 'improvement';
export type PersonalOpsImprovementStatus =
  | 'draft'
  | 'approved'
  | 'rejected'
  | 'implemented';
export type PersonalOpsOpenLoopState =
  | 'action'
  | 'waiting'
  | 'blocked'
  | 'awareness'
  | 'closed';
export type PersonalOpsThreadStateStatus =
  | 'direct_ask'
  | 'shared_alias'
  | 'waiting_for_response'
  | 'already_replied'
  | 'blocked'
  | 'resolved'
  | 'awareness';
export type PersonalOpsMemoryFactKind =
  | 'contact_client'
  | 'contact_project'
  | 'contact_role'
  | 'contact_importance'
  | 'relationship_hint';
export type PersonalOpsApprovalActionKind =
  | 'reply_draft'
  | 'follow_up_task'
  | 'meeting_prep'
  | 'report_draft'
  | 'jira_comment_draft';
export type PersonalOpsApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'suppressed';
export type PersonalOpsAttributionDiagnosticKind =
  | 'connection_default'
  | 'domain_match'
  | 'workspace_match'
  | 'jira_key'
  | 'repo_alias'
  | 'project_match'
  | 'client_match'
  | 'single_project_fallback';

export interface PersonalOpsAttributionDiagnostic {
  kind: PersonalOpsAttributionDiagnosticKind;
  label: string;
  detail?: string | null;
}

export type WorkItemStatus =
  | 'open'
  | 'in_progress'
  | 'blocked'
  | 'waiting'
  | 'done'
  | 'ignored'
  | 'on_hold';

export interface OperatorProfile {
  roleSummary: string;
  workHoursStart: number;
  workHoursEnd: number;
  reportingPreferences: string;
  escalationPreferences: string;
  assistantStyle: string;
  clientOperatingPosture?: string;
  updatedAt: string;
}

export interface AssistantQuestionOption {
  id: string;
  label: string;
  scope: PersonalOpsQuestionOptionScope;
  effectSummary: string;
}

export interface AssistantQuestion {
  id: string;
  dedupeKey: string;
  status: PersonalOpsQuestionStatus;
  surface: PersonalOpsQuestionSurface;
  targetType: PersonalOpsQuestionTargetType | null;
  targetId: string | null;
  urgency: PersonalOpsQuestionUrgency;
  prompt: string;
  rationale: string;
  recommendedOptionId: string | null;
  options: AssistantQuestionOption[];
  freeformAllowed: boolean;
  effectPreview: string;
  createdFrom: string;
  answerOptionId: string | null;
  answerValue: string | null;
  snoozeUntil: string | null;
  createdAt: string;
  updatedAt: string;
  answeredAt: string | null;
}

export interface AttentionClassification {
  awarenessOnly: boolean;
  actionRequired: boolean;
  operationalRisk: boolean;
  reportWorthy: boolean;
  directness: 'direct' | 'mentioned' | 'shared' | 'ambient';
  importanceReason: string;
  actionConfidence: number | null;
  mappingConfidence: number | null;
  modelContextFingerprint?: string | null;
}

export interface ThreadState {
  state: PersonalOpsThreadStateStatus;
  summary: string;
  lastActor: 'self' | 'other' | 'unknown';
  confidence: number | null;
}

export interface Client {
  id: string;
  name: string;
  parentClientId: string | null;
  roles: string[];
  status: 'active' | 'prospect' | 'on_hold' | 'archived';
  notes: string;
  communicationPreferences: string;
}

export interface Project {
  id: string;
  clientId: string | null;
  name: string;
  status: 'active' | 'on_hold' | 'archived';
  priority: PersonalOpsPriority;
  deadline: string | null;
  notes: string;
  tags: string[];
}

export interface GitRepository {
  id: string;
  clientId: string | null;
  projectId: string | null;
  name: string;
  localPath: string;
  remoteUrl: string | null;
  defaultBranch: string | null;
  lastCommitAt: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  id: string;
  name: string;
  organizationHint: string | null;
  likelyRole: string | null;
  importance: PersonalOpsContactImportance;
  notes: string;
  lastSeenAt: string | null;
  defaultClientId: string | null;
  defaultProjectId: string | null;
  sourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContactIdentity {
  id: string;
  contactId: string;
  type: 'email' | 'slack' | 'jira' | 'calendar_attendee' | 'git_author' | 'name';
  provider: PersonalOpsProvider | 'git';
  value: string;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactMappingSuggestion {
  id: string;
  contactId: string;
  clientId: string | null;
  projectId: string | null;
  basis: string;
  confidence: number;
  occurrenceCount: number;
  status: PersonalOpsSuggestionStatus;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountScopedContactHint {
  id: string;
  contactId: string;
  provider: PersonalOpsProvider;
  accountId: string;
  accountLabel: string | null;
  identityValue: string;
  clientId: string | null;
  projectId: string | null;
  basis: string;
  confidence: number;
  occurrenceCount: number;
  status: PersonalOpsSuggestionStatus;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryFact {
  id: string;
  kind: PersonalOpsMemoryFactKind;
  subjectType: 'contact';
  subjectId: string;
  label: string;
  value: string;
  confidence: number;
  status: PersonalOpsSuggestionStatus | 'accepted';
  provenance: string[];
  sourceRecordKey: string | null;
  contactId: string | null;
  clientId: string | null;
  projectId: string | null;
  lastObservedAt: string | null;
  staleAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImprovementTicket {
  id: string;
  dedupeKey?: string;
  status: PersonalOpsImprovementStatus;
  title: string;
  problem: string;
  observedContext: string;
  desiredBehavior: string;
  userValue: string;
  acceptanceCriteria: string[];
  evidenceRefs: string[];
  suggestedSurface: string | null;
  suggestedSubsystem: string | null;
  createdFrom: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface SourceRecord {
  connectionKey?: string | null;
  provider: PersonalOpsProvider;
  accountId?: string | null;
  accountLabel?: string | null;
  kind: string;
  externalId: string;
  externalParentId?: string | null;
  sourceUrl?: string | null;
  title: string;
  summary: string;
  body: string;
  participants: string[];
  occurredAt: string;
  dueAt?: string | null;
  priority?: PersonalOpsPriority | null;
  status?: string | null;
  syncedAt: string;
  rawSnapshotRef?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  attributionSource?: 'manual' | 'rule' | 'model' | 'external' | 'none';
  attributionConfidence?: number | null;
  attention?: AttentionClassification | null;
  threadState?: ThreadState | null;
  linkedContactIds?: string[];
  reviewState?: PersonalOpsSuggestionStatus | null;
  metadata?: Record<string, unknown>;
}

export interface WorkItem {
  id: string;
  title: string;
  sourceKind: string;
  sourceProvider: PersonalOpsProvider | 'manual';
  sourceRecordKey: string | null;
  clientId: string | null;
  projectId: string | null;
  dueDate: string | null;
  priority: PersonalOpsPriority;
  status: WorkItemStatus;
  confidence: number | null;
  needsReview: boolean;
  linkedContactIds: string[];
  openLoopState: PersonalOpsOpenLoopState;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  id: string;
  timestamp: string;
  type: string;
  sourceProvider: PersonalOpsActivityProvider;
  sourceKind: string;
  sourceRecordKey: string | null;
  relatedClientId: string | null;
  relatedProjectId: string | null;
  summary: string;
  rawReference: string | null;
  metadata?: Record<string, unknown>;
}

export interface Correction {
  id: string;
  targetType: 'source_record' | 'work_item' | 'activity' | 'report' | 'preference';
  targetId: string;
  field: string;
  value: string;
  createdAt: string;
}

export interface OpenLoop {
  id: string;
  kind: 'work_item' | 'awareness' | 'review';
  state: PersonalOpsOpenLoopState;
  title: string;
  summary: string;
  priority: PersonalOpsPriority;
  confidence: number | null;
  clientId: string | null;
  projectId: string | null;
  workItemId: string | null;
  sourceRecordKey: string | null;
  workstreamKey: string | null;
  linkedContactIds: string[];
  needsReview: boolean;
  dueAt: string | null;
  lastUpdatedAt: string | null;
}

export interface ApprovalQueueItem {
  id: string;
  dedupeKey: string;
  kind: PersonalOpsApprovalActionKind;
  status: PersonalOpsApprovalStatus;
  title: string;
  summary: string;
  body: string;
  reason: string;
  confidence: number | null;
  clientId: string | null;
  projectId: string | null;
  sourceRecordKey: string | null;
  workItemId: string | null;
  reportType: ReportSnapshot['reportType'] | null;
  linkedContactIds: string[];
  evidence: string[];
  artifactRef: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface ReviewQueueItem {
  id: string;
  kind: 'contact_mapping' | 'source_record' | 'work_item';
  title: string;
  summary: string;
  confidence: number | null;
  status: PersonalOpsSuggestionStatus;
  clientId: string | null;
  projectId: string | null;
  contactId: string | null;
  sourceRecordKey: string | null;
  workItemId: string | null;
  reasons: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReportSnapshot {
  id: string;
  reportType: 'morning' | 'standup' | 'wrap' | 'history' | 'what_changed';
  generatedAt: string;
  rangeStart: string;
  rangeEnd: string;
  groupedOutput: string;
  sourceReferences: string[];
  model: string;
}

export interface PersonalOpsConnectionSettings {
  defaultClientId?: string;
  defaultProjectId?: string;
  preferClientOnlyMapping?: boolean;
  triageGuidance?: string;
  googleMailQuery?: string;
  googleCalendarIds?: string[];
  microsoftMailFolderIds?: string[];
  microsoftCalendarIds?: string[];
  jiraProjectKeys?: string[];
  jiraJql?: string;
  slackIncludedChannelIds?: string[];
  slackExcludedChannelIds?: string[];
}

export interface PersonalOpsConnectionCatalogOption {
  id: string;
  label: string;
  secondaryLabel?: string | null;
  kind?: string | null;
  isDefault?: boolean;
}

export interface PersonalOpsConnectionCatalog {
  provider: PersonalOpsProvider;
  accountId: string;
  accountLabel: string | null;
  mailLabels: PersonalOpsConnectionCatalogOption[];
  mailFolders: PersonalOpsConnectionCatalogOption[];
  calendars: PersonalOpsConnectionCatalogOption[];
  projects: PersonalOpsConnectionCatalogOption[];
  channels: PersonalOpsConnectionCatalogOption[];
}

export interface ConnectionSummary {
  connectionKey: string;
  provider: PersonalOpsProvider;
  status: 'connected' | 'degraded' | 'disconnected';
  accountLabel: string | null;
  accountId: string | null;
  baseUrl: string | null;
  scopes: string[];
  expiresAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: 'success' | 'error' | 'never';
  lastSyncError: string | null;
  resourceId: string | null;
  settings: PersonalOpsConnectionSettings;
  createdAt: string;
  updatedAt: string;
  syncJobs: Array<{
    connectionKey: string;
    accountId: string | null;
    accountLabel: string | null;
    sourceKind: string;
    cursor: string | null;
    lastRunAt: string | null;
    nextRunAt: string | null;
    backoffUntil: string | null;
    status: string;
    error: string | null;
  }>;
}

export interface TodaySummary {
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
  headerSummary?: string;
  recommendedNextAction?: string;
  degradedSummary?: string | null;
  statusStrip?: Array<{
    key: string;
    label: string;
    tone: 'accent' | 'muted' | 'warning' | 'danger';
  }>;
  now?: GuidedListItem[];
  next?: GuidedListItem[];
  waiting?: GuidedListItem[];
  awarenessLane?: GuidedListItem[];
  secondary?: {
    meetings: GuidedListItem[];
    approvals: GuidedListItem[];
    workstreams: GuidedListItem[];
    standupPreview: string;
  };
}

export interface GuidedListItem {
  kind: 'source_record' | 'work_item' | 'open_loop' | 'approval_queue' | 'workstream';
  id: string;
  title: string;
  summary: string;
  timestamp: string | null;
  surfacedReasonSummary: string;
  status?: string | null;
  priority?: string | null;
  provider?: string;
  accountLabel?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  sourceRecordKey?: string | null;
  workItemId?: string | null;
  streamKey?: string | null;
  latestEvidence?: string;
  nextExpectedMove?: string;
}

export interface SetupChecklistItem {
  key: string;
  label: string;
  detail: string;
  done: boolean;
  href: string;
}

export interface SetupSummary {
  complete: boolean;
  incompleteCount: number;
  recommendedNextAction: string;
  reviewBurden: number;
  checklist: SetupChecklistItem[];
  questions: AssistantQuestion[];
  recommendedQuestionId?: string | null;
  pendingInlineQuestions?: number;
  queuedQuestions?: number;
  improvementDrafts?: number;
}

export interface InboxLanes {
  needsAction: GuidedListItem[];
  importantAwareness: GuidedListItem[];
  lowSignal: GuidedListItem[];
}

export interface WorkboardSection {
  key: 'needsMyAction' | 'waitingOnOthers' | 'blocked' | 'needsReview';
  title: string;
  items: GuidedListItem[];
}

export interface PersonalOpsWorkstream {
  key: string;
  client: Client | null;
  project: Project | null;
  items: WorkItem[];
  sourceRecords: SourceRecord[];
  recentActivity: Activity[];
  repositories: GitRepository[];
  linkedContacts: Contact[];
  links: PersonalOpsWorkstreamLink[];
  lastUpdatedAt: string | null;
  nextDueAt: string | null;
  blockerCount: number;
  waitingCount: number;
  openLoopCount: number;
  needsReviewCount: number;
  signals: string[];
}

export interface PersonalOpsWorkstreamLink {
  key: string;
  label: string;
  kind: 'jira_issue' | 'email_thread' | 'slack_thread' | 'repository';
  itemCount: number;
  sourceCount: number;
  activityCount: number;
  repositoryCount: number;
  lastUpdatedAt: string | null;
}

export interface WorkboardBucket extends PersonalOpsWorkstream {
  client: Client | null;
  project: Project | null;
  items: WorkItem[];
}

export interface AppBootstrap {
  ok: true;
  assistantName: string;
  timezone: string;
  refreshedAt: string;
  legacyUrl: string;
  capabilities: {
    personalOps: boolean;
    admin: boolean;
    legacyAdmin: boolean;
  };
  primaryCounts: {
    today: number;
    inbox: number;
    work: number;
    review: number;
  };
  setupChecklist: SetupSummary;
  recommendedNextAction: string;
  degradedSummary: string | null;
  pendingInlineQuestions?: number;
  queuedQuestions?: number;
  improvementDrafts?: number;
  navCounts: Record<string, number>;
  status: {
    degradedConnections: number;
    runningSyncJobs: number;
    activeGroups: number;
    idleGroups: number;
  };
  admin: {
    defaultGroupJid: string | null;
    groupCount: number;
    taskCount: number;
  };
  registry: {
    clients: Client[];
    projects: Project[];
    repositories: GitRepository[];
  };
}

export interface GroupView {
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
  session?: {
    previousResponseId?: string;
    conversationId?: string | null;
    compactionCount?: number;
    transcriptPath?: string;
    summaryPath?: string;
  };
  transcriptPath?: string;
}

export interface ConversationItem {
  timestamp: string;
  role: 'user' | 'assistant';
  label: string;
  text: string;
  source: 'messages' | 'local-outbox' | 'transcript';
}

export interface AdminTaskView {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused';
  created_at: string;
  recentRuns: Array<{
    task_id: string;
    run_at: string;
    duration_ms: number | null;
    status: string;
    result: string | null;
    error: string | null;
  }>;
  groupName?: string;
  groupFolder?: string;
  chatJid?: string;
}

export interface AdminGroupDetail {
  group: GroupView;
  conversation: ConversationItem[];
  tasks: AdminTaskView[];
  events: Array<{
    name: string;
    summary: string;
    timestamp: string;
  }>;
  transcriptEventCount: number;
}

declare global {
  interface Window {
    __NANOCLAW_OPERATOR_TOKEN__?: string;
  }
}

function operatorUiHeaders(
  extraHeaders?: HeadersInit,
): Record<string, string> {
  const token = window.__NANOCLAW_OPERATOR_TOKEN__;
  if (!token) {
    throw new Error('Operator UI session token is unavailable. Reload the page.');
  }
  const headers = new Headers(extraHeaders);
  headers.set('x-nanoclaw-operator-token', token);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return Object.fromEntries(headers.entries());
}

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    cache: 'no-store',
    headers: operatorUiHeaders(init?.headers),
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as { error?: string };
      message = payload.error || message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

function post<T>(url: string, body: Record<string, unknown>): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export const api = {
  beginOAuth: (provider: Exclude<PersonalOpsProvider, 'manual'>) =>
    request<{ ok: true; url: string }>(`/api/connections/${provider}/start`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getBootstrap: () => request<AppBootstrap>('/api/app/bootstrap'),
  getSetup: () => request<{ ok: true; setup: SetupSummary }>('/api/setup'),
  getQuestions: (params?: {
    surface?: PersonalOpsQuestionSurface;
    targetType?: PersonalOpsQuestionTargetType;
    targetId?: string;
    urgency?: PersonalOpsQuestionUrgency;
  }) => {
    const url = new URL('/api/questions', window.location.origin);
    if (params?.surface) url.searchParams.set('surface', params.surface);
    if (params?.targetType) url.searchParams.set('targetType', params.targetType);
    if (params?.targetId) url.searchParams.set('targetId', params.targetId);
    if (params?.urgency) url.searchParams.set('urgency', params.urgency);
    return request<{ ok: true; questions: AssistantQuestion[] }>(url);
  },
  answerQuestion: (
    id: string,
    input: { optionId?: string | null; value?: string | null },
  ) => post<{ ok: true; question: AssistantQuestion }>(`/api/questions/${encodeURIComponent(id)}/answer`, input),
  dismissQuestion: (
    id: string,
    input: { reason: 'not_now' | 'resolved' | 'wrong_question' },
  ) =>
    post<{ ok: true; question: AssistantQuestion }>(
      `/api/questions/${encodeURIComponent(id)}/dismiss`,
      input,
    ),
  getToday: () => request<{ ok: true; today: TodaySummary }>('/api/today'),
  getInbox: (params?: { includeNoise?: boolean }) => {
    const url = new URL('/api/inbox', window.location.origin);
    if (params?.includeNoise) url.searchParams.set('includeNoise', 'true');
    return request<{ ok: true; inbox: SourceRecord[]; lanes: InboxLanes }>(url);
  },
  getCalendar: () => request<{ ok: true; calendar: SourceRecord[] }>('/api/calendar'),
  getWorkboard: () =>
    request<{ ok: true; workboard: PersonalOpsWorkstream[]; sections: WorkboardSection[] }>(
      '/api/workboard',
    ),
  getHistory: (params?: { since?: string; until?: string }) => {
    const url = new URL('/api/history', window.location.origin);
    if (params?.since) url.searchParams.set('since', params.since);
    if (params?.until) url.searchParams.set('until', params.until);
    return request<{ ok: true; history: Activity[]; workstreams: PersonalOpsWorkstream[] }>(url);
  },
  getCorrections: () =>
    request<{
      ok: true;
      corrections: Correction[];
      clients: Client[];
      projects: Project[];
      repositories: GitRepository[];
    }>('/api/corrections'),
  getContacts: () =>
    request<{
      ok: true;
      contacts: Contact[];
      identities: ContactIdentity[];
      suggestions: ContactMappingSuggestion[];
      accountHints: AccountScopedContactHint[];
      operatorProfile: OperatorProfile;
    }>('/api/contacts'),
  linkContact: (
    contactId: string,
    input: {
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
    },
  ) =>
    post<{ ok: true; contact: Contact }>(
      `/api/contacts/${encodeURIComponent(contactId)}/link`,
      input,
    ),
  getOpenLoops: () =>
    request<{ ok: true; openLoops: OpenLoop[] }>('/api/open-loops'),
  getQueue: () =>
    request<{ ok: true; queue: ApprovalQueueItem[] }>('/api/queue'),
  approveQueueItem: (id: string) =>
    post<{ ok: true; item: ApprovalQueueItem }>(
      `/api/queue/${encodeURIComponent(id)}/approve`,
      {},
    ),
  rejectQueueItem: (id: string) =>
    post<{ ok: true; item: ApprovalQueueItem }>(
      `/api/queue/${encodeURIComponent(id)}/reject`,
      {},
    ),
  editQueueItem: (
    id: string,
    input: Partial<Pick<ApprovalQueueItem, 'title' | 'summary' | 'body' | 'reason'>>,
  ) =>
    post<{ ok: true; item: ApprovalQueueItem }>(
      `/api/queue/${encodeURIComponent(id)}/edit`,
      input as Record<string, unknown>,
    ),
  getMemory: () =>
    request<{ ok: true; memory: MemoryFact[] }>('/api/memory'),
  acceptMemoryFact: (id: string) =>
    post<{ ok: true }>(`/api/memory/${encodeURIComponent(id)}/accept`, {}),
  rejectMemoryFact: (id: string) =>
    post<{ ok: true }>(`/api/memory/${encodeURIComponent(id)}/reject`, {}),
  getReview: () =>
    request<{ ok: true; review: ReviewQueueItem[] }>('/api/review'),
  getImprovements: () =>
    request<{ ok: true; improvements: ImprovementTicket[] }>('/api/improvements'),
  approveImprovement: (id: string) =>
    post<{ ok: true; ticket: ImprovementTicket }>(
      `/api/improvements/${encodeURIComponent(id)}/approve`,
      {},
    ),
  rejectImprovement: (id: string) =>
    post<{ ok: true; ticket: ImprovementTicket }>(
      `/api/improvements/${encodeURIComponent(id)}/reject`,
      {},
    ),
  editImprovement: (
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
  ) =>
    post<{ ok: true; ticket: ImprovementTicket }>(
      `/api/improvements/${encodeURIComponent(id)}/edit`,
      input as Record<string, unknown>,
    ),
  acceptReview: (id: string) =>
    post<{ ok: true }>(`/api/review/${encodeURIComponent(id)}/accept`, {}),
  rejectReview: (id: string) =>
    post<{ ok: true }>(`/api/review/${encodeURIComponent(id)}/reject`, {}),
  getOperatorProfile: () =>
    request<{ ok: true; profile: OperatorProfile }>('/api/operator-profile'),
  updateOperatorProfile: (input: Partial<OperatorProfile>) =>
    post<{ ok: true; profile: OperatorProfile }>('/api/operator-profile', input),
  getConnections: () =>
    request<{ ok: true; connections: ConnectionSummary[] }>('/api/connections'),
  getConnectionCatalog: (
    provider: Exclude<PersonalOpsProvider, 'manual'>,
    accountId: string,
  ) =>
    request<{ ok: true; catalog: PersonalOpsConnectionCatalog }>(
      `/api/connections/${provider}/${encodeURIComponent(accountId)}/catalog`,
    ),
  getReport: (type: 'morning' | 'standup' | 'wrap') =>
    request<{ ok: true; report: ReportSnapshot | null }>(`/api/reports/${type}`),
  generateReport: (type: 'morning' | 'standup' | 'wrap') =>
    post<{ ok: true; report: ReportSnapshot }>(`/api/reports/${type}/generate`, {}),
  syncConnection: (
    provider: Exclude<PersonalOpsProvider, 'manual'>,
    accountId: string,
  ) => post<{ ok: true }>(`/api/connections/${provider}/${encodeURIComponent(accountId)}/sync`, {}),
  disconnectConnection: (
    provider: Exclude<PersonalOpsProvider, 'manual'>,
    accountId: string,
  ) =>
    post<{ ok: true }>(
      `/api/connections/${provider}/${encodeURIComponent(accountId)}/disconnect`,
      {},
    ),
  updateConnectionSettings: (
    provider: Exclude<PersonalOpsProvider, 'manual'>,
    accountId: string,
    settings: PersonalOpsConnectionSettings,
  ) =>
    post<{ ok: true; connection: ConnectionSummary }>(
      `/api/connections/${provider}/${encodeURIComponent(accountId)}/settings`,
      { settings },
    ),
  createManualTask: (input: {
    title: string;
    notes?: string;
    clientId?: string | null;
    projectId?: string | null;
    dueDate?: string | null;
    priority?: PersonalOpsPriority;
  }) => post<{ ok: true; item: WorkItem }>('/api/manual/task', input),
  createManualNote: (input: {
    title: string;
    body?: string;
    clientId?: string | null;
    projectId?: string | null;
  }) => post<{ ok: true; note: SourceRecord }>('/api/manual/note', input),
  createCorrection: (input: {
    targetType: Correction['targetType'];
    targetId: string;
    field: string;
    value: string;
  }) => post<{ ok: true; correction: Correction }>('/api/corrections', input),
  createClient: (input: {
    id?: string;
    name: string;
    parentClientId?: string | null;
    roles?: string[];
    status?: Client['status'];
    notes?: string;
    communicationPreferences?: string;
  }) => post<{ ok: true; client: Client }>('/api/clients', input),
  createProject: (input: {
    id?: string;
    name: string;
    clientId?: string | null;
    notes?: string;
    deadline?: string | null;
    tags?: string;
  }) => post<{ ok: true; project: Project }>('/api/projects', input),
  createRepository: (input: {
    id?: string;
    name?: string;
    localPath: string;
    clientId?: string | null;
    projectId?: string | null;
    notes?: string;
  }) => post<{ ok: true; repository: GitRepository }>('/api/repositories', input),
  discoverRepositories: (input?: {
    rootPath?: string;
    maxDepth?: number;
  }) =>
    post<{ ok: true; repositories: GitRepository[]; count: number }>(
      '/api/repositories/discover',
      input || {},
    ),
  getAdminGroups: () =>
    request<{ ok: true; defaultGroupJid: string | null; groups: GroupView[] }>(
      '/api/admin/groups',
    ),
  getAdminGroupDetail: (chatJid: string) =>
    request<{ ok: true; detail: AdminGroupDetail }>(
      `/api/admin/groups/${encodeURIComponent(chatJid)}`,
    ),
  getAdminTasks: () =>
    request<{ ok: true; tasks: AdminTaskView[] }>('/api/admin/tasks'),
  sendAdminMessage: (input: {
    chatJid: string;
    text: string;
    sender?: string;
    senderName?: string;
  }) => post<{ ok: true; messageId: string }>('/api/admin/messages', input),
  sendAdminInput: (input: { chatJid: string; text: string }) =>
    post<{ ok: true }>('/api/admin/input', input),
  sendAdminOutbound: (input: { chatJid: string; text: string }) =>
    post<{ ok: true }>('/api/admin/outbound', input),
  createTask: (input: {
    chatJid: string;
    groupFolder: string;
    prompt: string;
    scheduleType: 'cron' | 'interval' | 'once';
    scheduleValue: string;
    contextMode: 'group' | 'isolated';
  }) => post<{ ok: true; taskId: string }>('/api/tasks', input),
  updateTask: (taskId: string, input: {
    chatJid: string;
    groupFolder: string;
    prompt: string;
    scheduleType: 'cron' | 'interval' | 'once';
    scheduleValue: string;
    contextMode: 'group' | 'isolated';
  }) =>
    post<{ ok: true }>(`/api/tasks/${encodeURIComponent(taskId)}/update`, input),
  pauseTask: (taskId: string) =>
    post<{ ok: true }>(`/api/tasks/${encodeURIComponent(taskId)}/pause`, {}),
  resumeTask: (taskId: string) =>
    post<{ ok: true }>(`/api/tasks/${encodeURIComponent(taskId)}/resume`, {}),
  cancelTask: (taskId: string) =>
    post<{ ok: true }>(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {}),
};

export function sourceRecordKey(source: SourceRecord): string {
  if (source.provider === 'manual') {
    return `manual:${source.kind}:${source.externalId}`;
  }
  return `${source.provider}:${source.accountId || 'default'}:${source.kind}:${source.externalId}`;
}

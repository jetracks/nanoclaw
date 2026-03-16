export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
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
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export interface OpenAISessionState {
  provider: 'openai';
  previousResponseId?: string;
  conversationId?: string;
  transcriptPath?: string;
  summaryPath?: string;
  compactedAt?: string;
  compactionCount?: number;
  invalidatedLegacySessionId?: string;
}

export type PersonalOpsProvider = 'google' | 'microsoft' | 'jira' | 'slack';
export type PersonalOpsSourceKind =
  | 'email'
  | 'calendar_event'
  | 'git_commit'
  | 'jira_issue'
  | 'slack_message'
  | 'manual_note'
  | 'manual_task'
  | 'report';
export type PersonalOpsActivityProvider =
  | PersonalOpsProvider
  | 'manual'
  | 'git';
export type PersonalOpsReportType =
  | 'morning'
  | 'standup'
  | 'wrap'
  | 'history'
  | 'what_changed';
export type PersonalOpsItemStatus =
  | 'open'
  | 'in_progress'
  | 'blocked'
  | 'waiting'
  | 'done'
  | 'on_hold'
  | 'ignored';
export type PersonalOpsPriority = 'low' | 'medium' | 'high' | 'urgent';
export type PersonalOpsContactImportance =
  | 'low'
  | 'normal'
  | 'high'
  | 'critical';
export type PersonalOpsContactIdentityType =
  | 'email'
  | 'slack'
  | 'jira'
  | 'calendar_attendee'
  | 'git_author'
  | 'name';
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

export interface ConnectedAccount {
  connectionKey: string;
  provider: PersonalOpsProvider;
  status: 'disconnected' | 'connected' | 'degraded';
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
}

export interface SyncJobState {
  connectionKey: string;
  provider: PersonalOpsProvider;
  accountId: string | null;
  accountLabel: string | null;
  sourceKind: PersonalOpsSourceKind;
  cursor: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  backoffUntil: string | null;
  status: 'idle' | 'running' | 'error';
  error: string | null;
  updatedAt: string;
}

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

export interface SourceRecord {
  connectionKey?: string | null;
  provider: PersonalOpsProvider | 'manual';
  accountId?: string | null;
  accountLabel?: string | null;
  kind: PersonalOpsSourceKind;
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

export interface Client {
  id: string;
  name: string;
  parentClientId: string | null;
  roles: string[];
  status: 'active' | 'prospect' | 'on_hold' | 'archived';
  notes: string;
  communicationPreferences: string;
  createdAt: string;
  updatedAt: string;
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
  createdAt: string;
  updatedAt: string;
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
  type: PersonalOpsContactIdentityType;
  provider: PersonalOpsProvider | 'manual' | 'git';
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

export interface WorkItem {
  id: string;
  title: string;
  sourceKind: PersonalOpsSourceKind;
  sourceProvider: PersonalOpsProvider | 'manual';
  sourceRecordKey: string | null;
  clientId: string | null;
  projectId: string | null;
  dueDate: string | null;
  priority: PersonalOpsPriority;
  status: PersonalOpsItemStatus;
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
  sourceKind: PersonalOpsSourceKind;
  sourceRecordKey: string | null;
  relatedClientId: string | null;
  relatedProjectId: string | null;
  summary: string;
  rawReference: string | null;
  metadata?: Record<string, unknown>;
}

export interface ReportSnapshot {
  id: string;
  reportType: PersonalOpsReportType;
  generatedAt: string;
  rangeStart: string;
  rangeEnd: string;
  groupedOutput: string;
  sourceReferences: string[];
  model: string;
}

export interface Correction {
  id: string;
  targetType:
    | 'source_record'
    | 'work_item'
    | 'activity'
    | 'report'
    | 'preference';
  targetId: string;
  field: string;
  value: string;
  createdAt: string;
}

export interface PersonalOpsPreference {
  key: string;
  value: string;
  updatedAt: string;
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

export interface ProposedAction {
  kind: PersonalOpsApprovalActionKind;
  title: string;
  summary: string;
  body: string;
  reason: string;
  confidence: number | null;
  evidence: string[];
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
  reportType: PersonalOpsReportType | null;
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

export interface PersonalOpsTodayView {
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

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;

import { useMemo, useState, useEffect, Fragment, type ReactNode } from 'react';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from 'react-router-dom';

import {
  Activity,
  AssistantQuestion,
  ApprovalQueueItem,
  api,
  AppBootstrap,
  Client,
  ConnectionSummary,
  Contact,
  ContactMappingSuggestion,
  Correction,
  GuidedListItem,
  GitRepository,
  GroupView,
  ImprovementTicket,
  MemoryFact,
  OperatorProfile,
  PersonalOpsAttributionDiagnostic,
  PersonalOpsConnectionCatalogOption,
  PersonalOpsPriority,
  PersonalOpsWorkstream,
  Project,
  ReportSnapshot,
  ReviewQueueItem,
  SourceRecord,
  TodaySummary,
  WorkItem,
  sourceRecordKey,
} from './api';

const OPS_INTERVAL_IDLE = 15_000;
const OPS_INTERVAL_BUSY = 5_000;
const ADMIN_INTERVAL_IDLE = 3_000;
const ADMIN_INTERVAL_ACTIVE = 1_000;
const REPORT_TYPES = ['morning', 'standup', 'wrap'] as const;
type Tone = 'success' | 'danger' | 'warning' | 'muted';

function formatDateTime(value?: string | null): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatShortDate(value?: string | null): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'unordered-list'; items: string[] }
  | { type: 'ordered-list'; items: string[] }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'code'; language: string | null; code: string }
  | { type: 'rule' };

function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  const isSpecialLine = (line: string): boolean =>
    /^#{1,6}\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*```/.test(line) ||
    /^\s*(?:---|\*\*\*|___)\s*$/.test(line);

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    const fenceMatch = line.match(/^\s*```([\w-]+)?\s*$/);
    if (fenceMatch) {
      const language = fenceMatch[1] || null;
      const buffer: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        buffer.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        type: 'code',
        language,
        code: buffer.join('\n'),
      });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, '').trimEnd());
        index += 1;
      }
      blocks.push({ type: 'blockquote', lines: quoteLines });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, '').trim());
        index += 1;
      }
      blocks.push({ type: 'unordered-list', items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, '').trim());
        index += 1;
      }
      blocks.push({ type: 'ordered-list', items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (!current.trim()) break;
      if (paragraphLines.length > 0 && isSpecialLine(current)) break;
      paragraphLines.push(current.trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraphLines.join(' ') });
  }

  return blocks;
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const pattern =
    /(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;
  let nodeIndex = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const key = `${keyPrefix}-${nodeIndex}`;
    if (match[2] && match[3]) {
      nodes.push(
        <a key={key} href={match[3]} target="_blank" rel="noreferrer">
          {match[2]}
        </a>,
      );
    } else if (match[4]) {
      nodes.push(<code key={key}>{match[4]}</code>);
    } else if (match[5] || match[6]) {
      nodes.push(<strong key={key}>{match[5] || match[6]}</strong>);
    } else if (match[7] || match[8]) {
      nodes.push(<em key={key}>{match[7] || match[8]}</em>);
    }

    lastIndex = pattern.lastIndex;
    nodeIndex += 1;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function MarkdownContent(props: { content?: string | null; className?: string }) {
  if (!props.content?.trim()) {
    return null;
  }

  const blocks = parseMarkdownBlocks(props.content);
  return (
    <div className={['markdown-body', props.className].filter(Boolean).join(' ')}>
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        if (block.type === 'heading') {
          if (block.level === 1) return <h1 key={key}>{renderInlineMarkdown(block.text, key)}</h1>;
          if (block.level === 2) return <h2 key={key}>{renderInlineMarkdown(block.text, key)}</h2>;
          if (block.level === 3) return <h3 key={key}>{renderInlineMarkdown(block.text, key)}</h3>;
          if (block.level === 4) return <h4 key={key}>{renderInlineMarkdown(block.text, key)}</h4>;
          if (block.level === 5) return <h5 key={key}>{renderInlineMarkdown(block.text, key)}</h5>;
          return <h6 key={key}>{renderInlineMarkdown(block.text, key)}</h6>;
        }
        if (block.type === 'unordered-list') {
          return (
            <ul key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-item-${itemIndex}`}>{renderInlineMarkdown(item, `${key}-${itemIndex}`)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === 'ordered-list') {
          return (
            <ol key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-item-${itemIndex}`}>{renderInlineMarkdown(item, `${key}-${itemIndex}`)}</li>
              ))}
            </ol>
          );
        }
        if (block.type === 'blockquote') {
          return (
            <blockquote key={key}>
              {block.lines.map((line, lineIndex) => (
                <p key={`${key}-line-${lineIndex}`}>{renderInlineMarkdown(line, `${key}-${lineIndex}`)}</p>
              ))}
            </blockquote>
          );
        }
        if (block.type === 'code') {
          return (
            <pre key={key} className="markdown-code-block">
              <code data-language={block.language || undefined}>{block.code}</code>
            </pre>
          );
        }
        if (block.type === 'rule') {
          return <hr key={key} className="markdown-rule" />;
        }
        return <p key={key}>{renderInlineMarkdown(block.text, key)}</p>;
      })}
    </div>
  );
}

function dayKey(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function providerLabel(provider: string): string {
  if (provider === 'google') return 'Google';
  if (provider === 'microsoft') return 'Microsoft';
  if (provider === 'jira') return 'Jira';
  if (provider === 'slack') return 'Slack';
  if (provider === 'git') return 'Git';
  return 'Manual';
}

function formatScopeSummary(connection: ConnectionSummary): string[] {
  const settings = connection.settings || {};
  const summary: string[] = [];
  if (settings.defaultClientId) {
    summary.push('Default client set');
  }
  if (settings.defaultProjectId) {
    summary.push('Default project set');
  }
  if (settings.preferClientOnlyMapping) {
    summary.push('Client-only default');
  }
  if (settings.triageGuidance) {
    summary.push('Triage guidance set');
  }
  if (connection.provider === 'google') {
    if (settings.googleMailQuery) {
      summary.push(`Mail query: ${settings.googleMailQuery}`);
    }
    if (settings.googleCalendarIds?.length) {
      summary.push(`${settings.googleCalendarIds.length} calendar scope${settings.googleCalendarIds.length === 1 ? '' : 's'}`);
    }
  } else if (connection.provider === 'microsoft') {
    if (settings.microsoftMailFolderIds?.length) {
      summary.push(`${settings.microsoftMailFolderIds.length} mail folder${settings.microsoftMailFolderIds.length === 1 ? '' : 's'}`);
    }
    if (settings.microsoftCalendarIds?.length) {
      summary.push(`${settings.microsoftCalendarIds.length} calendar scope${settings.microsoftCalendarIds.length === 1 ? '' : 's'}`);
    }
  } else if (connection.provider === 'jira') {
    if (settings.jiraProjectKeys?.length) {
      summary.push(`Projects: ${settings.jiraProjectKeys.join(', ')}`);
    }
    if (settings.jiraJql) {
      summary.push('Custom JQL filter');
    }
  } else if (connection.provider === 'slack') {
    if (settings.slackIncludedChannelIds?.length) {
      summary.push(`${settings.slackIncludedChannelIds.length} included channel${settings.slackIncludedChannelIds.length === 1 ? '' : 's'}`);
    }
    if (settings.slackExcludedChannelIds?.length) {
      summary.push(`${settings.slackExcludedChannelIds.length} excluded channel${settings.slackExcludedChannelIds.length === 1 ? '' : 's'}`);
    }
  }
  return summary.length ? summary : ['Using default scope'];
}

function toggleSelection(current: string[], value: string): string[] {
  return current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
}

function sourceAccountLabel(source: SourceRecord): string | null {
  if (source.provider === 'manual') return null;
  return source.accountLabel || source.accountId || null;
}

function sourceMailboxLine(source: SourceRecord): string | null {
  if (source.kind !== 'email') return null;
  const account = sourceAccountLabel(source);
  if (!account) return null;
  return `${providerLabel(source.provider)} account: ${account}`;
}

function sourceCalendarLine(source: SourceRecord): string | null {
  if (source.kind !== 'calendar_event') return null;
  const account = sourceAccountLabel(source);
  if (!account) return null;
  return `${providerLabel(source.provider)} calendar: ${account}`;
}

function sourceWorkspaceLine(source: SourceRecord): string | null {
  if (source.kind !== 'slack_message') return null;
  const account = sourceAccountLabel(source);
  if (!account) return null;
  const channelLabel =
    typeof source.metadata?.channelLabel === 'string'
      ? source.metadata.channelLabel
      : null;
  return channelLabel
    ? `${providerLabel(source.provider)} workspace: ${account} • ${channelLabel}`
    : `${providerLabel(source.provider)} workspace: ${account}`;
}

function sourceLooksNoisy(source: SourceRecord): boolean {
  return (
    source.status === 'filtered' ||
    source.metadata?.likelyNoise === true
  );
}

function sourceAttentionState(source: SourceRecord) {
  return source.attention || {
    awarenessOnly: false,
    actionRequired: false,
    operationalRisk: false,
    reportWorthy: false,
    directness: 'ambient' as const,
    importanceReason: '',
    actionConfidence: source.attributionConfidence ?? null,
    mappingConfidence: source.attributionConfidence ?? null,
  };
}

function sourceNeedsAction(source: SourceRecord): boolean {
  const attention = sourceAttentionState(source);
  return attention.actionRequired || attention.operationalRisk;
}

function sourceIsImportantAwareness(source: SourceRecord): boolean {
  const attention = sourceAttentionState(source);
  return attention.awarenessOnly && (attention.reportWorthy || attention.operationalRisk);
}

function sourceNeedsReview(source: SourceRecord): boolean {
  const attention = sourceAttentionState(source);
  return (
    source.reviewState === 'suggested' ||
    (attention.actionConfidence !== null && attention.actionConfidence < 0.7) ||
    (attention.mappingConfidence !== null && attention.mappingConfidence < 0.7)
  );
}

function sourceThreadLine(source: SourceRecord): string | null {
  if (!source.threadState) return null;
  return `Thread state: ${source.threadState.summary}`;
}

function isAttributionDiagnostic(
  value: unknown,
): value is PersonalOpsAttributionDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.kind === 'string' && typeof candidate.label === 'string';
}

function extractQuotedDetail(rule: string): string | null {
  const match = rule.match(/"([^"]+)"/);
  return match?.[1] || null;
}

function inferAttributionDiagnosticFromRule(
  rule: string,
): PersonalOpsAttributionDiagnostic | null {
  const normalized = rule.trim().toLowerCase();
  const detail = extractQuotedDetail(rule);
  if (!normalized) return null;
  if (normalized.startsWith('connection default')) {
    return {
      kind: 'connection_default',
      label: 'Connection default',
      detail:
        normalized.includes('project') ? 'project default' : normalized.includes('client') ? 'client default' : detail,
    };
  }
  if (normalized.includes('jira project key')) {
    return { kind: 'jira_key', label: 'Jira key', detail };
  }
  if (normalized.includes('domain')) {
    return { kind: 'domain_match', label: 'Domain match', detail };
  }
  if (normalized.includes('account label')) {
    return { kind: 'workspace_match', label: 'Workspace/account match', detail };
  }
  if (normalized.startsWith('repository ')) {
    return { kind: 'repo_alias', label: 'Repo alias', detail };
  }
  if (normalized.startsWith('single active project')) {
    return { kind: 'single_project_fallback', label: 'Single active project', detail };
  }
  if (normalized.startsWith('client name')) {
    return { kind: 'client_match', label: 'Client match', detail };
  }
  if (
    normalized.startsWith('project name') ||
    normalized.startsWith('project tag') ||
    normalized.startsWith('source project name')
  ) {
    return { kind: 'project_match', label: 'Project match', detail };
  }
  return null;
}

function sourceAttributionDiagnostics(
  source: SourceRecord,
): PersonalOpsAttributionDiagnostic[] {
  const rawDiagnostics = source.metadata?.attributionDiagnostics;
  const typedDiagnostics = Array.isArray(rawDiagnostics)
    ? rawDiagnostics.filter(isAttributionDiagnostic)
    : [];
  if (typedDiagnostics.length) {
    return typedDiagnostics;
  }
  const rawRule =
    typeof source.metadata?.attributionRule === 'string'
      ? source.metadata.attributionRule
      : '';
  if (!rawRule) return [];
  const inferred = rawRule
    .split(/\s*,\s*/)
    .map((entry) => inferAttributionDiagnosticFromRule(entry))
    .filter((entry): entry is PersonalOpsAttributionDiagnostic => Boolean(entry));
  return inferred.filter(
    (diagnostic, index) =>
      inferred.findIndex(
        (entry) =>
          entry.kind === diagnostic.kind &&
          (entry.detail || '') === (diagnostic.detail || ''),
      ) === index,
  );
}

function formatAttributionDiagnostic(
  diagnostic: PersonalOpsAttributionDiagnostic,
  includeDetail = false,
): string {
  if (!includeDetail || !diagnostic.detail) {
    return diagnostic.label;
  }
  return `${diagnostic.label}: ${diagnostic.detail}`;
}

function attributionDiagnosticTone(
  diagnostic: PersonalOpsAttributionDiagnostic,
): Tone {
  if (diagnostic.kind === 'connection_default') return 'success';
  if (diagnostic.kind === 'single_project_fallback') return 'warning';
  return 'muted';
}

function sourceWhySurfaced(source: SourceRecord): string[] {
  const reasons: string[] = [];
  const attention = sourceAttentionState(source);
  const diagnostics = sourceAttributionDiagnostics(source);
  if (diagnostics.length) {
    reasons.push(
      `Mapped by ${diagnostics
        .map((diagnostic) => diagnostic.label.toLowerCase())
        .join(' + ')}`,
    );
  } else if (typeof source.metadata?.attributionRule === 'string') {
    reasons.push(`Mapped by ${source.metadata.attributionRule}`);
  }
  if (source.metadata?.isImportant === true) reasons.push('Marked important by Gmail');
  if (source.metadata?.isUnread === true) reasons.push('Unread');
  if (source.metadata?.mentionsSelf === true) reasons.push('Mentions you directly');
  if (source.metadata?.isDirectMessage === true) reasons.push('Direct message');
  if (attention.importanceReason) reasons.push(attention.importanceReason);
  if (attention.directness !== 'ambient') reasons.push(`Directness: ${attention.directness}`);
  if (sourceNeedsReview(source)) reasons.push('Needs review');
  if (source.priority === 'urgent') reasons.push('Urgent wording detected');
  if (source.priority === 'high') reasons.push('High-priority wording or labels');
  if (source.clientId || source.projectId) reasons.push('Linked to active work');
  if (sourceLooksNoisy(source)) reasons.push('Likely low-signal or noisy');
  if (reasons.length === 0) reasons.push('Recently synced into personal ops');
  return reasons;
}

function sourceSurfacedReasonSummary(source: SourceRecord): string {
  return sourceWhySurfaced(source)[0] || 'Recently synced';
}

function sourceRecommendedAction(source: SourceRecord): string {
  const attention = sourceAttentionState(source);
  if (attention.operationalRisk) {
    return 'Treat this as an operational risk and confirm the next response or escalation.';
  }
  if (attention.actionRequired) {
    return 'Confirm the assignment, then create or update the follow-up you need to move it forward.';
  }
  if (attention.awarenessOnly) {
    return 'Keep this visible for awareness unless it becomes action-bearing.';
  }
  if (sourceNeedsReview(source)) {
    return 'Review the suggested mapping or priority before this becomes durable memory.';
  }
  return 'Check whether this belongs in action, awareness, or suppression.';
}

function workstreamLabel(stream: PersonalOpsWorkstream): string {
  return [stream.client?.name || 'Unassigned client', stream.project?.name || 'General work'].join(' / ');
}

function workstreamTone(stream: PersonalOpsWorkstream): Tone {
  if (stream.blockerCount > 0) return 'danger';
  if (stream.needsReviewCount > 0) return 'warning';
  if (stream.items.some((item) => item.priority === 'urgent')) return 'warning';
  return 'muted';
}

function statusTone(status: string): Tone {
  if (status === 'active' || status === 'connected' || status === 'success') return 'success';
  if (status === 'degraded' || status === 'blocked' || status === 'urgent') return 'danger';
  if (status === 'paused' || status === 'waiting' || status === 'error') return 'warning';
  return 'muted';
}

function useOpsInterval(bootstrap?: AppBootstrap): number {
  return bootstrap?.status.runningSyncJobs ? OPS_INTERVAL_BUSY : OPS_INTERVAL_IDLE;
}

function useStableSelectedId<T>(
  items: T[],
  getId: (item: T) => string,
): [string | null, (id: string | null) => void] {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (items.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !items.some((item) => getId(item) === selectedId)) {
      setSelectedId(getId(items[0]));
    }
  }, [items, getId, selectedId]);

  return [selectedId, setSelectedId];
}

function findClient(clients: Client[], clientId?: string | null): Client | null {
  return clients.find((client) => client.id === clientId) || null;
}

function findProject(projects: Project[], projectId?: string | null): Project | null {
  return projects.find((project) => project.id === projectId) || null;
}

function splitDelimitedValues(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function repositoryProjectOptions(
  projects: Project[],
  clientId?: string | null,
): Project[] {
  return projects
    .filter((project) => !clientId || project.clientId === clientId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function invalidateOps(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['bootstrap'] }),
    queryClient.invalidateQueries({ queryKey: ['today'] }),
    queryClient.invalidateQueries({ queryKey: ['inbox'] }),
    queryClient.invalidateQueries({ queryKey: ['calendar'] }),
    queryClient.invalidateQueries({ queryKey: ['workboard'] }),
    queryClient.invalidateQueries({ queryKey: ['history'] }),
    queryClient.invalidateQueries({ queryKey: ['connections'] }),
    queryClient.invalidateQueries({ queryKey: ['setup'] }),
    queryClient.invalidateQueries({ queryKey: ['reports'] }),
    queryClient.invalidateQueries({ queryKey: ['corrections'] }),
    queryClient.invalidateQueries({ queryKey: ['contacts'] }),
    queryClient.invalidateQueries({ queryKey: ['memory'] }),
    queryClient.invalidateQueries({ queryKey: ['questions'] }),
    queryClient.invalidateQueries({ queryKey: ['improvements'] }),
    queryClient.invalidateQueries({ queryKey: ['open-loops'] }),
    queryClient.invalidateQueries({ queryKey: ['queue'] }),
    queryClient.invalidateQueries({ queryKey: ['review'] }),
    queryClient.invalidateQueries({ queryKey: ['admin-groups'] }),
    queryClient.invalidateQueries({ queryKey: ['admin-group-detail'] }),
    queryClient.invalidateQueries({ queryKey: ['admin-tasks'] }),
  ]);
}

function AppShell(props: {
  bootstrap?: AppBootstrap;
  children: React.ReactNode;
}) {
  const location = useLocation();
  const [moreExpanded, setMoreExpanded] = usePersistentBoolean('nav-more-expanded', false);
  const [dismissedOnboarding, setDismissedOnboarding] = usePersistentBoolean(
    'setup-onboarding-dismissed',
    false,
  );
  const primaryNav = [
    { to: '/today', label: 'Today', count: props.bootstrap?.primaryCounts.today },
    { to: '/inbox', label: 'Inbox', count: props.bootstrap?.primaryCounts.inbox },
    { to: '/work', label: 'Work', count: props.bootstrap?.primaryCounts.work },
    { to: '/review', label: 'Review', count: props.bootstrap?.primaryCounts.review },
  ];
  const moreNav = [
    { to: '/calendar', label: 'Calendar', count: props.bootstrap?.navCounts.meetings },
    { to: '/reports', label: 'Reports', count: props.bootstrap?.navCounts.reports },
    { to: '/history', label: 'History', count: props.bootstrap?.navCounts.groups },
    { to: '/connections', label: 'Connections', count: props.bootstrap?.navCounts.degradedConnections },
    { to: '/admin', label: 'Admin', count: props.bootstrap?.navCounts.activeGroups },
  ];
  const pathTitleMap: Record<string, string> = {
    '/today': 'Today',
    '/inbox': 'Inbox',
    '/work': 'Work',
    '/workboard': 'Work',
    '/review': 'Review',
    '/queue': 'Review',
    '/calendar': 'Calendar',
    '/reports': 'Reports',
    '/history': 'History',
    '/connections': 'Connections',
    '/admin': 'Admin',
  };
  const currentTitle = pathTitleMap[location.pathname] || 'Today';
  const showSetupBanner =
    Boolean(props.bootstrap?.setupChecklist.incompleteCount) && !dismissedOnboarding;

  return (
    <div className="app-shell">
      <aside className="side-nav">
        <div className="brand-block">
          <div className="eyebrow">NanoClaw Personal Ops</div>
          <h1>Operational clarity without the console noise.</h1>
          <p>
            Daily execution first. Runtime controls stay available when you need them.
          </p>
        </div>
        <nav className="nav-stack">
          {primaryNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `nav-link${isActive ? ' active' : ''}`
              }
            >
              <span>{item.label}</span>
              <span className="nav-count">{item.count ?? 0}</span>
            </NavLink>
          ))}
        </nav>
        <div className="more-nav">
          <button
            className={`nav-link nav-toggle${moreExpanded ? ' active' : ''}`}
            onClick={() => setMoreExpanded((current) => !current)}
          >
            <span>More</span>
            <span className="nav-count">{moreNav.reduce((count, item) => count + (item.count || 0), 0)}</span>
          </button>
          {moreExpanded ? (
            <nav className="nav-stack secondary">
              {moreNav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `nav-link secondary${isActive ? ' active' : ''}`
                  }
                >
                  <span>{item.label}</span>
                  <span className="nav-count">{item.count ?? 0}</span>
                </NavLink>
              ))}
            </nav>
          ) : null}
        </div>
        <div className="side-footer">
          <a href={props.bootstrap?.legacyUrl || '/admin/legacy'} className="legacy-link">
            Open legacy admin
          </a>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div>
            <div className="eyebrow">Current view</div>
            <h2>{currentTitle}</h2>
          </div>
          <div className="status-strip">
            <StatusPill tone="muted" label={props.bootstrap?.timezone || 'local'} />
            <StatusPill
              tone={props.bootstrap?.status.runningSyncJobs ? 'warning' : 'muted'}
              label={
                props.bootstrap?.status.runningSyncJobs
                  ? `${props.bootstrap.status.runningSyncJobs} sync job${props.bootstrap.status.runningSyncJobs === 1 ? '' : 's'} running`
                  : 'No sync in progress'
              }
            />
            <StatusPill
              tone={props.bootstrap?.degradedSummary ? 'warning' : 'success'}
              label={props.bootstrap?.degradedSummary || 'Setup and connections look healthy'}
            />
          </div>
        </header>
        {showSetupBanner ? (
          <div className="setup-banner">
            <div>
              <div className="eyebrow">Setup guidance</div>
              <strong>{props.bootstrap?.recommendedNextAction}</strong>
              <p className="detail-copy">
                The assistant is more useful once accounts, defaults, and review items are in a good state.
              </p>
              <SetupQuestionCards
                questions={props.bootstrap?.setupChecklist.questions.slice(0, 2) || []}
                compact
              />
              <div className="reason-list">
                {props.bootstrap?.setupChecklist.checklist.map((item) => (
                  <a
                    key={item.key}
                    href={item.href}
                    className={`reason-chip setup-chip${item.done ? ' done' : ''}`}
                  >
                    {item.done ? 'Done' : 'Next'}: {item.label}
                  </a>
                ))}
              </div>
            </div>
            <div className="button-row">
              <a href="/connections" className="secondary-button link-button">
                Open setup
              </a>
              <button
                className="chip-button"
                onClick={() => setDismissedOnboarding(true)}
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
        <main className="route-shell">{props.children}</main>
      </div>
    </div>
  );
}

function StatusPill(props: { tone: 'muted' | 'success' | 'warning' | 'danger'; label: string }) {
  return <span className={`status-pill ${props.tone}`}>{props.label}</span>;
}

function ScreenFrame(props: {
  title: string;
  subtitle: string;
  guide?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="screen-frame">
      <div className="screen-header">
        <div>
          <div className="eyebrow">{props.title}</div>
          <h3>{props.subtitle}</h3>
          {props.guide ? <p className="screen-guide">{props.guide}</p> : null}
        </div>
        {props.actions ? <div className="button-row">{props.actions}</div> : null}
      </div>
      {props.children}
    </section>
  );
}

function EmptyState(props: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <strong>{props.title}</strong>
      <p>{props.body}</p>
    </div>
  );
}

function questionSurfaceLabel(surface: AssistantQuestion['surface']): string {
  if (surface === 'today') return 'Today coach';
  if (surface === 'inbox') return 'Inbox coach';
  if (surface === 'work') return 'Work coach';
  if (surface === 'review') return 'Review coach';
  if (surface === 'connections') return 'Setup coach';
  return 'Calendar coach';
}

function questionDestination(question: AssistantQuestion): string {
  if (question.surface === 'review') return '/review?tab=questions';
  if (question.surface === 'work') return '/work';
  return `/${question.surface}`;
}

function questionTargetForSource(source: SourceRecord): {
  targetType: Exclude<AssistantQuestion['targetType'], null>;
  targetId: string;
} {
  return {
    targetType: source.kind === 'calendar_event' ? 'calendar_event' : 'source_record',
    targetId: sourceRecordKey(source),
  };
}

function AssistantQuestionCard(props: {
  question: AssistantQuestion;
  compact?: boolean;
  inline?: boolean;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(props.question.answerValue || '');
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    setValue(props.question.answerValue || '');
    setFeedback('');
  }, [props.question]);

  const answerMutation = useMutation({
    mutationFn: (input: { optionId?: string | null; value?: string | null }) =>
      api.answerQuestion(props.question.id, input),
    onSuccess: async () => {
      setFeedback('Saved.');
      await invalidateOps(queryClient);
    },
    onError: (error) =>
      setFeedback(error instanceof Error ? error.message : String(error)),
  });
  const dismissMutation = useMutation({
    mutationFn: (reason: 'not_now' | 'resolved' | 'wrong_question') =>
      api.dismissQuestion(props.question.id, { reason }),
    onSuccess: async () => {
      setFeedback('Question updated.');
      await invalidateOps(queryClient);
    },
    onError: (error) =>
      setFeedback(error instanceof Error ? error.message : String(error)),
  });

  const recommendedOption =
    props.question.options.find((option) => option.id === props.question.recommendedOptionId) ||
    props.question.options[0] ||
    null;
  const secondaryOptions = props.question.options.filter(
    (option) => option.id !== recommendedOption?.id,
  );

  return (
    <div className={`setup-question-card${props.inline ? ' coach-inline' : ''}${props.compact ? ' compact' : ''}`}>
      <div className="setup-question-copy">
        <div className="eyebrow">{questionSurfaceLabel(props.question.surface)}</div>
        <strong>{props.question.prompt}</strong>
        <p className="detail-copy">{props.question.rationale}</p>
        <p className="record-why">Effect: {props.question.effectPreview}</p>
      </div>
      {props.question.freeformAllowed ? (
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Add your answer or refine the recommendation"
        />
      ) : null}
      <div className="button-row wrap">
        {recommendedOption ? (
          <button
            className="primary-button"
            onClick={() =>
              answerMutation.mutate({
                optionId: recommendedOption.id,
                value: props.question.freeformAllowed ? value : null,
              })
            }
            disabled={answerMutation.isPending || dismissMutation.isPending}
          >
            {answerMutation.isPending ? 'Saving…' : recommendedOption.label}
          </button>
        ) : null}
        {secondaryOptions.map((option) => (
          <button
            key={option.id}
            className="secondary-button"
            onClick={() =>
              answerMutation.mutate({
                optionId: option.id,
                value: props.question.freeformAllowed ? value : null,
              })
            }
            disabled={answerMutation.isPending || dismissMutation.isPending}
          >
            {option.label}
          </button>
        ))}
        <button
          className="chip-button"
          onClick={() => dismissMutation.mutate('not_now')}
          disabled={answerMutation.isPending || dismissMutation.isPending}
        >
          Not now
        </button>
        <a href={questionDestination(props.question)} className="chip-button link-button">
          Open page
        </a>
      </div>
      {feedback ? <p className="feedback">{feedback}</p> : null}
    </div>
  );
}

function SetupQuestionCards(props: {
  questions: AssistantQuestion[];
  compact?: boolean;
  inline?: boolean;
}) {
  if (!props.questions.length) return null;
  return (
    <div className={`setup-questions${props.compact ? ' compact' : ''}`}>
      {props.questions.map((question) => (
        <AssistantQuestionCard
          key={question.id}
          question={question}
          compact={props.compact}
          inline={props.inline}
        />
      ))}
    </div>
  );
}

function usePersistentBoolean(key: string, defaultValue: boolean): [boolean, (value: boolean | ((current: boolean) => boolean)) => void] {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === 'undefined') return defaultValue;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === 'true') return true;
      if (stored === 'false') return false;
    } catch {
      // ignore storage failures
    }
    return defaultValue;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      // ignore storage failures
    }
  }, [key, value]);

  return [value, setValue];
}

function usePersistentString(
  key: string,
  defaultValue: string,
): [string, (value: string | ((current: string) => string)) => void] {
  const [value, setValue] = useState<string>(() => {
    if (typeof window === 'undefined') return defaultValue;
    try {
      return window.localStorage.getItem(key) || defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // ignore storage failures
    }
  }, [key, value]);

  return [value, setValue];
}

function DetailScaffold(props: {
  list: React.ReactNode;
  detail: React.ReactNode;
}) {
  return (
    <div className="detail-scaffold">
      <div className="detail-list">{props.list}</div>
      <aside className="detail-panel">{props.detail}</aside>
    </div>
  );
}

function CollapsiblePanel(props: {
  storageKey: string;
  title: string;
  eyebrow?: string;
  subtitle?: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = usePersistentBoolean(
    props.storageKey,
    props.defaultExpanded ?? true,
  );

  return (
    <div className={`panel-card ${props.className || ''}`}>
      <div className="panel-topline collapsible-header">
        <div>
          {props.eyebrow ? <div className="eyebrow">{props.eyebrow}</div> : null}
          <h4>{props.title}</h4>
          {props.subtitle ? <p className="detail-copy">{props.subtitle}</p> : null}
        </div>
        <div className="button-row no-margin">
          {props.actions}
          <button
            className="chip-button"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </div>
      </div>
      {expanded ? props.children : null}
    </div>
  );
}

function ScopeOptionChecklist(props: {
  title: string;
  options: PersonalOpsConnectionCatalogOption[];
  selected: string[];
  onToggle: (id: string) => void;
  emptyLabel: string;
}) {
  return (
    <div className="scope-settings-box">
      <div className="field-label">{props.title}</div>
      {props.options.length ? (
        <div className="scope-option-grid">
          {props.options.map((option) => (
            <label key={option.id} className="scope-option">
              <input
                type="checkbox"
                checked={props.selected.includes(option.id)}
                onChange={() => props.onToggle(option.id)}
              />
              <span>
                <strong>{option.label}</strong>
                {option.secondaryLabel ? ` • ${option.secondaryLabel}` : ''}
                {option.kind ? ` • ${option.kind}` : ''}
                {option.isDefault ? ' • default' : ''}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="detail-copy">{props.emptyLabel}</p>
      )}
    </div>
  );
}

function ConnectionScopeEditor(props: {
  connection: ConnectionSummary;
  clients: Client[];
  projects: Project[];
  onFeedback: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = usePersistentBoolean(
    `connection-scope-${props.connection.connectionKey}`,
    false,
  );
  const catalogQuery = useQuery({
    queryKey: ['connection-catalog', props.connection.connectionKey],
    queryFn: async () =>
      (
        await api.getConnectionCatalog(
          props.connection.provider as 'google' | 'microsoft' | 'jira' | 'slack',
          props.connection.accountId as string,
        )
      ).catalog,
    enabled: expanded && Boolean(props.connection.accountId),
    staleTime: 5 * 60_000,
  });
  const [googleMailQuery, setGoogleMailQuery] = useState(
    props.connection.settings.googleMailQuery || '',
  );
  const [defaultClientId, setDefaultClientId] = useState(
    props.connection.settings.defaultClientId || '',
  );
  const [defaultProjectId, setDefaultProjectId] = useState(
    props.connection.settings.defaultProjectId || '',
  );
  const [preferClientOnlyMapping, setPreferClientOnlyMapping] = useState(
    props.connection.settings.preferClientOnlyMapping === true,
  );
  const [triageGuidance, setTriageGuidance] = useState(
    props.connection.settings.triageGuidance || '',
  );
  const [googleCalendarIds, setGoogleCalendarIds] = useState<string[]>(
    props.connection.settings.googleCalendarIds || [],
  );
  const [microsoftMailFolderIds, setMicrosoftMailFolderIds] = useState<string[]>(
    props.connection.settings.microsoftMailFolderIds || [],
  );
  const [microsoftCalendarIds, setMicrosoftCalendarIds] = useState<string[]>(
    props.connection.settings.microsoftCalendarIds || [],
  );
  const [jiraProjectKeys, setJiraProjectKeys] = useState<string[]>(
    props.connection.settings.jiraProjectKeys || [],
  );
  const [jiraJql, setJiraJql] = useState(props.connection.settings.jiraJql || '');
  const [slackIncludedChannelIds, setSlackIncludedChannelIds] = useState<string[]>(
    props.connection.settings.slackIncludedChannelIds || [],
  );
  const [slackExcludedChannelIds, setSlackExcludedChannelIds] = useState<string[]>(
    props.connection.settings.slackExcludedChannelIds || [],
  );

  useEffect(() => {
    setDefaultClientId(props.connection.settings.defaultClientId || '');
    setDefaultProjectId(props.connection.settings.defaultProjectId || '');
    setPreferClientOnlyMapping(props.connection.settings.preferClientOnlyMapping === true);
    setTriageGuidance(props.connection.settings.triageGuidance || '');
    setGoogleMailQuery(props.connection.settings.googleMailQuery || '');
    setGoogleCalendarIds(props.connection.settings.googleCalendarIds || []);
    setMicrosoftMailFolderIds(props.connection.settings.microsoftMailFolderIds || []);
    setMicrosoftCalendarIds(props.connection.settings.microsoftCalendarIds || []);
    setJiraProjectKeys(props.connection.settings.jiraProjectKeys || []);
    setJiraJql(props.connection.settings.jiraJql || '');
    setSlackIncludedChannelIds(props.connection.settings.slackIncludedChannelIds || []);
    setSlackExcludedChannelIds(props.connection.settings.slackExcludedChannelIds || []);
  }, [props.connection.connectionKey, props.connection.settings]);

  const availableProjects = useMemo(() => {
    if (!defaultClientId) {
      return props.projects;
    }
    return props.projects.filter((project) => project.clientId === defaultClientId);
  }, [defaultClientId, props.projects]);

  useEffect(() => {
    if (defaultProjectId && !availableProjects.some((project) => project.id === defaultProjectId)) {
      setDefaultProjectId('');
    }
  }, [availableProjects, defaultProjectId]);

  useEffect(() => {
    if (preferClientOnlyMapping && defaultProjectId) {
      setDefaultProjectId('');
    }
  }, [preferClientOnlyMapping, defaultProjectId]);

  const saveMutation = useMutation({
    mutationFn: async () =>
      api.updateConnectionSettings(
        props.connection.provider as 'google' | 'microsoft' | 'jira' | 'slack',
        props.connection.accountId as string,
        {
          defaultClientId: defaultClientId || undefined,
          defaultProjectId:
            preferClientOnlyMapping ? undefined : defaultProjectId || undefined,
          preferClientOnlyMapping,
          triageGuidance: triageGuidance.trim() || undefined,
          googleMailQuery,
          googleCalendarIds,
          microsoftMailFolderIds,
          microsoftCalendarIds,
          jiraProjectKeys,
          jiraJql,
          slackIncludedChannelIds,
          slackExcludedChannelIds,
        },
      ),
    onSuccess: async () => {
      await invalidateOps(queryClient);
      props.onFeedback(`Saved scope settings for ${props.connection.accountLabel || props.connection.accountId}.`);
    },
    onError: (error) => {
      props.onFeedback(error instanceof Error ? error.message : String(error));
    },
  });

  const catalog = catalogQuery.data;
  const scopeSummary = formatScopeSummary(props.connection);

  return (
    <div className="scope-settings-box">
      <div className="panel-topline">
        <div>
          <div className="field-label">Scope settings</div>
          <div className="chip-row">
            {scopeSummary.map((entry) => (
              <span key={entry} className="chip">
                {entry}
              </span>
            ))}
          </div>
        </div>
        <button
          className="chip-button"
          onClick={() => setExpanded((current) => !current)}
        >
      {expanded ? 'Hide scope' : 'Edit scope'}
        </button>
      </div>
      {expanded ? (
        <div className="scope-settings-grid">
          <label>
            Default client
            <select
              value={defaultClientId}
              onChange={(event) => setDefaultClientId(event.target.value)}
            >
              <option value="">No default client</option>
              {props.clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Default project
            <select
              value={defaultProjectId}
              onChange={(event) => setDefaultProjectId(event.target.value)}
              disabled={!availableProjects.length || preferClientOnlyMapping}
            >
              <option value="">No default project</option>
              {availableProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="scope-option field-span-2">
            <input
              type="checkbox"
              checked={preferClientOnlyMapping}
              onChange={(event) => setPreferClientOnlyMapping(event.target.checked)}
            />
            <span>
              <strong>Keep this account client-only by default</strong>
              {' • '}
              Only apply a project when the message, issue, or event clearly signals one.
            </span>
          </label>
          <label className="field-span-2">
            Triage guidance
            <textarea
              value={triageGuidance}
              onChange={(event) => setTriageGuidance(event.target.value)}
              placeholder="Describe how this account should be interpreted by the assistant. Example: I'm the Betty Mills COO. Alias inboxes are usually low priority unless I'm directly addressed, mentioned, or it's a pricing, MAP, outage, or system alert."
            />
            <span className="detail-copy">
              This is soft context for the model when it classifies email, Slack, and follow-up work. It does not create hard rules.
            </span>
          </label>
          {props.connection.provider === 'google' ? (
            <Fragment>
              <label className="field-span-2">
                Gmail query
                <input
                  value={googleMailQuery}
                  onChange={(event) => setGoogleMailQuery(event.target.value)}
                  placeholder='Example: category:primary newer_than:14d'
                />
              </label>
              <ScopeOptionChecklist
                title="Calendars to include"
                options={catalog?.calendars || []}
                selected={googleCalendarIds}
                onToggle={(id) =>
                  setGoogleCalendarIds((current) => toggleSelection(current, id))
                }
                emptyLabel={catalogQuery.isLoading ? 'Loading calendars…' : 'No calendars available.'}
              />
              <div className="scope-settings-box">
                <div className="field-label">Available Gmail labels</div>
                {catalogQuery.isLoading ? (
                  <p className="detail-copy">Loading Gmail labels…</p>
                ) : catalog?.mailLabels?.length ? (
                  <div className="chip-row">
                    {catalog.mailLabels.map((label) => (
                      <span key={label.id} className="chip">
                        {label.label}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="detail-copy">No labels available.</p>
                )}
              </div>
            </Fragment>
          ) : null}
          {props.connection.provider === 'microsoft' ? (
            <Fragment>
              <ScopeOptionChecklist
                title="Mail folders to include"
                options={catalog?.mailFolders || []}
                selected={microsoftMailFolderIds}
                onToggle={(id) =>
                  setMicrosoftMailFolderIds((current) => toggleSelection(current, id))
                }
                emptyLabel={catalogQuery.isLoading ? 'Loading mail folders…' : 'No mail folders available.'}
              />
              <ScopeOptionChecklist
                title="Calendars to include"
                options={catalog?.calendars || []}
                selected={microsoftCalendarIds}
                onToggle={(id) =>
                  setMicrosoftCalendarIds((current) => toggleSelection(current, id))
                }
                emptyLabel={catalogQuery.isLoading ? 'Loading calendars…' : 'No calendars available.'}
              />
            </Fragment>
          ) : null}
          {props.connection.provider === 'jira' ? (
            <Fragment>
              <ScopeOptionChecklist
                title="Projects to include"
                options={catalog?.projects || []}
                selected={jiraProjectKeys}
                onToggle={(id) =>
                  setJiraProjectKeys((current) => toggleSelection(current, id))
                }
                emptyLabel={catalogQuery.isLoading ? 'Loading Jira projects…' : 'No Jira projects available.'}
              />
              <label className="field-span-2">
                Additional JQL
                <textarea
                  value={jiraJql}
                  onChange={(event) => setJiraJql(event.target.value)}
                  placeholder='Example: assignee = currentUser() AND statusCategory != Done'
                />
              </label>
            </Fragment>
          ) : null}
          {props.connection.provider === 'slack' ? (
            <Fragment>
              <ScopeOptionChecklist
                title="Included channels"
                options={catalog?.channels || []}
                selected={slackIncludedChannelIds}
                onToggle={(id) =>
                  setSlackIncludedChannelIds((current) => toggleSelection(current, id))
                }
                emptyLabel={catalogQuery.isLoading ? 'Loading Slack channels…' : 'No channels available.'}
              />
              <ScopeOptionChecklist
                title="Excluded channels"
                options={catalog?.channels || []}
                selected={slackExcludedChannelIds}
                onToggle={(id) =>
                  setSlackExcludedChannelIds((current) => toggleSelection(current, id))
                }
                emptyLabel={catalogQuery.isLoading ? 'Loading Slack channels…' : 'No channels available.'}
              />
            </Fragment>
          ) : null}
          <div className="button-row">
            <button
              className="secondary-button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? 'Saving…' : 'Save scope'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RecordMeta(props: {
  provider?: string;
  accountLabel?: string | null;
  client?: Client | null;
  project?: Project | null;
  priority?: string | null;
  status?: string | null;
  attributionDiagnostics?: PersonalOpsAttributionDiagnostic[];
}) {
  const visibleDiagnostics = (props.attributionDiagnostics || []).slice(0, 2);
  const hiddenDiagnosticCount = Math.max(
    0,
    (props.attributionDiagnostics || []).length - visibleDiagnostics.length,
  );
  return (
    <div className="chip-row">
      {props.provider ? <span className="chip">{providerLabel(props.provider)}</span> : null}
      {props.accountLabel ? <span className="chip">{props.accountLabel}</span> : null}
      {props.priority ? <span className="chip">{props.priority}</span> : null}
      {props.status ? (
        <span className={`chip tone-${statusTone(props.status)}`}>{props.status}</span>
      ) : null}
      {props.client ? <span className="chip">{props.client.name}</span> : null}
      {props.project ? <span className="chip">{props.project.name}</span> : null}
      {visibleDiagnostics.map((diagnostic) => (
        <span
          key={`${diagnostic.kind}:${diagnostic.detail || ''}`}
          className={`chip tone-${attributionDiagnosticTone(diagnostic)}`}
          title={formatAttributionDiagnostic(diagnostic, true)}
        >
          {diagnostic.label}
        </span>
      ))}
      {hiddenDiagnosticCount > 0 ? (
        <span className="chip">{`+${hiddenDiagnosticCount} more rule${hiddenDiagnosticCount === 1 ? '' : 's'}`}</span>
      ) : null}
    </div>
  );
}

function SourceInspector(props: {
  source: SourceRecord;
  clients: Client[];
  projects: Project[];
  onMutated: () => Promise<void>;
  coachQuestion?: AssistantQuestion | null;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [draftClientId, setDraftClientId] = useState(props.source.clientId || '');
  const [draftProjectId, setDraftProjectId] = useState(props.source.projectId || '');
  const [draftPriority, setDraftPriority] = useState<PersonalOpsPriority>(
    props.source.priority || 'medium',
  );
  const [draftWorkStatus, setDraftWorkStatus] = useState<
    'open' | 'in_progress' | 'blocked' | 'waiting' | 'done' | 'on_hold' | null
  >(null);
  const [saving, setSaving] = useState(false);
  const client = findClient(props.clients, props.source.clientId);
  const project = findProject(props.projects, props.source.projectId);
  const hidden = sourceLooksNoisy(props.source);
  const targetId = sourceRecordKey(props.source);
  const attributionDiagnostics = sourceAttributionDiagnostics(props.source);
  const attention = sourceAttentionState(props.source);

  useEffect(() => {
    setDraftClientId(props.source.clientId || '');
    setDraftProjectId(props.source.projectId || '');
    setDraftPriority(props.source.priority || 'medium');
    setDraftWorkStatus(null);
    setMessage('');
  }, [props.source]);

  const runImmediateCorrection = async (input: {
    targetType: Correction['targetType'];
    targetId: string;
    field: string;
    value: string;
  }) => {
    try {
      await api.createCorrection(input);
      await invalidateOps(queryClient);
      await props.onMutated();
      setMessage('Saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const saveCorrections = async () => {
    const changes: Array<{
      targetType: Correction['targetType'];
      targetId: string;
      field: string;
      value: string;
    }> = [];
    if ((props.source.clientId || '') !== draftClientId) {
      changes.push({
        targetType: 'source_record',
        targetId,
        field: 'clientId',
        value: draftClientId,
      });
    }
    if ((props.source.projectId || '') !== draftProjectId) {
      changes.push({
        targetType: 'source_record',
        targetId,
        field: 'projectId',
        value: draftProjectId,
      });
    }
    if ((props.source.priority || 'medium') !== draftPriority) {
      changes.push({
        targetType: 'source_record',
        targetId,
        field: 'priority',
        value: draftPriority,
      });
    }
    if (draftWorkStatus) {
      changes.push({
        targetType: 'source_record',
        targetId,
        field: 'workflowStatus',
        value: draftWorkStatus,
      });
    }
    if (!changes.length) {
      setMessage('No changes to save.');
      return;
    }
    try {
      setSaving(true);
      for (const change of changes) {
        await api.createCorrection(change);
      }
      await invalidateOps(queryClient);
      await props.onMutated();
      setDraftWorkStatus(null);
      setMessage(`Saved ${changes.length} change${changes.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const resetCorrections = () => {
    setDraftClientId(props.source.clientId || '');
    setDraftProjectId(props.source.projectId || '');
    setDraftPriority(props.source.priority || 'medium');
    setDraftWorkStatus(null);
    setMessage('');
  };

  return (
    <div className="inspector-stack">
      {props.coachQuestion ? (
        <AssistantQuestionCard question={props.coachQuestion} compact inline />
      ) : null}
      <div className="panel-card">
        <div className="panel-topline">
          <div>
            <div className="eyebrow">Source detail</div>
            <h4>{props.source.title}</h4>
          </div>
          <a
            href={props.source.sourceUrl || '#'}
            target="_blank"
            rel="noreferrer"
            className={`open-link${props.source.sourceUrl ? '' : ' disabled'}`}
          >
            Open source
          </a>
        </div>
        <RecordMeta
          provider={props.source.provider}
          accountLabel={sourceAccountLabel(props.source)}
          client={client}
          project={project}
          priority={props.source.priority}
          status={props.source.status}
          attributionDiagnostics={attributionDiagnostics}
        />
        <p className="detail-copy">{props.source.summary || props.source.body || 'No summary available.'}</p>
        <div className="callout-card">
          <div className="eyebrow">What should I do?</div>
          <p>{sourceRecommendedAction(props.source)}</p>
        </div>
        <dl className="detail-grid">
          <div>
            <dt>Received</dt>
            <dd>{formatDateTime(props.source.occurredAt)}</dd>
          </div>
          <div>
            <dt>Participants</dt>
            <dd>{props.source.participants.join(', ') || 'n/a'}</dd>
          </div>
          <div>
            <dt>Account</dt>
            <dd>{sourceAccountLabel(props.source) || 'n/a'}</dd>
          </div>
          <div>
            <dt>Attribution</dt>
            <dd>{props.source.attributionSource || 'none'}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{props.source.attributionConfidence?.toFixed(2) || 'n/a'}</dd>
          </div>
          <div>
            <dt>Directness</dt>
            <dd>{attention.directness}</dd>
          </div>
          <div>
            <dt>Thread state</dt>
            <dd>{props.source.threadState?.summary || 'n/a'}</dd>
          </div>
          <div>
            <dt>Importance</dt>
            <dd>{attention.importanceReason || 'n/a'}</dd>
          </div>
          <div>
            <dt>Review</dt>
            <dd>{sourceNeedsReview(props.source) ? 'Needs review' : props.source.reviewState || 'n/a'}</dd>
          </div>
          <div>
            <dt>Linked contacts</dt>
            <dd>{props.source.linkedContactIds?.length || 0}</dd>
          </div>
          <div>
            <dt>Rule basis</dt>
            <dd>
              {attributionDiagnostics.length
                ? attributionDiagnostics.map((diagnostic) => diagnostic.label).join(' • ')
                : typeof props.source.metadata?.attributionRule === 'string'
                  ? props.source.metadata.attributionRule
                  : 'n/a'}
            </dd>
          </div>
        </dl>
        {attributionDiagnostics.length ? (
          <div className="stack-gap compact">
            <div className="field-label">Attribution diagnostics</div>
            <div className="reason-list">
              {attributionDiagnostics.map((diagnostic) => (
                <span
                  key={`${diagnostic.kind}:${diagnostic.detail || ''}`}
                  className="reason-chip"
                  title={formatAttributionDiagnostic(diagnostic, true)}
                >
                  {formatAttributionDiagnostic(diagnostic, true)}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <div className="reason-list">
          {sourceWhySurfaced(props.source).map((reason) => (
            <span key={reason} className="reason-chip">
              {reason}
            </span>
          ))}
        </div>
        <div className="reason-list">
          {attention.actionRequired ? <span className="reason-chip">Action required</span> : null}
          {attention.awarenessOnly ? <span className="reason-chip">Awareness only</span> : null}
          {attention.operationalRisk ? <span className="reason-chip">Operational risk</span> : null}
          {attention.reportWorthy ? <span className="reason-chip">Report worthy</span> : null}
        </div>
        {typeof props.source.metadata?.attributionRule === 'string' ? (
          <p className="detail-copy">Rule trace: {props.source.metadata.attributionRule}</p>
        ) : null}
      </div>

      <div className="panel-card">
        <div className="eyebrow">Corrections</div>
        <div className="field-grid">
          <label>
            Client
            <select
              value={draftClientId}
              onChange={(event) => setDraftClientId(event.target.value)}
            >
              <option value="">Unassigned</option>
              {props.clients.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Project
            <select
              value={draftProjectId}
              onChange={(event) => setDraftProjectId(event.target.value)}
            >
              <option value="">Unassigned</option>
              {props.projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="button-row wrap">
          {(['low', 'medium', 'high', 'urgent'] as const).map((priority) => (
            <button
              key={priority}
              className={`mini-button${draftPriority === priority ? ' selected' : ''}`}
              onClick={() => setDraftPriority(priority)}
            >
              {priority}
            </button>
          ))}
        </div>
        <div className="detail-copy">Workflow state</div>
        <div className="button-row wrap">
          <button
            className="mini-button"
            onClick={() =>
              runImmediateCorrection({
                targetType: 'source_record',
                targetId,
                field: 'ignoreTask',
                value: 'true',
              })
            }
          >
            Not a task
          </button>
          <button
            className={`mini-button${sourceIsImportantAwareness(props.source) ? ' selected' : ''}`}
            onClick={() =>
              runImmediateCorrection({
                targetType: 'source_record',
                targetId,
                field: 'awarenessOnly',
                value: sourceIsImportantAwareness(props.source) ? 'false' : 'true',
              })
            }
          >
            {sourceIsImportantAwareness(props.source) ? 'Restore action lane' : 'Mark awareness-only'}
          </button>
          <button
            className={`mini-button${hidden ? ' selected' : ''}`}
            onClick={() =>
              runImmediateCorrection({
                targetType: 'source_record',
                targetId,
                field: 'hideFromSummaries',
                value: hidden ? 'false' : 'true',
              })
            }
          >
            {hidden ? 'Restore to summaries' : 'Hide from summaries'}
          </button>
          {props.source.kind === 'email' ? (
            <button
              className="mini-button"
              onClick={() =>
                runImmediateCorrection({
                  targetType: 'source_record',
                  targetId,
                  field: 'ignoreSimilar',
                  value: props.source.title || 'ignore similar email messages',
                })
              }
            >
              Ignore similar messages
            </button>
          ) : null}
        </div>
        <div className="button-row wrap">
          {(['open', 'in_progress', 'blocked', 'waiting', 'done', 'on_hold'] as const).map(
            (status) => (
              <button
                key={status}
                className={`mini-button${draftWorkStatus === status ? ' selected' : ''}`}
                onClick={() => setDraftWorkStatus(status)}
              >
                Mark {status.replace('_', ' ')}
              </button>
            ),
          )}
        </div>
        <div className="button-row">
          <button className="primary-button" onClick={saveCorrections} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button className="secondary-button" onClick={resetCorrections} disabled={saving}>
            Reset
          </button>
        </div>
        {message ? <p className="feedback">{message}</p> : null}
      </div>
    </div>
  );
}

function WorkItemInspector(props: {
  item: WorkItem;
  clients: Client[];
  projects: Project[];
  onMutated: () => Promise<void>;
  coachQuestion?: AssistantQuestion | null;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [draftClientId, setDraftClientId] = useState(props.item.clientId || '');
  const [draftProjectId, setDraftProjectId] = useState(props.item.projectId || '');
  const [draftPriority, setDraftPriority] = useState<PersonalOpsPriority>(
    props.item.priority,
  );
  const [draftStatus, setDraftStatus] = useState(props.item.status);
  const [saving, setSaving] = useState(false);
  const client = findClient(props.clients, props.item.clientId);
  const project = findProject(props.projects, props.item.projectId);

  useEffect(() => {
    setDraftClientId(props.item.clientId || '');
    setDraftProjectId(props.item.projectId || '');
    setDraftPriority(props.item.priority);
    setDraftStatus(props.item.status);
    setMessage('');
  }, [props.item]);

  const saveCorrections = async () => {
    const changes: Array<{ field: string; value: string }> = [];
    if ((props.item.clientId || '') !== draftClientId) {
      changes.push({ field: 'clientId', value: draftClientId });
    }
    if ((props.item.projectId || '') !== draftProjectId) {
      changes.push({ field: 'projectId', value: draftProjectId });
    }
    if (props.item.priority !== draftPriority) {
      changes.push({ field: 'priority', value: draftPriority });
    }
    if (props.item.status !== draftStatus) {
      changes.push({ field: 'status', value: draftStatus });
    }
    if (!changes.length) {
      setMessage('No changes to save.');
      return;
    }
    try {
      setSaving(true);
      for (const change of changes) {
        await api.createCorrection({
          targetType: 'work_item',
          targetId: props.item.id,
          field: change.field,
          value: change.value,
        });
      }
      await invalidateOps(queryClient);
      await props.onMutated();
      setMessage(`Saved ${changes.length} change${changes.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const resetCorrections = () => {
    setDraftClientId(props.item.clientId || '');
    setDraftProjectId(props.item.projectId || '');
    setDraftPriority(props.item.priority);
    setDraftStatus(props.item.status);
    setMessage('');
  };

  return (
    <div className="inspector-stack">
      {props.coachQuestion ? (
        <AssistantQuestionCard question={props.coachQuestion} compact inline />
      ) : null}
      <div className="panel-card">
        <div className="eyebrow">Work item</div>
        <h4>{props.item.title}</h4>
        <RecordMeta
          provider={props.item.sourceProvider}
          client={client}
          project={project}
          priority={props.item.priority}
          status={props.item.status}
        />
        <p className="detail-copy">{props.item.notes || 'No notes available.'}</p>
        <dl className="detail-grid">
          <div>
            <dt>Due</dt>
            <dd>{formatDateTime(props.item.dueDate)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatDateTime(props.item.updatedAt)}</dd>
          </div>
          <div>
            <dt>Open-loop state</dt>
            <dd>{props.item.openLoopState}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{props.item.confidence?.toFixed(2) || 'n/a'}</dd>
          </div>
          <div>
            <dt>Needs review</dt>
            <dd>{props.item.needsReview ? 'Yes' : 'No'}</dd>
          </div>
          <div>
            <dt>Linked contacts</dt>
            <dd>{props.item.linkedContactIds.length}</dd>
          </div>
        </dl>
      </div>

      <div className="panel-card">
        <div className="eyebrow">Corrections</div>
        <div className="field-grid">
          <label>
            Client
            <select
              value={draftClientId}
              onChange={(event) => setDraftClientId(event.target.value)}
            >
              <option value="">Unassigned</option>
              {props.clients.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Project
            <select
              value={draftProjectId}
              onChange={(event) => setDraftProjectId(event.target.value)}
            >
              <option value="">Unassigned</option>
              {props.projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="button-row wrap">
          {(['low', 'medium', 'high', 'urgent'] as const).map((priority) => (
            <button
              key={priority}
              className={`mini-button${draftPriority === priority ? ' selected' : ''}`}
              onClick={() => setDraftPriority(priority)}
            >
              {priority}
            </button>
          ))}
        </div>
        <div className="button-row wrap">
          {(['open', 'in_progress', 'blocked', 'waiting', 'done', 'on_hold'] as const).map(
            (status) => (
              <button
                key={status}
                className={`mini-button${draftStatus === status ? ' selected' : ''}`}
                onClick={() => setDraftStatus(status)}
              >
                {status.replace('_', ' ')}
              </button>
            ),
          )}
        </div>
        <div className="button-row">
          <button className="primary-button" onClick={saveCorrections} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button className="secondary-button" onClick={resetCorrections} disabled={saving}>
            Reset
          </button>
        </div>
        {message ? <p className="feedback">{message}</p> : null}
      </div>
    </div>
  );
}

function ActivityInspector(props: {
  activity: Activity;
  clients: Client[];
  projects: Project[];
}) {
  const client = findClient(props.clients, props.activity.relatedClientId);
  const project = findProject(props.projects, props.activity.relatedProjectId);
  return (
    <div className="inspector-stack">
      <div className="panel-card">
        <div className="eyebrow">History detail</div>
        <h4>{props.activity.summary}</h4>
        <RecordMeta
          provider={props.activity.sourceProvider}
          client={client}
          project={project}
          status={props.activity.type}
        />
        <dl className="detail-grid">
          <div>
            <dt>Timestamp</dt>
            <dd>{formatDateTime(props.activity.timestamp)}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{props.activity.sourceKind}</dd>
          </div>
          <div>
            <dt>Reference</dt>
            <dd>{props.activity.rawReference || props.activity.sourceRecordKey || 'n/a'}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function WorkstreamInspector(props: {
  stream: PersonalOpsWorkstream;
}) {
  return (
    <div className="inspector-stack">
      <div className="panel-card">
        <div className="eyebrow">Workstream</div>
        <h4>{workstreamLabel(props.stream)}</h4>
        <div className="chip-row">
          {props.stream.signals.length ? (
            props.stream.signals.map((signal) => (
              <span key={signal} className="chip">
                {signal}
              </span>
            ))
          ) : (
            <span className="chip">No active signals</span>
          )}
        </div>
        <dl className="detail-grid">
          <div>
            <dt>Last updated</dt>
            <dd>{formatDateTime(props.stream.lastUpdatedAt)}</dd>
          </div>
          <div>
            <dt>Next due</dt>
            <dd>{formatDateTime(props.stream.nextDueAt)}</dd>
          </div>
          <div>
            <dt>Open items</dt>
            <dd>{props.stream.items.length}</dd>
          </div>
          <div>
            <dt>Source signals</dt>
            <dd>{props.stream.sourceRecords.length}</dd>
          </div>
          <div>
            <dt>Open loops</dt>
            <dd>{props.stream.openLoopCount}</dd>
          </div>
          <div>
            <dt>Needs review</dt>
            <dd>{props.stream.needsReviewCount}</dd>
          </div>
        </dl>
      </div>

      <div className="panel-card">
        <div className="eyebrow">Open work</div>
        {props.stream.items.length ? (
          <div className="stack-gap compact">
            {props.stream.items.slice(0, 6).map((item) => (
              <div key={item.id} className="mini-list-item">
                <strong>{item.title}</strong>
                <span>{item.status.replace('_', ' ')} • {item.priority}</span>
              </div>
            ))}
          </div>
        ) : (
          <p>No open work items are linked yet.</p>
        )}
      </div>

      <div className="panel-card">
        <div className="eyebrow">Source signals</div>
        {props.stream.sourceRecords.length ? (
          <div className="stack-gap compact">
            {props.stream.sourceRecords.slice(0, 6).map((source) => (
              <div key={sourceRecordKey(source)} className="mini-list-item">
                <strong>{source.title}</strong>
                <span>{providerLabel(source.provider)} • {formatShortDate(source.occurredAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p>No recent linked source records.</p>
        )}
      </div>

      <div className="panel-card">
        <div className="eyebrow">Contacts</div>
        {props.stream.linkedContacts.length ? (
          <div className="stack-gap compact">
            {props.stream.linkedContacts.map((contact) => (
              <div key={contact.id} className="mini-list-item">
                <strong>{contact.name}</strong>
                <span>
                  {[contact.likelyRole, contact.organizationHint, contact.importance]
                    .filter(Boolean)
                    .join(' • ')}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p>No contacts linked to this workstream yet.</p>
        )}
      </div>

      <div className="panel-card">
        <div className="eyebrow">Linked evidence</div>
        {props.stream.links.length ? (
          <div className="stack-gap compact">
            {props.stream.links.map((link) => (
              <div key={link.key} className="mini-list-item">
                <strong>{link.label}</strong>
                <span>
                  {[link.itemCount ? `${link.itemCount} item` : null, link.sourceCount ? `${link.sourceCount} source` : null, link.activityCount ? `${link.activityCount} activity` : null, link.repositoryCount ? `${link.repositoryCount} repo` : null]
                    .filter(Boolean)
                    .join(' • ')}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p>No cross-source evidence anchors are linked yet.</p>
        )}
      </div>

      <div className="panel-card">
        <div className="eyebrow">Repositories</div>
        {props.stream.repositories.length ? (
          <div className="stack-gap compact">
            {props.stream.repositories.map((repository) => (
              <div key={repository.id} className="mini-list-item">
                <strong>{repository.name}</strong>
                <span>{repository.defaultBranch || 'branch n/a'} • {formatDateTime(repository.lastCommitAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p>No repositories attached to this workstream yet.</p>
        )}
      </div>
    </div>
  );
}

function TodayPage(props: { bootstrap: AppBootstrap }) {
  const queryClient = useQueryClient();
  const interval = useOpsInterval(props.bootstrap);
  const todayQuery = useQuery({
    queryKey: ['today'],
    queryFn: api.getToday,
    refetchInterval: interval,
  });
  const today = todayQuery.data?.today;
  const todayQuestionsQuery = useQuery({
    queryKey: ['questions', 'today', 'inline'],
    queryFn: () => api.getQuestions({ surface: 'today', urgency: 'inline' }),
    refetchInterval: interval,
  });
  const [taskTitle, setTaskTitle] = useState('');
  const [taskNotes, setTaskNotes] = useState('');
  const [taskPriority, setTaskPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');
  const [noteTitle, setNoteTitle] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [feedback, setFeedback] = useState('');

  const mixed = useMemo(() => {
    if (!today) return [];
    return [
      ...today.workstreams.map((item) => ({
        type: 'workstream' as const,
        id: item.key,
        label: 'Workstream',
        timestamp: item.lastUpdatedAt || item.nextDueAt || '',
        item,
      })),
      ...today.priorities.map((item) => ({ type: 'work' as const, id: item.id, label: 'Priority', timestamp: item.updatedAt, item })),
      ...today.meetings.map((item) => ({ type: 'source' as const, id: sourceRecordKey(item), label: 'Meeting', timestamp: item.occurredAt, item })),
      ...today.inbox.map((item) => ({ type: 'source' as const, id: sourceRecordKey(item), label: 'Inbox', timestamp: item.occurredAt, item })),
      ...today.approvalQueue.map((item) => ({ type: 'queue' as const, id: item.id, label: 'Queue', timestamp: item.updatedAt, item })),
    ].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [today]);

  const [selectedId, setSelectedId] = useStableSelectedId(mixed, (item) => item.id);
  const selected = mixed.find((item) => item.id === selectedId) || null;
  const [autoFocusedQuestionId, setAutoFocusedQuestionId] = useState<string | null>(null);
  const selectedQuestionTarget = useMemo(() => {
    if (!selected) return null;
    if (selected.type === 'source') {
      return questionTargetForSource(selected.item);
    }
    if (selected.type === 'work') {
      return { targetType: 'work_item' as const, targetId: selected.item.id };
    }
    return null;
  }, [selected]);
  const selectedTodayQuestionQuery = useQuery({
    queryKey: [
      'questions',
      'today',
      'inline',
      selectedQuestionTarget?.targetType || 'none',
      selectedQuestionTarget?.targetId || 'none',
    ],
    queryFn: () =>
      api.getQuestions({
        surface: 'today',
        urgency: 'inline',
        targetType: selectedQuestionTarget!.targetType,
        targetId: selectedQuestionTarget!.targetId,
      }),
    refetchInterval: interval,
    enabled: Boolean(selectedQuestionTarget),
  });
  const selectedTodayQuestion = selectedTodayQuestionQuery.data?.questions?.[0] || null;

  useEffect(() => {
    const question = todayQuestionsQuery.data?.questions?.[0];
    if (!question?.id || !question.targetId || autoFocusedQuestionId === question.id) return;
    if (!mixed.some((item) => item.id === question.targetId)) {
      setAutoFocusedQuestionId(question.id);
      return;
    }
    setSelectedId(question.targetId);
    setAutoFocusedQuestionId(question.id);
  }, [autoFocusedQuestionId, mixed, setSelectedId, todayQuestionsQuery.data?.questions]);

  const createTask = async () => {
    try {
      await api.createManualTask({
        title: taskTitle,
        notes: taskNotes || undefined,
        priority: taskPriority,
      });
      setTaskTitle('');
      setTaskNotes('');
      setFeedback('Manual task added.');
      await invalidateOps(queryClient);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  const createNote = async () => {
    try {
      await api.createManualNote({
        title: noteTitle,
        body: noteBody || undefined,
      });
      setNoteTitle('');
      setNoteBody('');
      setFeedback('Manual note added.');
      await invalidateOps(queryClient);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  if (!today) {
    return <EmptyState title="Loading today" body="Personal ops data is loading." />;
  }

  return (
    <ScreenFrame title="Today" subtitle="A focused start-of-day and check-in surface.">
      <div className="today-grid">
        <div className="summary-card accent">
          <div className="eyebrow">Suggested plan</div>
          <h3>Work the day from the top down.</h3>
          <ul>
            {today.suggestedPlan.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </div>
        <div className="metric-grid">
          <MetricCard label="Priorities" value={today.priorities.length} tone="accent" />
          <MetricCard label="Meetings" value={today.meetings.length} tone="muted" />
          <MetricCard label="Open loops" value={today.openLoops.length} tone="warning" />
          <MetricCard label="Follow-ups" value={today.followUps.length} tone="warning" />
          <MetricCard label="Pending approvals" value={today.approvalQueue.length} tone="warning" />
          <MetricCard label="Blockers" value={today.blockers.length} tone="danger" />
        </div>
      </div>
      <DetailScaffold
        list={
          <div className="stack-gap">
            <SectionBlock
              title="Active workstreams"
              collapsible
              storageKey="today-workstreams"
              defaultExpanded={true}
            >
              {today.workstreams.length ? (
                today.workstreams.map((stream) => (
                  <button
                    key={stream.key}
                    className={`record-card${selectedId === stream.key ? ' selected' : ''}`}
                    onClick={() => setSelectedId(stream.key)}
                  >
                    <div className="record-card-top">
                      <strong>{workstreamLabel(stream)}</strong>
                      <StatusPill tone={workstreamTone(stream)} label={stream.blockerCount ? 'attention' : 'active'} />
                    </div>
                    <p className="record-submeta">
                      Last updated {formatShortDate(stream.lastUpdatedAt)}
                      {stream.nextDueAt ? ` • due ${formatShortDate(stream.nextDueAt)}` : ''}
                    </p>
                    {stream.signals.length ? (
                      <div className="activity-strip">
                        {stream.signals.map((signal) => (
                          <span key={signal} className="activity-chip">
                            {signal}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </button>
                ))
              ) : (
                <EmptyState title="No grouped work yet" body="Client and project links will condense into workstreams here." />
              )}
            </SectionBlock>

            <SectionBlock title="Must-do now">
              {today.priorities.length ? (
                today.priorities.slice(0, 6).map((item) => (
                  <button
                    key={item.id}
                    className={`record-card${selectedId === item.id ? ' selected' : ''}`}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <div className="record-card-top">
                      <strong>{item.title}</strong>
                      <StatusPill tone={statusTone(item.priority)} label={item.priority} />
                    </div>
                    <p>{item.notes || 'No notes available.'}</p>
                  </button>
                ))
              ) : (
                <EmptyState title="No active priorities" body="You have room to think ahead today." />
              )}
            </SectionBlock>

            <SectionBlock
              title="Open loops requiring attention"
              collapsible
              storageKey="today-open-loops"
              defaultExpanded={true}
            >
              {today.openLoops.length ? (
                today.openLoops.slice(0, 8).map((loop) => (
                  <button
                    key={loop.id}
                    className="record-card compact static-card"
                    onClick={() => {
                      if (loop.workItemId) {
                        setSelectedId(loop.workItemId);
                      } else if (loop.sourceRecordKey) {
                        setSelectedId(loop.sourceRecordKey);
                      }
                    }}
                  >
                    <div className="record-card-top">
                      <strong>{loop.title}</strong>
                      <StatusPill
                        tone={loop.needsReview ? 'warning' : statusTone(loop.state)}
                        label={loop.needsReview ? 'needs review' : loop.state}
                      />
                    </div>
                    <p>{loop.summary}</p>
                  </button>
                ))
              ) : (
                <EmptyState title="No open loops" body="Nothing is currently waiting on you or marked for awareness." />
              )}
            </SectionBlock>

            <SectionBlock
              title="Pending approvals"
              collapsible
              storageKey="today-queue"
              defaultExpanded={true}
            >
              {today.approvalQueue.length ? (
                today.approvalQueue.slice(0, 6).map((item) => (
                  <button
                    key={item.id}
                    className={`record-card${selectedId === item.id ? ' selected' : ''}`}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <div className="record-card-top">
                      <strong>{item.title}</strong>
                      <StatusPill tone="warning" label={item.kind.replace(/_/g, ' ')} />
                    </div>
                    <p className="record-submeta">{item.reason}</p>
                    <p>{item.summary}</p>
                  </button>
                ))
              ) : (
                <EmptyState title="No pending approvals" body="Draft replies, follow-ups, and prep items will appear here." />
              )}
            </SectionBlock>

            <SectionBlock title="Meetings" collapsible storageKey="today-meetings" defaultExpanded={true}>
              {today.meetings.length ? (
                today.meetings.slice(0, 6).map((meeting) => (
                  <button
                    key={sourceRecordKey(meeting)}
                    className={`record-card${selectedId === sourceRecordKey(meeting) ? ' selected' : ''}`}
                    onClick={() => setSelectedId(sourceRecordKey(meeting))}
                  >
                    <div className="record-card-top">
                      <strong>{meeting.title}</strong>
                      <span className="record-time">{formatShortDate(meeting.occurredAt)}</span>
                    </div>
                    <RecordMeta
                      provider={meeting.provider}
                      accountLabel={sourceAccountLabel(meeting)}
                      priority={meeting.priority}
                      status={meeting.status}
                      attributionDiagnostics={sourceAttributionDiagnostics(meeting)}
                    />
                    {sourceCalendarLine(meeting) ? (
                      <p className="record-submeta">{sourceCalendarLine(meeting)}</p>
                    ) : null}
                    {sourceWorkspaceLine(meeting) ? (
                      <p className="record-submeta">{sourceWorkspaceLine(meeting)}</p>
                    ) : null}
                    <p>{meeting.summary || 'No prep notes yet.'}</p>
                  </button>
                ))
              ) : (
                <EmptyState title="No meetings" body="Your calendar is open today." />
              )}
            </SectionBlock>

            <SectionBlock
              title="Needs attention from inbox"
              collapsible
              storageKey="today-inbox"
              defaultExpanded={true}
            >
              {today.inbox.length ? (
                today.inbox.slice(0, 6).map((source) => (
                  <button
                    key={sourceRecordKey(source)}
                    className={`record-card${selectedId === sourceRecordKey(source) ? ' selected' : ''}`}
                    onClick={() => setSelectedId(sourceRecordKey(source))}
                  >
                    <div className="record-card-top">
                      <strong>{source.title}</strong>
                      <StatusPill tone={statusTone(source.priority || 'medium')} label={source.priority || 'medium'} />
                    </div>
                    <RecordMeta
                      provider={source.provider}
                      accountLabel={sourceAccountLabel(source)}
                      status={source.status}
                      attributionDiagnostics={sourceAttributionDiagnostics(source)}
                    />
                    {sourceMailboxLine(source) ? (
                      <p className="record-submeta">{sourceMailboxLine(source)}</p>
                    ) : null}
                    {sourceWorkspaceLine(source) ? (
                      <p className="record-submeta">{sourceWorkspaceLine(source)}</p>
                    ) : null}
                    {sourceThreadLine(source) ? (
                      <p className="record-submeta">{sourceThreadLine(source)}</p>
                    ) : null}
                    <p>{source.summary || 'No preview available.'}</p>
                  </button>
                ))
              ) : (
                <EmptyState title="Inbox is quiet" body="Nothing important is waiting right now." />
              )}
            </SectionBlock>

            <SectionBlock
              title="Important awareness"
              collapsible
              storageKey="today-awareness"
              defaultExpanded={false}
            >
              {today.awareness.length ? (
                today.awareness.map((source) => (
                  <button
                    key={sourceRecordKey(source)}
                    className={`record-card${selectedId === sourceRecordKey(source) ? ' selected' : ''}`}
                    onClick={() => setSelectedId(sourceRecordKey(source))}
                  >
                    <div className="record-card-top">
                      <strong>{source.title}</strong>
                      <StatusPill tone={sourceNeedsReview(source) ? 'warning' : 'muted'} label={sourceNeedsReview(source) ? 'needs review' : 'awareness'} />
                    </div>
                    <RecordMeta
                      provider={source.provider}
                      accountLabel={sourceAccountLabel(source)}
                      attributionDiagnostics={sourceAttributionDiagnostics(source)}
                    />
                    {sourceThreadLine(source) ? (
                      <p className="record-submeta">{sourceThreadLine(source)}</p>
                    ) : null}
                    <p>{source.summary || sourceAttentionState(source).importanceReason || 'No preview available.'}</p>
                  </button>
                ))
              ) : (
                <EmptyState title="No awareness items" body="No important awareness-only items are surfaced right now." />
              )}
            </SectionBlock>
          </div>
        }
        detail={
          selected?.type === 'workstream' ? (
            <WorkstreamInspector stream={selected.item} />
          ) : selected?.type === 'source' ? (
            <SourceInspector
              source={selected.item}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
              coachQuestion={selectedTodayQuestion}
              onMutated={() => invalidateOps(queryClient)}
            />
          ) : selected?.type === 'work' ? (
            <WorkItemInspector
              item={selected.item}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
              coachQuestion={selectedTodayQuestion}
              onMutated={() => invalidateOps(queryClient)}
            />
          ) : selected?.type === 'queue' ? (
            <ApprovalQueueInspector
              item={selected.item}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
              onMutated={() => invalidateOps(queryClient)}
            />
          ) : (
            <EmptyState title="Select an item" body="Open a priority, meeting, or inbox item to review details." />
          )
        }
      />
      <div className="bottom-grid">
        <CollapsiblePanel
          storageKey="today-quick-capture"
          eyebrow="Quick capture"
          title="Manual notes and tasks"
          subtitle="Keep low-friction capture available without leaving it open all day."
          defaultExpanded={false}
        >
          <div className="field-grid">
            <label>
              Manual task
              <input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="What needs to happen?" />
            </label>
            <label>
              Priority
              <select value={taskPriority} onChange={(event) => setTaskPriority(event.target.value as typeof taskPriority)}>
                <option value="medium">Medium</option>
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="low">Low</option>
              </select>
            </label>
          </div>
          <textarea value={taskNotes} onChange={(event) => setTaskNotes(event.target.value)} placeholder="Notes or context" />
          <div className="button-row">
            <button className="primary-button" onClick={createTask} disabled={!taskTitle.trim()}>
              Add task
            </button>
          </div>
          <div className="field-grid">
            <label>
              Manual note
              <input value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} placeholder="Short note title" />
            </label>
          </div>
          <textarea value={noteBody} onChange={(event) => setNoteBody(event.target.value)} placeholder="Reference detail or context" />
          <div className="button-row">
            <button className="secondary-button" onClick={createNote} disabled={!noteTitle.trim()}>
              Add note
            </button>
          </div>
          {feedback ? <p className="feedback">{feedback}</p> : null}
        </CollapsiblePanel>

        <CollapsiblePanel
          storageKey="today-standup-preview"
          eyebrow="Standup preview"
          title="Today’s draft"
          defaultExpanded={false}
        >
          <MarkdownContent content={today.draftStandup} className="report-markdown" />
        </CollapsiblePanel>
      </div>
    </ScreenFrame>
  );
}

function InboxPage(props: { bootstrap: AppBootstrap }) {
  const queryClient = useQueryClient();
  const interval = useOpsInterval(props.bootstrap);
  const [showNoise, setShowNoise] = useState(false);
  const [providerFilter, setProviderFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [actionOnly, setActionOnly] = useState(false);
  const [linkedOnly, setLinkedOnly] = useState(false);
  const [search, setSearch] = useState('');

  const inboxQuery = useQuery({
    queryKey: ['inbox', showNoise],
    queryFn: () => api.getInbox({ includeNoise: showNoise }),
    refetchInterval: interval,
  });
  const inboxQuestionsQuery = useQuery({
    queryKey: ['questions', 'inbox', 'inline'],
    queryFn: () => api.getQuestions({ surface: 'inbox', urgency: 'inline' }),
    refetchInterval: interval,
  });
  const inbox = inboxQuery.data?.inbox || [];

  const filtered = useMemo(() => {
    return inbox.filter((source) => {
      if (providerFilter !== 'all' && source.provider !== providerFilter) return false;
      if (priorityFilter !== 'all' && (source.priority || 'medium') !== priorityFilter) return false;
      if (actionOnly && !sourceNeedsAction(source)) return false;
      if (linkedOnly && !source.clientId && !source.projectId) return false;
      if (search.trim()) {
        const haystack = `${source.title}\n${source.summary}\n${source.body}`.toLowerCase();
        if (!haystack.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [actionOnly, inbox, linkedOnly, priorityFilter, providerFilter, search]);

  const lanes = useMemo(() => {
    const needsAction = filtered.filter(sourceNeedsAction);
    const awareness = filtered.filter(
      (source) => !sourceNeedsAction(source) && sourceIsImportantAwareness(source),
    );
    const awarenessKeys = new Set(awareness.map((source) => sourceRecordKey(source)));
    const actionKeys = new Set(needsAction.map((source) => sourceRecordKey(source)));
    const lowSignal = filtered.filter((source) => {
      const key = sourceRecordKey(source);
      return !actionKeys.has(key) && !awarenessKeys.has(key);
    });
    return [
      { key: 'action', title: 'Needs action', items: needsAction, defaultExpanded: true },
      { key: 'awareness', title: 'Important awareness', items: awareness, defaultExpanded: true },
      { key: 'low', title: 'Low-signal', items: lowSignal, defaultExpanded: false },
    ];
  }, [filtered]);

  const [selectedId, setSelectedId] = useStableSelectedId(filtered, sourceRecordKey);
  const selected = filtered.find((item) => sourceRecordKey(item) === selectedId) || null;
  const [autoFocusedQuestionId, setAutoFocusedQuestionId] = useState<string | null>(null);
  const selectedInboxQuestionQuery = useQuery({
    queryKey: ['questions', 'inbox', 'inline', selectedId || 'none'],
    queryFn: () =>
      api.getQuestions({
        surface: 'inbox',
        urgency: 'inline',
        targetType: 'source_record',
        targetId: selectedId!,
      }),
    refetchInterval: interval,
    enabled: Boolean(selectedId),
  });
  const selectedInboxQuestion = selectedInboxQuestionQuery.data?.questions?.[0] || null;

  useEffect(() => {
    const question = inboxQuestionsQuery.data?.questions?.[0];
    if (!question?.id || !question.targetId || autoFocusedQuestionId === question.id) return;
    if (!filtered.some((item) => sourceRecordKey(item) === question.targetId)) {
      setAutoFocusedQuestionId(question.id);
      return;
    }
    setSelectedId(question.targetId);
    setAutoFocusedQuestionId(question.id);
  }, [autoFocusedQuestionId, filtered, inboxQuestionsQuery.data?.questions, setSelectedId]);

  return (
    <ScreenFrame title="Inbox" subtitle="Triage inbound with source context and fast corrections.">
      <DetailScaffold
        list={
          <Fragment>
            <CollapsiblePanel
              storageKey="inbox-filters"
              title="Inbox filters"
              subtitle="Keep triage controls available without pinning them open."
              defaultExpanded={false}
              className="toolbar-card"
            >
              <div className="filter-row">
                <select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}>
                  <option value="all">All providers</option>
                  <option value="google">Google</option>
                  <option value="microsoft">Microsoft</option>
                  <option value="slack">Slack</option>
                  <option value="manual">Manual</option>
                </select>
                <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}>
                  <option value="all">All urgency</option>
                  <option value="urgent">Urgent</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search inbox" />
              </div>
              <div className="chip-row">
                <button className={`chip-button${actionOnly ? ' active' : ''}`} onClick={() => setActionOnly((value) => !value)}>
                  Action needed
                </button>
                <button className={`chip-button${linkedOnly ? ' active' : ''}`} onClick={() => setLinkedOnly((value) => !value)}>
                  Linked only
                </button>
                <button className={`chip-button${showNoise ? ' active' : ''}`} onClick={() => setShowNoise((value) => !value)}>
                  Show noisy/hidden
                </button>
              </div>
            </CollapsiblePanel>

            <div className="stack-gap">
              {filtered.length ? (
                lanes.map((lane) => (
                  <SectionBlock
                    key={lane.key}
                    title={`${lane.title} (${lane.items.length})`}
                    collapsible
                    storageKey={`inbox-lane-${lane.key}`}
                    defaultExpanded={lane.defaultExpanded}
                  >
                    {lane.items.length ? (
                      lane.items.map((source) => {
                        const client = findClient(props.bootstrap.registry.clients, source.clientId);
                        const project = findProject(props.bootstrap.registry.projects, source.projectId);
                        return (
                          <button
                            key={sourceRecordKey(source)}
                            className={`record-card${selectedId === sourceRecordKey(source) ? ' selected' : ''}`}
                            onClick={() => setSelectedId(sourceRecordKey(source))}
                          >
                            <div className="record-card-top">
                              <strong>{source.title}</strong>
                              <span className="record-time">{formatShortDate(source.occurredAt)}</span>
                            </div>
                            <RecordMeta
                              provider={source.provider}
                              accountLabel={sourceAccountLabel(source)}
                              client={client}
                              project={project}
                              priority={source.priority}
                              status={
                                sourceLooksNoisy(source)
                                  ? 'hidden'
                                  : sourceNeedsReview(source)
                                    ? 'needs review'
                                    : sourceNeedsAction(source)
                                      ? 'action needed'
                                      : source.status
                              }
                              attributionDiagnostics={sourceAttributionDiagnostics(source)}
                            />
                            {sourceMailboxLine(source) ? (
                              <p className="record-submeta">{sourceMailboxLine(source)}</p>
                            ) : null}
                            {sourceWorkspaceLine(source) ? (
                              <p className="record-submeta">{sourceWorkspaceLine(source)}</p>
                            ) : null}
                            {sourceThreadLine(source) ? (
                              <p className="record-submeta">{sourceThreadLine(source)}</p>
                            ) : null}
                            <p>{source.summary || sourceAttentionState(source).importanceReason || 'No preview available.'}</p>
                          </button>
                        );
                      })
                    ) : (
                      <EmptyState title={`No ${lane.title.toLowerCase()} items`} body="Nothing currently falls into this lane." />
                    )}
                  </SectionBlock>
                ))
              ) : (
                <EmptyState title="No matching inbox items" body="Adjust the filters or wait for the next sync." />
              )}
            </div>
          </Fragment>
        }
        detail={
          selected ? (
            <SourceInspector
              source={selected}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
              coachQuestion={selectedInboxQuestion}
              onMutated={() => invalidateOps(queryClient)}
            />
          ) : (
            <EmptyState title="Select an inbox item" body="Open an email to inspect why it surfaced and correct it inline." />
          )
        }
      />
    </ScreenFrame>
  );
}

function CalendarPage(props: { bootstrap: AppBootstrap }) {
  const queryClient = useQueryClient();
  const interval = useOpsInterval(props.bootstrap);
  const calendarQuery = useQuery({
    queryKey: ['calendar'],
    queryFn: api.getCalendar,
    refetchInterval: interval,
  });
  const events = calendarQuery.data?.calendar || [];
  const [selectedId, setSelectedId] = useStableSelectedId(events, sourceRecordKey);
  const selected = events.find((item) => sourceRecordKey(item) === selectedId) || null;
  const selectedCalendarQuestionQuery = useQuery({
    queryKey: ['questions', 'today', 'inline', 'calendar', selectedId || 'none'],
    queryFn: () =>
      api.getQuestions({
        surface: 'today',
        urgency: 'inline',
        targetType: 'calendar_event',
        targetId: selectedId!,
      }),
    refetchInterval: interval,
    enabled: Boolean(selectedId),
  });
  const selectedCalendarQuestion =
    selectedCalendarQuestionQuery.data?.questions?.[0] || null;
  const grouped = useMemo(() => {
    const map = new Map<string, SourceRecord[]>();
    events.forEach((event) => {
      const key = dayKey(event.occurredAt);
      const bucket = map.get(key) || [];
      bucket.push(event);
      map.set(key, bucket);
    });
    return [...map.entries()];
  }, [events]);

  return (
    <ScreenFrame title="Calendar" subtitle="Upcoming meetings with linked context and prep cues.">
      <DetailScaffold
        list={
          <div className="stack-gap">
            {grouped.length ? (
              grouped.map(([label, bucket]) => (
                <SectionBlock
                  key={label}
                  title={label}
                  collapsible
                  storageKey={`calendar-${label}`}
                  defaultExpanded={true}
                >
                  {bucket.map((event) => (
                    <button
                      key={sourceRecordKey(event)}
                      className={`record-card${selectedId === sourceRecordKey(event) ? ' selected' : ''}`}
                      onClick={() => setSelectedId(sourceRecordKey(event))}
                    >
                      <div className="record-card-top">
                        <strong>{event.title}</strong>
                        <span className="record-time">{formatShortDate(event.occurredAt)}</span>
                      </div>
                      <RecordMeta
                        provider={event.provider}
                        accountLabel={sourceAccountLabel(event)}
                        priority={event.priority}
                        status={event.status}
                        attributionDiagnostics={sourceAttributionDiagnostics(event)}
                      />
                      {sourceCalendarLine(event) ? (
                        <p className="record-submeta">{sourceCalendarLine(event)}</p>
                      ) : null}
                      {sourceWorkspaceLine(event) ? (
                        <p className="record-submeta">{sourceWorkspaceLine(event)}</p>
                      ) : null}
                      <p>{event.summary || 'No prep notes available.'}</p>
                    </button>
                  ))}
                </SectionBlock>
              ))
            ) : (
              <EmptyState title="No upcoming events" body="Calendar sync has not surfaced anything in the next week." />
            )}
          </div>
        }
        detail={
          selected ? (
            <SourceInspector
              source={selected}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
              coachQuestion={selectedCalendarQuestion}
              onMutated={() => invalidateOps(queryClient)}
            />
          ) : (
            <EmptyState title="Select a meeting" body="Choose a meeting to inspect context and fix client/project attribution." />
          )
        }
      />
    </ScreenFrame>
  );
}

function WorkboardPage(props: { bootstrap: AppBootstrap }) {
  const queryClient = useQueryClient();
  const interval = useOpsInterval(props.bootstrap);
  const workboardQuery = useQuery({
    queryKey: ['workboard'],
    queryFn: api.getWorkboard,
    refetchInterval: interval,
  });
  const workQuestionsQuery = useQuery({
    queryKey: ['questions', 'work', 'inline'],
    queryFn: () => api.getQuestions({ surface: 'work', urgency: 'inline' }),
    refetchInterval: interval,
  });
  const buckets = workboardQuery.data?.workboard || [];
  const allItems = buckets.flatMap((bucket) => bucket.items);
  const [selectedId, setSelectedId] = useStableSelectedId(allItems, (item) => item.id);
  const selected = allItems.find((item) => item.id === selectedId) || null;
  const selectedStream = buckets.find((bucket) => bucket.items.some((item) => item.id === selectedId)) || buckets[0] || null;
  const [autoFocusedQuestionId, setAutoFocusedQuestionId] = useState<string | null>(null);
  const selectedWorkQuestionQuery = useQuery({
    queryKey: ['questions', 'work', 'inline', selectedId || 'none'],
    queryFn: () =>
      api.getQuestions({
        surface: 'work',
        urgency: 'inline',
        targetType: 'work_item',
        targetId: selectedId!,
      }),
    refetchInterval: interval,
    enabled: Boolean(selectedId),
  });
  const selectedWorkQuestion = selectedWorkQuestionQuery.data?.questions?.[0] || null;

  useEffect(() => {
    const question = workQuestionsQuery.data?.questions?.[0];
    if (!question?.id || !question.targetId || autoFocusedQuestionId === question.id) return;
    if (!allItems.some((item) => item.id === question.targetId)) {
      setAutoFocusedQuestionId(question.id);
      return;
    }
    setSelectedId(question.targetId);
    setAutoFocusedQuestionId(question.id);
  }, [allItems, autoFocusedQuestionId, setSelectedId, workQuestionsQuery.data?.questions]);

  return (
    <ScreenFrame title="Workboard" subtitle="Track execution by client and project instead of by source system.">
      <DetailScaffold
        list={
          <div className="stack-gap">
            {buckets.length ? (
              buckets.map((bucket) => (
                <CollapsiblePanel
                  key={bucket.key}
                  storageKey={`workboard-${bucket.key}`}
                  eyebrow={bucket.client?.name || 'Unassigned client'}
                  title={bucket.project?.name || 'General work'}
                  subtitle={`${bucket.items.length} open item${bucket.items.length === 1 ? '' : 's'} • ${bucket.sourceRecords.length} source signal${bucket.sourceRecords.length === 1 ? '' : 's'}`}
                  defaultExpanded={true}
                  className="bucket-card"
                  actions={
                    <div className="chip-row compact">
                      {bucket.blockerCount ? <span className="chip danger">{bucket.blockerCount} blocker{bucket.blockerCount === 1 ? '' : 's'}</span> : null}
                      {bucket.waitingCount ? <span className="chip">{bucket.waitingCount} waiting</span> : null}
                      {bucket.needsReviewCount ? <span className="chip warning">{bucket.needsReviewCount} review</span> : null}
                      {bucket.openLoopCount ? <span className="chip">{bucket.openLoopCount} open loop{bucket.openLoopCount === 1 ? '' : 's'}</span> : null}
                      <span className="chip">{formatShortDate(bucket.lastUpdatedAt)}</span>
                    </div>
                  }
                >
                  <div className="stack-gap compact">
                    {bucket.signals.length ? (
                      <div className="activity-strip">
                        {bucket.signals.map((signal) => (
                          <span key={signal} className="activity-chip">
                            {signal}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {bucket.items.map((item) => (
                      <button
                        key={item.id}
                        className={`record-card compact${selectedId === item.id ? ' selected' : ''}`}
                        onClick={() => setSelectedId(item.id)}
                      >
                        <div className="record-card-top">
                          <strong>{item.title}</strong>
                          <StatusPill tone={item.needsReview ? 'warning' : statusTone(item.status)} label={item.needsReview ? 'needs review' : item.status.replace('_', ' ')} />
                        </div>
                        <p>{item.notes || 'No notes available.'}</p>
                      </button>
                    ))}
                    {bucket.sourceRecords.length ? (
                      <div className="stack-gap compact">
                        {bucket.sourceRecords.slice(0, 4).map((source) => (
                          <div key={sourceRecordKey(source)} className="mini-list-item">
                            <strong>{source.title}</strong>
                            <span>{providerLabel(source.provider)} • {formatShortDate(source.occurredAt)}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {bucket.recentActivity.length ? (
                      <div className="activity-strip">
                        {bucket.recentActivity.map((activity) => (
                          <span key={activity.id} className="activity-chip">
                            {activity.summary}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {bucket.repositories.length ? (
                      <div className="activity-strip">
                        {bucket.repositories.map((repository) => (
                          <span key={repository.id} className="activity-chip">
                            {repository.name}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {bucket.linkedContacts.length ? (
                      <div className="activity-strip">
                        {bucket.linkedContacts.map((contact) => (
                          <span key={contact.id} className="activity-chip">
                            {contact.name}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </CollapsiblePanel>
              ))
            ) : (
              <EmptyState title="No active workboard buckets" body="Once mail, calendar, or Jira items are linked, they will appear here." />
            )}
          </div>
        }
        detail={
          selected ? (
            <WorkItemInspector
              item={selected}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
              coachQuestion={selectedWorkQuestion}
              onMutated={() => invalidateOps(queryClient)}
            />
          ) : selectedStream ? (
            <WorkstreamInspector stream={selectedStream} />
          ) : (
            <EmptyState title="Select a work item" body="Choose an item to change status, priority, or attribution." />
          )
        }
      />
    </ScreenFrame>
  );
}

function HistoryPage(props: { bootstrap: AppBootstrap }) {
  const interval = useOpsInterval(props.bootstrap);
  const [windowDays, setWindowDays] = useState('7');
  const historyQuery = useQuery({
    queryKey: ['history', windowDays],
    queryFn: () =>
      api.getHistory({
        since: new Date(Date.now() - Number(windowDays) * 24 * 60 * 60 * 1000).toISOString(),
      }),
    refetchInterval: interval,
  });
  const activities = historyQuery.data?.history || [];
  const workstreams = historyQuery.data?.workstreams || [];
  const [selectedId, setSelectedId] = useStableSelectedId(activities, (activity) => activity.id);
  const selected = activities.find((entry) => entry.id === selectedId) || null;

  return (
    <ScreenFrame title="History" subtitle="Reconstruct what changed by source, time, client, and project.">
      <DetailScaffold
        list={
          <Fragment>
            <CollapsiblePanel
              storageKey="history-filters"
              title="History range"
              subtitle="Change the reconstruction window without keeping controls open."
              defaultExpanded={false}
              className="toolbar-card"
            >
              <div className="filter-row">
                <select value={windowDays} onChange={(event) => setWindowDays(event.target.value)}>
                  <option value="1">Past day</option>
                  <option value="3">Past 3 days</option>
                  <option value="7">Past 7 days</option>
                  <option value="14">Past 14 days</option>
                </select>
              </div>
            </CollapsiblePanel>
            <CollapsiblePanel
              storageKey="history-workstreams"
              title="Workstreams touched"
              subtitle="Correlated client/project lanes that moved during this window."
              defaultExpanded={true}
              className="toolbar-card"
            >
              {workstreams.length ? (
                <div className="stack-gap compact">
                  {workstreams.map((stream) => (
                    <div key={stream.key} className="record-card compact static-card">
                      <div className="record-card-top">
                        <strong>{workstreamLabel(stream)}</strong>
                        <span className="record-time">{formatShortDate(stream.lastUpdatedAt)}</span>
                      </div>
                      <p>{stream.signals.join(' • ') || 'Tracked activity in this window.'}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title="No workstreams moved" body="Nothing grouped into a client/project lane during this range." />
              )}
            </CollapsiblePanel>
            <div className="stack-gap">
              {activities.length ? (
                activities.map((activity) => {
                  const client = findClient(props.bootstrap.registry.clients, activity.relatedClientId);
                  const project = findProject(props.bootstrap.registry.projects, activity.relatedProjectId);
                  return (
                    <button
                      key={activity.id}
                      className={`record-card${selectedId === activity.id ? ' selected' : ''}`}
                      onClick={() => setSelectedId(activity.id)}
                    >
                      <div className="record-card-top">
                        <strong>{activity.summary}</strong>
                        <span className="record-time">{formatShortDate(activity.timestamp)}</span>
                      </div>
                      <RecordMeta
                        provider={activity.sourceProvider}
                        client={client}
                        project={project}
                        status={activity.type}
                      />
                    </button>
                  );
                })
              ) : (
                <EmptyState title="No history for that range" body="Try widening the window or waiting for more activity to sync." />
              )}
            </div>
          </Fragment>
        }
        detail={
          selected ? (
            <ActivityInspector
              activity={selected}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
            />
          ) : (
            <EmptyState title="Select a history item" body="Inspect activity context and source traceability here." />
          )
        }
      />
    </ScreenFrame>
  );
}

function ReportsPage() {
  const queryClient = useQueryClient();
  const reportsQueries = useQueries({
    queries: REPORT_TYPES.map((type) => ({
      queryKey: ['reports', type],
      queryFn: () => api.getReport(type),
      refetchInterval: OPS_INTERVAL_IDLE,
    })),
  });
  const [selected, setSelected] = useState<'morning' | 'standup' | 'wrap'>('morning');
  const reportIndex = REPORT_TYPES.indexOf(selected);
  const report = reportsQueries[reportIndex]?.data?.report || null;
  const regenerate = useMutation({
    mutationFn: (type: 'morning' | 'standup' | 'wrap') => api.generateReport(type),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
      await queryClient.invalidateQueries({ queryKey: ['today'] });
      await queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
    },
  });

  return (
    <ScreenFrame title="Reports" subtitle="Readable summaries with source references and one-click regeneration.">
      <div className="report-layout">
        <div className="report-tabs">
          {REPORT_TYPES.map((type, index) => {
            const entry = reportsQueries[index]?.data?.report || null;
            return (
              <button
                key={type}
                className={`report-tab${selected === type ? ' active' : ''}`}
                onClick={() => setSelected(type)}
              >
                <strong>{type}</strong>
                <span>{entry ? formatShortDate(entry.generatedAt) : 'Not generated yet'}</span>
              </button>
            );
          })}
        </div>
        <div className="panel-card report-card">
          <div className="panel-topline">
            <div>
              <div className="eyebrow">Report detail</div>
              <h4>{selected}</h4>
            </div>
            <button
              className="primary-button"
              onClick={() => regenerate.mutate(selected)}
              disabled={regenerate.isPending}
            >
              {regenerate.isPending ? 'Regenerating…' : 'Regenerate'}
            </button>
          </div>
          {report ? (
            <Fragment>
              <RecordMeta status={report.model} />
              <MarkdownContent content={report.groupedOutput} className="report-markdown" />
              <div className="reason-list">
                {report.sourceReferences.map((reference) => (
                  <span key={reference} className="reason-chip">
                    {reference}
                  </span>
                ))}
              </div>
            </Fragment>
          ) : (
            <EmptyState title="No report yet" body="Generate this report once data is available." />
          )}
        </div>
      </div>
    </ScreenFrame>
  );
}

function ApprovalQueueInspector(props: {
  item: ApprovalQueueItem;
  clients: Client[];
  projects: Project[];
  onMutated: () => Promise<void>;
}) {
  const [title, setTitle] = useState(props.item.title);
  const [summary, setSummary] = useState(props.item.summary);
  const [body, setBody] = useState(props.item.body);
  const [reason, setReason] = useState(props.item.reason);
  const queryClient = useQueryClient();

  useEffect(() => {
    setTitle(props.item.title);
    setSummary(props.item.summary);
    setBody(props.item.body);
    setReason(props.item.reason);
  }, [props.item]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.editQueueItem(props.item.id, {
        title,
        summary,
        body,
        reason,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['queue'] });
      await queryClient.invalidateQueries({ queryKey: ['today'] });
      await queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
      await props.onMutated();
    },
  });
  const approveMutation = useMutation({
    mutationFn: () => api.approveQueueItem(props.item.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['queue'] });
      await queryClient.invalidateQueries({ queryKey: ['today'] });
      await queryClient.invalidateQueries({ queryKey: ['workboard'] });
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
      await queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
      await props.onMutated();
    },
  });
  const rejectMutation = useMutation({
    mutationFn: () => api.rejectQueueItem(props.item.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['queue'] });
      await queryClient.invalidateQueries({ queryKey: ['today'] });
      await queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
      await props.onMutated();
    },
  });

  const client = findClient(props.clients, props.item.clientId);
  const project = findProject(props.projects, props.item.projectId);

  return (
    <div className="inspector-stack">
      <div className="panel-card">
        <div className="eyebrow">Approval item</div>
        <h4>{props.item.title}</h4>
        <RecordMeta client={client} project={project} status={props.item.kind.replace(/_/g, ' ')} />
        <p className="detail-copy">{props.item.reason}</p>
        <dl className="detail-grid">
          <div>
            <dt>Confidence</dt>
            <dd>{props.item.confidence?.toFixed(2) || 'n/a'}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{props.item.status}</dd>
          </div>
          <div>
            <dt>Evidence</dt>
            <dd>{props.item.evidence.length ? props.item.evidence.length : 'n/a'}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatDateTime(props.item.updatedAt)}</dd>
          </div>
        </dl>
        {props.item.evidence.length ? (
          <div className="reason-list">
            {props.item.evidence.map((evidence) => (
              <span key={evidence} className="reason-chip">
                {evidence}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="panel-card">
        <div className="eyebrow">Draft content</div>
        <div className="field-grid">
          <label className="field-span-2">
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="field-span-2">
            Summary
            <textarea value={summary} onChange={(event) => setSummary(event.target.value)} />
          </label>
          <label className="field-span-2">
            Reason
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
        </div>
        <label className="field-span-2">
          Draft body
          <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={14} />
        </label>
        <div className="button-row wrap">
          <button className="secondary-button" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving…' : 'Save draft'}
          </button>
          <button className="primary-button" onClick={() => approveMutation.mutate()} disabled={approveMutation.isPending || rejectMutation.isPending}>
            {approveMutation.isPending ? 'Approving…' : 'Approve'}
          </button>
          <button className="secondary-button" onClick={() => rejectMutation.mutate()} disabled={approveMutation.isPending || rejectMutation.isPending}>
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

function QueuePage(props: { bootstrap: AppBootstrap }) {
  const queryClient = useQueryClient();
  const interval = useOpsInterval(props.bootstrap);
  const queueQuery = useQuery({
    queryKey: ['queue'],
    queryFn: api.getQueue,
    refetchInterval: interval,
  });
  const queue = queueQuery.data?.queue || [];
  const [selectedId, setSelectedId] = useStableSelectedId(queue, (item) => item.id);
  const selected = queue.find((item) => item.id === selectedId) || null;

  return (
    <ScreenFrame title="Queue" subtitle="Drafts and proposed actions stay here until you approve or reject them.">
      <DetailScaffold
        list={
          <SectionBlock title={`Pending approvals (${queue.length})`} collapsible storageKey="approval-queue" defaultExpanded={true}>
            {queue.length ? (
              queue.map((item) => (
                <button
                  key={item.id}
                  className={`record-card${selectedId === item.id ? ' selected' : ''}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <div className="record-card-top">
                    <strong>{item.title}</strong>
                    <StatusPill tone="warning" label={item.kind.replace(/_/g, ' ')} />
                  </div>
                  <p className="record-submeta">{item.reason}</p>
                  <p>{item.summary}</p>
                </button>
              ))
            ) : (
              <EmptyState title="Queue is clear" body="No reply drafts, follow-up proposals, or prep drafts are waiting right now." />
            )}
          </SectionBlock>
        }
        detail={
          selected ? (
            <ApprovalQueueInspector
              item={selected}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
              onMutated={() => invalidateOps(queryClient)}
            />
          ) : (
            <EmptyState title="Select a queued action" body="Review the draft, adjust it, then approve or reject it." />
          )
        }
      />
    </ScreenFrame>
  );
}

function ReviewItemInspector(props: {
  item: ReviewQueueItem;
  clients: Client[];
  projects: Project[];
  onAccept: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const client = findClient(props.clients, props.item.clientId);
  const project = findProject(props.projects, props.item.projectId);
  return (
    <div className="inspector-stack">
      <div className="panel-card">
        <div className="eyebrow">Review item</div>
        <h4>{props.item.title}</h4>
        <RecordMeta
          client={client}
          project={project}
          status={props.item.kind}
        />
        <p className="detail-copy">{props.item.summary}</p>
        <dl className="detail-grid">
          <div>
            <dt>Confidence</dt>
            <dd>{props.item.confidence?.toFixed(2) || 'n/a'}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{props.item.status}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatDateTime(props.item.updatedAt)}</dd>
          </div>
          <div>
            <dt>Linked source</dt>
            <dd>{props.item.sourceRecordKey || props.item.workItemId || props.item.contactId || 'n/a'}</dd>
          </div>
        </dl>
        {props.item.reasons.length ? (
          <div className="reason-list">
            {props.item.reasons.map((reason) => (
              <span key={reason} className="reason-chip">
                {reason}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="panel-card">
        <div className="eyebrow">Resolution</div>
        <div className="button-row wrap">
          <button className="primary-button" onClick={props.onAccept} disabled={props.busy}>
            {props.busy ? 'Saving…' : 'Accept'}
          </button>
          <button className="secondary-button" onClick={props.onReject} disabled={props.busy}>
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewPage(props: { bootstrap: AppBootstrap }) {
  const queryClient = useQueryClient();
  const interval = useOpsInterval(props.bootstrap);
  const reviewQuery = useQuery({
    queryKey: ['review'],
    queryFn: api.getReview,
    refetchInterval: interval,
  });
  const contactsQuery = useQuery({
    queryKey: ['contacts'],
    queryFn: api.getContacts,
    refetchInterval: OPS_INTERVAL_IDLE,
  });
  const memoryQuery = useQuery({
    queryKey: ['memory'],
    queryFn: api.getMemory,
    refetchInterval: OPS_INTERVAL_IDLE,
  });
  const review = reviewQuery.data?.review || [];
  const contacts = contactsQuery.data?.contacts || [];
  const operatorProfile = contactsQuery.data?.operatorProfile;
  const memory = memoryQuery.data?.memory || [];
  const [profileDraft, setProfileDraft] = useState<OperatorProfile | null>(null);

  useEffect(() => {
    if (operatorProfile) {
      setProfileDraft(operatorProfile);
    }
  }, [operatorProfile]);

  const [selectedId, setSelectedId] = useStableSelectedId(review, (item) => item.id);
  const selected = review.find((item) => item.id === selectedId) || null;

  const acceptMutation = useMutation({
    mutationFn: (id: string) => api.acceptReview(id),
    onSuccess: async () => {
      await invalidateOps(queryClient);
      await queryClient.invalidateQueries({ queryKey: ['review'] });
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
    },
  });
  const rejectMutation = useMutation({
    mutationFn: (id: string) => api.rejectReview(id),
    onSuccess: async () => {
      await invalidateOps(queryClient);
      await queryClient.invalidateQueries({ queryKey: ['review'] });
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
    },
  });
  const saveProfileMutation = useMutation({
    mutationFn: (input: Partial<OperatorProfile>) => api.updateOperatorProfile(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
      await queryClient.invalidateQueries({ queryKey: ['today'] });
      await queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
    },
  });
  const acceptMemoryMutation = useMutation({
    mutationFn: (id: string) => api.acceptMemoryFact(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
      await queryClient.invalidateQueries({ queryKey: ['review'] });
      await queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
  const rejectMemoryMutation = useMutation({
    mutationFn: (id: string) => api.rejectMemoryFact(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
      await queryClient.invalidateQueries({ queryKey: ['review'] });
      await queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });

  return (
    <ScreenFrame title="Review" subtitle="Confirm durable memory, low-confidence inferences, and operator context.">
      <DetailScaffold
        list={
          <div className="stack-gap">
            <CollapsiblePanel
              storageKey="review-operator-profile"
              title="Operator profile"
              subtitle="Soft context the assistant should keep in mind while it triages and drafts."
              defaultExpanded={true}
            >
              {profileDraft ? (
                <div className="field-grid">
                  <label className="field-span-2">
                    Role summary
                    <textarea
                      value={profileDraft.roleSummary}
                      onChange={(event) =>
                        setProfileDraft({ ...profileDraft, roleSummary: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Work hours start
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={profileDraft.workHoursStart}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          workHoursStart: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    Work hours end
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={profileDraft.workHoursEnd}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          workHoursEnd: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="field-span-2">
                    Reporting preferences
                    <textarea
                      value={profileDraft.reportingPreferences}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          reportingPreferences: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="field-span-2">
                    Escalation preferences
                    <textarea
                      value={profileDraft.escalationPreferences}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          escalationPreferences: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="field-span-2">
                    Assistant style
                    <textarea
                      value={profileDraft.assistantStyle}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          assistantStyle: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
              ) : (
                <EmptyState title="Loading profile" body="Operator guidance is loading." />
              )}
              {profileDraft ? (
                <div className="button-row">
                  <button
                    className="primary-button"
                    onClick={() => saveProfileMutation.mutate(profileDraft)}
                    disabled={saveProfileMutation.isPending}
                  >
                    {saveProfileMutation.isPending ? 'Saving…' : 'Save operator profile'}
                  </button>
                </div>
              ) : null}
            </CollapsiblePanel>

            <CollapsiblePanel
              storageKey="review-contact-memory"
              title="Contact memory"
              subtitle="Frequently seen people and the client/project context they currently imply."
              defaultExpanded={false}
            >
              {contacts.length ? (
                <div className="stack-gap compact">
                  {contacts.slice(0, 16).map((contact) => {
                    const client = findClient(props.bootstrap.registry.clients, contact.defaultClientId);
                    const project = findProject(props.bootstrap.registry.projects, contact.defaultProjectId);
                    return (
                      <div key={contact.id} className="record-card compact static-card">
                        <div className="record-card-top">
                          <strong>{contact.name}</strong>
                          <span className="record-time">{contact.importance}</span>
                        </div>
                        <p className="record-submeta">
                          {[client?.name, project?.name, contact.likelyRole, contact.organizationHint]
                            .filter(Boolean)
                            .join(' • ') || 'No default mapping yet'}
                        </p>
                        <p>{contact.notes || `Seen ${contact.sourceCount} time${contact.sourceCount === 1 ? '' : 's'}`}</p>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyState title="No contacts yet" body="Contacts will accumulate from participants across mail, Slack, and calendar." />
              )}
            </CollapsiblePanel>

            <CollapsiblePanel
              storageKey="review-memory-facts"
              title="Durable memory"
              subtitle="Safe facts and suggested mappings that now shape triage and drafting."
              defaultExpanded={false}
            >
              {memory.length ? (
                <div className="stack-gap compact">
                  {memory.slice(0, 24).map((fact) => (
                    <div key={fact.id} className="record-card compact static-card">
                      <div className="record-card-top">
                        <strong>{fact.label}</strong>
                        <StatusPill
                          tone={fact.status === 'suggested' ? 'warning' : 'success'}
                          label={fact.status}
                        />
                      </div>
                      <p className="record-submeta">
                        {fact.kind.replace(/_/g, ' ')} • confidence {fact.confidence.toFixed(2)}
                      </p>
                      {fact.provenance.length ? (
                        <div className="reason-list">
                          {fact.provenance.map((reason) => (
                            <span key={reason} className="reason-chip">
                              {reason}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {fact.status === 'suggested' ? (
                        <div className="button-row wrap">
                          <button
                            className="primary-button"
                            onClick={() => acceptMemoryMutation.mutate(fact.id)}
                            disabled={acceptMemoryMutation.isPending || rejectMemoryMutation.isPending}
                          >
                            Accept
                          </button>
                          <button
                            className="secondary-button"
                            onClick={() => rejectMemoryMutation.mutate(fact.id)}
                            disabled={acceptMemoryMutation.isPending || rejectMemoryMutation.isPending}
                          >
                            Reject
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title="No durable memory yet" body="Accepted mappings and stable contact context will accumulate here." />
              )}
            </CollapsiblePanel>

            <SectionBlock title={`Needs review (${review.length})`} collapsible storageKey="review-queue" defaultExpanded={true}>
              {review.length ? (
                review.map((item) => (
                  <button
                    key={item.id}
                    className={`record-card${selectedId === item.id ? ' selected' : ''}`}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <div className="record-card-top">
                      <strong>{item.title}</strong>
                      <StatusPill tone="warning" label={item.kind.replace('_', ' ')} />
                    </div>
                    <p className="record-submeta">
                      {item.summary}
                    </p>
                    <div className="reason-list">
                      {item.reasons.slice(0, 3).map((reason) => (
                        <span key={reason} className="reason-chip">
                          {reason}
                        </span>
                      ))}
                    </div>
                  </button>
                ))
              ) : (
                <EmptyState title="Review queue is clear" body="No low-confidence memory or task suggestions are waiting for confirmation." />
              )}
            </SectionBlock>
          </div>
        }
        detail={
          selected ? (
            <ReviewItemInspector
              item={selected}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
              onAccept={() => acceptMutation.mutate(selected.id)}
              onReject={() => rejectMutation.mutate(selected.id)}
              busy={acceptMutation.isPending || rejectMutation.isPending}
            />
          ) : (
            <EmptyState title="Select a review item" body="Choose a suggestion or low-confidence item to confirm or reject it." />
          )
        }
      />
    </ScreenFrame>
  );
}

function ClientRegistryCard(props: {
  client: Client;
  clients: Client[];
  projectsByClient: Map<string, Project[]>;
  repositoriesByClient: Map<string, GitRepository[]>;
  repositoriesByProject: Map<string, GitRepository[]>;
  expandedState: Record<string, boolean>;
  onToggleExpanded: (clientId: string) => void;
  depth?: number;
  onSaved: (message: string) => Promise<void>;
}) {
  const depth = props.depth || 0;
  const [editing, setEditing] = useState(false);
  const [parentClientId, setParentClientId] = useState(props.client.parentClientId || '');
  const [status, setStatus] = useState<Client['status']>(props.client.status);
  const [rolesText, setRolesText] = useState(props.client.roles.join(', '));
  const [notesText, setNotesText] = useState(props.client.notes);

  useEffect(() => {
    setParentClientId(props.client.parentClientId || '');
    setStatus(props.client.status);
    setRolesText(props.client.roles.join(', '));
    setNotesText(props.client.notes);
  }, [props.client]);

  const parent = findClient(props.clients, props.client.parentClientId);
  const childProjects = props.projectsByClient.get(props.client.id) || [];
  const clientRepositories = props.repositoriesByClient.get(props.client.id) || [];
  const childClients = props.clients.filter((client) => client.parentClientId === props.client.id);
  const isExpanded = props.expandedState[props.client.id] ?? depth === 0;
  const notesPreview = props.client.notes.trim()
    ? props.client.notes.trim().slice(0, 180) +
      (props.client.notes.trim().length > 180 ? '…' : '')
    : 'No client notes yet.';

  return (
    <div className={`record-card compact static registry-client-card depth-${depth}`}>
      <div className="record-card-top registry-card-head">
        <div className="stack-gap compact">
          <strong>{props.client.name}</strong>
          <div className="chip-row">
            <span className={`chip tone-${statusTone(props.client.status)}`}>{props.client.status}</span>
            {parent ? <span className="chip">child of {parent.name}</span> : null}
            <span className="chip">
              {childProjects.length} project{childProjects.length === 1 ? '' : 's'}
            </span>
            {childClients.length ? (
              <span className="chip">
                {childClients.length} subclient{childClients.length === 1 ? '' : 's'}
              </span>
            ) : null}
            {clientRepositories.length ? (
              <span className="chip">
                {clientRepositories.length} repo{clientRepositories.length === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
        </div>
        <div className="button-row no-margin">
          <button
            className="chip-button"
            onClick={() => props.onToggleExpanded(props.client.id)}
          >
            {isExpanded ? 'Collapse' : 'Expand'}
          </button>
          <button
            className="chip-button"
            onClick={() => setEditing((current) => !current)}
          >
            {editing ? 'Close editor' : 'Edit client'}
          </button>
        </div>
      </div>
      {isExpanded ? (
        <>
          <p className="detail-copy registry-notes">{notesPreview}</p>
          {props.client.roles.length ? (
            <div className="reason-list">
              {props.client.roles.map((role) => (
                <span key={role} className="reason-chip">
                  {role}
                </span>
              ))}
            </div>
          ) : null}
          {clientRepositories.length ? (
            <div className="registry-project-list">
              {clientRepositories.map((repository) => (
                <RepositoryRegistryCard
                  key={repository.id}
                  repository={repository}
                  clients={props.clients}
                  projects={childProjects}
                  onSaved={props.onSaved}
                />
              ))}
            </div>
          ) : null}
          {childProjects.length ? (
            <div className="registry-project-list">
              {childProjects.map((project) => (
                <ProjectRegistryCard
                  key={project.id}
                  project={project}
                  clients={props.clients}
                  availableProjects={childProjects}
                  repositories={props.repositoriesByProject.get(project.id) || []}
                  onSaved={props.onSaved}
                />
              ))}
            </div>
          ) : (
            <p className="detail-copy">
              {clientRepositories.length ? 'No projects assigned yet.' : 'No projects or repositories assigned yet.'}
            </p>
          )}
          {editing ? (
            <div className="registry-editor">
              <div className="field-grid">
                <label>
                  Parent client
                  <select value={parentClientId} onChange={(event) => setParentClientId(event.target.value)}>
                    <option value="">Top-level client</option>
                    {props.clients
                      .filter((entry) => entry.id !== props.client.id)
                      .map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Status
                  <select value={status} onChange={(event) => setStatus(event.target.value as Client['status'])}>
                    <option value="active">Active</option>
                    <option value="prospect">Prospect</option>
                    <option value="on_hold">On hold</option>
                    <option value="archived">Archived</option>
                  </select>
                </label>
                <label>
                  Roles
                  <input
                    value={rolesText}
                    onChange={(event) => setRolesText(event.target.value)}
                    placeholder="CTO, Main Developer"
                  />
                </label>
                <label className="field-span-2">
                  Notes
                  <textarea
                    value={notesText}
                    onChange={(event) => setNotesText(event.target.value)}
                    placeholder="Engagement summary or context"
                  />
                </label>
              </div>
              <div className="button-row">
                <button
                  className="secondary-button"
                  onClick={async () => {
                    await api.createClient({
                      id: props.client.id,
                      name: props.client.name,
                      parentClientId: parentClientId || undefined,
                      roles: splitDelimitedValues(rolesText),
                      status,
                      notes: notesText || undefined,
                      communicationPreferences: props.client.communicationPreferences,
                    });
                    setEditing(false);
                    await props.onSaved(`Updated ${props.client.name}.`);
                  }}
                >
                  Save client
                </button>
              </div>
            </div>
          ) : null}
          {childClients.length ? (
            <div className="registry-nested">
              {childClients.map((client) => (
                <ClientRegistryCard
                  key={client.id}
                  client={client}
                  clients={props.clients}
                  projectsByClient={props.projectsByClient}
                  repositoriesByClient={props.repositoriesByClient}
                  repositoriesByProject={props.repositoriesByProject}
                  expandedState={props.expandedState}
                  onToggleExpanded={props.onToggleExpanded}
                  depth={depth + 1}
                  onSaved={props.onSaved}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ProjectRegistryCard(props: {
  project: Project;
  clients: Client[];
  availableProjects: Project[];
  repositories: GitRepository[];
  onSaved: (message: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState(props.project.clientId || '');

  useEffect(() => {
    setClientId(props.project.clientId || '');
  }, [props.project]);

  const client = findClient(props.clients, props.project.clientId);
  return (
    <div className="subtle-card registry-project-card">
      <div className="record-card-top">
        <div className="stack-gap compact">
          <strong>{props.project.name}</strong>
          <div className="chip-row">
            <span className={`chip tone-${statusTone(props.project.status)}`}>{props.project.status}</span>
            <span className="chip">{props.project.priority}</span>
            {client ? <span className="chip">{client.name}</span> : <span className="chip">Unassigned</span>}
          </div>
        </div>
        <button
          className="chip-button"
          onClick={() => setEditing((current) => !current)}
        >
          {editing ? 'Done' : 'Edit project'}
        </button>
      </div>
      {props.project.notes ? <p className="detail-copy registry-notes">{props.project.notes}</p> : null}
      {props.repositories.length ? (
        <div className="registry-project-list">
          {props.repositories.map((repository) => (
            <RepositoryRegistryCard
              key={repository.id}
              repository={repository}
              clients={props.clients}
              projects={props.availableProjects}
              onSaved={props.onSaved}
            />
          ))}
        </div>
      ) : null}
      {editing ? (
        <div className="registry-editor">
          <label>
            Client
            <select value={clientId} onChange={(event) => setClientId(event.target.value)}>
              <option value="">Unassigned</option>
              {props.clients.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <button
              className="secondary-button"
              onClick={async () => {
                await api.createProject({
                  id: props.project.id,
                  name: props.project.name,
                  clientId: clientId || undefined,
                  notes: props.project.notes,
                  deadline: props.project.deadline || undefined,
                  tags: props.project.tags.join(','),
                });
                setEditing(false);
                await props.onSaved(`Updated ${props.project.name}.`);
              }}
            >
              Save project
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RepositoryRegistryCard(props: {
  repository: GitRepository;
  clients: Client[];
  projects: Project[];
  onSaved: (message: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(props.repository.name);
  const [localPath, setLocalPath] = useState(props.repository.localPath);
  const [clientId, setClientId] = useState(props.repository.clientId || '');
  const [projectId, setProjectId] = useState(props.repository.projectId || '');
  const [notes, setNotes] = useState(props.repository.notes);

  useEffect(() => {
    setName(props.repository.name);
    setLocalPath(props.repository.localPath);
    setClientId(props.repository.clientId || '');
    setProjectId(props.repository.projectId || '');
    setNotes(props.repository.notes);
  }, [props.repository]);

  const client = findClient(props.clients, props.repository.clientId);
  const project = findProject(props.projects, props.repository.projectId);
  const projectOptions = repositoryProjectOptions(props.projects, clientId || undefined);
  const assignmentLabel = project
    ? `${client?.name || 'Unassigned client'} / ${project.name}`
    : client
      ? client.name
      : 'Unassigned';

  return (
    <div className="subtle-card registry-project-card">
      <div className="record-card-top">
        <div className="stack-gap compact">
          <strong>{props.repository.name}</strong>
          <div className="chip-row">
            <span className="chip">repo</span>
            {client ? <span className="chip">{client.name}</span> : null}
            {project ? <span className="chip">{project.name}</span> : null}
            {props.repository.defaultBranch ? (
              <span className="chip">{props.repository.defaultBranch}</span>
            ) : null}
            {props.repository.lastCommitAt ? (
              <span className="chip">Updated {formatShortDate(props.repository.lastCommitAt)}</span>
            ) : (
              <span className="chip">No commits detected</span>
            )}
          </div>
        </div>
        <button
          className="chip-button"
          onClick={() => setEditing((current) => !current)}
        >
          {editing ? 'Done' : 'Edit repo'}
        </button>
      </div>
      <p className="detail-copy registry-assignment">
        <strong>Assigned to:</strong> {assignmentLabel}
      </p>
      <p className="detail-copy registry-notes">{props.repository.localPath}</p>
      {props.repository.remoteUrl ? (
        <p className="detail-copy registry-notes">{props.repository.remoteUrl}</p>
      ) : null}
      {props.repository.notes ? (
        <p className="detail-copy registry-notes">{props.repository.notes}</p>
      ) : null}
      {editing ? (
        <div className="registry-editor">
          <div className="field-grid">
            <label>
              Display name
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Repo name" />
            </label>
            <label>
              Local path
              <input
                value={localPath}
                onChange={(event) => setLocalPath(event.target.value)}
                placeholder="~/repos/nanoclaw"
              />
            </label>
            <label>
              Client
              <select
                value={clientId}
                onChange={(event) => {
                  const nextClientId = event.target.value;
                  setClientId(nextClientId);
                  if (
                    projectId &&
                    !repositoryProjectOptions(props.projects, nextClientId || undefined).some(
                      (entry) => entry.id === projectId,
                    )
                  ) {
                    setProjectId('');
                  }
                }}
              >
                <option value="">Unassigned</option>
                {props.clients.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Project
              <select
                value={projectId}
                onChange={(event) => {
                  const nextProjectId = event.target.value;
                  setProjectId(nextProjectId);
                  const nextProject = props.projects.find((entry) => entry.id === nextProjectId);
                  if (nextProject?.clientId) {
                    setClientId(nextProject.clientId);
                  }
                }}
              >
                <option value="">Client-level only</option>
                {projectOptions.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-span-2">
              Notes
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Why this repo matters for the engagement"
              />
            </label>
          </div>
          <div className="button-row">
            <button
              className="secondary-button"
              onClick={async () => {
                await api.createRepository({
                  id: props.repository.id,
                  name: name || undefined,
                  localPath,
                  clientId: clientId || undefined,
                  projectId: projectId || undefined,
                  notes: notes || undefined,
                });
                setEditing(false);
                await props.onSaved(`Updated ${name || props.repository.name}.`);
              }}
              disabled={!localPath.trim()}
            >
              Save repository
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConnectionsPage(props: { bootstrap: AppBootstrap }) {
  const queryClient = useQueryClient();
  const interval = useOpsInterval(props.bootstrap);
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: api.getConnections,
    refetchInterval: interval,
  });
  const correctionsQuery = useQuery({
    queryKey: ['corrections'],
    queryFn: api.getCorrections,
    refetchInterval: interval,
  });
  const connections = connectionsQuery.data?.connections || [];
  const discoverRepositories = useMutation({
    mutationFn: () => api.discoverRepositories({ rootPath: '~', maxDepth: 5 }),
    onSuccess: async (payload) => {
      await invalidateOps(queryClient);
      setFeedback(
        `Discovered ${payload.count} repos in your home directory, including Downloads.`,
      );
    },
    onError: (error) => {
      setFeedback(error instanceof Error ? error.message : String(error));
    },
  });
  const [clientName, setClientName] = useState('');
  const [clientParentId, setClientParentId] = useState('');
  const [clientStatus, setClientStatus] = useState<Client['status']>('active');
  const [clientRoles, setClientRoles] = useState('');
  const [clientNotes, setClientNotes] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectClientId, setProjectClientId] = useState('');
  const [repositoryName, setRepositoryName] = useState('');
  const [repositoryPath, setRepositoryPath] = useState('');
  const [repositoryClientId, setRepositoryClientId] = useState('');
  const [repositoryProjectId, setRepositoryProjectId] = useState('');
  const [repositoryNotes, setRepositoryNotes] = useState('');
  const [showAddClient, setShowAddClient] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showAddRepository, setShowAddRepository] = useState(false);
  const [expandedClientIds, setExpandedClientIds] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState('');
  const registryClients = correctionsQuery.data?.clients || props.bootstrap.registry.clients;
  const registryProjects = correctionsQuery.data?.projects || props.bootstrap.registry.projects;
  const registryRepositories = correctionsQuery.data?.repositories || props.bootstrap.registry.repositories;
  const providerGroups = useMemo(
    () =>
      ['google', 'microsoft', 'jira', 'slack'].map((provider) => ({
        provider: provider as 'google' | 'microsoft' | 'jira' | 'slack',
        connections: connections.filter((connection) => connection.provider === provider),
      })),
    [connections],
  );
  const projectsByClient = useMemo(() => {
    const buckets = new Map<string, Project[]>();
    registryProjects.forEach((project) => {
      const key = project.clientId || 'unassigned';
      const bucket = buckets.get(key) || [];
      bucket.push(project);
      buckets.set(key, bucket);
    });
    return buckets;
  }, [registryProjects]);
  const repositoriesByClient = useMemo(() => {
    const buckets = new Map<string, GitRepository[]>();
    registryRepositories
      .filter((repository) => repository.clientId && !repository.projectId)
      .forEach((repository) => {
        const key = repository.clientId as string;
        const bucket = buckets.get(key) || [];
        bucket.push(repository);
        buckets.set(key, bucket);
      });
    return buckets;
  }, [registryRepositories]);
  const repositoriesByProject = useMemo(() => {
    const buckets = new Map<string, GitRepository[]>();
    registryRepositories
      .filter((repository) => repository.projectId)
      .forEach((repository) => {
        const key = repository.projectId as string;
        const bucket = buckets.get(key) || [];
        bucket.push(repository);
        buckets.set(key, bucket);
      });
    return buckets;
  }, [registryRepositories]);
  const rootClients = useMemo(
    () => registryClients.filter((client) => !client.parentClientId),
    [registryClients],
  );
  const unassignedProjects = projectsByClient.get('unassigned') || [];
  const unassignedRepositories = registryRepositories.filter(
    (repository) => !repository.clientId && !repository.projectId,
  );
  const repositoryProjectChoices = repositoryProjectOptions(
    registryProjects,
    repositoryClientId || undefined,
  );
  const toggleClientExpanded = (clientId: string) => {
    setExpandedClientIds((current) => ({
      ...current,
      [clientId]: !(current[clientId] ?? rootClients.some((client) => client.id === clientId)),
    }));
  };

  const runConnectionAction = async (
    action: 'sync' | 'disconnect',
    provider: 'google' | 'microsoft' | 'jira' | 'slack',
    accountId: string,
  ) => {
    try {
      if (action === 'sync') {
        await api.syncConnection(provider, accountId);
      } else {
        await api.disconnectConnection(provider, accountId);
      }
      await invalidateOps(queryClient);
      setFeedback(`${provider} ${action} complete for ${accountId}.`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <ScreenFrame title="Connections" subtitle="Provider health, registry management, and manual corrections.">
      <div className="two-column-grid">
        <div className="stack-gap">
          {providerGroups.map((group) => (
            <CollapsiblePanel
              key={group.provider}
              storageKey={`connections-${group.provider}`}
              eyebrow={providerLabel(group.provider)}
              title={`${group.connections.filter((connection) => connection.accountId).length} connected account${group.connections.filter((connection) => connection.accountId).length === 1 ? '' : 's'}`}
              defaultExpanded={group.connections.some((connection) => connection.accountId)}
                  actions={
                    <button
                      className="secondary-button"
                      onClick={async () => {
                        const result = await api.beginOAuth(group.provider);
                        window.location.href = result.url;
                      }}
                    >
                  {group.connections.some((connection) => connection.accountId)
                    ? `Add another ${providerLabel(group.provider)} account`
                    : `Connect ${providerLabel(group.provider)}`}
                </button>
              }
            >
              <div className="stack-gap">
                {group.connections.map((connection) => (
                  <div key={connection.connectionKey} className="subtle-card">
                    <div className="panel-topline">
                      <div>
                        <h4>{connection.accountLabel || connection.accountId || 'Not connected'}</h4>
                        <p className="detail-copy">
                          Last sync: {formatDateTime(connection.lastSyncAt)}
                          {connection.lastSyncError ? ` • ${connection.lastSyncError}` : ''}
                        </p>
                      </div>
                      <StatusPill tone={statusTone(connection.status)} label={connection.status} />
                    </div>
                    <div className="reason-list">
                      {connection.syncJobs.length ? (
                        connection.syncJobs.map((job) => (
                          <span
                            key={`${connection.connectionKey}-${job.sourceKind}`}
                            className="reason-chip"
                          >
                            {job.sourceKind}: {job.status}
                          </span>
                        ))
                      ) : (
                        <span className="reason-chip">No sync jobs yet</span>
                      )}
                    </div>
                    <div className="button-row">
                      {connection.accountId ? (
                        <Fragment>
                          <button
                            className="primary-button"
                            onClick={() =>
                              runConnectionAction(
                                'sync',
                                connection.provider as 'google' | 'microsoft' | 'jira' | 'slack',
                                connection.accountId as string,
                              )
                            }
                          >
                            Sync now
                          </button>
                          <button
                            className="danger-button"
                            onClick={() =>
                              runConnectionAction(
                                'disconnect',
                                connection.provider as 'google' | 'microsoft' | 'jira' | 'slack',
                                connection.accountId as string,
                              )
                            }
                          >
                            Disconnect
                          </button>
                        </Fragment>
                      ) : (
                        <span className="detail-copy">
                          No account connected yet. Use the button above to authenticate.
                        </span>
                      )}
                    </div>
                    {connection.accountId ? (
                      <ConnectionScopeEditor
                        connection={connection}
                        clients={registryClients}
                        projects={registryProjects}
                        onFeedback={setFeedback}
                      />
                    ) : null}
                    {connection.accountId ? (
                      <p className="detail-copy">
                        Background sync runs during normal work hours. <strong>Sync now</strong> always works as a manual override.
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </CollapsiblePanel>
          ))}
        </div>

        <div className="stack-gap">
          <CollapsiblePanel
            storageKey="connections-registry"
            eyebrow="Registry"
            title="Clients and projects"
            subtitle="Grouped by client first, with edits hidden until you open them."
            defaultExpanded={true}
            actions={
              <div className="chip-row">
                <span className="chip">{registryClients.length} clients</span>
                <span className="chip">{registryProjects.length} projects</span>
                <span className="chip">{registryRepositories.length} repos</span>
              </div>
            }
          >
            <div className="registry-toolbar">
              <button
                className={`chip-button${showAddClient ? ' active' : ''}`}
                onClick={() => setShowAddClient((current) => !current)}
              >
                {showAddClient ? 'Close add client' : 'Add client'}
              </button>
              <button
                className={`chip-button${showAddProject ? ' active' : ''}`}
                onClick={() => setShowAddProject((current) => !current)}
              >
                {showAddProject ? 'Close add project' : 'Add project'}
              </button>
              <button
                className={`chip-button${showAddRepository ? ' active' : ''}`}
                onClick={() => setShowAddRepository((current) => !current)}
              >
                {showAddRepository ? 'Close add repo' : 'Add repository'}
              </button>
              <button
                className="chip-button"
                onClick={() => discoverRepositories.mutate()}
                disabled={discoverRepositories.isPending}
              >
                {discoverRepositories.isPending ? 'Discovering…' : 'Discover repos in home'}
              </button>
              <button
                className="chip-button"
                onClick={() =>
                  setExpandedClientIds(
                    Object.fromEntries(registryClients.map((client) => [client.id, true])),
                  )
                }
              >
                Expand all
              </button>
              <button
                className="chip-button"
                onClick={() =>
                  setExpandedClientIds(
                    Object.fromEntries(registryClients.map((client) => [client.id, false])),
                  )
                }
              >
                Collapse all
              </button>
            </div>
            {showAddClient ? (
              <div className="registry-editor">
                <div className="field-grid">
                  <label>
                    Client name
                    <input value={clientName} onChange={(event) => setClientName(event.target.value)} placeholder="Client A" />
                  </label>
                  <label>
                    Parent client
                    <select value={clientParentId} onChange={(event) => setClientParentId(event.target.value)}>
                      <option value="">Top-level client</option>
                      {registryClients.map((client) => (
                        <option key={client.id} value={client.id}>
                          {client.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Client roles
                    <input
                      value={clientRoles}
                      onChange={(event) => setClientRoles(event.target.value)}
                      placeholder="CTO, Main Developer"
                    />
                  </label>
                  <label>
                    Client status
                    <select
                      value={clientStatus}
                      onChange={(event) => setClientStatus(event.target.value as Client['status'])}
                    >
                      <option value="active">Active</option>
                      <option value="prospect">Prospect</option>
                      <option value="on_hold">On hold</option>
                      <option value="archived">Archived</option>
                    </select>
                  </label>
                  <label className="field-span-2">
                    Client notes
                    <textarea
                      value={clientNotes}
                      onChange={(event) => setClientNotes(event.target.value)}
                      placeholder="Engagement summary or context"
                    />
                  </label>
                </div>
                <div className="button-row">
                  <button
                    className="secondary-button"
                    onClick={async () => {
                      try {
                        await api.createClient({
                          name: clientName,
                          parentClientId: clientParentId || undefined,
                          roles: splitDelimitedValues(clientRoles),
                          status: clientStatus,
                          notes: clientNotes || undefined,
                        });
                        setClientName('');
                        setClientParentId('');
                        setClientStatus('active');
                        setClientRoles('');
                        setClientNotes('');
                        setShowAddClient(false);
                        await invalidateOps(queryClient);
                        setFeedback('Client added.');
                      } catch (error) {
                        setFeedback(error instanceof Error ? error.message : String(error));
                      }
                    }}
                    disabled={!clientName.trim()}
                  >
                    Save client
                  </button>
                </div>
              </div>
            ) : null}
            {showAddProject ? (
              <div className="registry-editor">
                <div className="field-grid">
                  <label>
                    Project name
                    <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Project X" />
                  </label>
                  <label>
                    Client
                    <select value={projectClientId} onChange={(event) => setProjectClientId(event.target.value)}>
                      <option value="">Unassigned</option>
                      {registryClients.map((client) => (
                        <option key={client.id} value={client.id}>
                          {client.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="button-row">
                  <button
                    className="secondary-button"
                    onClick={async () => {
                      try {
                        await api.createProject({ name: projectName, clientId: projectClientId || undefined });
                        setProjectName('');
                        setProjectClientId('');
                        setShowAddProject(false);
                        await invalidateOps(queryClient);
                        setFeedback('Project added.');
                      } catch (error) {
                        setFeedback(error instanceof Error ? error.message : String(error));
                      }
                    }}
                    disabled={!projectName.trim()}
                  >
                    Save project
                  </button>
                </div>
              </div>
            ) : null}
            {showAddRepository ? (
              <div className="registry-editor">
                <div className="field-grid">
                  <label>
                    Repository path
                    <input
                      value={repositoryPath}
                      onChange={(event) => setRepositoryPath(event.target.value)}
                      placeholder="~/repos/nanoclaw"
                    />
                  </label>
                  <label>
                    Display name (optional)
                    <input
                      value={repositoryName}
                      onChange={(event) => setRepositoryName(event.target.value)}
                      placeholder="Auto-detected from git path"
                    />
                  </label>
                  <label>
                    Client
                    <select
                      value={repositoryClientId}
                      onChange={(event) => {
                        const nextClientId = event.target.value;
                        setRepositoryClientId(nextClientId);
                        if (
                          repositoryProjectId &&
                          !repositoryProjectOptions(
                            registryProjects,
                            nextClientId || undefined,
                          ).some((entry) => entry.id === repositoryProjectId)
                        ) {
                          setRepositoryProjectId('');
                        }
                      }}
                    >
                      <option value="">Unassigned</option>
                      {registryClients.map((client) => (
                        <option key={client.id} value={client.id}>
                          {client.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Project
                    <select
                      value={repositoryProjectId}
                      onChange={(event) => {
                        const nextProjectId = event.target.value;
                        setRepositoryProjectId(nextProjectId);
                        const nextProject = registryProjects.find((project) => project.id === nextProjectId);
                        if (nextProject?.clientId) {
                          setRepositoryClientId(nextProject.clientId);
                        }
                      }}
                    >
                      <option value="">Client-level only</option>
                      {repositoryProjectChoices.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field-span-2">
                    Notes
                    <textarea
                      value={repositoryNotes}
                      onChange={(event) => setRepositoryNotes(event.target.value)}
                      placeholder="Optional context for how this repo supports the client or project"
                    />
                  </label>
                </div>
                <div className="button-row">
                  <button
                    className="secondary-button"
                    onClick={async () => {
                      try {
                        await api.createRepository({
                          name: repositoryName || undefined,
                          localPath: repositoryPath,
                          clientId: repositoryClientId || undefined,
                          projectId: repositoryProjectId || undefined,
                          notes: repositoryNotes || undefined,
                        });
                        setRepositoryName('');
                        setRepositoryPath('');
                        setRepositoryClientId('');
                        setRepositoryProjectId('');
                        setRepositoryNotes('');
                        setShowAddRepository(false);
                        await invalidateOps(queryClient);
                        setFeedback('Repository attached.');
                      } catch (error) {
                        setFeedback(error instanceof Error ? error.message : String(error));
                      }
                    }}
                    disabled={!repositoryPath.trim()}
                  >
                    Save repository
                  </button>
                </div>
              </div>
            ) : null}
            <div className="registry-tree">
              {rootClients.map((client) => (
                <ClientRegistryCard
                  key={client.id}
                  client={client}
                  clients={registryClients}
                  projectsByClient={projectsByClient}
                  repositoriesByClient={repositoriesByClient}
                  repositoriesByProject={repositoriesByProject}
                  expandedState={expandedClientIds}
                  onToggleExpanded={toggleClientExpanded}
                  onSaved={async (message) => {
                    await invalidateOps(queryClient);
                    setFeedback(message);
                  }}
                />
              ))}
            </div>
            {unassignedProjects.length ? (
              <div className="section-block">
                <div className="section-topline">
                  <div>
                    <div className="eyebrow">Unassigned projects</div>
                    <h4>Projects needing a client</h4>
                  </div>
                </div>
                <div className="registry-project-list">
                  {unassignedProjects.map((project) => (
                    <ProjectRegistryCard
                      key={project.id}
                      project={project}
                      clients={registryClients}
                      availableProjects={registryProjects}
                      repositories={repositoriesByProject.get(project.id) || []}
                      onSaved={async (message) => {
                        await invalidateOps(queryClient);
                        setFeedback(message);
                      }}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {unassignedRepositories.length ? (
              <div className="section-block">
                <div className="section-topline">
                  <div>
                    <div className="eyebrow">Unassigned repositories</div>
                    <h4>Repos needing a client or project</h4>
                  </div>
                </div>
                <div className="registry-project-list">
                  {unassignedRepositories.map((repository) => (
                    <RepositoryRegistryCard
                      key={repository.id}
                      repository={repository}
                      clients={registryClients}
                      projects={registryProjects}
                      onSaved={async (message) => {
                        await invalidateOps(queryClient);
                        setFeedback(message);
                      }}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </CollapsiblePanel>

          <CollapsiblePanel
            storageKey="connections-corrections"
            eyebrow="Recent corrections"
            title="What has been overridden recently"
            defaultExpanded={false}
          >
            {correctionsQuery.data?.corrections?.length ? (
              <div className="stack-gap compact">
                {correctionsQuery.data.corrections.slice(0, 10).map((correction) => (
                  <div key={correction.id} className="record-card compact static">
                    <div className="record-card-top">
                      <strong>{correction.field}</strong>
                      <span className="record-time">{formatShortDate(correction.createdAt)}</span>
                    </div>
                    <p>{correction.targetId}</p>
                    <p>{correction.value}</p>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState title="No corrections yet" body="As you reassign, hide, or reprioritize items, the audit trail will appear here." />
            )}
          </CollapsiblePanel>
          {feedback ? <p className="feedback">{feedback}</p> : null}
        </div>
      </div>
    </ScreenFrame>
  );
}

function AdminPage(props: { bootstrap: AppBootstrap }) {
  const queryClient = useQueryClient();
  const groupsQuery = useQuery({
    queryKey: ['admin-groups'],
    queryFn: api.getAdminGroups,
    refetchInterval: ADMIN_INTERVAL_IDLE,
    refetchIntervalInBackground: true,
  });
  const groups = groupsQuery.data?.groups || [];
  const [selectedGroupJid, setSelectedGroupJid] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedGroupJid) {
      setSelectedGroupJid(groupsQuery.data?.defaultGroupJid || props.bootstrap.admin.defaultGroupJid || null);
    }
    if (
      selectedGroupJid &&
      groups.length &&
      !groups.some((group) => group.chatJid === selectedGroupJid)
    ) {
      setSelectedGroupJid(groups[0]?.chatJid || null);
    }
  }, [groups, groupsQuery.data?.defaultGroupJid, props.bootstrap.admin.defaultGroupJid, selectedGroupJid]);

  const detailQuery = useQuery({
    queryKey: ['admin-group-detail', selectedGroupJid],
    queryFn: () => api.getAdminGroupDetail(selectedGroupJid!),
    enabled: Boolean(selectedGroupJid),
    refetchInterval: (query) => {
      const active = query.state.data?.detail.group.active;
      return active ? ADMIN_INTERVAL_ACTIVE : ADMIN_INTERVAL_IDLE;
    },
    refetchIntervalInBackground: true,
  });
  const tasksQuery = useQuery({
    queryKey: ['admin-tasks'],
    queryFn: api.getAdminTasks,
    refetchInterval: ADMIN_INTERVAL_IDLE,
    refetchIntervalInBackground: true,
  });
  const detail = detailQuery.data?.detail;
  const adminConversation = useMemo(
    () => (detail ? [...detail.conversation].reverse() : []),
    [detail],
  );
  const [messageText, setMessageText] = useState('');
  const [inputText, setInputText] = useState('');
  const [outboundText, setOutboundText] = useState('');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [taskScheduleType, setTaskScheduleType] = useState<'cron' | 'interval' | 'once'>('cron');
  const [taskScheduleValue, setTaskScheduleValue] = useState('0 9 * * *');
  const [taskContextMode, setTaskContextMode] = useState<'group' | 'isolated'>('group');
  const [feedback, setFeedback] = useState('');

  const selectedGroup = groups.find((group) => group.chatJid === selectedGroupJid) || null;

  return (
    <ScreenFrame title="Admin" subtitle="Runtime inspection and control without losing the new product UI.">
      <div className="admin-layout">
        <div className="admin-groups">
          <div className="panel-card">
            <div className="eyebrow">Groups</div>
            <div className="stack-gap compact">
              {groups.map((group) => (
                <button
                  key={group.chatJid}
                  className={`record-card compact${selectedGroupJid === group.chatJid ? ' selected' : ''}`}
                  onClick={() => setSelectedGroupJid(group.chatJid)}
                >
                  <div className="record-card-top">
                    <strong>{group.name}</strong>
                    <StatusPill tone={group.active ? 'success' : group.idleWaiting ? 'warning' : 'muted'} label={group.active ? 'active' : group.idleWaiting ? 'idle' : 'resting'} />
                  </div>
                  <p>{group.folder} • {group.channel || 'unknown channel'}</p>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="admin-main">
          {detail ? (
            <div className="stack-gap">
              <CollapsiblePanel
                storageKey="admin-runtime"
                eyebrow="Runtime"
                title={detail.group.name}
                defaultExpanded={true}
                actions={
                  <a href={props.bootstrap.legacyUrl} className="open-link">
                    Legacy console
                  </a>
                }
              >
                <RecordMeta
                  status={detail.group.active ? 'active' : detail.group.idleWaiting ? 'idle' : 'resting'}
                />
                <dl className="detail-grid">
                  <div>
                    <dt>Trigger</dt>
                    <dd>{detail.group.trigger || 'none'}</dd>
                  </div>
                  <div>
                    <dt>Response ID</dt>
                    <dd>{detail.group.session?.previousResponseId || 'new'}</dd>
                  </div>
                  <div>
                    <dt>Conversation ID</dt>
                    <dd>{detail.group.session?.conversationId || 'n/a'}</dd>
                  </div>
                  <div>
                    <dt>Transcript</dt>
                    <dd>{detail.group.transcriptPath || 'n/a'}</dd>
                  </div>
                </dl>
              </CollapsiblePanel>

              <CollapsiblePanel
                storageKey="admin-conversation"
                eyebrow="Conversation"
                title="Live transcript"
                defaultExpanded={false}
              >
                <div className="conversation-feed">
                  {adminConversation.map((item) => (
                    <div key={`${item.timestamp}-${item.source}-${item.text.slice(0, 16)}`} className={`conversation-bubble ${item.role}`}>
                      <div className="conversation-meta">
                        <strong>{item.label}</strong>
                        <span>{formatShortDate(item.timestamp)} • {item.source}</span>
                      </div>
                      <p>{item.text}</p>
                    </div>
                  ))}
                </div>
              </CollapsiblePanel>

              <CollapsiblePanel
                storageKey="admin-controls"
                eyebrow="Controls"
                title="Direct runtime actions"
                defaultExpanded={false}
              >
                <div className="field-grid">
                  <label>
                    Queue user message
                    <textarea value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder="Start a fresh turn" />
                  </label>
                  <div className="button-row end">
                    <button
                      className="secondary-button"
                      onClick={async () => {
                        if (!selectedGroup) return;
                        try {
                          await api.sendAdminMessage({ chatJid: selectedGroup.chatJid, text: messageText });
                          setMessageText('');
                          setFeedback('User message queued.');
                          await invalidateOps(queryClient);
                        } catch (error) {
                          setFeedback(error instanceof Error ? error.message : String(error));
                        }
                      }}
                      disabled={!selectedGroup || !messageText.trim()}
                    >
                      Queue
                    </button>
                  </div>

                  <label>
                    Send input to active agent
                    <textarea value={inputText} onChange={(event) => setInputText(event.target.value)} placeholder="Only works while a container is active" />
                  </label>
                  <div className="button-row end">
                    <button
                      className="secondary-button"
                      onClick={async () => {
                        if (!selectedGroup) return;
                        try {
                          await api.sendAdminInput({ chatJid: selectedGroup.chatJid, text: inputText });
                          setInputText('');
                          setFeedback('Input sent to active agent.');
                          await invalidateOps(queryClient);
                        } catch (error) {
                          setFeedback(error instanceof Error ? error.message : String(error));
                        }
                      }}
                      disabled={!selectedGroup || !inputText.trim()}
                    >
                      Send input
                    </button>
                  </div>

                  <label>
                    Send outbound reply
                    <textarea value={outboundText} onChange={(event) => setOutboundText(event.target.value)} placeholder="Send a direct operator-authored response" />
                  </label>
                  <div className="button-row end">
                    <button
                      className="primary-button"
                      onClick={async () => {
                        if (!selectedGroup) return;
                        try {
                          await api.sendAdminOutbound({ chatJid: selectedGroup.chatJid, text: outboundText });
                          setOutboundText('');
                          setFeedback('Outbound reply sent.');
                          await invalidateOps(queryClient);
                        } catch (error) {
                          setFeedback(error instanceof Error ? error.message : String(error));
                        }
                      }}
                      disabled={!selectedGroup || !outboundText.trim()}
                    >
                      Send outbound
                    </button>
                  </div>
                </div>
                {feedback ? <p className="feedback">{feedback}</p> : null}
              </CollapsiblePanel>
            </div>
          ) : (
            <EmptyState title="Select a group" body="Pick a group to inspect runtime state and send control actions." />
          )}
        </div>

        <div className="admin-side">
          <CollapsiblePanel
            storageKey="admin-scheduled-work"
            eyebrow="Scheduled work"
            title="Existing tasks"
            defaultExpanded={false}
          >
            <div className="stack-gap compact">
              {(tasksQuery.data?.tasks || []).map((task) => (
                <div key={task.id} className="record-card compact static">
                  <div className="record-card-top">
                    <strong>{task.prompt}</strong>
                    <StatusPill tone={task.status === 'active' ? 'success' : 'warning'} label={task.status} />
                  </div>
                  <p>{task.groupName || task.group_folder}</p>
                  <p>{task.schedule_type} • {task.schedule_value}</p>
                  <div className="button-row wrap">
                    <button className="mini-button" onClick={async () => { await api.pauseTask(task.id); await invalidateOps(queryClient); }}>Pause</button>
                    <button className="mini-button" onClick={async () => { await api.resumeTask(task.id); await invalidateOps(queryClient); }}>Resume</button>
                    <button className="mini-button" onClick={async () => { await api.cancelTask(task.id); await invalidateOps(queryClient); }}>Cancel</button>
                  </div>
                </div>
              ))}
            </div>
          </CollapsiblePanel>

          <CollapsiblePanel
            storageKey="admin-create-task"
            eyebrow="Create task"
            title="Add scheduled work"
            defaultExpanded={false}
          >
            <label>
              Prompt
              <textarea value={taskPrompt} onChange={(event) => setTaskPrompt(event.target.value)} placeholder="Task prompt" />
            </label>
            <div className="field-grid">
              <label>
                Schedule type
                <select value={taskScheduleType} onChange={(event) => setTaskScheduleType(event.target.value as typeof taskScheduleType)}>
                  <option value="cron">Cron</option>
                  <option value="interval">Interval</option>
                  <option value="once">Once</option>
                </select>
              </label>
              <label>
                Schedule
                <input value={taskScheduleValue} onChange={(event) => setTaskScheduleValue(event.target.value)} />
              </label>
            </div>
            <label>
              Context
              <select value={taskContextMode} onChange={(event) => setTaskContextMode(event.target.value as typeof taskContextMode)}>
                <option value="group">Group</option>
                <option value="isolated">Isolated</option>
              </select>
            </label>
            <div className="button-row">
              <button
                className="primary-button"
                onClick={async () => {
                  if (!selectedGroup) return;
                  try {
                    await api.createTask({
                      chatJid: selectedGroup.chatJid,
                      groupFolder: selectedGroup.folder,
                      prompt: taskPrompt,
                      scheduleType: taskScheduleType,
                      scheduleValue: taskScheduleValue,
                      contextMode: taskContextMode,
                    });
                    setTaskPrompt('');
                    setFeedback('Task created.');
                    await invalidateOps(queryClient);
                  } catch (error) {
                    setFeedback(error instanceof Error ? error.message : String(error));
                  }
                }}
                disabled={!selectedGroup || !taskPrompt.trim()}
              >
                Create task
              </button>
            </div>
          </CollapsiblePanel>
        </div>
      </div>
    </ScreenFrame>
  );
}

function MetricCard(props: { label: string; value: number; tone: 'accent' | 'muted' | 'warning' | 'danger' }) {
  return (
    <div className={`metric-card tone-${props.tone}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function SectionBlock(props: {
  title: string;
  children: React.ReactNode;
  collapsible?: boolean;
  storageKey?: string;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = usePersistentBoolean(
    props.storageKey || `section-${props.title}`,
    props.defaultExpanded ?? true,
  );
  return (
    <section className="section-block">
      <div className="section-topline">
        <div className="eyebrow">{props.title}</div>
        {props.collapsible ? (
          <button
            className="chip-button"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        ) : null}
      </div>
      {!props.collapsible || expanded ? props.children : null}
    </section>
  );
}

function GuidedRecordButton(props: {
  item: GuidedListItem;
  clients: Client[];
  projects: Project[];
  selected?: boolean;
  onClick: () => void;
}) {
  const client = findClient(props.clients, props.item.clientId);
  const project = findProject(props.projects, props.item.projectId);
  const meta = [
    props.item.provider ? providerLabel(props.item.provider) : null,
    props.item.accountLabel || null,
    client?.name || null,
    project?.name || null,
  ]
    .filter(Boolean)
    .join(' • ');

  return (
    <button
      className={`record-card compact guided-card${props.selected ? ' selected' : ''}`}
      onClick={props.onClick}
    >
      <div className="record-card-top">
        <strong>{props.item.title}</strong>
        {props.item.timestamp ? (
          <span className="record-time">{formatShortDate(props.item.timestamp)}</span>
        ) : null}
      </div>
      {meta ? <p className="record-submeta">{meta}</p> : null}
      <p className="record-why">Why: {props.item.surfacedReasonSummary}</p>
      <p>{props.item.latestEvidence || props.item.summary}</p>
      {props.item.nextExpectedMove ? (
        <p className="record-next">Next: {props.item.nextExpectedMove}</p>
      ) : null}
    </button>
  );
}

function resolveTodaySelection(
  today: TodaySummary,
  selectedId: string | null,
):
  | { type: 'source'; item: SourceRecord }
  | { type: 'work'; item: WorkItem }
  | { type: 'queue'; item: ApprovalQueueItem }
  | { type: 'workstream'; item: PersonalOpsWorkstream }
  | null {
  if (!selectedId) return null;
  const source =
    today.meetings.find((entry) => sourceRecordKey(entry) === selectedId) ||
    today.inbox.find((entry) => sourceRecordKey(entry) === selectedId) ||
    today.awareness.find((entry) => sourceRecordKey(entry) === selectedId);
  if (source) return { type: 'source', item: source };
  const work =
    today.priorities.find((entry) => entry.id === selectedId) ||
    today.blockers.find((entry) => entry.id === selectedId) ||
    today.followUps.find((entry) => entry.id === selectedId) ||
    today.overdue.find((entry) => entry.id === selectedId);
  if (work) return { type: 'work', item: work };
  const queue = today.approvalQueue.find((entry) => entry.id === selectedId);
  if (queue) return { type: 'queue', item: queue };
  const workstream = today.workstreams.find((entry) => entry.key === selectedId);
  if (workstream) return { type: 'workstream', item: workstream };
  return null;
}

function TodayWorkspacePage(props: { bootstrap: AppBootstrap }) {
  const queryClient = useQueryClient();
  const interval = useOpsInterval(props.bootstrap);
  const todayQuery = useQuery({
    queryKey: ['today'],
    queryFn: api.getToday,
    refetchInterval: interval,
  });
  const today = todayQuery.data?.today;
  const [taskTitle, setTaskTitle] = useState('');
  const [taskNotes, setTaskNotes] = useState('');
  const [taskPriority, setTaskPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>(
    'medium',
  );
  const [noteTitle, setNoteTitle] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [feedback, setFeedback] = useState('');

  const selectable = useMemo(() => {
    if (!today) return [];
    return [
      ...(today.now || []),
      ...(today.next || []),
      ...(today.waiting || []),
      ...(today.awarenessLane || []),
      ...(today.secondary?.meetings || []),
      ...(today.secondary?.approvals || []),
      ...(today.secondary?.workstreams || []),
    ];
  }, [today]);
  const [selectedId, setSelectedId] = useStableSelectedId(selectable, (item) => item.id);
  const selected = today ? resolveTodaySelection(today, selectedId) : null;

  const createTask = async () => {
    try {
      await api.createManualTask({
        title: taskTitle,
        notes: taskNotes || undefined,
        priority: taskPriority,
      });
      setTaskTitle('');
      setTaskNotes('');
      setFeedback('Manual task added.');
      await invalidateOps(queryClient);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  const createNote = async () => {
    try {
      await api.createManualNote({
        title: noteTitle,
        body: noteBody || undefined,
      });
      setNoteTitle('');
      setNoteBody('');
      setFeedback('Manual note added.');
      await invalidateOps(queryClient);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  if (!today) {
    return <EmptyState title="Loading Today" body="Personal ops data is loading." />;
  }

  return (
    <ScreenFrame
      title="Today"
      subtitle={today.headerSummary || 'Run the day from a calmer, clearer cockpit.'}
      guide="Start here to see what needs your attention now."
    >
      <div className="today-hero">
        <div className="summary-card accent">
          <div className="eyebrow">Recommended next step</div>
          <h3>{today.recommendedNextAction || today.suggestedPlan[0] || 'Review Today.'}</h3>
          {today.degradedSummary ? <p>{today.degradedSummary}</p> : null}
        </div>
        <div className="compact-status-strip">
          {(today.statusStrip || []).map((entry) => (
            <span key={entry.key} className={`chip tone-${entry.tone}`}>
              {entry.label}
            </span>
          ))}
        </div>
      </div>
      <DetailScaffold
        list={
          <div className="stack-gap">
            <SectionBlock title={`Now (${(today.now || []).length})`}>
              {(today.now || []).length ? (
                (today.now || []).map((item) => (
                  <GuidedRecordButton
                    key={item.id}
                    item={item}
                    clients={props.bootstrap.registry.clients}
                    projects={props.bootstrap.registry.projects}
                    selected={selectedId === item.id}
                    onClick={() => setSelectedId(item.id)}
                  />
                ))
              ) : (
                <EmptyState title="No urgent focus items" body="The most urgent work is clear right now." />
              )}
            </SectionBlock>

            <SectionBlock
              title={`Next (${(today.next || []).length})`}
              collapsible
              storageKey="today-25-next"
              defaultExpanded={true}
            >
              {(today.next || []).length ? (
                (today.next || []).map((item) => (
                  <GuidedRecordButton
                    key={item.id}
                    item={item}
                    clients={props.bootstrap.registry.clients}
                    projects={props.bootstrap.registry.projects}
                    selected={selectedId === item.id}
                    onClick={() => setSelectedId(item.id)}
                  />
                ))
              ) : (
                <EmptyState title="Nothing queued next" body="No meetings, approvals, or workstreams need immediate sequencing." />
              )}
            </SectionBlock>

            <SectionBlock
              title={`Waiting / Blocked (${(today.waiting || []).length})`}
              collapsible
              storageKey="today-25-waiting"
              defaultExpanded={true}
            >
              {(today.waiting || []).length ? (
                (today.waiting || []).map((item) => (
                  <GuidedRecordButton
                    key={item.id}
                    item={item}
                    clients={props.bootstrap.registry.clients}
                    projects={props.bootstrap.registry.projects}
                    selected={selectedId === item.id}
                    onClick={() => setSelectedId(item.id)}
                  />
                ))
              ) : (
                <EmptyState title="No blockers or waiting loops" body="Nothing critical is currently stuck." />
              )}
            </SectionBlock>

            <SectionBlock
              title={`Important Awareness (${(today.awarenessLane || []).length})`}
              collapsible
              storageKey="today-25-awareness"
              defaultExpanded={false}
            >
              {(today.awarenessLane || []).length ? (
                (today.awarenessLane || []).map((item) => (
                  <GuidedRecordButton
                    key={item.id}
                    item={item}
                    clients={props.bootstrap.registry.clients}
                    projects={props.bootstrap.registry.projects}
                    selected={selectedId === item.id}
                    onClick={() => setSelectedId(item.id)}
                  />
                ))
              ) : (
                <EmptyState title="No awareness-only items" body="Nothing important is parked in awareness right now." />
              )}
            </SectionBlock>

            <CollapsiblePanel
              storageKey="today-25-more"
              eyebrow="Secondary"
              title="More for today"
              subtitle="Meetings, pending approvals, active workstreams, and quick capture stay available without crowding the main flow."
              defaultExpanded={false}
            >
              <div className="stack-gap compact">
                <SectionBlock title={`Meetings (${today.secondary?.meetings.length || 0})`}>
                  {(today.secondary?.meetings || []).length ? (
                    (today.secondary?.meetings || []).map((item) => (
                      <GuidedRecordButton
                        key={item.id}
                        item={item}
                        clients={props.bootstrap.registry.clients}
                        projects={props.bootstrap.registry.projects}
                        selected={selectedId === item.id}
                        onClick={() => setSelectedId(item.id)}
                      />
                    ))
                  ) : (
                    <EmptyState title="No meetings" body="No meetings need prep today." />
                  )}
                </SectionBlock>
                <SectionBlock title={`Pending approvals (${today.secondary?.approvals.length || 0})`}>
                  {(today.secondary?.approvals || []).length ? (
                    (today.secondary?.approvals || []).map((item) => (
                      <GuidedRecordButton
                        key={item.id}
                        item={item}
                        clients={props.bootstrap.registry.clients}
                        projects={props.bootstrap.registry.projects}
                        selected={selectedId === item.id}
                        onClick={() => setSelectedId(item.id)}
                      />
                    ))
                  ) : (
                    <EmptyState title="No approvals" body="Nothing is waiting for approval right now." />
                  )}
                </SectionBlock>
                <SectionBlock title={`Active workstreams (${today.secondary?.workstreams.length || 0})`}>
                  {(today.secondary?.workstreams || []).length ? (
                    (today.secondary?.workstreams || []).map((item) => (
                      <GuidedRecordButton
                        key={item.id}
                        item={item}
                        clients={props.bootstrap.registry.clients}
                        projects={props.bootstrap.registry.projects}
                        selected={selectedId === item.id}
                        onClick={() => setSelectedId(item.id)}
                      />
                    ))
                  ) : (
                    <EmptyState title="No active workstreams" body="Grouped workstreams will appear as work gets linked." />
                  )}
                </SectionBlock>
                <div className="bottom-grid single-column">
                  <div className="panel-card">
                    <div className="eyebrow">Quick capture</div>
                    <div className="field-grid">
                      <label>
                        Manual task
                        <input
                          value={taskTitle}
                          onChange={(event) => setTaskTitle(event.target.value)}
                          placeholder="What needs to happen?"
                        />
                      </label>
                      <label>
                        Priority
                        <select
                          value={taskPriority}
                          onChange={(event) =>
                            setTaskPriority(event.target.value as typeof taskPriority)
                          }
                        >
                          <option value="medium">Medium</option>
                          <option value="urgent">Urgent</option>
                          <option value="high">High</option>
                          <option value="low">Low</option>
                        </select>
                      </label>
                    </div>
                    <textarea
                      value={taskNotes}
                      onChange={(event) => setTaskNotes(event.target.value)}
                      placeholder="Notes or context"
                    />
                    <div className="button-row">
                      <button
                        className="primary-button"
                        onClick={createTask}
                        disabled={!taskTitle.trim()}
                      >
                        Add task
                      </button>
                    </div>
                    <div className="field-grid">
                      <label>
                        Manual note
                        <input
                          value={noteTitle}
                          onChange={(event) => setNoteTitle(event.target.value)}
                          placeholder="Short note title"
                        />
                      </label>
                    </div>
                    <textarea
                      value={noteBody}
                      onChange={(event) => setNoteBody(event.target.value)}
                      placeholder="Reference detail or context"
                    />
                    <div className="button-row">
                      <button
                        className="secondary-button"
                        onClick={createNote}
                        disabled={!noteTitle.trim()}
                      >
                        Add note
                      </button>
                    </div>
                    {feedback ? <p className="feedback">{feedback}</p> : null}
                  </div>
                  <div className="panel-card">
                    <div className="eyebrow">Standup preview</div>
                    <MarkdownContent
                      content={today.secondary?.standupPreview || today.draftStandup}
                      className="report-markdown"
                    />
                  </div>
                </div>
              </div>
            </CollapsiblePanel>
          </div>
        }
        detail={
          selected?.type === 'source' ? (
            <SourceInspector
              source={selected.item}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
              onMutated={() => invalidateOps(queryClient)}
            />
          ) : selected?.type === 'work' ? (
            <WorkItemInspector
              item={selected.item}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
              onMutated={() => invalidateOps(queryClient)}
            />
          ) : selected?.type === 'queue' ? (
            <ApprovalQueueInspector
              item={selected.item}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
              onMutated={() => invalidateOps(queryClient)}
            />
          ) : selected?.type === 'workstream' ? (
            <WorkstreamInspector stream={selected.item} />
          ) : (
            <EmptyState title="Select an item" body="Pick something from Today to see why it surfaced and what to do next." />
          )
        }
      />
    </ScreenFrame>
  );
}

function InboxWorkspacePage(props: { bootstrap: AppBootstrap }) {
  const queryClient = useQueryClient();
  const interval = useOpsInterval(props.bootstrap);
  const [activeLane, setActiveLane] = usePersistentString('inbox-active-lane', 'needsAction');
  const [providerFilter, setProviderFilter] = usePersistentString('inbox-provider-filter-25', 'all');
  const [showNoise, setShowNoise] = usePersistentBoolean('inbox-show-noise-25', false);
  const [search, setSearch] = useState('');
  const inboxQuery = useQuery({
    queryKey: ['inbox', showNoise],
    queryFn: () => api.getInbox({ includeNoise: showNoise }),
    refetchInterval: interval,
  });
  const inbox = inboxQuery.data?.inbox || [];
  const filtered = useMemo(() => {
    return inbox.filter((source) => {
      if (providerFilter !== 'all' && source.provider !== providerFilter) return false;
      if (search.trim()) {
        const haystack = `${source.title}\n${source.summary}\n${source.body}`.toLowerCase();
        if (!haystack.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [inbox, providerFilter, search]);
  const lanes = useMemo(() => {
    const needsAction = filtered.filter(sourceNeedsAction);
    const importantAwareness = filtered.filter(
      (source) => !sourceNeedsAction(source) && sourceIsImportantAwareness(source),
    );
    const captured = new Set([
      ...needsAction.map((source) => sourceRecordKey(source)),
      ...importantAwareness.map((source) => sourceRecordKey(source)),
    ]);
    return {
      needsAction,
      importantAwareness,
      lowSignal: filtered.filter((source) => !captured.has(sourceRecordKey(source))),
    };
  }, [filtered]);
  const laneItems =
    activeLane === 'importantAwareness'
      ? lanes.importantAwareness
      : activeLane === 'lowSignal'
        ? lanes.lowSignal
        : lanes.needsAction;
  const [selectedId, setSelectedId] = useStableSelectedId(laneItems, sourceRecordKey);
  const selected = laneItems.find((item) => sourceRecordKey(item) === selectedId) || null;

  return (
    <ScreenFrame
      title="Inbox"
      subtitle="Process inbound in one lane at a time instead of juggling multiple feeds."
      guide="Process new inbound and confirm how the assistant should treat it."
    >
      <DetailScaffold
        list={
          <div className="stack-gap">
            <div className="tab-strip">
              <button
                className={`tab-button${activeLane === 'needsAction' ? ' active' : ''}`}
                onClick={() => setActiveLane('needsAction')}
              >
                Needs Action <span>{lanes.needsAction.length}</span>
              </button>
              <button
                className={`tab-button${activeLane === 'importantAwareness' ? ' active' : ''}`}
                onClick={() => setActiveLane('importantAwareness')}
              >
                Important Awareness <span>{lanes.importantAwareness.length}</span>
              </button>
              <button
                className={`tab-button${activeLane === 'lowSignal' ? ' active' : ''}`}
                onClick={() => setActiveLane('lowSignal')}
              >
                Low Signal <span>{lanes.lowSignal.length}</span>
              </button>
            </div>

            <CollapsiblePanel
              storageKey="inbox-25-filters"
              title="More filters"
              subtitle="Use these only when you need to narrow the lane further."
              defaultExpanded={false}
              className="toolbar-card"
            >
              <div className="filter-row">
                <select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}>
                  <option value="all">All providers</option>
                  <option value="google">Google</option>
                  <option value="microsoft">Microsoft</option>
                  <option value="slack">Slack</option>
                  <option value="jira">Jira</option>
                  <option value="manual">Manual</option>
                </select>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search this inbox"
                />
              </div>
              <div className="chip-row">
                <button
                  className={`chip-button${showNoise ? ' active' : ''}`}
                  onClick={() => setShowNoise((current) => !current)}
                >
                  {showNoise ? 'Hide noisy and hidden' : 'Include noisy and hidden'}
                </button>
              </div>
            </CollapsiblePanel>

            <div className="stack-gap">
              {laneItems.length ? (
                laneItems.map((source) => {
                  const client = findClient(props.bootstrap.registry.clients, source.clientId);
                  const project = findProject(props.bootstrap.registry.projects, source.projectId);
                  const meta = [
                    providerLabel(source.provider),
                    sourceAccountLabel(source),
                    client?.name,
                    project?.name,
                  ]
                    .filter(Boolean)
                    .join(' • ');
                  return (
                    <button
                      key={sourceRecordKey(source)}
                      className={`record-card compact guided-card${selectedId === sourceRecordKey(source) ? ' selected' : ''}`}
                      onClick={() => setSelectedId(sourceRecordKey(source))}
                    >
                      <div className="record-card-top">
                        <strong>{source.title}</strong>
                        <span className="record-time">{formatShortDate(source.occurredAt)}</span>
                      </div>
                      {meta ? <p className="record-submeta">{meta}</p> : null}
                      <p className="record-why">Why: {sourceSurfacedReasonSummary(source)}</p>
                      <p>{source.summary || source.body || 'No preview available.'}</p>
                    </button>
                  );
                })
              ) : (
                <EmptyState
                  title="Nothing in this lane"
                  body="The current filters leave this lane clear."
                />
              )}
            </div>
          </div>
        }
        detail={
          selected ? (
            <SourceInspector
              source={selected}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
              onMutated={() => invalidateOps(queryClient)}
            />
          ) : (
            <EmptyState
              title="Select an inbox item"
              body="Open an item to see why it surfaced and what the assistant recommends."
            />
          )
        }
      />
    </ScreenFrame>
  );
}

function WorkPage(props: { bootstrap: AppBootstrap }) {
  const interval = useOpsInterval(props.bootstrap);
  const workboardQuery = useQuery({
    queryKey: ['workboard'],
    queryFn: api.getWorkboard,
    refetchInterval: interval,
  });
  const workboard = workboardQuery.data?.workboard || [];
  const sections = workboardQuery.data?.sections || [];
  const [selectedStreamKey, setSelectedStreamKey] = useStableSelectedId(workboard, (stream) => stream.key);
  const selectedStream = workboard.find((stream) => stream.key === selectedStreamKey) || null;

  return (
    <ScreenFrame
      title="Work"
      subtitle="Follow active obligations by client and project, not by raw source system."
      guide="Track active obligations and what is waiting, blocked, or unresolved."
    >
      <DetailScaffold
        list={
          <div className="stack-gap">
            {sections.length ? (
              sections.map((section) => (
                <SectionBlock
                  key={section.key}
                  title={`${section.title} (${section.items.length})`}
                  collapsible
                  storageKey={`work-25-${section.key}`}
                  defaultExpanded={section.key === 'needsMyAction' || section.key === 'blocked'}
                >
                  {section.items.length ? (
                    section.items.map((item) => (
                      <GuidedRecordButton
                        key={item.streamKey || item.id}
                        item={item}
                        clients={props.bootstrap.registry.clients}
                        projects={props.bootstrap.registry.projects}
                        selected={selectedStreamKey === (item.streamKey || item.id)}
                        onClick={() => setSelectedStreamKey(item.streamKey || item.id)}
                      />
                    ))
                  ) : (
                    <EmptyState title={`No ${section.title.toLowerCase()}`} body="Nothing currently falls into this obligation state." />
                  )}
                </SectionBlock>
              ))
            ) : (
              <EmptyState title="No active work" body="Open loops and linked workstreams will appear here." />
            )}
          </div>
        }
        detail={
          selectedStream ? (
            <WorkstreamInspector stream={selectedStream} />
          ) : (
            <EmptyState
              title="Select a workstream"
              body="Open a client/project lane to inspect the latest evidence and next expected move."
            />
          )
        }
      />
    </ScreenFrame>
  );
}

function MemoryFactInspector(props: {
  fact: MemoryFact;
  clients: Client[];
  projects: Project[];
  onAccept: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const client = findClient(props.clients, props.fact.clientId);
  const project = findProject(props.projects, props.fact.projectId);
  return (
    <div className="inspector-stack">
      <div className="panel-card">
        <div className="eyebrow">Memory fact</div>
        <h4>{props.fact.label}</h4>
        <RecordMeta client={client} project={project} status={props.fact.status} />
        <p className="detail-copy">{props.fact.value}</p>
        <dl className="detail-grid">
          <div>
            <dt>Kind</dt>
            <dd>{props.fact.kind.replace(/_/g, ' ')}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{props.fact.confidence.toFixed(2)}</dd>
          </div>
          <div>
            <dt>Last observed</dt>
            <dd>{formatDateTime(props.fact.lastObservedAt)}</dd>
          </div>
          <div>
            <dt>Stale after</dt>
            <dd>{formatDateTime(props.fact.staleAfter)}</dd>
          </div>
        </dl>
        {props.fact.provenance.length ? (
          <div className="reason-list">
            {props.fact.provenance.map((reason) => (
              <span key={reason} className="reason-chip">
                {reason}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {props.fact.status === 'suggested' ? (
        <div className="panel-card">
          <div className="eyebrow">Resolution</div>
          <div className="button-row">
            <button className="primary-button" onClick={props.onAccept} disabled={props.busy}>
              {props.busy ? 'Saving…' : 'Accept'}
            </button>
            <button className="secondary-button" onClick={props.onReject} disabled={props.busy}>
              Reject
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ContactSuggestionInspector(props: {
  suggestion: ContactMappingSuggestion;
  contacts: Contact[];
  clients: Client[];
  projects: Project[];
  onAccept: () => void;
  busy: boolean;
}) {
  const contact = props.contacts.find((entry) => entry.id === props.suggestion.contactId) || null;
  const client = findClient(props.clients, props.suggestion.clientId);
  const project = findProject(props.projects, props.suggestion.projectId);
  return (
    <div className="inspector-stack">
      <div className="panel-card">
        <div className="eyebrow">Contact suggestion</div>
        <h4>{contact?.name || 'Unknown contact'}</h4>
        <RecordMeta client={client} project={project} status={props.suggestion.status} />
        <p className="detail-copy">{props.suggestion.basis}</p>
        <dl className="detail-grid">
          <div>
            <dt>Confidence</dt>
            <dd>{props.suggestion.confidence.toFixed(2)}</dd>
          </div>
          <div>
            <dt>Seen</dt>
            <dd>{props.suggestion.occurrenceCount}</dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>{formatDateTime(props.suggestion.lastSeenAt)}</dd>
          </div>
        </dl>
      </div>
      <div className="panel-card">
        <div className="eyebrow">Apply suggestion</div>
        <p className="detail-copy">
          Accepting this links the contact’s default client/project memory for future triage.
        </p>
        <div className="button-row">
          <button className="primary-button" onClick={props.onAccept} disabled={props.busy}>
            {props.busy ? 'Applying…' : 'Apply mapping'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CorrectionInspector(props: { correction: Correction }) {
  return (
    <div className="inspector-stack">
      <div className="panel-card">
        <div className="eyebrow">Noise control</div>
        <h4>{props.correction.field}</h4>
        <p className="detail-copy">{props.correction.targetId}</p>
        <dl className="detail-grid">
          <div>
            <dt>Value</dt>
            <dd>{props.correction.value}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDateTime(props.correction.createdAt)}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function ImprovementTicketInspector(props: {
  ticket: ImprovementTicket;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  return (
    <div className="inspector-stack">
      <div className="panel-card">
        <div className="eyebrow">Improvement backlog</div>
        <h4>{props.ticket.title}</h4>
        <p className="detail-copy">{props.ticket.problem}</p>
        <dl className="detail-grid">
          <div>
            <dt>Status</dt>
            <dd>{props.ticket.status}</dd>
          </div>
          <div>
            <dt>Surface</dt>
            <dd>{props.ticket.suggestedSurface || 'n/a'}</dd>
          </div>
          <div>
            <dt>Subsystem</dt>
            <dd>{props.ticket.suggestedSubsystem || 'n/a'}</dd>
          </div>
          <div>
            <dt>Created from</dt>
            <dd>{props.ticket.createdFrom}</dd>
          </div>
        </dl>
      </div>
      <div className="panel-card">
        <div className="eyebrow">Desired behavior</div>
        <p>{props.ticket.desiredBehavior}</p>
        <div className="eyebrow">User value</div>
        <p>{props.ticket.userValue}</p>
        {props.ticket.acceptanceCriteria.length ? (
          <Fragment>
            <div className="eyebrow">Acceptance criteria</div>
            <ul>
              {props.ticket.acceptanceCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          </Fragment>
        ) : null}
        {props.ticket.evidenceRefs.length ? (
          <div className="reason-list">
            {props.ticket.evidenceRefs.map((reference) => (
              <span key={reference} className="reason-chip">
                {reference}
              </span>
            ))}
          </div>
        ) : null}
        <div className="button-row">
          <button
            className="primary-button"
            onClick={props.onApprove}
            disabled={props.busy}
          >
            {props.busy ? 'Updating…' : 'Approve ticket'}
          </button>
          <button
            className="secondary-button"
            onClick={props.onReject}
            disabled={props.busy}
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewCenterPage(props: { bootstrap: AppBootstrap }) {
  const queryClient = useQueryClient();
  const interval = useOpsInterval(props.bootstrap);
  const [searchParams, setSearchParams] = useSearchParams();
  const [storedTab, setStoredTab] = usePersistentString('review-center-tab', 'questions');
  const searchTab = searchParams.get('tab');
  const activeTab =
    searchTab && ['questions', 'approvals', 'memory', 'improvements', 'noise'].includes(searchTab)
      ? searchTab
      : storedTab;
  const setActiveTab = (
    value: 'questions' | 'approvals' | 'memory' | 'improvements' | 'noise',
  ) => {
    setStoredTab(value);
    setSearchParams({ tab: value });
  };
  const questionsQuery = useQuery({
    queryKey: ['questions', 'review', 'queued'],
    queryFn: () => api.getQuestions({ surface: 'review', urgency: 'queued' }),
    refetchInterval: interval,
  });
  const queueQuery = useQuery({
    queryKey: ['queue'],
    queryFn: api.getQueue,
    refetchInterval: interval,
  });
  const memoryQuery = useQuery({
    queryKey: ['memory'],
    queryFn: api.getMemory,
    refetchInterval: OPS_INTERVAL_IDLE,
  });
  const improvementsQuery = useQuery({
    queryKey: ['improvements'],
    queryFn: api.getImprovements,
    refetchInterval: OPS_INTERVAL_IDLE,
  });
  const contactsQuery = useQuery({
    queryKey: ['contacts'],
    queryFn: api.getContacts,
    refetchInterval: OPS_INTERVAL_IDLE,
  });
  const correctionsQuery = useQuery({
    queryKey: ['corrections'],
    queryFn: api.getCorrections,
    refetchInterval: OPS_INTERVAL_IDLE,
  });
  const questions = questionsQuery.data?.questions || [];
  const queue = queueQuery.data?.queue || [];
  const memory = memoryQuery.data?.memory || [];
  const improvements = improvementsQuery.data?.improvements || [];
  const operatorProfile = contactsQuery.data?.operatorProfile;
  const [profileDraft, setProfileDraft] = useState<OperatorProfile | null>(null);
  useEffect(() => {
    if (operatorProfile) setProfileDraft(operatorProfile);
  }, [operatorProfile]);
  const noiseCorrections = (correctionsQuery.data?.corrections || []).filter((entry) =>
    ['hideFromSummaries', 'awarenessOnly', 'ignoreTask', 'ignoreSimilar'].includes(entry.field),
  );

  const acceptReviewMutation = useMutation({
    mutationFn: (id: string) => api.acceptReview(id),
    onSuccess: async () => invalidateOps(queryClient),
  });
  const rejectReviewMutation = useMutation({
    mutationFn: (id: string) => api.rejectReview(id),
    onSuccess: async () => invalidateOps(queryClient),
  });
  const acceptMemoryMutation = useMutation({
    mutationFn: (id: string) => api.acceptMemoryFact(id),
    onSuccess: async () => invalidateOps(queryClient),
  });
  const rejectMemoryMutation = useMutation({
    mutationFn: (id: string) => api.rejectMemoryFact(id),
    onSuccess: async () => invalidateOps(queryClient),
  });
  const saveProfileMutation = useMutation({
    mutationFn: (input: Partial<OperatorProfile>) => api.updateOperatorProfile(input),
    onSuccess: async () => invalidateOps(queryClient),
  });
  const approveImprovementMutation = useMutation({
    mutationFn: (id: string) => api.approveImprovement(id),
    onSuccess: async () => invalidateOps(queryClient),
  });
  const rejectImprovementMutation = useMutation({
    mutationFn: (id: string) => api.rejectImprovement(id),
    onSuccess: async () => invalidateOps(queryClient),
  });

  const questionEntries = questions.map((item) => ({ id: `question:${item.id}`, item }));
  const memoryEntries = memory.map((item) => ({ id: `memory:${item.id}`, item }));
  const noiseEntries = noiseCorrections.map((item) => ({ id: `noise:${item.id}`, item }));
  const approvalEntries = queue.map((item) => ({ id: `queue:${item.id}`, item }));
  const improvementEntries = improvements.map((item) => ({
    id: `improvement:${item.id}`,
    item,
  }));
  const activeSelectionList =
    activeTab === 'questions'
      ? questionEntries.map((entry) => entry.id)
      : activeTab === 'approvals'
      ? approvalEntries.map((entry) => entry.id)
      : activeTab === 'memory'
          ? memoryEntries.map((entry) => entry.id)
          : activeTab === 'improvements'
            ? improvementEntries.map((entry) => entry.id)
          : noiseEntries.map((entry) => entry.id);
  const [selectedId, setSelectedId] = useState<string | null>(activeSelectionList[0] || null);

  useEffect(() => {
    if (!activeSelectionList.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !activeSelectionList.includes(selectedId)) {
      setSelectedId(activeSelectionList[0]);
    }
  }, [activeSelectionList, selectedId]);

  const selectedQuestion =
    questionEntries.find((entry) => entry.id === selectedId)?.item || null;
  const selectedApproval = approvalEntries.find((entry) => entry.id === selectedId)?.item || null;
  const selectedMemory = memoryEntries.find((entry) => entry.id === selectedId)?.item || null;
  const selectedImprovement =
    improvementEntries.find((entry) => entry.id === selectedId)?.item || null;
  const selectedNoise = noiseEntries.find((entry) => entry.id === selectedId)?.item || null;

  return (
    <ScreenFrame
      title="Review"
      subtitle="One place for approvals, learning, uncertainty, and noise controls."
      guide="Approve drafts, confirm learning, and correct uncertainty."
    >
      <DetailScaffold
        list={
          <div className="stack-gap">
            <div className="review-intro panel-card">
              <div className="eyebrow">How this works</div>
              <h4>If the assistant is unsure, learning, or asking permission, it appears here.</h4>
              <p className="detail-copy">
                Approvals are ready-to-use drafts. Suggestions and memory shape future triage. Noise controls preserve the quieting decisions you have already made.
              </p>
            </div>
            <div className="tab-strip">
              <button className={`tab-button${activeTab === 'questions' ? ' active' : ''}`} onClick={() => setActiveTab('questions')}>
                Questions <span>{questions.length}</span>
              </button>
              <button className={`tab-button${activeTab === 'approvals' ? ' active' : ''}`} onClick={() => setActiveTab('approvals')}>
                Approvals <span>{queue.length}</span>
              </button>
              <button className={`tab-button${activeTab === 'memory' ? ' active' : ''}`} onClick={() => setActiveTab('memory')}>
                Memory <span>{memory.length}</span>
              </button>
              <button className={`tab-button${activeTab === 'improvements' ? ' active' : ''}`} onClick={() => setActiveTab('improvements')}>
                Improvements <span>{improvements.length}</span>
              </button>
              <button className={`tab-button${activeTab === 'noise' ? ' active' : ''}`} onClick={() => setActiveTab('noise')}>
                Noise Controls <span>{noiseCorrections.length}</span>
              </button>
            </div>

            {activeTab === 'questions' ? (
              <SectionBlock title={`Questions (${questions.length})`}>
                {questions.length ? (
                  questions.map((item) => (
                    <button
                      key={item.id}
                      className={`record-card compact guided-card${selectedId === `question:${item.id}` ? ' selected' : ''}`}
                      onClick={() => setSelectedId(`question:${item.id}`)}
                    >
                      <div className="record-card-top">
                        <strong>{item.prompt}</strong>
                        <span className="record-time">{questionSurfaceLabel(item.surface)}</span>
                      </div>
                      <p className="record-why">Why: {item.rationale}</p>
                    </button>
                  ))
                ) : (
                  <EmptyState title="No queued questions" body="Questions that need your judgment or setup input will appear here." />
                )}
              </SectionBlock>
            ) : null}

            {activeTab === 'approvals' ? (
              <SectionBlock title={`Pending approvals (${queue.length})`}>
                {queue.length ? (
                  queue.map((item) => (
                    <button
                      key={item.id}
                      className={`record-card compact guided-card${selectedId === `queue:${item.id}` ? ' selected' : ''}`}
                      onClick={() => setSelectedId(`queue:${item.id}`)}
                    >
                      <div className="record-card-top">
                        <strong>{item.title}</strong>
                        <span className="record-time">{formatShortDate(item.updatedAt)}</span>
                      </div>
                      <p className="record-why">Why: {item.reason}</p>
                      <p>{item.summary}</p>
                    </button>
                  ))
                ) : (
                  <EmptyState title="No pending approvals" body="Nothing is waiting for approval right now." />
                )}
              </SectionBlock>
            ) : null}

            {activeTab === 'memory' ? (
              <div className="stack-gap">
                <CollapsiblePanel
                  storageKey="review-25-operator-profile"
                  title="Operator profile"
                  subtitle="This is the top-level context the assistant uses when triaging and drafting."
                  defaultExpanded={false}
                >
                  {profileDraft ? (
                    <div className="stack-gap">
                      <div className="field-grid">
                        <label className="field-span-2">
                          Role summary
                          <input
                            value={profileDraft.roleSummary}
                            onChange={(event) =>
                              setProfileDraft((current) =>
                                current ? { ...current, roleSummary: event.target.value } : current,
                              )
                            }
                          />
                        </label>
                        <label className="field-span-2">
                          Reporting preference
                          <input
                            value={profileDraft.reportingPreferences}
                            onChange={(event) =>
                              setProfileDraft((current) =>
                                current
                                  ? { ...current, reportingPreferences: event.target.value }
                                  : current,
                              )
                            }
                          />
                        </label>
                        <label className="field-span-2">
                          Assistant style
                          <textarea
                            value={profileDraft.assistantStyle}
                            onChange={(event) =>
                              setProfileDraft((current) =>
                                current ? { ...current, assistantStyle: event.target.value } : current,
                              )
                            }
                          />
                        </label>
                      </div>
                      <div className="button-row">
                        <button
                          className="primary-button"
                          onClick={() => profileDraft && saveProfileMutation.mutate(profileDraft)}
                          disabled={saveProfileMutation.isPending}
                        >
                          {saveProfileMutation.isPending ? 'Saving…' : 'Save operator profile'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <EmptyState title="Loading operator profile" body="Profile context is loading." />
                  )}
                </CollapsiblePanel>

                <SectionBlock title={`Durable memory (${memory.length})`}>
                  {memory.length ? (
                    memory.map((fact) => (
                      <button
                        key={fact.id}
                        className={`record-card compact guided-card${selectedId === `memory:${fact.id}` ? ' selected' : ''}`}
                        onClick={() => setSelectedId(`memory:${fact.id}`)}
                      >
                        <div className="record-card-top">
                          <strong>{fact.label}</strong>
                          <span className="record-time">{fact.status}</span>
                        </div>
                        <p className="record-why">Why: {fact.provenance[0] || fact.kind.replace(/_/g, ' ')}</p>
                        <p>{fact.value}</p>
                      </button>
                    ))
                  ) : (
                    <EmptyState title="No durable memory" body="Accepted mappings and stable facts will accumulate here." />
                  )}
                </SectionBlock>
              </div>
            ) : null}

            {activeTab === 'improvements' ? (
              <SectionBlock title={`Improvements (${improvements.length})`}>
                {improvements.length ? (
                  improvements.map((ticket) => (
                    <button
                      key={ticket.id}
                      className={`record-card compact guided-card${selectedId === `improvement:${ticket.id}` ? ' selected' : ''}`}
                      onClick={() => setSelectedId(`improvement:${ticket.id}`)}
                    >
                      <div className="record-card-top">
                        <strong>{ticket.title}</strong>
                        <span className="record-time">{ticket.status}</span>
                      </div>
                      <p className="record-why">Why: {ticket.problem}</p>
                    </button>
                  ))
                ) : (
                  <EmptyState title="No improvement tickets" body="Repeated friction and product gaps will show up here as internal backlog items." />
                )}
              </SectionBlock>
            ) : null}

            {activeTab === 'noise' ? (
              <SectionBlock title={`Noise controls (${noiseCorrections.length})`}>
                {noiseCorrections.length ? (
                  noiseCorrections.map((entry) => (
                    <button
                      key={entry.id}
                      className={`record-card compact guided-card${selectedId === `noise:${entry.id}` ? ' selected' : ''}`}
                      onClick={() => setSelectedId(`noise:${entry.id}`)}
                    >
                      <div className="record-card-top">
                        <strong>{entry.field}</strong>
                        <span className="record-time">{formatShortDate(entry.createdAt)}</span>
                      </div>
                      <p className="record-why">Why: preserve a previous quieting or awareness decision</p>
                      <p>{entry.targetId}</p>
                    </button>
                  ))
                ) : (
                  <EmptyState title="No saved noise controls" body="Suppressions and awareness-only confirmations will appear here." />
                )}
              </SectionBlock>
            ) : null}
          </div>
        }
        detail={
          activeTab === 'questions' && selectedQuestion ? (
            <AssistantQuestionCard question={selectedQuestion} inline />
          ) : activeTab === 'approvals' && selectedApproval ? (
            <ApprovalQueueInspector
              item={selectedApproval}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
              onMutated={() => invalidateOps(queryClient)}
            />
          ) : activeTab === 'memory' && selectedMemory ? (
            <MemoryFactInspector
              fact={selectedMemory}
              clients={props.bootstrap.registry.clients}
              projects={props.bootstrap.registry.projects}
              onAccept={() => acceptMemoryMutation.mutate(selectedMemory.id)}
              onReject={() => rejectMemoryMutation.mutate(selectedMemory.id)}
              busy={acceptMemoryMutation.isPending || rejectMemoryMutation.isPending}
            />
          ) : activeTab === 'improvements' && selectedImprovement ? (
            <ImprovementTicketInspector
              ticket={selectedImprovement}
              onApprove={() => approveImprovementMutation.mutate(selectedImprovement.id)}
              onReject={() => rejectImprovementMutation.mutate(selectedImprovement.id)}
              busy={
                approveImprovementMutation.isPending || rejectImprovementMutation.isPending
              }
            />
          ) : activeTab === 'noise' && selectedNoise ? (
            <CorrectionInspector correction={selectedNoise} />
          ) : (
            <EmptyState
              title="Select a review item"
              body="Choose a question, approval, memory fact, improvement, or noise control to inspect it."
            />
          )
        }
      />
    </ScreenFrame>
  );
}

function ConnectionsSetupPage(props: { bootstrap: AppBootstrap }) {
  const queryClient = useQueryClient();
  const interval = useOpsInterval(props.bootstrap);
  const setupQuery = useQuery({
    queryKey: ['setup'],
    queryFn: api.getSetup,
    refetchInterval: OPS_INTERVAL_IDLE,
  });
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: api.getConnections,
    refetchInterval: interval,
  });
  const correctionsQuery = useQuery({
    queryKey: ['corrections'],
    queryFn: api.getCorrections,
    refetchInterval: interval,
  });
  const setup = setupQuery.data?.setup || props.bootstrap.setupChecklist;
  const connections = connectionsQuery.data?.connections || [];
  const [feedback, setFeedback] = useState('');
  const [clientName, setClientName] = useState('');
  const [clientParentId, setClientParentId] = useState('');
  const [clientStatus, setClientStatus] = useState<Client['status']>('active');
  const [clientRoles, setClientRoles] = useState('');
  const [clientNotes, setClientNotes] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectClientId, setProjectClientId] = useState('');
  const [repositoryName, setRepositoryName] = useState('');
  const [repositoryPath, setRepositoryPath] = useState('');
  const [repositoryClientId, setRepositoryClientId] = useState('');
  const [repositoryProjectId, setRepositoryProjectId] = useState('');
  const [repositoryNotes, setRepositoryNotes] = useState('');
  const [showAddClient, setShowAddClient] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showAddRepository, setShowAddRepository] = useState(false);
  const [expandedClientIds, setExpandedClientIds] = useState<Record<string, boolean>>({});
  const registryClients = correctionsQuery.data?.clients || props.bootstrap.registry.clients;
  const registryProjects = correctionsQuery.data?.projects || props.bootstrap.registry.projects;
  const registryRepositories =
    correctionsQuery.data?.repositories || props.bootstrap.registry.repositories;
  const providerGroups = useMemo(
    () =>
      ['google', 'microsoft', 'jira', 'slack'].map((provider) => ({
        provider: provider as 'google' | 'microsoft' | 'jira' | 'slack',
        connections: connections.filter((connection) => connection.provider === provider),
      })),
    [connections],
  );
  const projectsByClient = useMemo(() => {
    const buckets = new Map<string, Project[]>();
    registryProjects.forEach((project) => {
      const key = project.clientId || 'unassigned';
      const bucket = buckets.get(key) || [];
      bucket.push(project);
      buckets.set(key, bucket);
    });
    return buckets;
  }, [registryProjects]);
  const repositoriesByClient = useMemo(() => {
    const buckets = new Map<string, GitRepository[]>();
    registryRepositories
      .filter((repository) => repository.clientId && !repository.projectId)
      .forEach((repository) => {
        const key = repository.clientId as string;
        const bucket = buckets.get(key) || [];
        bucket.push(repository);
        buckets.set(key, bucket);
      });
    return buckets;
  }, [registryRepositories]);
  const repositoriesByProject = useMemo(() => {
    const buckets = new Map<string, GitRepository[]>();
    registryRepositories
      .filter((repository) => repository.projectId)
      .forEach((repository) => {
        const key = repository.projectId as string;
        const bucket = buckets.get(key) || [];
        bucket.push(repository);
        buckets.set(key, bucket);
      });
    return buckets;
  }, [registryRepositories]);
  const rootClients = useMemo(
    () => registryClients.filter((client) => !client.parentClientId),
    [registryClients],
  );
  const unassignedRepositories = registryRepositories.filter(
    (repository) => !repository.clientId && !repository.projectId,
  );
  const repositoryProjectChoices = repositoryProjectOptions(
    registryProjects,
    repositoryClientId || undefined,
  );
  const discoverRepositories = useMutation({
    mutationFn: () => api.discoverRepositories({ rootPath: '~', maxDepth: 5 }),
    onSuccess: async (payload) => {
      await invalidateOps(queryClient);
      setFeedback(`Discovered ${payload.count} repos in your home directory, including Downloads.`);
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : String(error)),
  });
  const runConnectionAction = async (
    action: 'sync' | 'disconnect',
    provider: 'google' | 'microsoft' | 'jira' | 'slack',
    accountId: string,
  ) => {
    try {
      if (action === 'sync') {
        await api.syncConnection(provider, accountId);
      } else {
        await api.disconnectConnection(provider, accountId);
      }
      await invalidateOps(queryClient);
      setFeedback(`${provider} ${action} complete for ${accountId}.`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };
  const toggleClientExpanded = (clientId: string) => {
    setExpandedClientIds((current) => ({
      ...current,
      [clientId]: !(current[clientId] ?? rootClients.some((client) => client.id === clientId)),
    }));
  };

  return (
    <ScreenFrame
      title="Connections"
      subtitle="Set up accounts, defaults, clients, projects, and repositories without feeling like you are in an admin console."
      guide="Tune the assistant here: connect accounts, set defaults, confirm clients and projects, and manage attached repos."
    >
      <div className="stack-gap">
        <CollapsiblePanel
          storageKey="connections-25-setup"
          eyebrow="Setup checklist"
          title={setup.complete ? 'Setup looks healthy' : `${setup.incompleteCount} setup item${setup.incompleteCount === 1 ? '' : 's'} still need attention`}
          subtitle={setup.recommendedNextAction}
          defaultExpanded={!setup.complete}
        >
          <div className="stack-gap compact">
            {setup.checklist.map((item) => (
              <a key={item.key} href={item.href} className={`record-card compact static-card setup-row${item.done ? ' done' : ''}`}>
                <div className="record-card-top">
                  <strong>{item.label}</strong>
                  <StatusPill tone={item.done ? 'success' : 'warning'} label={item.done ? 'done' : 'next'} />
                </div>
                <p>{item.detail}</p>
              </a>
            ))}
            <SetupQuestionCards questions={setup.questions} />
          </div>
        </CollapsiblePanel>

        <CollapsiblePanel
          storageKey="connections-25-accounts"
          eyebrow="Connected accounts"
          title="Connected accounts"
          subtitle="Authentication, health, and one-click sync stay here."
          defaultExpanded={true}
        >
          <div className="stack-gap">
            {providerGroups.map((group) => (
              <div key={group.provider} className="panel-card nested-panel">
                <div className="panel-topline">
                  <div>
                    <div className="eyebrow">{providerLabel(group.provider)}</div>
                    <h4>
                      {group.connections.filter((entry) => entry.accountId).length} connected account
                      {group.connections.filter((entry) => entry.accountId).length === 1 ? '' : 's'}
                    </h4>
                  </div>
                  <button
                    className="secondary-button"
                    onClick={async () => {
                      const result = await api.beginOAuth(group.provider);
                      window.location.href = result.url;
                    }}
                  >
                    {group.connections.some((entry) => entry.accountId)
                      ? `Add another ${providerLabel(group.provider)} account`
                      : `Connect ${providerLabel(group.provider)}`}
                  </button>
                </div>
                <div className="stack-gap compact">
                  {group.connections.map((connection) => (
                    <div key={connection.connectionKey} className="subtle-card">
                      <div className="record-card-top">
                        <strong>{connection.accountLabel || connection.accountId || 'Not connected'}</strong>
                        <StatusPill tone={statusTone(connection.status)} label={connection.status} />
                      </div>
                      <p className="record-submeta">
                        Last sync: {formatDateTime(connection.lastSyncAt)}
                        {connection.lastSyncError ? ` • ${connection.lastSyncError}` : ''}
                      </p>
                      <p className="record-why">
                        Scope: {formatScopeSummary(connection).join(' • ')}
                      </p>
                      <div className="reason-list">
                        {connection.syncJobs.length ? (
                          connection.syncJobs.map((job) => (
                            <span key={`${connection.connectionKey}-${job.sourceKind}`} className="reason-chip">
                              {job.sourceKind}: {job.status}
                            </span>
                          ))
                        ) : (
                          <span className="reason-chip">No sync jobs yet</span>
                        )}
                      </div>
                      {connection.accountId ? (
                        <div className="button-row">
                          <button
                            className="primary-button"
                            onClick={() =>
                              runConnectionAction(
                                'sync',
                                connection.provider as 'google' | 'microsoft' | 'jira' | 'slack',
                                connection.accountId as string,
                              )
                            }
                          >
                            Sync now
                          </button>
                          <button
                            className="danger-button"
                            onClick={() =>
                              runConnectionAction(
                                'disconnect',
                                connection.provider as 'google' | 'microsoft' | 'jira' | 'slack',
                                connection.accountId as string,
                              )
                            }
                          >
                            Disconnect
                          </button>
                        </div>
                      ) : (
                        <p className="detail-copy">Use the button above to authenticate this provider.</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CollapsiblePanel>

        <CollapsiblePanel
          storageKey="connections-25-scope"
          eyebrow="Scope and defaults"
          title="Scope and defaults"
          subtitle="Tune what each account pulls in and what client/project context it should imply."
          defaultExpanded={false}
        >
          <div className="stack-gap">
            {providerGroups.flatMap((group) => group.connections).filter((connection) => connection.accountId).length ? (
              providerGroups.map((group) =>
                group.connections
                  .filter((connection) => connection.accountId)
                  .map((connection) => (
                    <div key={`${connection.connectionKey}-scope`} className="subtle-card">
                      <div className="panel-topline">
                        <div>
                          <h4>{connection.accountLabel || connection.accountId}</h4>
                          <p className="detail-copy">{formatScopeSummary(connection).join(' • ')}</p>
                        </div>
                        <StatusPill tone={statusTone(connection.status)} label={connection.status} />
                      </div>
                      <ConnectionScopeEditor
                        connection={connection}
                        clients={registryClients}
                        projects={registryProjects}
                        onFeedback={setFeedback}
                      />
                    </div>
                  )),
              )
            ) : (
              <EmptyState title="No connected accounts" body="Connect an account first, then tune scope and defaults here." />
            )}
          </div>
        </CollapsiblePanel>

        <CollapsiblePanel
          storageKey="connections-25-registry"
          eyebrow="Clients and projects"
          title="Clients and projects"
          subtitle="Maintain the engagement structure without keeping all forms open at once."
          defaultExpanded={true}
        >
          <div className="registry-toolbar">
            <button className={`chip-button${showAddClient ? ' active' : ''}`} onClick={() => setShowAddClient((current) => !current)}>
              {showAddClient ? 'Close add client' : 'Add client'}
            </button>
            <button className={`chip-button${showAddProject ? ' active' : ''}`} onClick={() => setShowAddProject((current) => !current)}>
              {showAddProject ? 'Close add project' : 'Add project'}
            </button>
            <button className="chip-button" onClick={() => setExpandedClientIds(Object.fromEntries(registryClients.map((client) => [client.id, true])))}>Expand all</button>
            <button className="chip-button" onClick={() => setExpandedClientIds(Object.fromEntries(registryClients.map((client) => [client.id, false])))}>Collapse all</button>
          </div>
          {showAddClient ? (
            <div className="registry-editor">
              <div className="field-grid">
                <label>
                  Client name
                  <input value={clientName} onChange={(event) => setClientName(event.target.value)} placeholder="Client A" />
                </label>
                <label>
                  Parent client
                  <select value={clientParentId} onChange={(event) => setClientParentId(event.target.value)}>
                    <option value="">Top-level client</option>
                    {registryClients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Roles
                  <input value={clientRoles} onChange={(event) => setClientRoles(event.target.value)} placeholder="CTO, Main Developer" />
                </label>
                <label>
                  Status
                  <select value={clientStatus} onChange={(event) => setClientStatus(event.target.value as Client['status'])}>
                    <option value="active">Active</option>
                    <option value="prospect">Prospect</option>
                    <option value="on_hold">On hold</option>
                    <option value="archived">Archived</option>
                  </select>
                </label>
                <label className="field-span-2">
                  Notes
                  <textarea value={clientNotes} onChange={(event) => setClientNotes(event.target.value)} placeholder="Engagement summary or context" />
                </label>
              </div>
              <div className="button-row">
                <button
                  className="secondary-button"
                  disabled={!clientName.trim()}
                  onClick={async () => {
                    try {
                      await api.createClient({
                        name: clientName,
                        parentClientId: clientParentId || undefined,
                        roles: splitDelimitedValues(clientRoles),
                        status: clientStatus,
                        notes: clientNotes || undefined,
                      });
                      setClientName('');
                      setClientParentId('');
                      setClientStatus('active');
                      setClientRoles('');
                      setClientNotes('');
                      setShowAddClient(false);
                      await invalidateOps(queryClient);
                      setFeedback('Client added.');
                    } catch (error) {
                      setFeedback(error instanceof Error ? error.message : String(error));
                    }
                  }}
                >
                  Save client
                </button>
              </div>
            </div>
          ) : null}
          {showAddProject ? (
            <div className="registry-editor">
              <div className="field-grid">
                <label>
                  Project name
                  <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Project X" />
                </label>
                <label>
                  Client
                  <select value={projectClientId} onChange={(event) => setProjectClientId(event.target.value)}>
                    <option value="">Unassigned</option>
                    {registryClients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="button-row">
                <button
                  className="secondary-button"
                  disabled={!projectName.trim()}
                  onClick={async () => {
                    try {
                      await api.createProject({
                        name: projectName,
                        clientId: projectClientId || undefined,
                      });
                      setProjectName('');
                      setProjectClientId('');
                      setShowAddProject(false);
                      await invalidateOps(queryClient);
                      setFeedback('Project added.');
                    } catch (error) {
                      setFeedback(error instanceof Error ? error.message : String(error));
                    }
                  }}
                >
                  Save project
                </button>
              </div>
            </div>
          ) : null}
          <div className="registry-tree">
            {rootClients.map((client) => (
              <ClientRegistryCard
                key={client.id}
                client={client}
                clients={registryClients}
                projectsByClient={projectsByClient}
                repositoriesByClient={repositoriesByClient}
                repositoriesByProject={repositoriesByProject}
                expandedState={expandedClientIds}
                onToggleExpanded={toggleClientExpanded}
                onSaved={async (message) => {
                  await invalidateOps(queryClient);
                  setFeedback(message);
                }}
              />
            ))}
          </div>
        </CollapsiblePanel>

        <CollapsiblePanel
          storageKey="connections-25-repositories"
          eyebrow="Repositories"
          title="Repositories"
          subtitle="Discover, assign, and review repositories separately from the core client/project tree."
          defaultExpanded={false}
        >
          <div className="registry-toolbar">
            <button className={`chip-button${showAddRepository ? ' active' : ''}`} onClick={() => setShowAddRepository((current) => !current)}>
              {showAddRepository ? 'Close add repo' : 'Add repository'}
            </button>
            <button className="chip-button" onClick={() => discoverRepositories.mutate()} disabled={discoverRepositories.isPending}>
              {discoverRepositories.isPending ? 'Discovering…' : 'Discover repos in home'}
            </button>
          </div>
          {showAddRepository ? (
            <div className="registry-editor">
              <div className="field-grid">
                <label>
                  Repository path
                  <input value={repositoryPath} onChange={(event) => setRepositoryPath(event.target.value)} placeholder="~/repos/nanoclaw" />
                </label>
                <label>
                  Display name
                  <input value={repositoryName} onChange={(event) => setRepositoryName(event.target.value)} placeholder="Auto-detected from git path" />
                </label>
                <label>
                  Client
                  <select
                    value={repositoryClientId}
                    onChange={(event) => {
                      const nextClientId = event.target.value;
                      setRepositoryClientId(nextClientId);
                      if (
                        repositoryProjectId &&
                        !repositoryProjectOptions(registryProjects, nextClientId || undefined).some((entry) => entry.id === repositoryProjectId)
                      ) {
                        setRepositoryProjectId('');
                      }
                    }}
                  >
                    <option value="">Unassigned</option>
                    {registryClients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Project
                  <select
                    value={repositoryProjectId}
                    onChange={(event) => {
                      const nextProjectId = event.target.value;
                      setRepositoryProjectId(nextProjectId);
                      const nextProject = registryProjects.find((project) => project.id === nextProjectId);
                      if (nextProject?.clientId) setRepositoryClientId(nextProject.clientId);
                    }}
                  >
                    <option value="">Client-level only</option>
                    {repositoryProjectChoices.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-span-2">
                  Notes
                  <textarea value={repositoryNotes} onChange={(event) => setRepositoryNotes(event.target.value)} placeholder="Why this repo matters for the engagement" />
                </label>
              </div>
              <div className="button-row">
                <button
                  className="secondary-button"
                  disabled={!repositoryPath.trim()}
                  onClick={async () => {
                    try {
                      await api.createRepository({
                        name: repositoryName || undefined,
                        localPath: repositoryPath,
                        clientId: repositoryClientId || undefined,
                        projectId: repositoryProjectId || undefined,
                        notes: repositoryNotes || undefined,
                      });
                      setRepositoryName('');
                      setRepositoryPath('');
                      setRepositoryClientId('');
                      setRepositoryProjectId('');
                      setRepositoryNotes('');
                      setShowAddRepository(false);
                      await invalidateOps(queryClient);
                      setFeedback('Repository attached.');
                    } catch (error) {
                      setFeedback(error instanceof Error ? error.message : String(error));
                    }
                  }}
                >
                  Save repository
                </button>
              </div>
            </div>
          ) : null}
          {unassignedRepositories.length ? (
            <div className="registry-project-list">
              {unassignedRepositories.map((repository) => (
                <RepositoryRegistryCard
                  key={repository.id}
                  repository={repository}
                  clients={registryClients}
                  projects={registryProjects}
                  onSaved={async (message) => {
                    await invalidateOps(queryClient);
                    setFeedback(message);
                  }}
                />
              ))}
            </div>
          ) : (
            <EmptyState title="No unassigned repos" body="Discovered and attached repositories will appear here." />
          )}
        </CollapsiblePanel>

        <CollapsiblePanel
          storageKey="connections-25-advanced"
          eyebrow="Advanced"
          title="Advanced"
          subtitle="Audit trail and lower-frequency diagnostics stay here."
          defaultExpanded={false}
        >
          {(correctionsQuery.data?.corrections || []).length ? (
            <div className="stack-gap compact">
              {(correctionsQuery.data?.corrections || []).slice(0, 12).map((correction) => (
                <div key={correction.id} className="record-card compact static-card">
                  <div className="record-card-top">
                    <strong>{correction.field}</strong>
                    <span className="record-time">{formatShortDate(correction.createdAt)}</span>
                  </div>
                  <p>{correction.targetId}</p>
                  <p>{correction.value}</p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No advanced corrections" body="The correction trail will appear here as you override mappings and noise decisions." />
          )}
        </CollapsiblePanel>

        {feedback ? <p className="feedback">{feedback}</p> : null}
      </div>
    </ScreenFrame>
  );
}

export function App() {
  const bootstrapQuery = useQuery({
    queryKey: ['bootstrap'],
    queryFn: api.getBootstrap,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status.runningSyncJobs ? OPS_INTERVAL_BUSY : OPS_INTERVAL_IDLE;
    },
  });

  if (bootstrapQuery.isLoading || !bootstrapQuery.data) {
    return (
      <div className="loading-shell">
        <div className="loading-card">
          <div className="eyebrow">NanoClaw Personal Ops</div>
          <h1>Loading your operational picture…</h1>
        </div>
      </div>
    );
  }

  if (bootstrapQuery.isError) {
    return (
      <div className="loading-shell">
        <div className="loading-card error">
          <div className="eyebrow">Operator UI</div>
          <h1>Could not load the app shell.</h1>
          <p>{bootstrapQuery.error instanceof Error ? bootstrapQuery.error.message : 'Unknown error'}</p>
          <a href="/admin/legacy" className="legacy-link">
            Open legacy admin instead
          </a>
        </div>
      </div>
    );
  }

  const bootstrap = bootstrapQuery.data;

  return (
    <AppShell bootstrap={bootstrap}>
      <Routes>
        <Route path="/" element={<Navigate to="/today" replace />} />
        <Route path="/today" element={<TodayWorkspacePage bootstrap={bootstrap} />} />
        <Route path="/inbox" element={<InboxWorkspacePage bootstrap={bootstrap} />} />
        <Route path="/calendar" element={<CalendarPage bootstrap={bootstrap} />} />
        <Route path="/work" element={<WorkPage bootstrap={bootstrap} />} />
        <Route path="/workboard" element={<Navigate to="/work" replace />} />
        <Route path="/history" element={<HistoryPage bootstrap={bootstrap} />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/queue" element={<Navigate to="/review?tab=approvals" replace />} />
        <Route path="/review" element={<ReviewCenterPage bootstrap={bootstrap} />} />
        <Route path="/connections" element={<ConnectionsSetupPage bootstrap={bootstrap} />} />
        <Route path="/admin" element={<AdminPage bootstrap={bootstrap} />} />
        <Route path="*" element={<Navigate to="/today" replace />} />
      </Routes>
    </AppShell>
  );
}

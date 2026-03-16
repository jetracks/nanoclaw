import path from 'path';

import { ConnectedAccountRecord } from './db.js';
import {
  PersonalOpsConnectionCatalog,
  PersonalOpsConnectionCatalogOption,
  PersonalOpsConnectionSettings,
  PersonalOpsPriority,
  PersonalOpsProvider,
  PersonalOpsSourceKind,
  SourceRecord,
} from '../types.js';

export interface ProviderAccountIdentity {
  accountLabel: string;
  accountId: string;
  baseUrl?: string | null;
  resourceId?: string | null;
}

export interface SyncedProviderRecord {
  source: SourceRecord;
  raw: Record<string, unknown>;
}

export interface ProviderSyncBatch {
  provider: PersonalOpsProvider;
  records: SyncedProviderRecord[];
  cursors: Partial<Record<PersonalOpsSourceKind, string>>;
}

function sortCatalogOptions(
  options: PersonalOpsConnectionCatalogOption[],
): PersonalOpsConnectionCatalogOption[] {
  return [...options].sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    return a.label.localeCompare(b.label);
  });
}

const GMAIL_PAGE_SIZE = 100;
const GMAIL_MAX_MESSAGE_SCAN = 500;
const GMAIL_NOISE_LABELS = new Set([
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_FORUMS',
]);

const GMAIL_SECONDARY_NOISE_LABELS = new Set(['CATEGORY_UPDATES']);

async function fetchJson<T>(
  url: string,
  accessToken: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `${url} returned ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

function inferPriority(text: string): PersonalOpsPriority {
  const lower = text.toLowerCase();
  if (
    lower.includes('urgent') ||
    lower.includes('asap') ||
    lower.includes('today') ||
    lower.includes('blocked')
  ) {
    return 'urgent';
  }
  if (
    lower.includes('tomorrow') ||
    lower.includes('due') ||
    lower.includes('follow up') ||
    lower.includes('review')
  ) {
    return 'high';
  }
  if (lower.includes('fyi') || lower.includes('reference')) {
    return 'low';
  }
  return 'medium';
}

function priorityRank(priority: PersonalOpsPriority): number {
  switch (priority) {
    case 'urgent':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
  }
}

function maxPriority(
  a: PersonalOpsPriority,
  b: PersonalOpsPriority,
): PersonalOpsPriority {
  return priorityRank(a) >= priorityRank(b) ? a : b;
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function gmailHeader(
  headers: Array<{ name?: string; value?: string }>,
  name: string,
): string {
  const header = headers.find(
    (item) => item.name?.toLowerCase() === name.toLowerCase(),
  );
  return cleanText(header?.value);
}

function extractEmailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  if (match?.[1]) return match[1].trim().toLowerCase();
  return value.trim().toLowerCase();
}

function extractEmails(value: string): string[] {
  return Array.from(
    value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi),
    (match) => match[0].toLowerCase(),
  );
}

function isAutomatedMailbox(value: string): boolean {
  const email = extractEmailAddress(value);
  return /(^|[._-])(no-?reply|donotreply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounce|noreply)([._+-]|@|$)/i.test(
    email,
  );
}

function gmailCategory(labelIds: string[]): string {
  if (labelIds.includes('CATEGORY_PERSONAL')) return 'personal';
  if (labelIds.includes('CATEGORY_PROMOTIONS')) return 'promotions';
  if (labelIds.includes('CATEGORY_SOCIAL')) return 'social';
  if (labelIds.includes('CATEGORY_FORUMS')) return 'forums';
  if (labelIds.includes('CATEGORY_UPDATES')) return 'updates';
  return 'primary';
}

function isLikelyNoiseGmailMessage(input: {
  labelIds: string[];
  from: string;
  listUnsubscribe: string;
  precedence: string;
}): boolean {
  if (input.labelIds.includes('SPAM') || input.labelIds.includes('TRASH')) {
    return true;
  }
  if (
    input.labelIds.includes('IMPORTANT') ||
    input.labelIds.includes('STARRED')
  ) {
    return false;
  }
  if (input.labelIds.some((label) => GMAIL_NOISE_LABELS.has(label))) {
    return true;
  }
  const automated = isAutomatedMailbox(input.from);
  const hasListUnsubscribe = Boolean(input.listUnsubscribe);
  const precedence = input.precedence.toLowerCase();
  if (
    input.labelIds.some((label) => GMAIL_SECONDARY_NOISE_LABELS.has(label)) &&
    (automated || hasListUnsubscribe)
  ) {
    return true;
  }
  if (
    automated &&
    (hasListUnsubscribe ||
      precedence.includes('bulk') ||
      precedence.includes('list') ||
      precedence.includes('junk'))
  ) {
    return true;
  }
  return false;
}

function inferGmailPriority(input: {
  title: string;
  snippet: string;
  labelIds: string[];
  from: string;
  listUnsubscribe: string;
  precedence: string;
}): PersonalOpsPriority {
  let priority = inferPriority(`${input.title} ${input.snippet}`);
  if (isLikelyNoiseGmailMessage(input)) {
    return 'low';
  }
  if (input.labelIds.includes('IMPORTANT')) {
    priority = maxPriority(priority, 'high');
  }
  if (input.labelIds.includes('STARRED')) {
    priority = maxPriority(priority, 'high');
  }
  if (input.labelIds.includes('UNREAD') && !isAutomatedMailbox(input.from)) {
    priority = maxPriority(priority, 'high');
  }
  if (input.labelIds.includes('CATEGORY_PERSONAL')) {
    priority = maxPriority(priority, 'medium');
  }
  return priority;
}

function parseIsoTimestamp(
  value: string | undefined,
  fallback: string,
): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString();
}

function normalizeSelectedIds(
  selected: string[] | undefined,
  fallback: string[],
): string[] {
  const normalized = (selected || [])
    .map((entry) => cleanText(entry))
    .filter(Boolean);
  return normalized.length ? normalized : fallback;
}

function plusDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

async function fetchSlackJson<T>(
  method: string,
  accessToken: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(
      `${url} returned ${response.status}: ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  if (payload.ok === false) {
    throw new Error(
      `${method} returned ${String(payload.error || 'unknown_error')}`,
    );
  }
  return payload as T;
}

function slackTsToIso(ts: string | undefined, fallback: string): string {
  if (!ts) return fallback;
  const numeric = Number.parseFloat(ts);
  if (Number.isNaN(numeric)) return fallback;
  return new Date(numeric * 1000).toISOString();
}

function slackPermalink(
  baseUrl: string | null | undefined,
  channelId: string,
  ts: string,
): string | null {
  if (!baseUrl) return null;
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${normalized}archives/${channelId}/p${ts.replace('.', '')}`;
}

function cleanSlackText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<mailto:([^>|]+)\|([^>]+)>/g, '$2 <$1>')
    .replace(/<https?:\/\/([^>|]+)\|([^>]+)>/g, '$2')
    .replace(/<https?:\/\/([^>]+)>/g, 'https://$1')
    .replace(/<@([A-Z0-9]+)>/g, '@$1')
    .replace(/<!channel>/g, '@channel')
    .replace(/<!here>/g, '@here')
    .replace(/<!everyone>/g, '@everyone')
    .replace(/<#([A-Z0-9]+)\|([^>]+)>/g, '#$2')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function slackConversationLabel(
  conversation: {
    id: string;
    name?: string;
    user?: string;
    is_im?: boolean;
    is_mpim?: boolean;
    is_private?: boolean;
  },
  users: Map<string, string>,
): string {
  if (conversation.is_im) {
    return users.get(conversation.user || '') || 'Direct message';
  }
  if (conversation.is_mpim) {
    return conversation.name
      ? conversation.name.replace(/--/g, ', ')
      : 'Group DM';
  }
  if (conversation.name) {
    return `#${conversation.name}`;
  }
  return conversation.id;
}

function inferSlackPriority(
  text: string,
  metadata: {
    isDirectMessage: boolean;
    mentionsSelf: boolean;
    isPrivateChannel: boolean;
  },
): PersonalOpsPriority {
  let priority = inferPriority(text);
  if (metadata.mentionsSelf) {
    priority = maxPriority(priority, 'high');
  }
  if (metadata.isDirectMessage) {
    priority = maxPriority(priority, 'high');
  }
  if (metadata.isPrivateChannel) {
    priority = maxPriority(priority, 'medium');
  }
  return priority;
}

export async function fetchProviderIdentity(
  provider: PersonalOpsProvider,
  accessToken: string,
): Promise<ProviderAccountIdentity> {
  switch (provider) {
    case 'google': {
      const profile = await fetchJson<{
        emailAddress: string;
        messagesTotal?: number;
      }>('https://gmail.googleapis.com/gmail/v1/users/me/profile', accessToken);
      return {
        accountLabel: profile.emailAddress,
        accountId: profile.emailAddress,
      };
    }
    case 'microsoft': {
      const me = await fetchJson<{
        id: string;
        displayName?: string;
        mail?: string;
        userPrincipalName?: string;
      }>(
        'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName',
        accessToken,
      );
      return {
        accountLabel: cleanText(
          me.mail || me.userPrincipalName || me.displayName || me.id,
        ),
        accountId: me.id,
      };
    }
    case 'jira': {
      const resources = await fetchJson<
        Array<{ id: string; name: string; url: string }>
      >(
        'https://api.atlassian.com/oauth/token/accessible-resources',
        accessToken,
      );
      if (resources.length === 0) {
        throw new Error('Jira accessible resources returned no sites.');
      }
      return {
        accountLabel: resources[0].name,
        accountId: resources[0].id,
        baseUrl: resources[0].url,
        resourceId: resources[0].id,
      };
    }
    case 'slack': {
      const auth = await fetchSlackJson<{
        team?: string;
        team_id?: string;
        url?: string;
        user_id?: string;
      }>('auth.test', accessToken);
      if (!auth.team_id) {
        throw new Error('Slack auth.test did not return a team id.');
      }
      return {
        accountLabel:
          cleanText(auth.team) || cleanText(auth.url) || auth.team_id,
        accountId: auth.team_id,
        baseUrl: cleanText(auth.url) || null,
        resourceId: cleanText(auth.user_id) || null,
      };
    }
  }
}

export async function fetchProviderConnectionCatalog(input: {
  account: ConnectedAccountRecord;
}): Promise<PersonalOpsConnectionCatalog> {
  const { account } = input;
  const baseCatalog: PersonalOpsConnectionCatalog = {
    provider: account.provider,
    accountId: account.accountId || '',
    accountLabel: account.accountLabel,
    mailLabels: [],
    mailFolders: [],
    calendars: [],
    projects: [],
    channels: [],
  };

  if (!account.accessToken) {
    return baseCatalog;
  }

  switch (account.provider) {
    case 'google': {
      const [labels, calendars] = await Promise.all([
        fetchJson<{
          labels?: Array<{ id?: string; name?: string; type?: string }>;
        }>(
          'https://gmail.googleapis.com/gmail/v1/users/me/labels',
          account.accessToken,
        ),
        fetchJson<{
          items?: Array<{ id?: string; summary?: string; primary?: boolean }>;
        }>(
          'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250',
          account.accessToken,
        ),
      ]);
      return {
        ...baseCatalog,
        mailLabels: sortCatalogOptions(
          (labels.labels || [])
            .map((label) => ({
              id: cleanText(label.id),
              label: cleanText(label.name) || cleanText(label.id),
              kind: cleanText(label.type) || null,
              isDefault: cleanText(label.id) === 'INBOX',
            }))
            .filter((label) => label.id && label.label),
        ),
        calendars: sortCatalogOptions(
          (calendars.items || [])
            .map((calendar) => ({
              id: cleanText(calendar.id),
              label: cleanText(calendar.summary) || cleanText(calendar.id),
              isDefault:
                Boolean(calendar.primary) ||
                cleanText(calendar.id) === 'primary',
            }))
            .filter((calendar) => calendar.id && calendar.label),
        ),
      };
    }
    case 'microsoft': {
      const [mailFolders, calendars] = await Promise.all([
        fetchJson<{
          value?: Array<{
            id?: string;
            displayName?: string;
            childFolderCount?: number;
          }>;
        }>(
          'https://graph.microsoft.com/v1.0/me/mailFolders?$top=250&$select=id,displayName,childFolderCount',
          account.accessToken,
        ),
        fetchJson<{
          value?: Array<{
            id?: string;
            name?: string;
            isDefaultCalendar?: boolean;
          }>;
        }>(
          'https://graph.microsoft.com/v1.0/me/calendars?$top=250&$select=id,name,isDefaultCalendar',
          account.accessToken,
        ),
      ]);
      return {
        ...baseCatalog,
        mailFolders: sortCatalogOptions(
          (mailFolders.value || [])
            .map((folder) => ({
              id: cleanText(folder.id),
              label: cleanText(folder.displayName) || cleanText(folder.id),
              secondaryLabel:
                typeof folder.childFolderCount === 'number'
                  ? `${folder.childFolderCount} subfolders`
                  : null,
              isDefault:
                cleanText(folder.displayName).toLowerCase() === 'inbox',
            }))
            .filter((folder) => folder.id && folder.label),
        ),
        calendars: sortCatalogOptions(
          (calendars.value || [])
            .map((calendar) => ({
              id: cleanText(calendar.id),
              label: cleanText(calendar.name) || cleanText(calendar.id),
              isDefault: Boolean(calendar.isDefaultCalendar),
            }))
            .filter((calendar) => calendar.id && calendar.label),
        ),
      };
    }
    case 'jira': {
      if (!account.resourceId) {
        return baseCatalog;
      }
      const payload = await fetchJson<{
        values?: Array<{
          key?: string;
          name?: string;
          projectTypeKey?: string;
        }>;
      }>(
        `https://api.atlassian.com/ex/jira/${account.resourceId}/rest/api/3/project/search?maxResults=100`,
        account.accessToken,
      );
      return {
        ...baseCatalog,
        projects: sortCatalogOptions(
          (payload.values || [])
            .map((project) => ({
              id: cleanText(project.key),
              label: cleanText(project.name) || cleanText(project.key),
              secondaryLabel: cleanText(project.projectTypeKey) || null,
            }))
            .filter((project) => project.id && project.label),
        ),
      };
    }
    case 'slack': {
      const conversations: Array<{
        id: string;
        name?: string;
        user?: string;
        is_im?: boolean;
        is_mpim?: boolean;
        is_private?: boolean;
        is_member?: boolean;
      }> = [];
      const userCache = new Map<string, string>();
      if (account.resourceId) {
        userCache.set(account.resourceId, 'You');
      }
      const loadUserLabel = async (userId: string): Promise<string> => {
        if (!userId) return '';
        const cached = userCache.get(userId);
        if (cached) return cached;
        const user = await fetchSlackJson<{
          user?: {
            profile?: { display_name?: string; real_name?: string };
            real_name?: string;
            name?: string;
          };
        }>('users.info', account.accessToken!, { user: userId });
        const label =
          cleanText(user.user?.profile?.display_name) ||
          cleanText(user.user?.profile?.real_name) ||
          cleanText(user.user?.real_name) ||
          cleanText(user.user?.name) ||
          userId;
        userCache.set(userId, label);
        return label;
      };
      let cursor: string | undefined;
      do {
        const page = await fetchSlackJson<{
          channels?: Array<{
            id: string;
            name?: string;
            user?: string;
            is_im?: boolean;
            is_mpim?: boolean;
            is_private?: boolean;
            is_member?: boolean;
          }>;
          response_metadata?: { next_cursor?: string };
        }>('users.conversations', account.accessToken, {
          types: 'public_channel,private_channel,im,mpim',
          exclude_archived: 'true',
          limit: '200',
          cursor: cursor || '',
        });
        conversations.push(...(page.channels || []));
        cursor = cleanText(page.response_metadata?.next_cursor);
      } while (cursor);

      const channels: PersonalOpsConnectionCatalogOption[] = [];
      for (const conversation of conversations) {
        const label =
          conversation.is_im && conversation.user
            ? await loadUserLabel(conversation.user)
            : slackConversationLabel(conversation, userCache);
        channels.push({
          id: conversation.id,
          label,
          kind: conversation.is_im
            ? 'dm'
            : conversation.is_mpim
              ? 'group_dm'
              : conversation.is_private
                ? 'private_channel'
                : 'channel',
        });
      }

      return {
        ...baseCatalog,
        channels: sortCatalogOptions(
          channels.filter((channel) => channel.id && channel.label),
        ),
      };
    }
  }
}

export async function syncProviderData(input: {
  account: ConnectedAccountRecord;
  since: string;
  settings?: PersonalOpsConnectionSettings;
}): Promise<ProviderSyncBatch> {
  switch (input.account.provider) {
    case 'google':
      return syncGoogleData(input.account, input.since, input.settings);
    case 'microsoft':
      return syncMicrosoftData(input.account, input.since, input.settings);
    case 'jira':
      return syncJiraData(input.account, input.since, input.settings);
    case 'slack':
      return syncSlackData(input.account, input.since, input.settings);
  }
}

async function syncGoogleData(
  account: ConnectedAccountRecord,
  since: string,
  settings?: PersonalOpsConnectionSettings,
): Promise<ProviderSyncBatch> {
  if (!account.accessToken) {
    throw new Error('Google account is missing an access token.');
  }
  const sinceDate = new Date(since);
  const afterSeconds = Math.floor(sinceDate.getTime() / 1000);
  const googleMailQuery = cleanText(settings?.googleMailQuery);
  const mailRefs: Array<{ id: string; threadId: string }> = [];
  let nextPageToken: string | undefined;
  do {
    const listUrl = new URL(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages',
    );
    listUrl.searchParams.set('maxResults', String(GMAIL_PAGE_SIZE));
    listUrl.searchParams.set(
      'q',
      googleMailQuery
        ? `${googleMailQuery} after:${afterSeconds}`
        : `after:${afterSeconds}`,
    );
    listUrl.searchParams.set('includeSpamTrash', 'false');
    if (!googleMailQuery) {
      listUrl.searchParams.append('labelIds', 'INBOX');
    }
    if (nextPageToken) {
      listUrl.searchParams.set('pageToken', nextPageToken);
    }
    const page = await fetchJson<{
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
    }>(listUrl.toString(), account.accessToken);
    mailRefs.push(...(page.messages || []));
    nextPageToken =
      mailRefs.length < GMAIL_MAX_MESSAGE_SCAN ? page.nextPageToken : undefined;
  } while (nextPageToken);

  const mailRecords: SyncedProviderRecord[] = [];
  const sourceScope = {
    connectionKey: account.connectionKey,
    accountId: account.accountId,
    accountLabel: account.accountLabel,
  };
  let newestMail = since;
  for (const messageRef of mailRefs) {
    const message = await fetchJson<{
      id: string;
      threadId: string;
      snippet?: string;
      internalDate?: string;
      labelIds?: string[];
      payload?: { headers?: Array<{ name?: string; value?: string }> };
    }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageRef.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=Precedence`,
      account.accessToken,
    );
    const headers = message.payload?.headers || [];
    const occurredAt = parseIsoTimestamp(
      message.internalDate
        ? new Date(Number(message.internalDate)).toISOString()
        : undefined,
      since,
    );
    if (occurredAt > newestMail) newestMail = occurredAt;
    const title = gmailHeader(headers, 'Subject') || '(no subject)';
    const from = gmailHeader(headers, 'From');
    const to = gmailHeader(headers, 'To');
    const cc = gmailHeader(headers, 'Cc');
    const labelIds = message.labelIds || [];
    const listUnsubscribe = gmailHeader(headers, 'List-Unsubscribe');
    const precedence = gmailHeader(headers, 'Precedence');
    const likelyNoise = isLikelyNoiseGmailMessage({
      labelIds,
      from,
      listUnsubscribe,
      precedence,
    });
    mailRecords.push({
      source: {
        ...sourceScope,
        provider: 'google',
        kind: 'email',
        externalId: message.id,
        externalParentId: message.threadId,
        sourceUrl: `https://mail.google.com/mail/u/0/#inbox/${message.threadId}`,
        title,
        summary: cleanText(message.snippet),
        body: cleanText(message.snippet),
        participants: [from, to].filter(Boolean),
        occurredAt,
        priority: inferGmailPriority({
          title,
          snippet: cleanText(message.snippet),
          labelIds,
          from,
          listUnsubscribe,
          precedence,
        }),
        status: likelyNoise ? 'filtered' : 'received',
        syncedAt: new Date().toISOString(),
        metadata: {
          threadId: message.threadId,
          labelIds,
          category: gmailCategory(labelIds),
          fromAddress: extractEmailAddress(from),
          toRecipientAddresses: extractEmails(to || ''),
          ccRecipientAddresses: extractEmails(cc || ''),
          isUnread: labelIds.includes('UNREAD'),
          isImportant: labelIds.includes('IMPORTANT'),
          isStarred: labelIds.includes('STARRED'),
          automatedSender: isAutomatedMailbox(from),
          likelyNoise,
        },
      },
      raw: message as unknown as Record<string, unknown>,
    });
  }

  const calendarList = await fetchJson<{
    items?: Array<{ id?: string; summary?: string; primary?: boolean }>;
  }>(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250',
    account.accessToken,
  );
  const selectedCalendarIds = normalizeSelectedIds(
    settings?.googleCalendarIds,
    ['primary'],
  );
  const calendarMeta = new Map(
    (calendarList.items || []).map((calendar) => [
      cleanText(calendar.id),
      cleanText(calendar.summary) || cleanText(calendar.id),
    ]),
  );
  const calendarRecords: SyncedProviderRecord[] = [];
  let newestEvent = since;
  for (const calendarId of selectedCalendarIds) {
    const events = await fetchJson<{
      items?: Array<{
        id: string;
        summary?: string;
        description?: string;
        htmlLink?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
        attendees?: Array<{ email?: string; displayName?: string }>;
        organizer?: { email?: string };
      }>;
    }>(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(since)}&singleEvents=true&orderBy=startTime&maxResults=100`,
      account.accessToken,
    );
    for (const event of events.items || []) {
      const occurredAt = parseIsoTimestamp(
        event.start?.dateTime || event.start?.date,
        since,
      );
      if (occurredAt > newestEvent) newestEvent = occurredAt;
      const eventId =
        selectedCalendarIds.length > 1 || calendarId !== 'primary'
          ? `${calendarId}:${event.id}`
          : event.id;
      calendarRecords.push({
        source: {
          ...sourceScope,
          provider: 'google',
          kind: 'calendar_event',
          externalId: eventId,
          sourceUrl: event.htmlLink || null,
          title: cleanText(event.summary) || '(untitled event)',
          summary: cleanText(event.description) || cleanText(event.summary),
          body: cleanText(event.description),
          participants: [
            cleanText(event.organizer?.email),
            ...(event.attendees || []).map((attendee) =>
              cleanText(attendee.email || attendee.displayName),
            ),
          ].filter(Boolean),
          occurredAt,
          dueAt: parseIsoTimestamp(
            event.end?.dateTime || event.end?.date,
            occurredAt,
          ),
          priority: inferPriority(
            `${event.summary || ''} ${event.description || ''}`,
          ),
          status: 'scheduled',
          syncedAt: new Date().toISOString(),
          metadata: {
            end: event.end,
            organizer: event.organizer,
            calendarId,
            calendarLabel: calendarMeta.get(calendarId) || calendarId,
          },
        },
        raw: event as unknown as Record<string, unknown>,
      });
    }
  }

  return {
    provider: 'google',
    records: [...mailRecords, ...calendarRecords],
    cursors: {
      email: newestMail,
      calendar_event: newestEvent,
    },
  };
}

async function syncMicrosoftData(
  account: ConnectedAccountRecord,
  since: string,
  settings?: PersonalOpsConnectionSettings,
): Promise<ProviderSyncBatch> {
  if (!account.accessToken) {
    throw new Error('Microsoft account is missing an access token.');
  }
  const encodedSince = encodeURIComponent(since);
  const mailRecords: SyncedProviderRecord[] = [];
  const sourceScope = {
    connectionKey: account.connectionKey,
    accountId: account.accountId,
    accountLabel: account.accountLabel,
  };
  let newestMail = since;
  const mailFolderIds = normalizeSelectedIds(
    settings?.microsoftMailFolderIds,
    [],
  );
  const folderCatalog = mailFolderIds.length
    ? await fetchJson<{
        value?: Array<{ id?: string; displayName?: string }>;
      }>(
        'https://graph.microsoft.com/v1.0/me/mailFolders?$top=250&$select=id,displayName',
        account.accessToken,
      )
    : { value: [] };
  const folderLabels = new Map(
    (folderCatalog.value || []).map((folder) => [
      cleanText(folder.id),
      cleanText(folder.displayName) || cleanText(folder.id),
    ]),
  );
  const messageSources = mailFolderIds.length
    ? mailFolderIds.map((folderId) => ({
        folderId,
        url:
          `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folderId)}` +
          `/messages?$top=25&$select=id,conversationId,subject,bodyPreview,webLink,receivedDateTime,importance,from,sender,toRecipients,ccRecipients,bccRecipients` +
          `&$filter=receivedDateTime ge ${encodedSince}`,
      }))
    : [
        {
          folderId: 'inbox',
          url:
            `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=25&$select=id,conversationId,subject,bodyPreview,webLink,receivedDateTime,importance,from,sender,toRecipients,ccRecipients,bccRecipients` +
            `&$filter=receivedDateTime ge ${encodedSince}`,
        },
      ];
  for (const messageSource of messageSources) {
    const messages = await fetchJson<{
      value?: Array<{
        id: string;
        conversationId?: string;
        subject?: string;
        bodyPreview?: string;
        webLink?: string;
        receivedDateTime?: string;
        importance?: string;
        from?: { emailAddress?: { address?: string; name?: string } };
        sender?: { emailAddress?: { address?: string; name?: string } };
        toRecipients?: Array<{
          emailAddress?: { address?: string; name?: string };
        }>;
        ccRecipients?: Array<{
          emailAddress?: { address?: string; name?: string };
        }>;
        bccRecipients?: Array<{
          emailAddress?: { address?: string; name?: string };
        }>;
      }>;
    }>(messageSource.url, account.accessToken);
    for (const message of messages.value || []) {
      const occurredAt = parseIsoTimestamp(message.receivedDateTime, since);
      if (occurredAt > newestMail) newestMail = occurredAt;
      const title = cleanText(message.subject) || '(no subject)';
      const preview = cleanText(message.bodyPreview);
      const fromAddress = cleanText(
        message.from?.emailAddress?.address || message.from?.emailAddress?.name,
      );
      const senderAddress = cleanText(
        message.sender?.emailAddress?.address ||
          message.sender?.emailAddress?.name,
      );
      const toRecipientAddresses = (message.toRecipients || [])
        .map((recipient) =>
          cleanText(
            recipient.emailAddress?.address || recipient.emailAddress?.name,
          ),
        )
        .filter(Boolean);
      const ccRecipientAddresses = (message.ccRecipients || [])
        .map((recipient) =>
          cleanText(
            recipient.emailAddress?.address || recipient.emailAddress?.name,
          ),
        )
        .filter(Boolean);
      const bccRecipientAddresses = (message.bccRecipients || [])
        .map((recipient) =>
          cleanText(
            recipient.emailAddress?.address || recipient.emailAddress?.name,
          ),
        )
        .filter(Boolean);
      mailRecords.push({
        source: {
          ...sourceScope,
          provider: 'microsoft',
          kind: 'email',
          externalId: message.id,
          externalParentId: message.conversationId || null,
          sourceUrl: message.webLink || null,
          title,
          summary: preview,
          body: preview,
          participants: [
            fromAddress,
            senderAddress,
            ...toRecipientAddresses,
            ...ccRecipientAddresses,
            ...bccRecipientAddresses,
          ].filter(Boolean),
          occurredAt,
          priority: inferPriority(
            `${message.importance || ''} ${title} ${preview}`,
          ),
          status: 'received',
          syncedAt: new Date().toISOString(),
          metadata: {
            conversationId: message.conversationId,
            mailFolderId: messageSource.folderId,
            mailFolderLabel: messageSource.folderId
              ? folderLabels.get(messageSource.folderId) ||
                messageSource.folderId
              : 'Inbox',
            fromAddress,
            senderAddress,
            toRecipientAddresses,
            ccRecipientAddresses,
            bccRecipientAddresses,
          },
        },
        raw: message as unknown as Record<string, unknown>,
      });
    }
  }

  const calendarWindowStart = startOfDay(
    plusDays(new Date(), -14),
  ).toISOString();
  const calendarWindowEnd = plusDays(new Date(), 45).toISOString();
  const calendarIds = normalizeSelectedIds(settings?.microsoftCalendarIds, []);
  const calendarsCatalog = calendarIds.length
    ? await fetchJson<{
        value?: Array<{
          id?: string;
          name?: string;
          isDefaultCalendar?: boolean;
        }>;
      }>(
        'https://graph.microsoft.com/v1.0/me/calendars?$top=250&$select=id,name,isDefaultCalendar',
        account.accessToken,
      )
    : { value: [] };
  const calendarLabels = new Map(
    (calendarsCatalog.value || []).map((calendar) => [
      cleanText(calendar.id),
      cleanText(calendar.name) || cleanText(calendar.id),
    ]),
  );
  const calendarUrls = calendarIds.length
    ? calendarIds.map((calendarId) => {
        const url = new URL(
          `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView`,
        );
        url.searchParams.set('startDateTime', calendarWindowStart);
        url.searchParams.set('endDateTime', calendarWindowEnd);
        url.searchParams.set(
          '$select',
          'id,subject,bodyPreview,webLink,start,end,attendees,organizer',
        );
        url.searchParams.set('$top', '250');
        return { calendarId, url: url.toString() };
      })
    : [
        (() => {
          const url = new URL(
            'https://graph.microsoft.com/v1.0/me/calendarView',
          );
          url.searchParams.set('startDateTime', calendarWindowStart);
          url.searchParams.set('endDateTime', calendarWindowEnd);
          url.searchParams.set(
            '$select',
            'id,subject,bodyPreview,webLink,start,end,attendees,organizer',
          );
          url.searchParams.set('$top', '250');
          return { calendarId: null, url: url.toString() };
        })(),
      ];
  const calendarRecords: SyncedProviderRecord[] = [];
  for (const calendarSource of calendarUrls) {
    const events = await fetchJson<{
      value?: Array<{
        id: string;
        subject?: string;
        bodyPreview?: string;
        webLink?: string;
        start?: { dateTime?: string; timeZone?: string };
        end?: { dateTime?: string; timeZone?: string };
        attendees?: Array<{
          emailAddress?: { address?: string; name?: string };
        }>;
        organizer?: { emailAddress?: { address?: string; name?: string } };
      }>;
    }>(calendarSource.url, account.accessToken);
    for (const event of events.value || []) {
      const occurredAt = parseIsoTimestamp(event.start?.dateTime, since);
      const eventId =
        calendarUrls.length > 1 && calendarSource.calendarId
          ? `${calendarSource.calendarId}:${event.id}`
          : event.id;
      calendarRecords.push({
        source: {
          ...sourceScope,
          provider: 'microsoft',
          kind: 'calendar_event',
          externalId: eventId,
          sourceUrl: event.webLink || null,
          title: cleanText(event.subject) || '(untitled event)',
          summary: cleanText(event.bodyPreview) || cleanText(event.subject),
          body: cleanText(event.bodyPreview),
          participants: [
            cleanText(
              event.organizer?.emailAddress?.address ||
                event.organizer?.emailAddress?.name,
            ),
            ...(event.attendees || []).map((attendee) =>
              cleanText(
                attendee.emailAddress?.address || attendee.emailAddress?.name,
              ),
            ),
          ].filter(Boolean),
          occurredAt,
          dueAt: parseIsoTimestamp(event.end?.dateTime, occurredAt),
          priority: inferPriority(
            `${event.subject || ''} ${event.bodyPreview || ''}`,
          ),
          status: 'scheduled',
          syncedAt: new Date().toISOString(),
          metadata: {
            start: event.start,
            end: event.end,
            calendarId: calendarSource.calendarId,
            calendarLabel: calendarSource.calendarId
              ? calendarLabels.get(calendarSource.calendarId) ||
                calendarSource.calendarId
              : 'Default calendar',
          },
        },
        raw: event as unknown as Record<string, unknown>,
      });
    }
  }

  return {
    provider: 'microsoft',
    records: [...mailRecords, ...calendarRecords],
    cursors: {
      email: newestMail,
      calendar_event: new Date().toISOString(),
    },
  };
}

async function syncJiraData(
  account: ConnectedAccountRecord,
  since: string,
  settings?: PersonalOpsConnectionSettings,
): Promise<ProviderSyncBatch> {
  if (!account.accessToken || !account.resourceId) {
    throw new Error('Jira account is missing an access token or resource id.');
  }
  const jqlClauses: string[] = [`updated >= "${since}"`];
  if (settings?.jiraProjectKeys?.length) {
    jqlClauses.unshift(
      `project in (${settings.jiraProjectKeys.map((key) => `"${key}"`).join(', ')})`,
    );
  }
  if (cleanText(settings?.jiraJql)) {
    jqlClauses.unshift(`(${cleanText(settings?.jiraJql)})`);
  }
  const jql = `${jqlClauses.join(' AND ')} ORDER BY updated DESC`;
  const endpoint = `https://api.atlassian.com/ex/jira/${account.resourceId}/rest/api/3/search/jql?maxResults=100&fields=summary,status,priority,assignee,reporter,duedate,updated,project,description&jql=${encodeURIComponent(jql)}`;
  const payload = await fetchJson<{
    issues?: Array<{
      id: string;
      key: string;
      self?: string;
      fields?: {
        summary?: string;
        description?: unknown;
        updated?: string;
        duedate?: string;
        priority?: { name?: string };
        status?: { name?: string };
        assignee?: { displayName?: string; emailAddress?: string };
        reporter?: { displayName?: string; emailAddress?: string };
        project?: { key?: string; name?: string };
      };
    }>;
  }>(endpoint, account.accessToken);

  const records: SyncedProviderRecord[] = [];
  const sourceScope = {
    connectionKey: account.connectionKey,
    accountId: account.accountId,
    accountLabel: account.accountLabel,
  };
  let newestIssue = since;
  for (const issue of payload.issues || []) {
    const updated = parseIsoTimestamp(issue.fields?.updated, since);
    if (updated > newestIssue) newestIssue = updated;
    const description =
      typeof issue.fields?.description === 'string'
        ? issue.fields.description
        : JSON.stringify(issue.fields?.description || '');
    const title = `${issue.key}: ${cleanText(issue.fields?.summary) || '(untitled issue)'}`;
    records.push({
      source: {
        ...sourceScope,
        provider: 'jira',
        kind: 'jira_issue',
        externalId: issue.key,
        externalParentId: issue.id,
        sourceUrl: account.baseUrl
          ? `${account.baseUrl}/browse/${issue.key}`
          : issue.self || null,
        title,
        summary: cleanText(issue.fields?.summary),
        body: cleanText(description),
        participants: [
          cleanText(
            issue.fields?.assignee?.emailAddress ||
              issue.fields?.assignee?.displayName,
          ),
          cleanText(
            issue.fields?.reporter?.emailAddress ||
              issue.fields?.reporter?.displayName,
          ),
        ].filter(Boolean),
        occurredAt: updated,
        dueAt: issue.fields?.duedate || null,
        priority: inferPriority(
          `${issue.fields?.priority?.name || ''} ${title} ${description}`,
        ),
        status: cleanText(issue.fields?.status?.name) || 'open',
        syncedAt: new Date().toISOString(),
        metadata: {
          projectKey: issue.fields?.project?.key,
          projectName: issue.fields?.project?.name,
          priorityName: issue.fields?.priority?.name,
        },
      },
      raw: issue as unknown as Record<string, unknown>,
    });
  }

  return {
    provider: 'jira',
    records,
    cursors: {
      jira_issue: newestIssue,
    },
  };
}

async function syncSlackData(
  account: ConnectedAccountRecord,
  since: string,
  settings?: PersonalOpsConnectionSettings,
): Promise<ProviderSyncBatch> {
  if (!account.accessToken) {
    throw new Error('Slack account is missing an access token.');
  }

  const userCache = new Map<string, string>();
  if (account.resourceId) {
    userCache.set(account.resourceId, 'You');
  }

  const loadUserLabel = async (userId: string): Promise<string> => {
    if (!userId) return '';
    const cached = userCache.get(userId);
    if (cached) return cached;
    const user = await fetchSlackJson<{
      user?: {
        profile?: { display_name?: string; real_name?: string };
        real_name?: string;
        name?: string;
      };
    }>('users.info', account.accessToken!, { user: userId });
    const label =
      cleanText(user.user?.profile?.display_name) ||
      cleanText(user.user?.profile?.real_name) ||
      cleanText(user.user?.real_name) ||
      cleanText(user.user?.name) ||
      userId;
    userCache.set(userId, label);
    return label;
  };

  const sourceScope = {
    connectionKey: account.connectionKey,
    accountId: account.accountId,
    accountLabel: account.accountLabel,
  };

  const oldest = `${Math.floor(new Date(since).getTime() / 1000)}`;
  const conversations: Array<{
    id: string;
    name?: string;
    user?: string;
    is_im?: boolean;
    is_mpim?: boolean;
    is_private?: boolean;
    is_member?: boolean;
    updated?: number;
  }> = [];
  let cursor: string | undefined;
  do {
    const page = await fetchSlackJson<{
      channels?: Array<{
        id: string;
        name?: string;
        user?: string;
        is_im?: boolean;
        is_mpim?: boolean;
        is_private?: boolean;
        is_member?: boolean;
        updated?: number;
      }>;
      response_metadata?: { next_cursor?: string };
    }>('users.conversations', account.accessToken, {
      types: 'public_channel,private_channel,im,mpim',
      exclude_archived: 'true',
      limit: '200',
      cursor: cursor || '',
    });
    conversations.push(...(page.channels || []));
    cursor = cleanText(page.response_metadata?.next_cursor);
  } while (cursor);

  const includedChannels = new Set(settings?.slackIncludedChannelIds || []);
  const excludedChannels = new Set(settings?.slackExcludedChannelIds || []);
  const candidateConversations = conversations
    .filter((conversation) => {
      if (excludedChannels.has(conversation.id)) return false;
      if (includedChannels.size > 0 && !includedChannels.has(conversation.id)) {
        return false;
      }
      if (conversation.is_im || conversation.is_mpim) return true;
      return conversation.is_member !== false;
    })
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .slice(0, 25);

  const records: SyncedProviderRecord[] = [];
  let newestMessage = since;
  for (const conversation of candidateConversations) {
    const history = await fetchSlackJson<{
      messages?: Array<{
        type?: string;
        subtype?: string;
        text?: string;
        ts?: string;
        thread_ts?: string;
        user?: string;
        bot_id?: string;
        reply_count?: number;
      }>;
    }>('conversations.history', account.accessToken, {
      channel: conversation.id,
      oldest,
      inclusive: 'true',
      limit: '15',
    });

    for (const message of history.messages || []) {
      if (message.type !== 'message') continue;
      if (message.subtype && message.subtype !== 'thread_broadcast') continue;
      const text = cleanSlackText(message.text);
      if (!text) continue;

      const occurredAt = slackTsToIso(message.ts, since);
      if (occurredAt > newestMessage) newestMessage = occurredAt;

      const actorId = cleanText(message.user);
      const actorLabel = actorId ? await loadUserLabel(actorId) : 'Slack app';
      const channelLabel = slackConversationLabel(conversation, userCache);
      const isDirectMessage = Boolean(conversation.is_im);
      const mentionsSelf = Boolean(
        account.resourceId && text.includes(`<@${account.resourceId}>`),
      );
      const priority = inferSlackPriority(text, {
        isDirectMessage,
        mentionsSelf,
        isPrivateChannel: Boolean(conversation.is_private),
      });

      records.push({
        source: {
          ...sourceScope,
          provider: 'slack',
          kind: 'slack_message',
          externalId: `${conversation.id}:${message.ts}`,
          externalParentId:
            message.thread_ts && message.thread_ts !== message.ts
              ? `${conversation.id}:${message.thread_ts}`
              : conversation.id,
          sourceUrl: slackPermalink(
            account.baseUrl,
            conversation.id,
            message.ts || '',
          ),
          title: `${channelLabel} • ${text.slice(0, 96) || '(message)'}`,
          summary: text.slice(0, 220),
          body: text,
          participants: [actorLabel, channelLabel].filter(Boolean),
          occurredAt,
          priority,
          status: 'received',
          syncedAt: new Date().toISOString(),
          metadata: {
            channelId: conversation.id,
            channelLabel,
            channelType: conversation.is_im
              ? 'dm'
              : conversation.is_mpim
                ? 'group_dm'
                : conversation.is_private
                  ? 'private_channel'
                  : 'channel',
            authorId: actorId || null,
            authorLabel: actorLabel,
            isDirectMessage,
            isPrivateChannel: Boolean(conversation.is_private),
            mentionsSelf,
            replyCount: message.reply_count || 0,
            botId: cleanText(message.bot_id) || null,
          },
        },
        raw: {
          conversation,
          message,
        },
      });
    }
  }

  return {
    provider: 'slack',
    records,
    cursors: {
      slack_message: newestMessage,
    },
  };
}

export function providerRawSnapshotPath(
  storeDir: string,
  provider: PersonalOpsProvider,
  accountId: string | null,
  kind: PersonalOpsSourceKind,
  externalId: string,
): string {
  return path.join(
    storeDir,
    'raw',
    provider,
    encodeURIComponent(accountId || 'default'),
    kind,
    `${externalId}.json`,
  );
}

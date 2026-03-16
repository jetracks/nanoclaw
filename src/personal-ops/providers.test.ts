import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectedAccountRecord } from './db.js';
import { syncProviderData } from './providers.js';

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('personal-ops google provider sync', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('pages inbox mail, excludes spam/trash at query time, and marks noisy mail', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get('maxResults')).toBe('100');
        expect(parsed.searchParams.get('includeSpamTrash')).toBe('false');
        expect(parsed.searchParams.getAll('labelIds')).toEqual(['INBOX']);
        if (parsed.searchParams.get('pageToken') === 'page-2') {
          return jsonResponse({
            messages: [{ id: 'msg-3', threadId: 'thread-3' }],
          });
        }
        return jsonResponse({
          messages: [
            { id: 'msg-1', threadId: 'thread-1' },
            { id: 'msg-2', threadId: 'thread-2' },
          ],
          nextPageToken: 'page-2',
        });
      }

      if (url.includes('/messages/msg-1?')) {
        return jsonResponse({
          id: 'msg-1',
          threadId: 'thread-1',
          snippet: 'Can you review this today?',
          internalDate: String(Date.parse('2026-03-14T17:00:00.000Z')),
          labelIds: ['INBOX', 'UNREAD', 'IMPORTANT', 'CATEGORY_PERSONAL'],
          payload: {
            headers: [
              { name: 'Subject', value: 'Client contract review' },
              { name: 'From', value: 'Client Owner <owner@example.com>' },
              { name: 'To', value: 'Jerry <jerry@example.com>' },
              { name: 'Date', value: 'Sat, 14 Mar 2026 10:00:00 -0700' },
            ],
          },
        });
      }

      if (url.includes('/messages/msg-2?')) {
        return jsonResponse({
          id: 'msg-2',
          threadId: 'thread-2',
          snippet: 'Save 20% today on your next order',
          internalDate: String(Date.parse('2026-03-14T18:00:00.000Z')),
          labelIds: ['INBOX', 'CATEGORY_PROMOTIONS', 'UNREAD'],
          payload: {
            headers: [
              { name: 'Subject', value: 'Spring sale' },
              { name: 'From', value: 'Deals <noreply@promo.example.com>' },
              { name: 'To', value: 'Jerry <jerry@example.com>' },
              { name: 'Date', value: 'Sat, 14 Mar 2026 11:00:00 -0700' },
              { name: 'List-Unsubscribe', value: '<mailto:unsubscribe@example.com>' },
              { name: 'Precedence', value: 'bulk' },
            ],
          },
        });
      }

      if (url.includes('/messages/msg-3?')) {
        return jsonResponse({
          id: 'msg-3',
          threadId: 'thread-3',
          snippet: 'Notes for next week',
          internalDate: String(Date.parse('2026-03-14T16:00:00.000Z')),
          labelIds: ['INBOX', 'CATEGORY_UPDATES'],
          payload: {
            headers: [
              { name: 'Subject', value: 'Weekly digest' },
              { name: 'From', value: 'Updates <updates@example.com>' },
              { name: 'To', value: 'Jerry <jerry@example.com>' },
              { name: 'Date', value: 'Sat, 14 Mar 2026 09:00:00 -0700' },
            ],
          },
        });
      }

      if (url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events?')) {
        return jsonResponse({ items: [] });
      }

      if (url.startsWith('https://www.googleapis.com/calendar/v3/users/me/calendarList?')) {
        return jsonResponse({
          items: [{ id: 'primary', summary: 'Primary', primary: true }],
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    global.fetch = fetchMock as typeof fetch;

    const account: ConnectedAccountRecord = {
      connectionKey: 'google:jerry@example.com',
      provider: 'google',
      status: 'connected',
      accountLabel: 'jerry@example.com',
      accountId: 'jerry@example.com',
      baseUrl: null,
      scopes: [],
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: null,
      resourceId: null,
      lastSyncAt: null,
      lastSyncStatus: 'never',
      lastSyncError: null,
      settings: {},
      createdAt: '2026-03-14T00:00:00.000Z',
      updatedAt: '2026-03-14T00:00:00.000Z',
    };

    const batch = await syncProviderData({
      account,
      since: '2026-03-01T00:00:00.000Z',
    });

    const emailRecords = batch.records
      .map((entry) => entry.source)
      .filter((entry) => entry.kind === 'email');

    expect(emailRecords).toHaveLength(3);
    expect(batch.cursors.email).toBe('2026-03-14T18:00:00.000Z');

    const important = emailRecords.find((entry) => entry.externalId === 'msg-1');
    expect(important?.priority).toBe('urgent');
    expect(important?.accountId).toBe('jerry@example.com');
    expect(important?.accountLabel).toBe('jerry@example.com');
    expect(important?.metadata?.isImportant).toBe(true);
    expect(important?.metadata?.isUnread).toBe(true);
    expect(important?.status).toBe('received');

    const promo = emailRecords.find((entry) => entry.externalId === 'msg-2');
    expect(promo?.priority).toBe('low');
    expect(promo?.status).toBe('filtered');
    expect(promo?.metadata?.likelyNoise).toBe(true);

    const digest = emailRecords.find((entry) => entry.externalId === 'msg-3');
    expect(digest?.metadata?.category).toBe('updates');
  });

  it('respects a custom Gmail query and selected calendars', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get('q')).toContain('label:important after:');
        expect(parsed.searchParams.getAll('labelIds')).toEqual([]);
        return jsonResponse({ messages: [] });
      }

      if (url.startsWith('https://www.googleapis.com/calendar/v3/users/me/calendarList?')) {
        return jsonResponse({
          items: [
            { id: 'primary', summary: 'Primary', primary: true },
            { id: 'team@example.com', summary: 'Team Calendar' },
          ],
        });
      }

      if (
        url.startsWith(
          'https://www.googleapis.com/calendar/v3/calendars/team%40example.com/events?',
        )
      ) {
        return jsonResponse({
          items: [
            {
              id: 'event-1',
              summary: 'Scoped calendar event',
              description: 'Only from the selected calendar',
              htmlLink: 'https://calendar.google.com/calendar/event?eid=1',
              start: { dateTime: '2026-03-18T17:00:00.000Z' },
              end: { dateTime: '2026-03-18T17:30:00.000Z' },
              attendees: [],
              organizer: { email: 'team@example.com' },
            },
          ],
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    global.fetch = fetchMock as typeof fetch;

    const account: ConnectedAccountRecord = {
      connectionKey: 'google:jerry@example.com',
      provider: 'google',
      status: 'connected',
      accountLabel: 'jerry@example.com',
      accountId: 'jerry@example.com',
      baseUrl: null,
      scopes: [],
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: null,
      resourceId: null,
      lastSyncAt: null,
      lastSyncStatus: 'never',
      lastSyncError: null,
      settings: {},
      createdAt: '2026-03-14T00:00:00.000Z',
      updatedAt: '2026-03-14T00:00:00.000Z',
    };

    const batch = await syncProviderData({
      account,
      since: '2026-03-01T00:00:00.000Z',
      settings: {
        googleMailQuery: 'label:important',
        googleCalendarIds: ['team@example.com'],
      },
    });

    const calendarRecords = batch.records
      .map((entry) => entry.source)
      .filter((entry) => entry.kind === 'calendar_event');

    expect(calendarRecords).toHaveLength(1);
    expect(calendarRecords[0].metadata?.calendarId).toBe('team@example.com');
    expect(calendarRecords[0].metadata?.calendarLabel).toBe('Team Calendar');
  });
});

describe('personal-ops microsoft provider sync', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T16:00:00.000Z'));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('uses calendarView with a rolling window so future meetings appear even when created earlier', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.startsWith('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?')) {
        return jsonResponse({ value: [] });
      }

      if (url.startsWith('https://graph.microsoft.com/v1.0/me/calendarView?')) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get('startDateTime')).toBe(
          '2026-02-28T08:00:00.000Z',
        );
        expect(parsed.searchParams.get('endDateTime')).toBe(
          '2026-04-28T16:00:00.000Z',
        );
        expect(parsed.searchParams.get('$top')).toBe('250');
        return jsonResponse({
          value: [
            {
              id: 'event-1',
              subject: 'Betty Mills leadership sync',
              bodyPreview: 'Weekly operations review',
              webLink: 'https://outlook.office365.com/calendar/item/1',
              start: {
                dateTime: '2026-03-18T17:00:00.0000000',
                timeZone: 'UTC',
              },
              end: {
                dateTime: '2026-03-18T17:30:00.0000000',
                timeZone: 'UTC',
              },
              attendees: [
                { emailAddress: { address: 'jerry@bettymills.com', name: 'Jerry' } },
              ],
              organizer: {
                emailAddress: { address: 'ops@bettymills.com', name: 'Ops' },
              },
            },
          ],
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    global.fetch = fetchMock as typeof fetch;

    const account: ConnectedAccountRecord = {
      connectionKey: 'microsoft:c9ba2c2f-3d52-44ea-a6dd-93bdb728c964',
      provider: 'microsoft',
      status: 'connected',
      accountLabel: 'jerry@bettymills.com',
      accountId: 'c9ba2c2f-3d52-44ea-a6dd-93bdb728c964',
      baseUrl: null,
      scopes: [],
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: null,
      resourceId: null,
      lastSyncAt: null,
      lastSyncStatus: 'never',
      lastSyncError: null,
      settings: {},
      createdAt: '2026-03-14T00:00:00.000Z',
      updatedAt: '2026-03-14T00:00:00.000Z',
    };

    const batch = await syncProviderData({
      account,
      since: '2026-03-07T04:00:00.000Z',
    });

    const calendarRecords = batch.records
      .map((entry) => entry.source)
      .filter((entry) => entry.kind === 'calendar_event');

    expect(calendarRecords).toHaveLength(1);
    expect(calendarRecords[0].title).toBe('Betty Mills leadership sync');
    expect(calendarRecords[0].accountLabel).toBe('jerry@bettymills.com');
    expect(batch.cursors.calendar_event).toBe('2026-03-14T16:00:00.000Z');
  });
});

describe('personal-ops slack provider sync', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('syncs recent messages across conversations and preserves workspace/channel metadata', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.startsWith('https://slack.com/api/users.conversations?')) {
        return jsonResponse({
          ok: true,
          channels: [
            {
              id: 'C123',
              name: 'dynecom-dev',
              is_member: true,
              is_private: false,
              updated: 1710435600,
            },
            {
              id: 'D456',
              user: 'U999',
              is_im: true,
              updated: 1710439200,
            },
          ],
          response_metadata: { next_cursor: '' },
        });
      }

      if (url.startsWith('https://slack.com/api/conversations.history?')) {
        const parsed = new URL(url);
        const channel = parsed.searchParams.get('channel');
        if (channel === 'D456') {
          return jsonResponse({
            ok: true,
            messages: [
              {
                type: 'message',
                text: 'Please review the COO draft today',
                ts: '1710439800.000200',
                user: 'U999',
              },
            ],
          });
        }
        if (channel === 'C123') {
          return jsonResponse({
            ok: true,
            messages: [
              {
                type: 'message',
                text: '<@U_SELF> blocker on the Dynecom rollout',
                ts: '1710439200.000100',
                user: 'U123',
                thread_ts: '1710439200.000100',
              },
            ],
          });
        }
      }

      if (url.startsWith('https://slack.com/api/users.info?')) {
        const parsed = new URL(url);
        const user = parsed.searchParams.get('user');
        if (user === 'U123') {
          return jsonResponse({
            ok: true,
            user: { profile: { display_name: 'Ops Bot' } },
          });
        }
        if (user === 'U999') {
          return jsonResponse({
            ok: true,
            user: { profile: { display_name: 'Jerry' } },
          });
        }
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    global.fetch = fetchMock as typeof fetch;

    const account: ConnectedAccountRecord = {
      connectionKey: 'slack:T123',
      provider: 'slack',
      status: 'connected',
      accountLabel: 'Dynecom Slack',
      accountId: 'T123',
      baseUrl: 'https://dynecom.slack.com/',
      scopes: [],
      accessToken: 'token',
      refreshToken: null,
      expiresAt: null,
      resourceId: 'U_SELF',
      lastSyncAt: null,
      lastSyncStatus: 'never',
      lastSyncError: null,
      settings: {},
      createdAt: '2026-03-14T00:00:00.000Z',
      updatedAt: '2026-03-14T00:00:00.000Z',
    };

    const batch = await syncProviderData({
      account,
      since: '2024-03-14T16:00:00.000Z',
    });

    const messages = batch.records.map((entry) => entry.source);
    expect(messages).toHaveLength(2);
    expect(messages.every((entry) => entry.kind === 'slack_message')).toBe(true);

    const channelMessage = messages.find((entry) => entry.externalId.startsWith('C123:'));
    expect(channelMessage?.metadata?.channelLabel).toBe('#dynecom-dev');
    expect(channelMessage?.metadata?.mentionsSelf).toBe(true);
    expect(channelMessage?.priority).toBe('high');
    expect(channelMessage?.sourceUrl).toContain('/archives/C123/p1710439200000100');

    const dmMessage = messages.find((entry) => entry.externalId.startsWith('D456:'));
    expect(dmMessage?.metadata?.channelType).toBe('dm');
    expect(dmMessage?.metadata?.authorLabel).toBe('Jerry');
    expect(dmMessage?.priority).toBe('urgent');

    expect(batch.cursors.slack_message).toBe('2024-03-14T18:10:00.000Z');
  });

  it('respects included and excluded Slack channel settings', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.startsWith('https://slack.com/api/users.conversations?')) {
        return jsonResponse({
          ok: true,
          channels: [
            { id: 'C123', name: 'dynecom-dev', is_member: true, updated: 1710435600 },
            { id: 'C999', name: 'random', is_member: true, updated: 1710435601 },
          ],
          response_metadata: { next_cursor: '' },
        });
      }

      if (url.startsWith('https://slack.com/api/conversations.history?')) {
        const parsed = new URL(url);
        const channel = parsed.searchParams.get('channel');
        return jsonResponse({
          ok: true,
          messages: [
            {
              type: 'message',
              text: `hello from ${channel}`,
              ts: '1710439200.000100',
              user: 'U123',
            },
          ],
        });
      }

      if (url.startsWith('https://slack.com/api/users.info?')) {
        return jsonResponse({
          ok: true,
          user: { profile: { display_name: 'Jerry' } },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    global.fetch = fetchMock as typeof fetch;

    const account: ConnectedAccountRecord = {
      connectionKey: 'slack:T123',
      provider: 'slack',
      status: 'connected',
      accountLabel: 'Dynecom Slack',
      accountId: 'T123',
      baseUrl: 'https://dynecom.slack.com/',
      scopes: [],
      accessToken: 'token',
      refreshToken: null,
      expiresAt: null,
      resourceId: 'U_SELF',
      lastSyncAt: null,
      lastSyncStatus: 'never',
      lastSyncError: null,
      settings: {},
      createdAt: '2026-03-14T00:00:00.000Z',
      updatedAt: '2026-03-14T00:00:00.000Z',
    };

    const batch = await syncProviderData({
      account,
      since: '2024-03-14T16:00:00.000Z',
      settings: {
        slackIncludedChannelIds: ['C123'],
        slackExcludedChannelIds: ['C999'],
      },
    });

    const messages = batch.records.map((entry) => entry.source);
    expect(messages).toHaveLength(1);
    expect(messages[0].metadata?.channelId).toBe('C123');
    expect(fetchMock.mock.calls.some((call) => {
      const arg = call[0];
      const url =
        typeof arg === 'string' ? arg : arg instanceof URL ? arg.toString() : arg.url;
      return url.includes('channel=C999');
    })).toBe(false);
  });
});

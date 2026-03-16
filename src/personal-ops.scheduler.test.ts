import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  PERSONAL_OPS_ACTIVE_START_HOUR: 6,
  PERSONAL_OPS_ACTIVE_END_HOUR: 22,
}));

import {
  _isWithinPersonalOpsActiveWindowForTesting,
  _resetPersonalOpsSchedulerForTesting,
  startPersonalOpsScheduler,
} from './personal-ops/scheduler.js';

describe('personal-ops scheduler', () => {
  afterEach(() => {
    _resetPersonalOpsSchedulerForTesting();
    vi.useRealTimers();
  });

  it('treats 6am to 10pm as the active auto-sync window', () => {
    expect(
      _isWithinPersonalOpsActiveWindowForTesting(new Date('2026-03-15T05:59:00')),
    ).toBe(false);
    expect(
      _isWithinPersonalOpsActiveWindowForTesting(new Date('2026-03-15T06:00:00')),
    ).toBe(true);
    expect(
      _isWithinPersonalOpsActiveWindowForTesting(new Date('2026-03-15T21:59:00')),
    ).toBe(true);
    expect(
      _isWithinPersonalOpsActiveWindowForTesting(new Date('2026-03-15T22:00:00')),
    ).toBe(false);
  });

  it('skips background provider sync outside active hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T23:30:00'));
    const syncDueProviders = vi.fn(async () => undefined);
    const getLatestReport = vi.fn(() => ({
      generatedAt: '2026-03-15T17:30:00.000Z',
    }));

    startPersonalOpsScheduler({
      service: {
        syncDueProviders,
        getLatestReport,
        generateReport: vi.fn(async () => ({
          groupedOutput: 'report',
        })),
        shouldPushToMainChat: vi.fn(() => false),
      } as any,
      getMainChatJid: () => null,
      sendMessage: vi.fn(async () => undefined),
    });

    await vi.runOnlyPendingTimersAsync();
    expect(syncDueProviders).not.toHaveBeenCalled();
  });
});

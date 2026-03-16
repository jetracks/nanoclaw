import { logger } from '../logger.js';
import {
  PERSONAL_OPS_ACTIVE_END_HOUR,
  PERSONAL_OPS_ACTIVE_START_HOUR,
} from '../config.js';
import { PersonalOpsService } from './service.js';

const PERSONAL_OPS_SCHEDULER_INTERVAL_MS = 60_000;

export interface PersonalOpsSchedulerDependencies {
  service: PersonalOpsService;
  getMainChatJid: () => string | null;
  sendMessage: (chatJid: string, text: string) => Promise<void>;
}

let schedulerRunning = false;

function isWithinPersonalOpsActiveWindow(now: Date): boolean {
  const hour = now.getHours();
  if (PERSONAL_OPS_ACTIVE_START_HOUR === PERSONAL_OPS_ACTIVE_END_HOUR) {
    return true;
  }
  if (PERSONAL_OPS_ACTIVE_START_HOUR < PERSONAL_OPS_ACTIVE_END_HOUR) {
    return (
      hour >= PERSONAL_OPS_ACTIVE_START_HOUR &&
      hour < PERSONAL_OPS_ACTIVE_END_HOUR
    );
  }
  return (
    hour >= PERSONAL_OPS_ACTIVE_START_HOUR ||
    hour < PERSONAL_OPS_ACTIVE_END_HOUR
  );
}

export function _resetPersonalOpsSchedulerForTesting(): void {
  schedulerRunning = false;
}

export function _isWithinPersonalOpsActiveWindowForTesting(now: Date): boolean {
  return isWithinPersonalOpsActiveWindow(now);
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

async function maybeGenerateScheduledReport(
  deps: PersonalOpsSchedulerDependencies,
  reportType: 'morning' | 'wrap',
  hour: number,
  minute: number,
): Promise<void> {
  const now = new Date();
  const scheduledAt = new Date(now);
  scheduledAt.setHours(hour, minute, 0, 0);

  if (now.getTime() < scheduledAt.getTime()) {
    return;
  }

  const existing = deps.service.getLatestReport(reportType);
  if (existing && sameLocalDay(new Date(existing.generatedAt), now)) {
    return;
  }

  const snapshot = await deps.service.generateReport(reportType);
  if (!deps.service.shouldPushToMainChat()) {
    return;
  }

  const mainChatJid = deps.getMainChatJid();
  if (!mainChatJid) {
    return;
  }

  await deps.sendMessage(mainChatJid, snapshot.groupedOutput);
}

export function startPersonalOpsScheduler(
  deps: PersonalOpsSchedulerDependencies,
): void {
  if (schedulerRunning) {
    return;
  }
  schedulerRunning = true;

  const tick = async () => {
    try {
      if (isWithinPersonalOpsActiveWindow(new Date())) {
        await deps.service.syncDueProviders();
      }
      await maybeGenerateScheduledReport(deps, 'morning', 8, 0);
      await maybeGenerateScheduledReport(deps, 'wrap', 17, 30);
    } catch (err) {
      logger.warn({ err }, 'Personal ops scheduler tick failed');
    } finally {
      setTimeout(tick, PERSONAL_OPS_SCHEDULER_INTERVAL_MS);
    }
  };

  tick().catch((err) =>
    logger.warn({ err }, 'Personal ops scheduler bootstrap failed'),
  );
}

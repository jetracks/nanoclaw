import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  PERSONAL_OPS_ENABLED,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  getProxyBindHost,
} from './container-runtime.js';
import {
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getRecentConversationMessages,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  getTaskRunLogs,
  getTasksForGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  updateTask,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  configureRemoteControl,
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import { startOperatorUi, stopOperatorUi } from './operator-ui.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  Channel,
  NewMessage,
  OpenAISessionState,
  RegisteredGroup,
} from './types.js';
import { logger } from './logger.js';
import { PersonalOpsService } from './personal-ops/service.js';
import { startPersonalOpsScheduler } from './personal-ops/scheduler.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, OpenAISessionState> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
const personalOpsService = PERSONAL_OPS_ENABLED
  ? new PersonalOpsService()
  : null;

const PERSONAL_OPS_COMMANDS = new Set([
  '/today',
  '/inbox',
  '/calendar',
  '/standup',
  '/wrap',
  '/history',
  '/what-changed',
  '/followups',
  '/task',
  '/note',
  '/correct',
]);

function getMainGroupJid(): string | null {
  return (
    Object.entries(registeredGroups).find(
      ([, group]) => group.isMain === true,
    )?.[0] || null
  );
}

async function sendOutboundMessage(
  chatJid: string,
  rawText: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ jid: chatJid }, 'No channel owns JID, cannot send message');
    return { ok: false, error: 'No channel owns JID.' };
  }

  const text = formatOutbound(rawText);
  if (!text) {
    return { ok: false, error: 'Outbound message was empty after formatting.' };
  }

  await channel.sendMessage(chatJid, text);

  const timestamp = new Date().toISOString();
  const group = registeredGroups[chatJid];
  storeChatMetadata(chatJid, timestamp, group?.name, channel.name, true);
  storeMessageDirect({
    id: `bot_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    chat_jid: chatJid,
    sender: `nanoclaw:${ASSISTANT_NAME.toLowerCase()}`,
    sender_name: ASSISTANT_NAME,
    content: text,
    timestamp,
    is_from_me: true,
    is_bot_message: true,
  });

  return { ok: true, text };
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  fs.mkdirSync(path.join(DATA_DIR, 'host-logs', group.folder), {
    recursive: true,
  });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        const sent = await sendOutboundMessage(chatJid, text);
        outputSentToUser = sent.ok;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const session = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionState) {
          sessions[group.folder] = output.newSessionState;
          setSession(group.folder, output.newSessionState);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        session,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionState) {
      sessions[group.folder] = output.newSessionState;
      setSession(group.folder, output.newSessionState);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();
  configureRemoteControl({
    getGroups: () => {
      const inspectable = new Map(
        queue
          .getInspectableStates()
          .map((state) => [state.groupJid, state] as const),
      );
      return Object.entries(registeredGroups).map(([chatJid, group]) => {
        const queueState = inspectable.get(chatJid);
        const session = sessions[group.folder];
        return {
          chatJid,
          name: group.name,
          folder: group.folder,
          active:
            queueState?.active === true && queueState.isTaskContainer !== true,
          idleWaiting: queueState?.idleWaiting === true,
          transcriptPath:
            session?.transcriptPath ||
            path.join(
              DATA_DIR,
              'sessions',
              group.folder,
              'openai',
              'current-transcript.jsonl',
            ),
          previousResponseId: session?.previousResponseId,
        };
      });
    },
    sendInput: (chatJid, text) => queue.sendMessage(chatJid, text),
  });

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    getProxyBindHost(),
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await stopOperatorUi();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(msg.sender, chatJid);
      if (result.ok) {
        await sendOutboundMessage(chatJid, result.url);
      } else {
        await sendOutboundMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await sendOutboundMessage(chatJid, 'Remote Control session ended.');
      } else {
        await sendOutboundMessage(chatJid, result.error);
      }
    }
  }

  async function handlePersonalOpsCommand(
    trimmed: string,
    chatJid: string,
  ): Promise<void> {
    if (!personalOpsService) {
      await sendOutboundMessage(
        chatJid,
        'Personal ops is disabled in this NanoClaw instance.',
      );
      return;
    }
    const [command, ...rest] = trimmed.split(/\s+/);
    const args = rest.join(' ').trim();
    if (command === '/standup') {
      const snapshot = await personalOpsService.generateReport('standup');
      await sendOutboundMessage(chatJid, snapshot.groupedOutput);
      return;
    }
    if (command === '/wrap' && !personalOpsService.getLatestReport('wrap')) {
      const snapshot = await personalOpsService.generateReport('wrap');
      await sendOutboundMessage(chatJid, snapshot.groupedOutput);
      return;
    }
    await sendOutboundMessage(
      chatJid,
      personalOpsService.formatChatCommand(command, args),
    );
  }

  const acceptInboundMessage = (chatJid: string, msg: NewMessage): void => {
    const trimmed = msg.content.trim();
    if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
      handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
        logger.error({ err, chatJid }, 'Remote control command error'),
      );
      return;
    }
    const command = trimmed.split(/\s+/, 1)[0];
    if (PERSONAL_OPS_COMMANDS.has(command)) {
      handlePersonalOpsCommand(trimmed, chatJid).catch((err) =>
        logger.error({ err, chatJid, command }, 'Personal ops command error'),
      );
      return;
    }

    if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
      const cfg = loadSenderAllowlist();
      if (
        shouldDropMessage(chatJid, cfg) &&
        !isSenderAllowed(chatJid, msg.sender, cfg)
      ) {
        if (cfg.logDenied) {
          logger.debug(
            { chatJid, sender: msg.sender },
            'sender-allowlist: dropping message (drop mode)',
          );
        }
        return;
      }
    }

    storeMessage(msg);
  };

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      acceptInboundMessage(chatJid, msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      await sendOutboundMessage(jid, rawText);
    },
  });
  if (personalOpsService) {
    personalOpsService.writePublicSnapshots();
    startPersonalOpsScheduler({
      service: personalOpsService,
      getMainChatJid: getMainGroupJid,
      sendMessage: async (chatJid, text) => {
        await sendOutboundMessage(chatJid, text);
      },
    });
  }
  startIpcWatcher({
    sendMessage: (jid, text) => {
      return sendOutboundMessage(jid, text).then((result) => {
        if (!result.ok) {
          throw new Error(result.error);
        }
      });
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    personalOpsService,
  });

  const operatorUiStart = await startOperatorUi({
    getGroups: () => {
      const inspectable = new Map(
        queue
          .getInspectableStates()
          .map((state) => [state.groupJid, state] as const),
      );
      const chats = new Map(
        getAllChats().map((chat) => [chat.jid, chat] as const),
      );

      return Object.entries(registeredGroups).map(([chatJid, group]) => {
        const queueState = inspectable.get(chatJid);
        const chat = chats.get(chatJid);
        const session = sessions[group.folder];
        return {
          chatJid,
          name: group.name,
          folder: group.folder,
          trigger: group.trigger,
          addedAt: group.added_at,
          requiresTrigger:
            group.isMain === true ? false : group.requiresTrigger !== false,
          isMain: group.isMain === true,
          active:
            queueState?.active === true && queueState.isTaskContainer !== true,
          idleWaiting: queueState?.idleWaiting === true,
          lastMessageTime: chat?.last_message_time,
          channel: chat?.channel,
          session,
          transcriptPath:
            session?.transcriptPath ||
            path.join(
              DATA_DIR,
              'sessions',
              group.folder,
              'openai',
              'current-transcript.jsonl',
            ),
        };
      });
    },
    getMessages: (chatJid, limit) =>
      getRecentConversationMessages(chatJid, limit),
    getTasks: (groupFolder) => getTasksForGroup(groupFolder),
    getTaskRuns: (taskId, limit) => getTaskRunLogs(taskId, limit),
    injectMessage: (chatJid, text, sender, senderName) => {
      const group = registeredGroups[chatJid];
      if (!group) {
        return { ok: false, error: 'Group is not registered.' };
      }

      const timestamp = new Date().toISOString();
      storeChatMetadata(chatJid, timestamp, group.name);
      const message: NewMessage = {
        id: `ui_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        chat_jid: chatJid,
        sender: sender || 'operator:ui',
        sender_name: senderName || 'Operator UI',
        content: text,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };
      acceptInboundMessage(chatJid, message);
      return { ok: true, messageId: message.id };
    },
    sendInput: (chatJid, text) => queue.sendMessage(chatJid, text),
    sendOutbound: async (chatJid, text) => {
      const result = await sendOutboundMessage(chatJid, text);
      return result.ok ? { ok: true } : result;
    },
    createTask: ({
      chatJid,
      groupFolder,
      prompt,
      scheduleType,
      scheduleValue,
      contextMode,
    }) => {
      const group = registeredGroups[chatJid];
      if (!group || group.folder !== groupFolder) {
        return {
          ok: false,
          error: 'Task target does not match a registered group.',
        };
      }

      let nextRun: string | null = null;
      if (scheduleType === 'cron') {
        try {
          nextRun = CronExpressionParser.parse(scheduleValue, {
            tz: TIMEZONE,
          })
            .next()
            .toISOString();
        } catch {
          return { ok: false, error: 'Invalid cron expression.' };
        }
      } else if (scheduleType === 'interval') {
        const ms = parseInt(scheduleValue, 10);
        if (isNaN(ms) || ms <= 0) {
          return {
            ok: false,
            error: 'Interval must be a positive millisecond value.',
          };
        }
        nextRun = new Date(Date.now() + ms).toISOString();
      } else {
        const date = new Date(scheduleValue);
        if (isNaN(date.getTime())) {
          return { ok: false, error: 'Invalid once timestamp.' };
        }
        nextRun = date.toISOString();
      }

      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createTask({
        id: taskId,
        group_folder: groupFolder,
        chat_jid: chatJid,
        prompt,
        schedule_type: scheduleType,
        schedule_value: scheduleValue,
        context_mode: contextMode,
        next_run: nextRun,
        status: 'active',
        created_at: new Date().toISOString(),
      });
      return { ok: true, taskId };
    },
    updateTask: ({
      taskId,
      prompt,
      scheduleType,
      scheduleValue,
      contextMode,
    }) => {
      const task = getTaskById(taskId);
      if (!task) {
        return { ok: false, error: 'Task not found.' };
      }

      let nextRun: string | null = null;
      if (scheduleType === 'cron') {
        try {
          nextRun = CronExpressionParser.parse(scheduleValue, {
            tz: TIMEZONE,
          })
            .next()
            .toISOString();
        } catch {
          return { ok: false, error: 'Invalid cron expression.' };
        }
      } else if (scheduleType === 'interval') {
        const ms = parseInt(scheduleValue, 10);
        if (isNaN(ms) || ms <= 0) {
          return {
            ok: false,
            error: 'Interval must be a positive millisecond value.',
          };
        }
        nextRun = new Date(Date.now() + ms).toISOString();
      } else {
        const date = new Date(scheduleValue);
        if (isNaN(date.getTime())) {
          return { ok: false, error: 'Invalid once timestamp.' };
        }
        nextRun = date.toISOString();
      }

      updateTask(taskId, {
        prompt,
        schedule_type: scheduleType,
        schedule_value: scheduleValue,
        context_mode: contextMode,
        next_run: nextRun,
      });
      return { ok: true };
    },
    pauseTask: (taskId) => {
      const task = getTaskById(taskId);
      if (!task) {
        return { ok: false, error: 'Task not found.' };
      }
      updateTask(taskId, { status: 'paused' });
      return { ok: true };
    },
    resumeTask: (taskId) => {
      const task = getTaskById(taskId);
      if (!task) {
        return { ok: false, error: 'Task not found.' };
      }
      updateTask(taskId, { status: 'active' });
      return { ok: true };
    },
    cancelTask: (taskId) => {
      const task = getTaskById(taskId);
      if (!task) {
        return { ok: false, error: 'Task not found.' };
      }
      deleteTask(taskId);
      return { ok: true };
    },
    personalOps: personalOpsService
      ? {
          listConnections: () => personalOpsService.listConnections(),
          getToday: () => personalOpsService.getTodayView(),
          getInbox: (input) => personalOpsService.getInboxView(input),
          getCalendar: () => personalOpsService.getCalendarView(),
          getWorkboard: () => personalOpsService.getWorkboardView(),
          getHistory: (input) => personalOpsService.getHistoryView(input),
          getHistoryWorkstreams: (input) =>
            personalOpsService.getHistoryWorkstreams(input),
          getReports: () => personalOpsService.getReports(),
          generateReport: (reportType, range) =>
            personalOpsService.generateReport(reportType, range),
          getCorrections: () => personalOpsService.getCorrections(),
          getClients: () => personalOpsService.getClients(),
          getProjects: () => personalOpsService.getProjects(),
          getRepositories: () => personalOpsService.getRepositories(),
          getContacts: () => personalOpsService.getContacts(),
          linkContact: (input) => personalOpsService.linkContact(input),
          getOpenLoops: () => personalOpsService.getOpenLoops(),
          getAssistantQuestions: (input) =>
            personalOpsService.getAssistantQuestions(input),
          answerAssistantQuestion: (input) =>
            personalOpsService.answerAssistantQuestion(input),
          dismissAssistantQuestion: (input) =>
            personalOpsService.dismissAssistantQuestion(input),
          getApprovalQueue: () => personalOpsService.getApprovalQueue(),
          approveQueueItem: (id) => personalOpsService.approveQueueItem(id),
          rejectQueueItem: (id) => personalOpsService.rejectQueueItem(id),
          editQueueItem: (id, input) =>
            personalOpsService.editQueueItem(id, input),
          getMemoryFacts: () => personalOpsService.getMemoryFacts(),
          acceptMemoryFact: (id) => personalOpsService.acceptMemoryFact(id),
          rejectMemoryFact: (id) => personalOpsService.rejectMemoryFact(id),
          getReviewQueue: () => personalOpsService.getReviewQueue(),
          getImprovementTickets: () =>
            personalOpsService.getImprovementTickets(),
          approveImprovementTicket: (id) =>
            personalOpsService.approveImprovementTicket(id),
          rejectImprovementTicket: (id) =>
            personalOpsService.rejectImprovementTicket(id),
          editImprovementTicket: (id, input) =>
            personalOpsService.editImprovementTicket(id, input),
          reviewAccept: (id) => personalOpsService.reviewAccept(id),
          reviewReject: (id) => personalOpsService.reviewReject(id),
          getOperatorProfile: () => personalOpsService.getOperatorProfile(),
          updateOperatorProfile: (input) =>
            personalOpsService.updateOperatorProfile(input),
          beginOAuth: (provider, appBaseUrl) =>
            personalOpsService.beginOAuth(provider, appBaseUrl),
          handleOAuthCallback: (provider, code, state, appBaseUrl) =>
            personalOpsService.handleOAuthCallback(
              provider,
              code,
              state,
              appBaseUrl,
            ),
          disconnect: (input) => personalOpsService.disconnect(input),
          getConnectionCatalog: (input) =>
            personalOpsService.getConnectionCatalog(input),
          updateConnectionSettings: (input) =>
            personalOpsService.updateConnectionSettings(
              { provider: input.provider, accountId: input.accountId },
              input.settings,
            ),
          syncProvider: (input) => personalOpsService.syncProvider(input),
          createManualTask: (input) =>
            personalOpsService.createManualTask(input),
          createManualNote: (input) =>
            personalOpsService.createManualNote(input),
          upsertClient: (input) => personalOpsService.upsertClient(input),
          upsertProject: (input) => personalOpsService.upsertProject(input),
          upsertRepository: (input) =>
            personalOpsService.upsertRepository(input),
          discoverRepositories: (input) =>
            personalOpsService.discoverRepositories(input),
          recordCorrection: (input) =>
            personalOpsService.recordCorrection(input),
        }
      : undefined,
  });
  if (!operatorUiStart.ok) {
    logger.warn({ error: operatorUiStart.error }, 'Operator UI unavailable');
  }
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}

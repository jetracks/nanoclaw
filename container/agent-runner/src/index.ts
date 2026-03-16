/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 */

import { exec } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import OpenAI from 'openai';
import path from 'path';
import { promisify } from 'util';
import {
  executeApplyPatchOperation,
} from './apply-patch-operation.js';
import {
  createIsolatedSubagentSessionState,
  mergeTurnSessionState,
  OpenAISessionState,
} from './openai-session-state.js';
import { createShellCallOutput } from './local-shell-call-output.js';

const execAsync = promisify(exec);

interface ContainerInput {
  prompt: string;
  session?: OpenAISessionState;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionState?: OpenAISessionState;
  error?: string;
}

interface FunctionContext {
  containerInput: ContainerInput;
  client: OpenAI;
  transcriptPath: string;
  allowSendMessage: boolean;
  allowSubagent: boolean;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_STATE_DIR = '/workspace/ipc/state';
const IPC_POLL_MS = 500;
const WORKSPACE_ROOT = '/workspace/group';
const SESSION_ROOT = '/workspace/session';
const OPENAI_SESSION_ROOT = path.join(SESSION_ROOT, 'openai');
const CONVERSATIONS_DIR = path.join(WORKSPACE_ROOT, 'conversations');
const TASKS_FILE = path.join(IPC_STATE_DIR, 'current_tasks.json');
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const COMPACTION_LINE_THRESHOLD = 200;
const COMPACTION_SIZE_THRESHOLD = 250_000;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function currentSessionState(
  inputState: OpenAISessionState | undefined,
): OpenAISessionState {
  return {
    provider: 'openai',
    previousResponseId: inputState?.previousResponseId,
    conversationId: inputState?.conversationId,
    transcriptPath:
      inputState?.transcriptPath ||
      path.join(OPENAI_SESSION_ROOT, 'current-transcript.jsonl'),
    summaryPath:
      inputState?.summaryPath || path.join(OPENAI_SESSION_ROOT, 'summary.md'),
    compactedAt: inputState?.compactedAt,
    compactionCount: inputState?.compactionCount || 0,
    invalidatedLegacySessionId: inputState?.invalidatedLegacySessionId,
  };
}

function appendJsonLine(filePath: string, value: Record<string, unknown>): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function readPreferredMemoryFile(dir: string): string | null {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const filePath = path.join(dir, name);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim();
    }
  }
  return null;
}

function buildInstructions(
  containerInput: ContainerInput,
  sessionState: OpenAISessionState,
  allowSendMessage: boolean,
  allowSubagent: boolean,
): string {
  const globalMemory = readPreferredMemoryFile('/workspace/global');
  const groupMemory = readPreferredMemoryFile(WORKSPACE_ROOT);
  const summary = sessionState.summaryPath && fs.existsSync(sessionState.summaryPath)
    ? fs.readFileSync(sessionState.summaryPath, 'utf-8').trim()
    : '';

  const sections = [
    `You are ${containerInput.assistantName || 'NanoClaw'}, a NanoClaw assistant running inside a local container sandbox.`,
    `Workspace rules:
- Your writable workspace root is ${WORKSPACE_ROOT}.
- Session data and transcripts live under ${OPENAI_SESSION_ROOT}.
- Use the built-in local shell tool for file reads/writes, command execution, and inspection.
- Use the built-in apply_patch tool for file diffs when it is the most direct option.
- Use web search when current external information is required.
- Available groups snapshot: /workspace/ipc/state/available_groups.json
- Scheduled tasks snapshot: ${TASKS_FILE}
- Wrap internal-only notes in <internal>...</internal> so NanoClaw suppresses them.`,
    `Capability rules:
- Be precise about what you can access in this environment.
- Do not imply you can read or modify arbitrary files on the host machine; you are limited to the sandboxed workspace, mounted data, and host tools exposed through NanoClaw.
- Do not describe email, calendar, Jira, Slack, or other personal-ops integrations as "future" if host-side personal-ops tools are available.
- When asked what you can do here, what is connected, or what data you can use for personal operations, prefer checking the host state with personal_ops_get_connections when that tool is available.`,
    allowSendMessage
      ? `Messaging rules:
- Use send_message for progress updates or multi-message workflows.
- Final visible output will be delivered to the user unless wrapped in <internal>.`
      : `Messaging rules:
- You are acting as a subagent. Do not use send_message.`,
    allowSubagent
      ? 'You may delegate bounded work to run_subagent when parallel or specialized reasoning helps.'
      : 'Subagent delegation is disabled in this run.',
  ];

  if (sessionState.invalidatedLegacySessionId && !sessionState.previousResponseId) {
    sections.push(
      `This conversation was migrated from a legacy Anthropic session (${sessionState.invalidatedLegacySessionId}). Start a fresh OpenAI conversation using the memory files and latest user context.`,
    );
  }
  if (summary) {
    sections.push(`Conversation summary:\n${summary}`);
  }
  if (globalMemory) {
    sections.push(`Global memory:\n${globalMemory}`);
  }
  if (groupMemory) {
    sections.push(`Group memory:\n${groupMemory}`);
  }

  return sections.join('\n\n');
}

function shouldClose(): boolean {
  try {
    ensureDir(IPC_INPUT_DIR);
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (parsed.type === 'close') {
          fs.unlinkSync(filePath);
          return true;
        }
      } catch {
        // ignore malformed files here; drainIpcInput will handle them
      }
    }
  } catch {
    // ignore
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    ensureDir(IPC_INPUT_DIR);
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (parsed.type === 'message' && typeof parsed.text === 'string') {
          messages.push(parsed.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function writeIpcFile(dir: string, data: object): string {
  ensureDir(dir);
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filePath = path.join(dir, filename);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
  return filename;
}

function readTasksSnapshot(): Array<Record<string, unknown>> {
  try {
    if (!fs.existsSync(TASKS_FILE)) return [];
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

async function readPersonalOpsSnapshot(name: string): Promise<string> {
  const personalOpsDir = '/workspace/ipc/personal-ops';
  const responsesDir = path.join(IPC_STATE_DIR, 'personal-ops-responses');
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const responsePath = path.join(responsesDir, `${requestId}.json`);

  writeIpcFile(personalOpsDir, {
    type: 'get_snapshot',
    snapshotName: name,
    requestId,
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (fs.existsSync(responsePath)) {
      try {
        const payload = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
          ok?: boolean;
          output?: string;
          error?: string;
        };
        if (payload.ok && typeof payload.output === 'string') {
          return payload.output;
        }
        return payload.error || `No personal ops snapshot is available for "${name}".`;
      } catch {
        return `Failed to read personal ops snapshot "${name}".`;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, IPC_POLL_MS));
  }

  return `Timed out reading personal ops snapshot "${name}".`;
}

function resolveWorkspacePath(relativePath: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, relativePath);
  if (
    resolved !== WORKSPACE_ROOT &&
    !resolved.startsWith(`${WORKSPACE_ROOT}${path.sep}`)
  ) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }
  return resolved;
}

async function executeShellCall(item: any): Promise<Record<string, unknown>> {
  const commands = Array.isArray(item.action?.commands)
    ? item.action.commands.filter((command: unknown): command is string =>
        typeof command === 'string' && command.trim().length > 0,
      )
    : [];
  const maxOutputLength =
    typeof item.action?.max_output_length === 'number'
      ? item.action.max_output_length
      : undefined;
  if (commands.length === 0) {
    return createShellCallOutput(
      item,
      [
        {
          stdout: '',
          stderr: 'No commands provided',
          outcome: { type: 'exit', exit_code: 1 },
        },
      ],
      maxOutputLength,
    );
  }

  const timeoutMs =
    typeof item.action?.timeout_ms === 'number'
      ? Math.max(1, item.action.timeout_ms)
      : 120_000;
  const requestedWorkingDir =
    typeof item.action?.working_directory === 'string'
      ? item.action.working_directory
      : WORKSPACE_ROOT;
  const workingDirectory = requestedWorkingDir.startsWith('/workspace')
    ? requestedWorkingDir
    : resolveWorkspacePath(requestedWorkingDir);
  const env = {
    ...process.env,
    ...(item.action?.env || {}),
  };

  const results = [];
  for (const command of commands) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workingDirectory,
        env,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        shell: '/bin/sh',
      });
      results.push({
        stdout,
        stderr,
        outcome: { type: 'exit' as const, exit_code: 0 },
      });
    } catch (err: any) {
      results.push({
        stdout: err?.stdout || '',
        stderr: err?.stderr || err?.message || String(err),
        outcome:
          err?.killed || err?.signal === 'SIGTERM'
            ? ({ type: 'timeout' } as const)
            : ({
                type: 'exit' as const,
                exit_code: typeof err?.code === 'number' ? err.code : 1,
              } as const),
      });
    }
  }

  return createShellCallOutput(item, results, maxOutputLength);
}

async function executeApplyPatchCall(item: any): Promise<Record<string, unknown>> {
  const result = await executeApplyPatchOperation(WORKSPACE_ROOT, item.operation);
  return {
    type: 'apply_patch_call_output',
    call_id: item.call_id,
    status: result.status,
    output: result.output,
  };
}

function validateScheduleValue(
  scheduleType: string,
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    try {
      CronExpressionParser.parse(scheduleValue);
      return null;
    } catch {
      return `Invalid cron: "${scheduleValue}".`;
    }
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) {
      return `Invalid interval: "${scheduleValue}".`;
    }
    return null;
  }

  if (scheduleType === 'once') {
    if (/[Zz]$/.test(scheduleValue) || /[+-]\d{2}:\d{2}$/.test(scheduleValue)) {
      return `Timestamp must be local time without timezone suffix. Got "${scheduleValue}".`;
    }
    const date = new Date(scheduleValue);
    if (isNaN(date.getTime())) {
      return `Invalid timestamp: "${scheduleValue}".`;
    }
  }

  return null;
}

async function runSubagent(
  role: string,
  task: string,
  ctx: FunctionContext,
): Promise<string> {
  if (!ctx.allowSubagent) {
    return 'Subagent delegation is disabled for this run.';
  }

  const sessionState = currentSessionState(
    createIsolatedSubagentSessionState(OPENAI_SESSION_ROOT),
  );
  const result = await runOpenAITurn(
    ctx.client,
    ctx.containerInput,
    `[Subagent role: ${role}]\n\n${task}`,
    sessionState,
    false,
    false,
  );
  return result.result || '<internal>Subagent completed without visible output.</internal>';
}

async function executeFunctionCall(
  item: any,
  ctx: FunctionContext,
): Promise<Record<string, unknown>> {
  let args: Record<string, any> = {};
  try {
    args = item.arguments ? JSON.parse(item.arguments) : {};
  } catch {
    return {
      type: 'function_call_output',
      call_id: item.call_id,
      output: 'Invalid JSON arguments.',
    };
  }

  const tasksDir = '/workspace/ipc/tasks';
  const messagesDir = '/workspace/ipc/messages';
  const personalOpsDir = '/workspace/ipc/personal-ops';

  try {
    switch (item.name) {
      case 'send_message': {
        if (!ctx.allowSendMessage) {
          return {
            type: 'function_call_output',
            call_id: item.call_id,
            output: 'send_message is disabled for subagents.',
          };
        }
        writeIpcFile(messagesDir, {
          type: 'message',
          chatJid: ctx.containerInput.chatJid,
          text: args.text,
          sender: args.sender || undefined,
          groupFolder: ctx.containerInput.groupFolder,
          timestamp: new Date().toISOString(),
        });
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: 'Message sent.',
        };
      }

      case 'schedule_task': {
        const validation = validateScheduleValue(
          args.schedule_type,
          args.schedule_value,
        );
        if (validation) {
          return {
            type: 'function_call_output',
            call_id: item.call_id,
            output: validation,
          };
        }
        const targetJid =
          ctx.containerInput.isMain && args.target_group_jid
            ? args.target_group_jid
            : ctx.containerInput.chatJid;
        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(tasksDir, {
          type: 'schedule_task',
          taskId,
          prompt: args.prompt,
          schedule_type: args.schedule_type,
          schedule_value: args.schedule_value,
          context_mode: args.context_mode || 'group',
          targetJid,
          createdBy: ctx.containerInput.groupFolder,
          timestamp: new Date().toISOString(),
        });
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: `Task ${taskId} scheduled.`,
        };
      }

      case 'list_tasks': {
        const tasks = readTasksSnapshot();
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output:
            tasks.length === 0 ? 'No scheduled tasks found.' : JSON.stringify(tasks, null, 2),
        };
      }

      case 'pause_task':
      case 'resume_task':
      case 'cancel_task': {
        writeIpcFile(tasksDir, {
          type:
            item.name === 'pause_task'
              ? 'pause_task'
              : item.name === 'resume_task'
                ? 'resume_task'
                : 'cancel_task',
          taskId: args.task_id,
          groupFolder: ctx.containerInput.groupFolder,
          isMain: String(ctx.containerInput.isMain),
          timestamp: new Date().toISOString(),
        });
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: `${item.name} requested for ${args.task_id}.`,
        };
      }

      case 'update_task': {
        if (args.schedule_type && args.schedule_value) {
          const validation = validateScheduleValue(
            args.schedule_type,
            args.schedule_value,
          );
          if (validation) {
            return {
              type: 'function_call_output',
              call_id: item.call_id,
              output: validation,
            };
          }
        }
        writeIpcFile(tasksDir, {
          type: 'update_task',
          taskId: args.task_id,
          groupFolder: ctx.containerInput.groupFolder,
          isMain: String(ctx.containerInput.isMain),
          prompt: args.prompt,
          schedule_type: args.schedule_type,
          schedule_value: args.schedule_value,
          timestamp: new Date().toISOString(),
        });
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: `Task ${args.task_id} update requested.`,
        };
      }

      case 'register_group': {
        if (!ctx.containerInput.isMain) {
          return {
            type: 'function_call_output',
            call_id: item.call_id,
            output: 'Only the main group can register new groups.',
          };
        }
        writeIpcFile(tasksDir, {
          type: 'register_group',
          jid: args.jid,
          name: args.name,
          folder: args.folder,
          trigger: args.trigger,
          timestamp: new Date().toISOString(),
        });
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: `Group "${args.name}" registered.`,
        };
      }

      case 'personal_ops_get_today':
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: await readPersonalOpsSnapshot('today'),
        };

      case 'personal_ops_get_inbox':
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: await readPersonalOpsSnapshot('inbox'),
        };

      case 'personal_ops_get_calendar':
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: await readPersonalOpsSnapshot('calendar'),
        };

      case 'personal_ops_get_workboard':
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: await readPersonalOpsSnapshot('workboard'),
        };

      case 'personal_ops_get_history':
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: await readPersonalOpsSnapshot('history'),
        };

      case 'personal_ops_get_reports':
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: await readPersonalOpsSnapshot('reports'),
        };

      case 'personal_ops_get_connections':
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: await readPersonalOpsSnapshot('connections'),
        };

      case 'personal_ops_record_correction': {
        writeIpcFile(personalOpsDir, {
          type: 'record_correction',
          targetType: args.target_type,
          targetId: args.target_id,
          field: args.field,
          value: args.value,
          timestamp: new Date().toISOString(),
        });
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: 'Correction queued for the host.',
        };
      }

      case 'run_subagent': {
        const output = await runSubagent(
          args.role || 'Generalist',
          args.task,
          ctx,
        );
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output,
        };
      }

      default:
        return {
          type: 'function_call_output',
          call_id: item.call_id,
          output: `Unknown function: ${item.name}`,
        };
    }
  } catch (err) {
    return {
      type: 'function_call_output',
      call_id: item.call_id,
      output: err instanceof Error ? err.message : String(err),
    };
  }
}

function archiveTranscriptAsMarkdown(
  transcriptPath: string,
  assistantName: string,
): void {
  if (!fs.existsSync(transcriptPath)) return;
  ensureDir(CONVERSATIONS_DIR);

  const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n');
  const rendered: string[] = ['# Conversation Archive', '', `Archived: ${new Date().toISOString()}`, ''];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.kind === 'user_prompt' && typeof entry.prompt === 'string') {
        rendered.push(`**User**: ${entry.prompt}`, '');
      } else if (entry.kind === 'response' && typeof entry.output_text === 'string') {
        rendered.push(`**${assistantName}**: ${entry.output_text}`, '');
      } else if (entry.kind === 'tool' && typeof entry.name === 'string') {
        rendered.push(
          `**Tool ${entry.name}**: ${JSON.stringify(entry.payload || {}, null, 2)}`,
          '',
        );
      }
    } catch {
      // ignore malformed archive lines
    }
  }

  const filePath = path.join(
    CONVERSATIONS_DIR,
    `${new Date().toISOString().replace(/[:.]/g, '-')}.md`,
  );
  fs.writeFileSync(filePath, rendered.join('\n'));
}

async function compactConversation(
  client: OpenAI,
  transcriptPath: string,
  summaryPath: string,
): Promise<string | undefined> {
  if (!fs.existsSync(transcriptPath)) return undefined;
  const transcript = fs.readFileSync(transcriptPath, 'utf-8').slice(-200_000);
  if (!transcript.trim()) return undefined;

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-5.4',
    reasoning: { effort: (process.env.OPENAI_REASONING_EFFORT as any) || 'medium' },
    input: `Summarize this conversation for future continuation. Preserve user preferences, commitments, open tasks, important facts, and files that matter. Keep it concise but implementation-useful.\n\n${transcript}`,
    truncation: 'auto',
  });

  const summary = response.output_text?.trim();
  if (summary) {
    ensureDir(path.dirname(summaryPath));
    fs.writeFileSync(summaryPath, summary);
  }
  return summary;
}

async function maybeCompactConversation(
  client: OpenAI,
  sessionState: OpenAISessionState,
  assistantName: string,
): Promise<OpenAISessionState> {
  const transcriptPath = sessionState.transcriptPath;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return sessionState;

  const stat = fs.statSync(transcriptPath);
  const lineCount = fs.readFileSync(transcriptPath, 'utf-8').split('\n').length;
  if (
    stat.size < COMPACTION_SIZE_THRESHOLD &&
    lineCount < COMPACTION_LINE_THRESHOLD
  ) {
    return sessionState;
  }

  archiveTranscriptAsMarkdown(transcriptPath, assistantName);
  const summary = await compactConversation(
    client,
    transcriptPath,
    sessionState.summaryPath || path.join(OPENAI_SESSION_ROOT, 'summary.md'),
  );
  if (!summary) return sessionState;

  fs.writeFileSync(transcriptPath, '');
  return {
    ...sessionState,
    previousResponseId: undefined,
    compactedAt: new Date().toISOString(),
    compactionCount: (sessionState.compactionCount || 0) + 1,
  };
}

function responseTools(
  allowSendMessage: boolean,
  allowSubagent: boolean,
  includePersonalOps: boolean,
): any[] {
  const tools: any[] = [
    {
      type: 'shell',
      environment: {
        type: 'local',
      },
    },
    { type: 'apply_patch' },
    {
      type: 'web_search_preview',
      search_context_size: 'medium',
      user_location: {
        type: 'approximate',
        country: 'US',
        timezone: process.env.TZ || 'UTC',
      },
    },
  ];

  if (allowSendMessage) {
    tools.push({
      type: 'function',
      name: 'send_message',
      description:
        "Send a message to the user or group immediately while you're still working.",
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          sender: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
        },
        required: ['text', 'sender'],
        additionalProperties: false,
      },
    });
  }

  tools.push(
    {
      type: 'function',
      name: 'schedule_task',
      description: 'Schedule a recurring or one-time task.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          schedule_type: { enum: ['cron', 'interval', 'once'] },
          schedule_value: { type: 'string' },
          context_mode: { enum: ['group', 'isolated'] },
          target_group_jid: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
        },
        required: [
          'prompt',
          'schedule_type',
          'schedule_value',
          'context_mode',
          'target_group_jid',
        ],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'list_tasks',
      description: 'List all visible scheduled tasks.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'pause_task',
      description: 'Pause a scheduled task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'resume_task',
      description: 'Resume a paused scheduled task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'cancel_task',
      description: 'Cancel and delete a scheduled task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'update_task',
      description: 'Update an existing scheduled task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          prompt: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
          schedule_type: {
            anyOf: [{ enum: ['cron', 'interval', 'once'] }, { type: 'null' }],
          },
          schedule_value: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
        },
        required: ['task_id', 'prompt', 'schedule_type', 'schedule_value'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'register_group',
      description: 'Register a new chat/group. Main group only.',
      parameters: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          name: { type: 'string' },
          folder: { type: 'string' },
          trigger: { type: 'string' },
        },
        required: ['jid', 'name', 'folder', 'trigger'],
        additionalProperties: false,
      },
    },
  );

  if (allowSubagent) {
    tools.push({
      type: 'function',
      name: 'run_subagent',
      description:
        'Run a bounded subagent task and return its result. Use for delegated analysis or implementation work.',
      parameters: {
        type: 'object',
        properties: {
          role: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
          task: { type: 'string' },
        },
        required: ['role', 'task'],
        additionalProperties: false,
      },
    });
  }

  if (includePersonalOps) {
    tools.push(
      {
        type: 'function',
        name: 'personal_ops_get_today',
        description: 'Read the latest host-generated today summary and priorities.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'personal_ops_get_inbox',
        description: 'Read the latest normalized inbox summary.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'personal_ops_get_calendar',
        description: 'Read the latest normalized calendar summary.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'personal_ops_get_workboard',
        description: 'Read the grouped client/project workboard snapshot.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'personal_ops_get_history',
        description: 'Read the recent normalized activity history.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'personal_ops_get_reports',
        description: 'Read the latest generated brief, standup, and wrap snapshots.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'personal_ops_get_connections',
        description: 'Read the currently connected personal-ops accounts and sync status.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'personal_ops_record_correction',
        description: 'Record a host-side correction for a source record or work item.',
        parameters: {
          type: 'object',
          properties: {
            target_type: { type: 'string' },
            target_id: { type: 'string' },
            field: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['target_type', 'target_id', 'field', 'value'],
          additionalProperties: false,
        },
      },
    );
  }

  return tools;
}

async function runOpenAITurn(
  client: OpenAI,
  containerInput: ContainerInput,
  prompt: string,
  initialState: OpenAISessionState,
  allowSendMessage: boolean,
  allowSubagent: boolean,
): Promise<{ result: string | null; sessionState: OpenAISessionState }> {
  const sessionState = currentSessionState(initialState);
  ensureDir(OPENAI_SESSION_ROOT);
  ensureDir(CONVERSATIONS_DIR);

  const transcriptPath =
    sessionState.transcriptPath ||
    path.join(OPENAI_SESSION_ROOT, 'current-transcript.jsonl');
  const summaryPath =
    sessionState.summaryPath || path.join(OPENAI_SESSION_ROOT, 'summary.md');
  sessionState.transcriptPath = transcriptPath;
  sessionState.summaryPath = summaryPath;

  const tools = responseTools(
    allowSendMessage,
    allowSubagent,
    containerInput.isMain,
  );
  const instructions = buildInstructions(
    containerInput,
    sessionState,
    allowSendMessage,
    allowSubagent,
  );
  const userPrompt = containerInput.isScheduledTask
    ? `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`
    : prompt;

  appendJsonLine(transcriptPath, {
    ts: new Date().toISOString(),
    kind: 'user_prompt',
    prompt: userPrompt,
  });

  let response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-5.4',
    reasoning: { effort: (process.env.OPENAI_REASONING_EFFORT as any) || 'medium' },
    instructions,
    input: userPrompt,
    previous_response_id: sessionState.previousResponseId,
    truncation: 'auto',
    tools,
  });

  appendJsonLine(transcriptPath, {
    ts: new Date().toISOString(),
    kind: 'response',
    response_id: response.id,
    conversation_id: response.conversation?.id,
    output_text: response.output_text,
    output: response.output,
  });

  while (true) {
    const toolOutputs: Array<Record<string, unknown>> = [];
    const ctx: FunctionContext = {
      containerInput,
      client,
      transcriptPath,
      allowSendMessage,
      allowSubagent,
    };

    for (const item of response.output || []) {
      if (item.type === 'function_call') {
        const output = await executeFunctionCall(item, ctx);
        toolOutputs.push(output);
        appendJsonLine(transcriptPath, {
          ts: new Date().toISOString(),
          kind: 'tool',
          tool_type: item.type,
          name: item.name,
          payload: output,
        });
      } else if (item.type === 'shell_call') {
        const output = await executeShellCall(item);
        toolOutputs.push(output);
        appendJsonLine(transcriptPath, {
          ts: new Date().toISOString(),
          kind: 'tool',
          tool_type: item.type,
          payload: output,
        });
      } else if (item.type === 'apply_patch_call') {
        const output = await executeApplyPatchCall(item);
        toolOutputs.push(output);
        appendJsonLine(transcriptPath, {
          ts: new Date().toISOString(),
          kind: 'tool',
          tool_type: item.type,
          payload: output,
        });
      }
    }

    if (toolOutputs.length === 0) break;

    response = await client.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.4',
      reasoning: { effort: (process.env.OPENAI_REASONING_EFFORT as any) || 'medium' },
      instructions,
      input: toolOutputs as any,
      previous_response_id: response.id,
      truncation: 'auto',
      tools,
    });

    appendJsonLine(transcriptPath, {
      ts: new Date().toISOString(),
      kind: 'response',
      response_id: response.id,
      conversation_id: response.conversation?.id,
      output_text: response.output_text,
      output: response.output,
    });
  }

  const compactedState = await maybeCompactConversation(
    client,
    {
      ...sessionState,
      previousResponseId: response.id,
      conversationId: response.conversation?.id || sessionState.conversationId,
    },
    containerInput.assistantName || 'NanoClaw',
  );

  return {
    result: response.output_text?.trim() || null,
    sessionState: mergeTurnSessionState(
      sessionState,
      compactedState,
      response.id,
      response.conversation?.id || undefined,
      transcriptPath,
      summaryPath,
    ),
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  ensureDir(OPENAI_SESSION_ROOT);
  ensureDir(IPC_INPUT_DIR);

  const pending = drainIpcInput();
  let prompt = containerInput.prompt;
  if (pending.length > 0) {
    prompt += `\n${pending.join('\n')}`;
  }

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'placeholder',
    baseURL: process.env.OPENAI_BASE_URL,
    defaultHeaders: process.env.NANOCLAW_PROXY_TOKEN
      ? { 'x-nanoclaw-proxy-token': process.env.NANOCLAW_PROXY_TOKEN }
      : undefined,
  });

  let sessionState = currentSessionState(containerInput.session);

  try {
    while (true) {
      log(
        `Starting OpenAI turn (previous_response_id: ${sessionState.previousResponseId || 'new'})`,
      );
      const turn = await runOpenAITurn(
        client,
        containerInput,
        prompt,
        sessionState,
        true,
        true,
      );
      sessionState = turn.sessionState;
      writeOutput({
        status: 'success',
        result: turn.result,
        newSessionState: sessionState,
      });

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionState: sessionState,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();

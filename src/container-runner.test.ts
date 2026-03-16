import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  OPENAI_MODEL: 'gpt-5.4',
  OPENAI_REASONING_EFFORT: 'medium',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      lstatSync: vi.fn(() => ({ isSymbolicLink: () => false })),
      realpathSync: vi.fn((p: string) => p),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  buildContainerArgs,
  runContainerAgent,
  ContainerOutput,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    vi.mocked(fs.lstatSync).mockImplementation(
      () =>
        ({ isSymbolicLink: () => false }) as ReturnType<typeof fs.lstatSync>,
    );
    vi.mocked(fs.realpathSync).mockImplementation((p: fs.PathLike) =>
      String(p),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionState: {
        provider: 'openai',
        previousResponseId: 'resp-123',
      },
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionState?.previousResponseId).toBe('resp-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionState: {
        provider: 'openai',
        previousResponseId: 'resp-456',
      },
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionState?.previousResponseId).toBe('resp-456');
  });

  it('mounts /workspace/global for the main group', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (filePath) =>
        String(filePath) === '/tmp/nanoclaw-test-groups/global' ||
        String(filePath).endsWith('/.env'),
    );

    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        folder: 'main',
        isMain: true,
      },
      {
        ...testInput,
        groupFolder: 'main',
        isMain: true,
      },
      () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
    });
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
    expect(
      args.some((arg) =>
        String(arg).includes(
          '/tmp/nanoclaw-test-groups/global:/workspace/global',
        ),
      ),
    ).toBe(true);
  });

  it('builds apple-container args without docker-only uid mapping', () => {
    const args = buildContainerArgs(
      [
        {
          hostPath: '/tmp/host',
          containerPath: '/workspace/group',
          readonly: false,
        },
      ],
      'nanoclaw-test',
      'apple-container',
    );

    expect(args).toContain('--volume');
    expect(args).toContain('/tmp/host:/workspace/group');
    expect(args).toContain('--env');
    expect(args).toContain('NODE_OPTIONS=--dns-result-order=ipv4first');
    expect(args).not.toContain('--user');
    expect(args).not.toContain('--add-host=host.docker.internal:host-gateway');
    expect(args).toContain('OPENAI_BASE_URL=http://192.168.64.1:3001/v1');
    expect(
      args.some((arg) => String(arg).startsWith('NANOCLAW_PROXY_TOKEN=')),
    ).toBe(true);
  });

  it('main group only mounts curated static project content read-only', async () => {
    const mainGroup: RegisteredGroup = {
      ...testGroup,
      folder: 'main-group',
      isMain: true,
    };

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const value = String(p);
      return (
        value === '/Users/test/project' ||
        value === '/Users/test/project/.claude' ||
        value === '/Users/test/project/.mcp.json' ||
        value === '/Users/test/project/CLAUDE.md' ||
        value === '/Users/test/project/src' ||
        value === '/Users/test/project/README.md' ||
        value === '/Users/test/project/package.json'
      );
    });
    vi.mocked(fs.realpathSync).mockImplementation((p: fs.PathLike) =>
      String(p),
    );

    const originalCwd = process.cwd;
    process.cwd = () => '/Users/test/project';

    try {
      const resultPromise = runContainerAgent(
        mainGroup,
        { ...testInput, groupFolder: 'main-group', isMain: true },
        () => {},
      );

      emitOutputMarker(fakeProc, {
        status: 'success',
        result: 'Done',
      });
      fakeProc.emit('close', 0);

      await resultPromise;

      const containerArgs = vi.mocked(spawn).mock.calls[0]?.[1] as
        | string[]
        | undefined;
      expect(containerArgs).toBeDefined();
      expect(containerArgs).toContain(
        '/Users/test/project/src:/workspace/project/src:ro',
      );
      expect(containerArgs).toContain(
        '/Users/test/project/README.md:/workspace/project/README.md:ro',
      );
      expect(containerArgs).toContain(
        '/Users/test/project/package.json:/workspace/project/package.json:ro',
      );
      expect(containerArgs).not.toContain(
        '/Users/test/project:/workspace/project:ro',
      );
      expect(containerArgs).not.toContain(
        '/Users/test/project/.claude:/workspace/project/.claude:ro',
      );
      expect(containerArgs).not.toContain(
        '/Users/test/project/.mcp.json:/workspace/project/.mcp.json:ro',
      );
      expect(containerArgs).not.toContain(
        '/Users/test/project/CLAUDE.md:/workspace/project/CLAUDE.md:ro',
      );
      expect(containerArgs).not.toContain('/app/src');
    } finally {
      process.cwd = originalCwd;
    }
  });
});

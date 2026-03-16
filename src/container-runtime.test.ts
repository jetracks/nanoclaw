import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  cleanupOrphans,
  containerHostGateway,
  containerRuntimeBinary,
  ensureContainerRuntimeRunning,
  hostGatewayArgs,
  mountArgs,
  normalizeContainerRuntime,
  parseOrphanedContainerNames,
  readonlyMountArgs,
  resolveProxyBindHost,
  runtimeHealthcheckCommand,
  runtimeOrphanListCommand,
  runtimeSupportsUserMapping,
  stopContainer,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runtime selection', () => {
  it('defaults unknown values to docker', () => {
    expect(normalizeContainerRuntime(undefined)).toBe('docker');
    expect(normalizeContainerRuntime('weird')).toBe('docker');
  });

  it('preserves apple-container selection', () => {
    expect(normalizeContainerRuntime('apple-container')).toBe('apple-container');
  });
});

describe('runtime helpers', () => {
  it('returns the correct binary for each runtime', () => {
    expect(containerRuntimeBinary('docker')).toBe('docker');
    expect(containerRuntimeBinary('apple-container')).toBe('container');
  });

  it('returns the correct host gateway for each runtime', () => {
    expect(containerHostGateway('docker')).toBe('host.docker.internal');
    expect(containerHostGateway('apple-container')).toBe('192.168.64.1');
  });

  it('only adds docker host-gateway flags on linux', () => {
    expect(hostGatewayArgs('docker', 'linux')).toEqual([
      '--add-host=host.docker.internal:host-gateway',
    ]);
    expect(hostGatewayArgs('docker', 'darwin')).toEqual([]);
    expect(hostGatewayArgs('apple-container', 'linux')).toEqual([]);
  });

  it('uses --volume syntax for mounts', () => {
    expect(mountArgs('/host/path', '/container/path', false, 'docker')).toEqual([
      '--volume',
      '/host/path:/container/path',
    ]);
    expect(readonlyMountArgs('/host/path', '/container/path', 'apple-container')).toEqual([
      '--volume',
      '/host/path:/container/path:ro',
    ]);
  });

  it('disables uid mapping for apple-container', () => {
    expect(runtimeSupportsUserMapping('docker')).toBe(true);
    expect(runtimeSupportsUserMapping('apple-container')).toBe(false);
  });

  it('resolves proxy bind host for apple-container from bridge100', () => {
    expect(
      resolveProxyBindHost('apple-container', {
        platform: 'darwin',
        networkInterfaces: () => ({
          bridge100: [
            {
              address: '192.168.64.1',
              netmask: '255.255.255.0',
              family: 'IPv4',
              mac: '00:00:00:00:00:00',
              internal: false,
              cidr: '192.168.64.1/24',
            },
          ],
        }),
      }),
    ).toBe('192.168.64.1');
  });

  it('falls back to 0.0.0.0 when bridge100 is unavailable', () => {
    expect(
      resolveProxyBindHost('apple-container', {
        platform: 'darwin',
        networkInterfaces: () => ({}),
      }),
    ).toBe('0.0.0.0');
  });

  it('uses docker-specific healthcheck and orphan commands', () => {
    expect(runtimeHealthcheckCommand('docker')).toBe('docker info');
    expect(runtimeHealthcheckCommand('apple-container')).toBe(
      'container ls --format json --all',
    );
    expect(runtimeOrphanListCommand('docker')).toContain('docker ps');
    expect(runtimeOrphanListCommand('apple-container')).toBe(
      'container ls --format json --all',
    );
  });

  it('parses orphan names from apple-container JSON output', () => {
    expect(
      parseOrphanedContainerNames(
        JSON.stringify([
          { id: 'nanoclaw-main-1', state: 'running' },
          { id: 'other', state: 'running' },
          { name: 'nanoclaw-sidecar-2', state: 'exited' },
        ]),
        'apple-container',
      ),
    ).toEqual(['nanoclaw-main-1', 'nanoclaw-sidecar-2']);
  });
});

describe('stopContainer', () => {
  it('returns stop commands for both runtimes', () => {
    expect(stopContainer('nanoclaw-test-123', 'docker')).toBe(
      'docker stop nanoclaw-test-123',
    );
    expect(stopContainer('nanoclaw-test-123', 'apple-container')).toBe(
      'container stop nanoclaw-test-123',
    );
  });
});

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when docker is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning('docker');

    expect(mockExecSync).toHaveBeenCalledWith('docker info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      { runtime: 'docker' },
      'Container runtime already running',
    );
  });

  it('uses apple-container healthcheck when selected', () => {
    mockExecSync.mockReturnValueOnce('[]');

    ensureContainerRuntimeRunning('apple-container');

    expect(mockExecSync).toHaveBeenCalledWith('container ls --format json --all', {
      stdio: 'pipe',
      timeout: 10000,
    });
  });

  it('throws when the selected runtime is unavailable', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning('docker')).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('cleanupOrphans', () => {
  it('stops orphaned docker containers', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-group1-111\nnanoclaw-group2-222\n');
    mockExecSync.mockReturnValue('');

    cleanupOrphans('docker');

    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      'docker stop nanoclaw-group1-111',
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      'docker stop nanoclaw-group2-222',
      { stdio: 'pipe' },
    );
  });

  it('stops orphaned apple-container containers from JSON output', () => {
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        { id: 'nanoclaw-group1-111' },
        { id: 'nanoclaw-group2-222' },
      ]),
    );
    mockExecSync.mockReturnValue('');

    cleanupOrphans('apple-container');

    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      'container stop nanoclaw-group1-111',
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      'container stop nanoclaw-group2-222',
      { stdio: 'pipe' },
    );
  });

  it('warns and continues when the list command fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('runtime unavailable');
    });

    cleanupOrphans('apple-container');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });
});

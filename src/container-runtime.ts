/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type ContainerRuntime = 'docker' | 'apple-container';

const envConfig = readEnvFile(['CONTAINER_HOST_GATEWAY', 'CONTAINER_RUNTIME']);

export function normalizeContainerRuntime(
  value: string | undefined,
): ContainerRuntime {
  return value === 'apple-container' ? 'apple-container' : 'docker';
}

export const CONTAINER_RUNTIME = normalizeContainerRuntime(
  process.env.CONTAINER_RUNTIME || envConfig.CONTAINER_RUNTIME,
);

export function containerRuntimeBinary(
  runtime: ContainerRuntime = CONTAINER_RUNTIME,
): string {
  return runtime === 'apple-container' ? 'container' : 'docker';
}

/** The configured container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = containerRuntimeBinary();

export function containerHostGateway(
  runtime: ContainerRuntime = CONTAINER_RUNTIME,
): string {
  if (process.env.CONTAINER_HOST_GATEWAY || envConfig.CONTAINER_HOST_GATEWAY) {
    return process.env.CONTAINER_HOST_GATEWAY || envConfig.CONTAINER_HOST_GATEWAY!;
  }

  if (runtime === 'apple-container') {
    // Inference from docs/APPLE-CONTAINER-NETWORKING.md:
    // the macOS host is reachable at bridge100 (192.168.64.1).
    return '192.168.64.1';
  }

  return 'host.docker.internal';
}

/** Hostname or IP containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = containerHostGateway();

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 * Apple Container (macOS): prefer bridge100 when available, otherwise bind all
 *   interfaces so the VM can reach the proxy via 192.168.64.1.
 */
export function resolveProxyBindHost(
  runtime: ContainerRuntime = CONTAINER_RUNTIME,
  options?: {
    networkInterfaces?: typeof os.networkInterfaces;
    platform?: NodeJS.Platform;
    wslInteropExists?: () => boolean;
  },
): string {
  const platform = options?.platform || os.platform();
  const networkInterfaces = options?.networkInterfaces || os.networkInterfaces;
  const wslInteropExists =
    options?.wslInteropExists ||
    (() => fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop'));

  if (runtime === 'apple-container') {
    const ifaces = networkInterfaces();
    const bridge = ifaces['bridge100'];
    const bridgeIpv4 = bridge?.find((entry) => entry.family === 'IPv4');
    return bridgeIpv4?.address || '0.0.0.0';
  }

  if (platform === 'darwin') return '127.0.0.1';

  if (wslInteropExists()) return '127.0.0.1';

  const ifaces = networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((entry) => entry.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }

  return '0.0.0.0';
}

export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || resolveProxyBindHost();

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(
  runtime: ContainerRuntime = CONTAINER_RUNTIME,
  platform: NodeJS.Platform = os.platform(),
): string[] {
  if (runtime === 'docker' && platform === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }

  return [];
}

/** Returns CLI args for a bind mount. */
export function mountArgs(
  hostPath: string,
  containerPath: string,
  readonly: boolean,
  _runtime: ContainerRuntime = CONTAINER_RUNTIME,
): string[] {
  return [
    '--volume',
    `${hostPath}:${containerPath}${readonly ? ':ro' : ''}`,
  ];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
  runtime: ContainerRuntime = CONTAINER_RUNTIME,
): string[] {
  return mountArgs(hostPath, containerPath, true, runtime);
}

export function runtimeSupportsUserMapping(
  runtime: ContainerRuntime = CONTAINER_RUNTIME,
): boolean {
  return runtime === 'docker';
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(
  name: string,
  runtime: ContainerRuntime = CONTAINER_RUNTIME,
): string {
  return `${containerRuntimeBinary(runtime)} stop ${name}`;
}

export function runtimeHealthcheckCommand(
  runtime: ContainerRuntime = CONTAINER_RUNTIME,
): string {
  return runtime === 'apple-container'
    ? 'container ls --format json --all'
    : 'docker info';
}

export function runtimeOrphanListCommand(
  runtime: ContainerRuntime = CONTAINER_RUNTIME,
): string {
  return runtime === 'apple-container'
    ? 'container ls --format json --all'
    : "docker ps --filter name=nanoclaw- --format '{{.Names}}'";
}

export function parseOrphanedContainerNames(
  output: string,
  runtime: ContainerRuntime = CONTAINER_RUNTIME,
): string[] {
  if (runtime === 'docker') {
    return output
      .trim()
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean);
  }

  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }

  const collectNames = (entries: unknown[]): string[] =>
    entries
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return '';
        }
        const item = entry as Record<string, unknown>;
        const candidate = item.name || item.Name || item.id || item.ID;
        return typeof candidate === 'string' ? candidate : '';
      })
      .filter((name) => name.startsWith('nanoclaw-'));

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return collectNames(parsed);
    }
    if (parsed && typeof parsed === 'object') {
      return collectNames([parsed]);
    }
  } catch {
    // Fall through and try NDJSON.
  }

  return trimmed.split('\n').flatMap((line) => {
    try {
      return collectNames([JSON.parse(line) as unknown]);
    } catch {
      return [];
    }
  });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(
  runtime: ContainerRuntime = CONTAINER_RUNTIME,
): void {
  const healthcheck = runtimeHealthcheckCommand(runtime);

  try {
    execSync(healthcheck, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug({ runtime }, 'Container runtime already running');
  } catch (err) {
    logger.error({ err, runtime }, 'Failed to reach container runtime');
    const runtimeName =
      runtime === 'apple-container' ? 'Apple Container' : 'Docker';
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      `║  1. Ensure ${runtimeName.padEnd(54)}║`,
    );
    console.error(
      `║  2. Run: ${healthcheck.padEnd(52)}║`,
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(
  runtime: ContainerRuntime = CONTAINER_RUNTIME,
): void {
  try {
    const output = execSync(runtimeOrphanListCommand(runtime), {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const orphans = parseOrphanedContainerNames(output, runtime);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name, runtime), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

#!/usr/bin/env node

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const STOP_WAIT_MS = 10_000;
const STOP_POLL_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getPidFilePath(repoRoot) {
  return path.join(repoRoot, 'data', 'runtime', 'nanoclaw.pid');
}

function ensureRuntimeDir(repoRoot) {
  fs.mkdirSync(path.dirname(getPidFilePath(repoRoot)), {
    recursive: true,
    mode: 0o700,
  });
}

function readPidFile(repoRoot) {
  try {
    const raw = fs.readFileSync(getPidFilePath(repoRoot), 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw);
      return typeof parsed.pid === 'number' ? parsed.pid : null;
    }
    const pid = Number(raw);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function getCommandForPid(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function commandMatchesRepo(command, repoRoot) {
  if (!command) return false;
  const normalizedRepoRoot = repoRoot.replace(/\\/g, '/');
  return (
    command.includes(`${normalizedRepoRoot}/dist/index.js`) ||
    command.includes(`${normalizedRepoRoot}/scripts/start.mjs`)
  );
}

export function isNanoClawPidRunning(pid, repoRoot) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return commandMatchesRepo(getCommandForPid(pid), repoRoot);
}

function clearStalePidFile(repoRoot) {
  try {
    fs.rmSync(getPidFilePath(repoRoot), { force: true });
  } catch {
    // ignore
  }
}

export function findRunningNanoClawPid(repoRoot) {
  const pidFromFile = readPidFile(repoRoot);
  if (isNanoClawPidRunning(pidFromFile, repoRoot)) {
    return pidFromFile;
  }
  if (pidFromFile) {
    clearStalePidFile(repoRoot);
  }

  try {
    const output = execFileSync('ps', ['-Ao', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const command = match[2] || '';
      if (pid !== process.pid && commandMatchesRepo(command, repoRoot)) {
        return pid;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

export function writePidFile(repoRoot, pid) {
  ensureRuntimeDir(repoRoot);
  fs.writeFileSync(
    getPidFilePath(repoRoot),
    JSON.stringify(
      {
        pid,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

export function clearPidFile(repoRoot, pid) {
  const current = readPidFile(repoRoot);
  if (current && pid && current !== pid) {
    return;
  }
  clearStalePidFile(repoRoot);
}

export async function stopRunningNanoClaw(repoRoot) {
  const pid = findRunningNanoClawPid(repoRoot);
  if (!pid) {
    clearStalePidFile(repoRoot);
    return { stopped: false, pid: null, forced: false };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    clearPidFile(repoRoot, pid);
    return { stopped: false, pid, forced: false };
  }

  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isNanoClawPidRunning(pid, repoRoot)) {
      clearPidFile(repoRoot, pid);
      return { stopped: true, pid, forced: false };
    }
    await sleep(STOP_POLL_MS);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // ignore
  }

  const forcedDeadline = Date.now() + 2_000;
  while (Date.now() < forcedDeadline) {
    if (!isNanoClawPidRunning(pid, repoRoot)) {
      clearPidFile(repoRoot, pid);
      return { stopped: true, pid, forced: true };
    }
    await sleep(100);
  }

  clearPidFile(repoRoot, pid);
  return { stopped: true, pid, forced: true };
}

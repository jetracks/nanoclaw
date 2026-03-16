#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import { ensureProjectRuntime } from './ensure-runtime.mjs';
import {
  clearPidFile,
  findRunningNanoClawPid,
  writePidFile,
} from './process-control.mjs';

ensureProjectRuntime({ checkNative: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const existingPid = findRunningNanoClawPid(REPO_ROOT);

if (existingPid) {
  console.error(
    `NanoClaw is already running for this repo (pid ${existingPid}). Use "npm run restart" or "npm run stop".`,
  );
  process.exit(1);
}

const child = spawn(process.execPath, [path.join(REPO_ROOT, 'dist/index.js')], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});

if (!child.pid) {
  console.error('Failed to start NanoClaw child process.');
  process.exit(1);
}

writePidFile(REPO_ROOT, child.pid);

const forwardSignal = (signal) => {
  if (!child.killed && child.pid) {
    try {
      process.kill(child.pid, signal);
    } catch {
      // ignore
    }
  }
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => forwardSignal(signal));
}

child.on('error', () => {
  clearPidFile(REPO_ROOT, child.pid);
});

child.on('exit', (code, signal) => {
  clearPidFile(REPO_ROOT, child.pid);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

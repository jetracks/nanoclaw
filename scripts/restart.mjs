#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import { ensureProjectRuntime } from './ensure-runtime.mjs';
import { stopRunningNanoClaw } from './process-control.mjs';

ensureProjectRuntime({ checkNative: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const stopped = await stopRunningNanoClaw(REPO_ROOT);

if (stopped.pid) {
  console.log(
    `Stopped NanoClaw process ${stopped.pid}${stopped.forced ? ' (forced)' : ''}. Restarting...`,
  );
} else {
  console.log('No running NanoClaw process found. Starting a new one...');
}

const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/start.mjs')], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

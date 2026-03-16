#!/usr/bin/env node

import path from 'path';
import { fileURLToPath } from 'url';

import { stopRunningNanoClaw } from './process-control.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const result = await stopRunningNanoClaw(REPO_ROOT);

if (!result.pid) {
  console.log('NanoClaw is not running.');
  process.exit(0);
}

console.log(
  `Stopped NanoClaw process ${result.pid}${result.forced ? ' (forced)' : ''}.`,
);

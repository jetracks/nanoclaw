#!/usr/bin/env node

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const NVMRC_PATH = path.join(REPO_ROOT, '.nvmrc');

function readExpectedNodeMajor() {
  const raw = fs.readFileSync(NVMRC_PATH, 'utf8').trim();
  const match = raw.match(/^v?(\d+)/);
  if (!match) {
    throw new Error(`Unsupported .nvmrc value: "${raw}"`);
  }
  return Number(match[1]);
}

function failWrongNode(expectedMajor) {
  const current = process.version;
  console.error('');
  console.error(`NanoClaw is pinned to Node ${expectedMajor} via ${NVMRC_PATH}.`);
  console.error(`Current Node is ${current}, which will break native modules like better-sqlite3.`);
  console.error('');
  console.error('Use the project Node first, then rerun the command:');
  console.error('  source "$HOME/.nvm/nvm.sh" && nvm use');
  console.error('');
  process.exit(1);
}

function runNodeRequireCheck() {
  return spawnSync(
    process.execPath,
    [
      '-e',
      'const Database = require("better-sqlite3"); const db = new Database(":memory:"); db.prepare("select 1").get(); db.close();',
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    },
  );
}

function runNpmRebuild() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return spawnSync(
      process.execPath,
      [npmExecPath, 'rebuild', 'better-sqlite3'],
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      },
    );
  }

  return spawnSync('npm', ['rebuild', 'better-sqlite3'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

function ensureNativeModule() {
  const initial = runNodeRequireCheck();
  if (initial.status === 0) {
    return;
  }

  const output = `${initial.stdout || ''}${initial.stderr || ''}`;
  const looksLikeAbiMismatch =
    output.includes('NODE_MODULE_VERSION') ||
    output.includes('ERR_DLOPEN_FAILED');

  if (!looksLikeAbiMismatch) {
    process.stderr.write(output);
    process.exit(initial.status || 1);
  }

  console.warn('');
  console.warn(`better-sqlite3 was built for a different Node ABI. Rebuilding for ${process.version}...`);
  const rebuild = runNpmRebuild();
  if (rebuild.status !== 0) {
    process.exit(rebuild.status || 1);
  }

  const verified = runNodeRequireCheck();
  if (verified.status !== 0) {
    const verifiedOutput = `${verified.stdout || ''}${verified.stderr || ''}`;
    process.stderr.write(verifiedOutput);
    process.exit(verified.status || 1);
  }
}

export function ensureProjectRuntime(options = {}) {
  const { checkNative = false } = options;
  const expectedMajor = readExpectedNodeMajor();
  const currentMajor = Number(process.versions.node.split('.')[0]);

  if (currentMajor !== expectedMajor) {
    failWrongNode(expectedMajor);
  }

  if (checkNative) {
    ensureNativeModule();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  ensureProjectRuntime({
    checkNative: process.argv.includes('--check-native'),
  });
}

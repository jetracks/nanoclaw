import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'LOCAL_CHANNEL_ENABLED',
  'LOCAL_CHANNEL_PORT',
  'OPERATOR_UI_ENABLED',
  'OPERATOR_UI_PORT',
  'PERSONAL_OPS_ENABLED',
  'PERSONAL_OPS_PUSH_MAIN_CHAT',
  'PERSONAL_OPS_STORE_DIR',
  'PERSONAL_OPS_CLASSIFICATION_MODEL',
  'PERSONAL_OPS_REPORT_MODEL',
  'PERSONAL_OPS_ACTIVE_START_HOUR',
  'PERSONAL_OPS_ACTIVE_END_HOUR',
  'OPENAI_MODEL',
  'OPENAI_REASONING_EFFORT',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const LOCAL_CHANNEL_ENABLED =
  (process.env.LOCAL_CHANNEL_ENABLED || envConfig.LOCAL_CHANNEL_ENABLED) ===
  'true';
export const LOCAL_CHANNEL_HOST = '127.0.0.1';
export const LOCAL_CHANNEL_PORT = parseInt(
  process.env.LOCAL_CHANNEL_PORT || envConfig.LOCAL_CHANNEL_PORT || '8787',
  10,
);
export const OPERATOR_UI_ENABLED =
  (process.env.OPERATOR_UI_ENABLED || envConfig.OPERATOR_UI_ENABLED || 'true') ===
  'true';
export const OPERATOR_UI_HOST = '127.0.0.1';
export const OPERATOR_UI_PORT = parseInt(
  process.env.OPERATOR_UI_PORT || envConfig.OPERATOR_UI_PORT || '8788',
  10,
);
export const PERSONAL_OPS_ENABLED =
  (process.env.PERSONAL_OPS_ENABLED ||
    envConfig.PERSONAL_OPS_ENABLED ||
    'true') === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const PERSONAL_OPS_STORE_DIR =
  process.env.PERSONAL_OPS_STORE_DIR ||
  envConfig.PERSONAL_OPS_STORE_DIR ||
  (process.platform === 'darwin'
    ? path.join(
        HOME_DIR,
        'Library',
        'Application Support',
        'NanoClaw',
        'personal-ops',
      )
    : path.join(HOME_DIR, '.config', 'nanoclaw', 'personal-ops'));
export const PERSONAL_OPS_PUBLIC_DIR = path.join(PERSONAL_OPS_STORE_DIR, 'public');
export const PERSONAL_OPS_PUSH_MAIN_CHAT =
  (process.env.PERSONAL_OPS_PUSH_MAIN_CHAT ||
    envConfig.PERSONAL_OPS_PUSH_MAIN_CHAT ||
    'false') === 'true';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const OPENAI_MODEL =
  process.env.OPENAI_MODEL || envConfig.OPENAI_MODEL || 'gpt-5.4';
export const OPENAI_REASONING_EFFORT =
  process.env.OPENAI_REASONING_EFFORT ||
  envConfig.OPENAI_REASONING_EFFORT ||
  'medium';
export const PERSONAL_OPS_CLASSIFICATION_MODEL =
  process.env.PERSONAL_OPS_CLASSIFICATION_MODEL ||
  envConfig.PERSONAL_OPS_CLASSIFICATION_MODEL ||
  OPENAI_MODEL;
export const PERSONAL_OPS_REPORT_MODEL =
  process.env.PERSONAL_OPS_REPORT_MODEL ||
  envConfig.PERSONAL_OPS_REPORT_MODEL ||
  OPENAI_MODEL;
export const PERSONAL_OPS_ACTIVE_START_HOUR = Math.min(
  23,
  Math.max(
    0,
    parseInt(
      process.env.PERSONAL_OPS_ACTIVE_START_HOUR ||
        envConfig.PERSONAL_OPS_ACTIVE_START_HOUR ||
        '6',
      10,
    ) || 6,
  ),
);
export const PERSONAL_OPS_ACTIVE_END_HOUR = Math.min(
  23,
  Math.max(
    0,
    parseInt(
      process.env.PERSONAL_OPS_ACTIVE_END_HOUR ||
        envConfig.PERSONAL_OPS_ACTIVE_END_HOUR ||
        '22',
      10,
    ) || 22,
  ),
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
export const REMOTE_CONTROL_PORT = parseInt(
  process.env.REMOTE_CONTROL_PORT || '0',
  10,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

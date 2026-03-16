import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const KEY_DIR = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'nanoclaw',
);
const KEY_PATH = path.join(KEY_DIR, 'secret-key.bin');
const SECRET_PREFIX = 'enc:v1';

function ensureDir(): void {
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(KEY_DIR, 0o700);
  } catch {
    // ignore
  }
}

function loadMasterKey(): Buffer {
  ensureDir();
  if (!fs.existsSync(KEY_PATH)) {
    const key = randomBytes(32);
    fs.writeFileSync(KEY_PATH, key, { mode: 0o600 });
    return key;
  }
  const key = fs.readFileSync(KEY_PATH);
  if (key.length !== 32) {
    throw new Error(`Invalid NanoClaw secret key length at ${KEY_PATH}`);
  }
  try {
    fs.chmodSync(KEY_PATH, 0o600);
  } catch {
    // ignore
  }
  return key;
}

export function encryptLocalSecret(
  value: string | null | undefined,
): string | null {
  if (value == null || value === '') return value ?? null;
  if (value.startsWith(`${SECRET_PREFIX}:`)) return value;
  const key = loadMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptLocalSecret(
  value: string | null | undefined,
): string | null {
  if (value == null || value === '') return value ?? null;
  if (!value.startsWith(`${SECRET_PREFIX}:`)) return value;
  const parts = value.split(':');
  if (parts.length !== 5) {
    throw new Error('Invalid encrypted secret format');
  }
  const [, , ivPart, tagPart, ciphertextPart] = parts;
  const key = loadMasterKey();
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

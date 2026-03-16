import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { decryptLocalSecret, encryptLocalSecret } from './secret-storage.js';

const keyPath = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'nanoclaw',
  'secret-key.bin',
);

describe('secret-storage', () => {
  afterEach(() => {
    try {
      fs.unlinkSync(keyPath);
    } catch {
      // ignore
    }
  });

  it('round-trips encrypted secrets', () => {
    const ciphertext = encryptLocalSecret('token-value');
    expect(ciphertext).toMatch(/^enc:v1:/);
    expect(decryptLocalSecret(ciphertext)).toBe('token-value');
  });

  it('preserves legacy plaintext values for backward compatibility', () => {
    expect(decryptLocalSecret('plain-token')).toBe('plain-token');
  });
});

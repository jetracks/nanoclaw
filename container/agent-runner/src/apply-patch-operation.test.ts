import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { executeApplyPatchOperation } from './apply-patch-operation.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-patch-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('apply-patch-operation', () => {
  it('supports delete_file operations without a diff payload', async () => {
    const workspace = makeTempDir();
    const filePath = path.join(workspace, 'delete-me.txt');
    fs.writeFileSync(filePath, 'remove me');

    const result = await executeApplyPatchOperation(workspace, {
      type: 'delete_file',
      path: 'delete-me.txt',
    });

    expect(result.status).toBe('completed');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('updates an existing file with unified diff content', async () => {
    const workspace = makeTempDir();
    const filePath = path.join(workspace, 'note.txt');
    fs.writeFileSync(filePath, 'old value\n');

    const result = await executeApplyPatchOperation(workspace, {
      type: 'update_file',
      path: 'note.txt',
      diff: `--- note.txt\n+++ note.txt\n@@ -1 +1 @@\n-old value\n+new value\n`,
    });

    expect(result.status).toBe('completed');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new value\n');
  });
});

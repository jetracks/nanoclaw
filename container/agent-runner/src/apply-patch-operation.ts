import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ApplyPatchOperation {
  type: 'create_file' | 'update_file' | 'delete_file';
  path: string;
  diff?: string;
}

function resolveWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
): string {
  const resolved = path.resolve(workspaceRoot, relativePath);
  if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }
  return resolved;
}

export async function executeApplyPatchOperation(
  workspaceRoot: string,
  operation: ApplyPatchOperation | null | undefined,
): Promise<{ status: 'completed' | 'failed'; output: string }> {
  if (!operation || typeof operation.path !== 'string') {
    return {
      status: 'failed',
      output: 'Invalid apply_patch payload',
    };
  }

  let targetPath: string;
  try {
    targetPath = resolveWorkspacePath(workspaceRoot, operation.path);
  } catch (err) {
    return {
      status: 'failed',
      output: err instanceof Error ? err.message : String(err),
    };
  }

  if (operation.type === 'delete_file') {
    try {
      fs.rmSync(targetPath, { force: true });
      return {
        status: 'completed',
        output: 'File deleted.',
      };
    } catch (err) {
      return {
        status: 'failed',
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (typeof operation.diff !== 'string') {
    return {
      status: 'failed',
      output: 'Invalid apply_patch payload',
    };
  }

  const patchFile = path.join(
    '/tmp',
    `nanoclaw-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`,
  );

  try {
    fs.writeFileSync(patchFile, operation.diff);
    const { stdout, stderr } = await execFileAsync(
      'patch',
      ['-p0', '--forward', '--batch', '-i', patchFile],
      {
        cwd: workspaceRoot,
        maxBuffer: 1024 * 1024,
      },
    );
    return {
      status: 'completed',
      output: [stdout, stderr].filter(Boolean).join('\n') || 'Patch applied.',
    };
  } catch (err: any) {
    return {
      status: 'failed',
      output: err?.stderr || err?.message || String(err),
    };
  } finally {
    try {
      fs.unlinkSync(patchFile);
    } catch {
      // ignore
    }
  }
}

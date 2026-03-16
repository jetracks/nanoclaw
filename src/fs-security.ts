import fs from 'fs';
import path from 'path';

const SAFE_IPC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function ensureWithinBase(baseDir: string, candidatePath: string): void {
  const relative = path.relative(baseDir, candidatePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes base directory: ${candidatePath}`);
  }
}

export function assertSafeIpcId(value: string, label = 'IPC identifier'): string {
  const normalized = value.trim();
  if (!SAFE_IPC_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

export function resolveSafeChildPath(
  baseDir: string,
  childName: string,
  label = 'path',
): string {
  const normalized = assertSafeIpcId(childName, label);
  const candidatePath = path.resolve(baseDir, normalized);
  ensureWithinBase(path.resolve(baseDir), candidatePath);
  return candidatePath;
}

export function safeReadUtf8FileNoFollow(
  filePath: string,
  options?: { requireSingleLink?: boolean },
): string {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Refusing to read non-regular file: ${filePath}`);
  }
  if (options?.requireSingleLink !== false && stats.nlink !== 1) {
    throw new Error(`Refusing to read linked file: ${filePath}`);
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    return fs.readFileSync(fd, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

export function listSafeJsonFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs
    .readdirSync(dirPath)
    .filter((fileName) => fileName.endsWith('.json'))
    .filter((fileName) => {
      const filePath = path.join(dirPath, fileName);
      try {
        const stats = fs.lstatSync(filePath);
        return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1;
      } catch {
        return false;
      }
    })
    .sort();
}

export function unlinkIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

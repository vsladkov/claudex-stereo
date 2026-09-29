import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';

import { parsePositiveIntEnv } from './env.ts';
import { errorCode, errorMessage } from './errors.ts';

const STDIN_TIMEOUT_ENV = 'CODEX_STDIN_TIMEOUT_MS';
const MAX_STDIN_BYTES = 32 * 1024 * 1024;

const DEFAULT_STDIN_TIMEOUT_MS = 10_000;
const DEFAULT_SYNC_STDIN_BUDGET_MS = 250;
const STDIN_READ_CHUNK_BYTES = 64 * 1024;
const SYNC_STDIN_RETRY_MS = 20;
const OUTSIDE_ALLOWED_ROOTS_CODE = 'ERR_STEREO_FILE_OUTSIDE_ROOTS';

export function ensureAbsolutePath(cwd: string, maybePath: string): string {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// A JSON record another process may be rewriting or may have removed: a
// missing file and an unreadable one are both answers, never throws.
export interface JsonFileRead {
  missing: boolean;
  record: unknown;
  parseError: string | null;
}

export function readJsonFileTolerant(filePath: string): JsonFileRead {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { missing: true, record: null, parseError: null };
    }
    return {
      missing: false,
      record: null,
      parseError: errorMessage(error),
    };
  }
  try {
    return { missing: false, record: JSON.parse(text), parseError: null };
  } catch (error) {
    return {
      missing: false,
      record: null,
      parseError: errorMessage(error),
    };
  }
}

// Readers never see a torn file: the contents land in a unique temporary
// file beside the target, then replace it through a rename.
export function writeTextAtomic(filePath: string, contents: string): void {
  const tempFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempFile, contents, 'utf8');
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Best-effort cleanup: preserve the original write/rename failure.
    }
    throw error;
  }
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// Creates a file only while none exists (an exclusive create): false when
// one already does; any other failure throws.
export function writeFileExclusive(filePath: string, contents: string): boolean {
  try {
    fs.writeFileSync(filePath, contents, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      throw error;
    }
    return false;
  }
}

export function isProbablyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

export function resolveStdinTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntEnv(env[STDIN_TIMEOUT_ENV], DEFAULT_STDIN_TIMEOUT_MS);
}

// A blocking pause for the few synchronous paths that need one (signal
// handlers, lock retries).
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The I/O failures a read retries: a Windows antivirus scan holding the file,
// a full descriptor table.
const TRANSIENT_READ_CODES = new Set(['EBUSY', 'EACCES', 'EPERM', 'EMFILE']);
const READ_RETRY_MS = 20;

// A text file another process may hold open or be replacing: a transient I/O
// failure (EBUSY, EACCES, EPERM, EMFILE: a Windows antivirus scan, a full
// descriptor table) is retried briefly before it is thrown. Null when no file
// exists.
export function readTextRetrying(
  filePath: string,
  options: { attempts?: number } = {},
): string | null {
  const attempts = Math.max(1, options.attempts ?? 5);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') {
        return null;
      }
      const transient = code !== undefined && TRANSIENT_READ_CODES.has(code);
      if (!transient || attempt >= attempts) {
        throw error;
      }
      sleepSync(READ_RETRY_MS);
    }
  }
}

// Removes a file only while it still holds the given contents: re-read,
// compare, unlink. A stale lock's taker (or a lock's holder) never deletes a
// successor's file that replaced it before the re-read. True when no file
// holding those contents is left at the path; a read or unlink failure throws.
export function removeFileHolding(filePath: string, contents: string): boolean {
  const current = readTextRetrying(filePath, { attempts: 1 });
  if (current === null) {
    return true;
  }
  if (current !== contents) {
    return false;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
  return true;
}

// A release that fails (a Windows antivirus scan holding the file, a full
// descriptor table) is retried briefly before its error is thrown.
const RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_MS = 20;

// A holder's own release: its file goes only while it still holds its contents.
export function releaseLockFile(lockPath: string, contents: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      removeFileHolding(lockPath, contents);
      return;
    } catch (error) {
      if (attempt >= RELEASE_ATTEMPTS) {
        throw error;
      }
      sleepSync(RELEASE_RETRY_MS);
    }
  }
}

// A lock whose file is older than this (its mtime) is taken over.
const STALE_LOCK_MS = 5_000;
// The pause between two attempts at a held lock, before its jitter.
const LOCK_RETRY_MS = 25;

export interface FileLockOptions {
  attempts?: number;
  /** Epoch ms after which no further attempt is made (at least one always is). */
  deadline?: number | null;
  /**
   * Run the work without the lock when it cannot be taken in time, instead of
   * throwing. Best effort by definition: the lock's one-holder guarantee
   * covers only work that ran under the lock, never work run this way.
   */
  unlockedFallback?: boolean;
}

// A lock held by someone else, judged once: taken over (removed) when its
// file is older than STALE_LOCK_MS and it still holds what was read; true
// when the path is free to try again at once. The work under a lock takes
// milliseconds, so age alone marks a dead writer's lock; the pid it holds is
// informational. A lock that cannot be read or stated is waited out like a
// held one.
function takeOverStaleLock(lockPath: string): boolean {
  let text: string | null;
  let ageMs: number;
  try {
    // Read before the stat: a lock that replaced the one read is younger, so
    // its age never lets the older contents be taken over.
    text = readTextRetrying(lockPath, { attempts: 1 });
    if (text === null) {
      return true;
    }
    ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
  if (ageMs <= STALE_LOCK_MS) {
    return false;
  }
  try {
    return removeFileHolding(lockPath, text);
  } catch {
    return false;
  }
}

// Exclusive-create lock file around a read-modify-write of a small JSON file
// shared by concurrent companion processes. The lock holds `<pid> <token>`
// and is released only while it still holds them; one older than
// STALE_LOCK_MS is taken to be a dead writer's and taken over
// (takeOverStaleLock). An error thrown by the work is the work's own: it is
// never mistaken for lock contention, and the work never runs twice. The
// one-holder guarantee is the lock's, without `unlockedFallback`: work run
// through that fallback holds nothing.
export function withFileLock<T>(lockPath: string, work: () => T, options: FileLockOptions = {}): T {
  const attempts = Math.max(1, options.attempts ?? 40);
  const deadline = options.deadline ?? null;
  const contents = `${process.pid} ${randomUUID()}`;
  let acquired = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 && deadline !== null && Date.now() >= deadline) {
      break;
    }
    if (writeFileExclusive(lockPath, contents)) {
      acquired = true;
      break;
    }
    if (takeOverStaleLock(lockPath)) {
      continue;
    }
    // Jittered, so waiters do not retry in lockstep.
    sleepSync(Math.round(LOCK_RETRY_MS * (0.5 + Math.random())));
  }
  if (!acquired) {
    if (options.unlockedFallback) {
      return work();
    }
    throw new Error(
      `Timed out waiting for the lock ${lockPath}. If no Stereo process holds it, delete it and retry.`,
    );
  }
  try {
    return work();
  } finally {
    try {
      releaseLockFile(lockPath, contents);
    } catch {
      // A release that keeps failing leaves a lock the next writer takes over once it is stale.
    }
  }
}

export function readStdinSyncBestEffort(
  options: {
    readImpl?: typeof fs.readSync;
    nowImpl?: () => number;
    budgetMs?: number;
  } = {},
): string {
  if (process.stdin.isTTY) {
    return '';
  }

  const readImpl = options.readImpl ?? fs.readSync;
  const nowImpl = options.nowImpl ?? Date.now;
  const deadline = nowImpl() + (options.budgetMs ?? DEFAULT_SYNC_STDIN_BUDGET_MS);
  const buffer = Buffer.allocUnsafe(STDIN_READ_CHUNK_BYTES);
  const chunks: Buffer[] = [];

  while (true) {
    try {
      const bytesRead = readImpl(0, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EOF') {
        break;
      }
      if (code !== 'EAGAIN') {
        return '';
      }
      if (nowImpl() >= deadline) {
        break;
      }
      sleepSync(SYNC_STDIN_RETRY_MS);
    }
  }

  return Buffer.concat(chunks).toString('utf8');
}

function formatTimeoutSeconds(timeoutMs: number): string {
  return `${timeoutMs / 1000}s`;
}

export function readStdinTextIfPiped(options: {
  label: string;
  onTimeout: 'error' | 'empty';
  timeoutMs?: number;
}): Promise<string> {
  if (process.stdin.isTTY) {
    return Promise.resolve('');
  }

  const timeoutMs = options.timeoutMs ?? resolveStdinTimeoutMs();
  const timeoutText = formatTimeoutSeconds(timeoutMs);

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer ?? undefined);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      process.stdin.destroy();
    };
    const settle = (value: string | Error, isError = false) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (isError) {
        reject(value);
      } else {
        resolve(value as string);
      }
    };
    const armIdleTimer = () => {
      clearTimeout(timer ?? undefined);
      timer = setTimeout(() => {
        if (options.onTimeout === 'error') {
          settle(
            new Error(
              `${options.label} requires the plan document on stdin; piped input timed out after ${timeoutText}. Redirect a file with < "<planFile>" instead of leaving stdin open.`,
            ),
            true,
          );
          return;
        }
        const detail =
          byteCount === 0
            ? `no input within ${timeoutText}`
            : `stdin stayed open after ${timeoutText} idle; ignoring ${byteCount} bytes of incomplete piped input`;
        process.stderr.write(`Ignoring piped stdin for ${options.label}: ${detail}.\n`);
        settle('');
      }, timeoutMs);
    };
    const onData = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += data.length;
      if (byteCount > MAX_STDIN_BYTES) {
        settle(new Error(`${options.label} exceeds the 32 MiB stdin limit.`), true);
        return;
      }
      chunks.push(data);
      armIdleTimer();
    };
    const onEnd = () => {
      settle(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === 'EAGAIN' || error.code === 'EOF') {
        settle('');
        return;
      }
      settle(error, true);
    };

    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    armIdleTimer();
    process.stdin.resume();
  });
}

// A path's canonical form: symlinks and Windows 8.3 short names resolved
// (realpathSync.native, not realpathSync: only the native call expands short
// names, and os.tmpdir() is short-form on GitHub's Windows runners). A path
// that does not exist is only resolved.
export function canonicalPath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

// Whether `child` is `parent` or inside it; path.relative compares Windows
// paths case-insensitively.
export function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function resolveContainedUserFile(
  candidate: string,
  allowedRoots: readonly string[],
): string {
  const resolved = path.resolve(candidate);
  // Containment compares candidate and roots in the same canonical form (see
  // canonicalPath); a candidate or root that does not exist fails the read.
  const canonicalCandidate = fs.realpathSync.native(resolved);
  const contained = allowedRoots.some((root) =>
    isWithin(canonicalCandidate, fs.realpathSync.native(path.resolve(root))),
  );
  if (!contained) {
    const error = new Error(
      `Path is outside the allowed roots: ${resolved}`,
    ) as NodeJS.ErrnoException;
    error.code = OUTSIDE_ALLOWED_ROOTS_CODE;
    throw error;
  }
  return canonicalCandidate;
}

export function isOutsideAllowedRootsError(error: unknown): boolean {
  return errorCode(error) === OUTSIDE_ALLOWED_ROOTS_CODE;
}

export function readStdinJsonIfPiped(): Record<string, unknown> {
  // Hook stdin is untrusted: malformed (or unreadable) input must degrade to
  // empty input, never throw. Throwing exits nonzero before any decision,
  // which Claude Code treats as a non-blocking hook error - that silently
  // bypasses an enabled Stop gate and skips SessionEnd job/broker cleanup.
  let raw: string;
  try {
    raw = readStdinSyncBestEffort().trim();
  } catch {
    return {};
  }
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STDIN_TIMEOUT_ENV = 'CODEX_STDIN_TIMEOUT_MS';
export const MAX_STDIN_BYTES = 32 * 1024 * 1024;

const DEFAULT_STDIN_TIMEOUT_MS = 10_000;
const DEFAULT_SYNC_STDIN_BUDGET_MS = 250;
const STDIN_READ_CHUNK_BYTES = 64 * 1024;
const SYNC_STDIN_RETRY_MS = 20;
const OUTSIDE_ALLOWED_ROOTS_CODE = 'ERR_STEREO_FILE_OUTSIDE_ROOTS';

export function ensureAbsolutePath(cwd: string, maybePath: string): string {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = 'codex-plugin-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function safeReadFile(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
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
  const raw = env[STDIN_TIMEOUT_ENV];
  if (raw == null || raw.trim() === '') {
    return DEFAULT_STDIN_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_STDIN_TIMEOUT_MS;
  }
  return parsed > 0 ? parsed : 0;
}

function sleepForSyncStdinRetry(): boolean {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SYNC_STDIN_RETRY_MS);
    return true;
  } catch {
    // Some runtimes disallow blocking Atomics waits on the main thread. Hook
    // input must still degrade immediately instead of entering a busy loop.
    return false;
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
      const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
      if (code === 'EOF') {
        break;
      }
      if (code !== 'EAGAIN') {
        return '';
      }
      if (nowImpl() >= deadline || !sleepForSyncStdinRetry()) {
        break;
      }
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

export function resolveContainedUserFile(
  candidate: string,
  allowedRoots: readonly string[],
): string {
  const resolved = path.resolve(candidate);
  const canonicalCandidate = fs.realpathSync(resolved);
  const contained = allowedRoots.some((root) => {
    const canonicalRoot = fs.realpathSync(path.resolve(root));
    const relative = path.relative(canonicalRoot, canonicalCandidate);
    return (
      relative === '' ||
      (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    );
  });
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
  return (error as NodeJS.ErrnoException | null | undefined)?.code === OUTSIDE_ALLOWED_ROOTS_CODE;
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

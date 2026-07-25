import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const THREAD_RESERVATION_DIR = 'companion-thread-locks';

// Reservation JSON is untrusted disk state. Callers must validate the fields
// they rely on before acting on a record.
export interface StoredReservationRecord {
  invalid?: true;
  error?: unknown;
  token?: string;
  pid?: number;
  jobId?: string | null;
  threadId?: string;
  createdAt?: string;
}

export interface ThreadLockVerification {
  ok: boolean;
  reason?: string;
}

export interface ClaimAndDeleteThreadLockOptions {
  verify: (record: StoredReservationRecord) => ThreadLockVerification;
  beforeUnlink?: (context: {
    lockPath: string;
    cleanupPath: string;
    current: StoredReservationRecord;
  }) => unknown | Promise<unknown>;
  // The cancel path preserves its existing job-tagged claim record. Broker
  // cleanup has no job identity of its own and leaves this null.
  claimJobId?: string | null;
  // Cancel cleanup may discover a lock by scanning rather than by a recorded
  // thread id. Supplying the exact discovered path preserves that behavior.
  lockPath?: string;
}

export interface ClaimAndDeleteThreadLockResult {
  released: boolean;
  status: 'released' | 'missing' | 'claim-exists' | 'verification-failed';
  path: string;
  reason: string;
}

export function resolveCodexHome(): string {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

export function resolveThreadReservationDir(): string {
  return path.join(resolveCodexHome(), THREAD_RESERVATION_DIR);
}

export function threadReservationPath(threadId: string): string {
  const digest = crypto.createHash('sha256').update(String(threadId)).digest('hex').slice(0, 32);
  return path.join(resolveThreadReservationDir(), `${digest}.lock`);
}

export function readReservationRecord(lockPath: string): StoredReservationRecord | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as StoredReservationRecord | null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') {
      return null;
    }
    return { invalid: true, error };
  }
}

export async function claimAndDeleteThreadLock(
  threadId: string,
  options: ClaimAndDeleteThreadLockOptions,
): Promise<ClaimAndDeleteThreadLockResult> {
  const lockPath = options.lockPath ?? threadReservationPath(threadId);
  const cleanupPath = `${lockPath}.cleanup`;

  try {
    fs.writeFileSync(
      cleanupPath,
      `${JSON.stringify({
        pid: process.pid,
        jobId: options.claimJobId ?? null,
        createdAt: new Date().toISOString(),
      })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'EEXIST') {
      return {
        released: false,
        status: 'claim-exists',
        path: lockPath,
        reason: `Reservation cleanup is already in progress for ${lockPath}.`,
      };
    }
    throw error;
  }

  try {
    const current = readReservationRecord(lockPath);
    if (!current) {
      return {
        released: false,
        status: 'missing',
        path: lockPath,
        reason: `Reservation ${lockPath} no longer exists.`,
      };
    }

    const verification = options.verify(current);
    if (!verification.ok) {
      return {
        released: false,
        status: 'verification-failed',
        path: lockPath,
        reason: verification.reason ?? `Reservation ${lockPath} belongs to a different owner.`,
      };
    }

    await options.beforeUnlink?.({
      lockPath,
      cleanupPath,
      current,
    });
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') {
        throw error;
      }
    }
    return {
      released: true,
      status: 'released',
      path: lockPath,
      reason: `Released reservation ${lockPath}.`,
    };
  } finally {
    try {
      fs.unlinkSync(cleanupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') {
        // A failed cleanup unlink outranks the pending result: surfacing it is
        // safer than silently leaving a claim that blocks future acquisition.
        // eslint-disable-next-line no-unsafe-finally
        throw error;
      }
    }
  }
}

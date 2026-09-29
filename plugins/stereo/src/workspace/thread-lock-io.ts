import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { currentProcessOwner, processHasExited } from '../platform/process.ts';
import { errorCode } from '../shared/errors.ts';
import {
  readTextRetrying,
  releaseLockFile,
  removeFileHolding,
  sleepSync,
  writeFileExclusive,
} from '../shared/fs.ts';
import { optionalString, recordedPid } from '../shared/json.ts';

const THREAD_RESERVATION_DIR = 'companion-thread-locks';

// Reservation JSON is untrusted disk state. Callers must validate the fields
// they rely on before acting on a record.
export interface StoredReservationRecord {
  invalid?: true;
  /** The file exists but could not be read (an I/O failure, not its contents). */
  transient?: true;
  error?: unknown;
  token?: string;
  pid?: number;
  /** The owning process's start token, so a reused pid is not mistaken for it. */
  pidStart?: string | null;
  jobId?: string | null;
  threadId?: string;
  createdAt?: string;
  /** The headless Claude child of the owning run, once it has one. */
  childPid?: number | null;
  /** The Claude child's start token. */
  childPidStart?: string | null;
}

/** Who holds a cleanup claim, as its contents record it. */
export interface Claimant {
  pid: number;
  /** Its start token, null when not recorded. */
  pidStart: string | null;
}

export interface CleanupClaimOptions {
  // Whether a stale cleanup claim's claimant still runs. Defaults to bare
  // liveness; a takeover passes the identity-checked probe, so a claim whose
  // pid was reused is reaped, and the stranded-reservation scan its cheap
  // rule.
  isClaimantAlive?: (claimant: Claimant) => boolean;
}

export interface ClaimAndDeleteThreadLockOptions extends CleanupClaimOptions {
  /** Whether the record read under the claim is the one to remove. */
  verify: (record: StoredReservationRecord) => boolean;
}

/** The cleanup claim this process holds beside a reservation lock. */
export interface CleanupClaim {
  path: string;
  contents: string;
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

// A record is written by an exclusive create (not atomic: a reader can catch
// it empty or half written) or replaced through a rename, and a Windows
// antivirus scan can hold it briefly: both are retried before an answer.
const RECORD_READ_ATTEMPTS = 5;
const RECORD_READ_RETRY_MS = 20;

// null only when no file exists; anything that is not a JSON object (a
// parse error, a literal null, an array) is an invalid record, so callers can
// tell a missing lock from a damaged one. A file that cannot be read at all
// is `transient`: its contents are unknown, never evidence of damage.
export function readReservationRecord(lockPath: string): StoredReservationRecord | null {
  let failure: StoredReservationRecord = { invalid: true };
  for (let attempt = 1; attempt <= RECORD_READ_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      sleepSync(RECORD_READ_RETRY_MS);
    }
    let text: string | null;
    try {
      text = readTextRetrying(lockPath, { attempts: 1 });
    } catch (error) {
      failure = { invalid: true, transient: true, error };
      continue;
    }
    if (text === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      failure = { invalid: true, error };
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { invalid: true, error: new Error('Reservation record is not a JSON object.') };
    }
    return parsed as StoredReservationRecord;
  }
  return failure;
}

function parseClaimant(contents: string): Claimant | null {
  let claim: unknown;
  try {
    claim = JSON.parse(contents);
  } catch {
    return null;
  }
  const record = claim as { pid?: unknown; pidStart?: unknown } | null;
  const pid = recordedPid(record?.pid);
  return pid === null ? null : { pid, pidStart: optionalString(record?.pidStart) };
}

// Removes a cleanup claim whose claimant no longer runs (bare liveness unless
// a probe is given), re-reading it first: a claim a live cleaner created in
// its place meanwhile is never the one removed. A claim with no valid pid is
// kept (setup lists it), and so is one that cannot be read. True when no
// claim is left at the path.
export function reapDeadCleanupClaim(
  cleanupPath: string,
  options: CleanupClaimOptions = {},
): boolean {
  let text: string | null;
  try {
    text = readTextRetrying(cleanupPath);
  } catch {
    return false;
  }
  if (text === null) {
    return true;
  }
  const claimant = parseClaimant(text);
  if (!claimant) {
    return false;
  }
  const alive = options.isClaimantAlive
    ? options.isClaimantAlive(claimant)
    : !processHasExited(claimant.pid);
  if (alive) {
    return false;
  }
  try {
    return removeFileHolding(cleanupPath, text);
  } catch {
    return false;
  }
}

// The cleanup claim beside a reservation lock, which every remover of that
// lock (a takeover, a status scan) must hold: created exclusively; a claim
// whose claimant is gone is reaped and the create tried once more. Null when
// a live claimant holds it.
export function acquireCleanupClaim(
  lockPath: string,
  options: CleanupClaimOptions = {},
): CleanupClaim | null {
  const cleanupPath = `${lockPath}.cleanup`;
  const contents = `${JSON.stringify({
    ...currentProcessOwner(),
    jobId: null,
    createdAt: new Date().toISOString(),
  })}\n`;
  const create = (): boolean => writeFileExclusive(cleanupPath, contents);
  const created = create() || (reapDeadCleanupClaim(cleanupPath, options) && create());
  return created ? { path: cleanupPath, contents } : null;
}

// Gives the claim back (only while it is still this process's own), retrying
// a transient failure; one that persists surfaces (a claim left behind blocks
// every later acquisition until it is reaped).
export function releaseCleanupClaim(claim: CleanupClaim): void {
  releaseLockFile(claim.path, claim.contents);
}

// Removes a thread's lock, under the cleanup claim, when `verify` accepts
// the record. The unlink invariant: while this process holds the claim and
// the verified owner is dead, nothing may change the lock at the path (every
// remover must hold the claim, the dead owner can no longer rewrite or
// release it, and a new acquirer's exclusive create fails while it exists),
// so the one read, the verification, and the unlink run in one synchronous
// step. Keep it synchronous. True when the lock was removed; false when
// another cleaner holds the claim, no lock is left, or `verify` refused it.
export function claimAndDeleteThreadLock(
  lockPath: string,
  options: ClaimAndDeleteThreadLockOptions,
): boolean {
  const claim = acquireCleanupClaim(lockPath, options);
  if (!claim) {
    return false;
  }

  try {
    const current = readReservationRecord(lockPath);
    if (!current || !options.verify(current)) {
      return false;
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw error;
      }
    }
    return true;
  } finally {
    // A failed release outranks the pending result: surfacing it is safer
    // than silently leaving a claim that blocks future acquisition.
    releaseCleanupClaim(claim);
  }
}

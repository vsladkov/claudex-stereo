import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  PROCESS_MARKERS,
  PROCESS_OPS,
  currentProcessOwner,
  processMaybeOurs,
  recordNamesThisProcess,
  recordedProcessGone,
} from '../platform/process.ts';
import type { ProcessOps, RecordedProcess } from '../platform/process.ts';
import { writeFileExclusive, writeTextAtomic } from '../shared/fs.ts';
import { optionalString, recordedPid } from '../shared/json.ts';
import {
  claimAndDeleteThreadLock,
  readReservationRecord,
  reapDeadCleanupClaim,
  resolveThreadReservationDir,
  threadReservationPath,
} from '../workspace/thread-lock-io.ts';
import type { StoredReservationRecord } from '../workspace/thread-lock-io.ts';
import { errorCode, errorMessage } from '../shared/errors.ts';

// Exclusive creates of a lock that keeps vanishing before it can be read.
const RESERVATION_CREATE_ATTEMPTS = 3;

export { resolveCodexHome } from '../workspace/thread-lock-io.ts';

export interface ThreadReservationMeta {
  jobId?: string | null;
  /** The headless Claude child driving the session, when it already exists. */
  child?: RecordedProcess | null;
}

export interface ThreadReservation {
  token: string;
  pid: number;
  pidStart: string;
  jobId: string | null;
  threadId: string;
  createdAt: string;
  path: string;
  cleanupPath: string;
}

// The reservations this process holds, for the signal path to release.
const liveReservations = new Set<ThreadReservation>();

export interface StrandedReservationEntry {
  kind: 'unreadable' | 'scan-error';
  /** unreadable: the records that could not be validated. */
  paths?: string[];
  /** scan-error: the directory that could not be read, or the record that could not be removed. */
  path?: string;
  detail?: string;
}

interface ReservationLockRecord {
  pid: number;
  pidStart?: string | null;
  token: string;
  threadId: string;
  jobId?: string | null;
  createdAt?: string;
  childPid?: number | null;
  childPidStart?: string | null;
}

interface ReservationClaimRecord {
  pid: number;
  pidStart?: string | null;
  jobId?: string | null;
  createdAt?: string;
}

type ValidatedReservationRecord<T> =
  { state: 'valid'; record: T } | { state: 'missing' } | { state: 'invalid'; detail: string };

function isValidReservationRecord(record: unknown, kind: 'lock' | 'claim'): boolean {
  const candidate = record as Record<string, unknown> | null | undefined;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype ||
    !Number.isInteger(candidate.pid) ||
    (candidate.pid as number) <= 0
  ) {
    return false;
  }

  if (kind === 'lock') {
    return (
      typeof candidate.token === 'string' &&
      candidate.token.length > 0 &&
      typeof candidate.threadId === 'string' &&
      candidate.threadId.length > 0
    );
  }

  return Object.prototype.hasOwnProperty.call(candidate, 'jobId');
}

function readValidatedReservationRecord(
  recordPath: string,
  kind: 'lock',
): ValidatedReservationRecord<ReservationLockRecord>;
function readValidatedReservationRecord(
  recordPath: string,
  kind: 'claim',
): ValidatedReservationRecord<ReservationClaimRecord>;
function readValidatedReservationRecord(
  recordPath: string,
  kind: 'lock' | 'claim',
):
  | ValidatedReservationRecord<ReservationLockRecord>
  | ValidatedReservationRecord<ReservationClaimRecord> {
  const record = readReservationRecord(recordPath);
  if (!record) {
    return { state: 'missing' };
  }
  if (record.invalid) {
    return {
      state: 'invalid',
      detail: errorMessage(record.error),
    };
  }
  if (!isValidReservationRecord(record, kind)) {
    return { state: 'invalid', detail: `Invalid ${kind} reservation record.` };
  }
  return {
    state: 'valid',
    record: record as unknown as ReservationLockRecord & ReservationClaimRecord,
  };
}

// Whether a recorded owner or claimant may still run (processMaybeOurs: one
// that may still run keeps what it holds): the full identity check a
// takeover makes.
function pidIsAlive(record: { pid?: number | null; pidStart?: unknown }, ops: ProcessOps): boolean {
  const pid = record.pid;
  // A reservation without a finite recorded pid is reapable (dead), while
  // processHasExited treats a non-finite pid as not exited. This inversion is deliberate.
  if (typeof pid !== 'number' || !Number.isFinite(pid)) {
    return false;
  }
  const start = optionalString(record.pidStart);
  // This very process is alive and, by construction, a companion, unless
  // the record names an earlier process that had the same pid.
  if (pid === process.pid) {
    return recordNamesThisProcess(start);
  }
  // Pids are reused: a lock is held by a companion run and a claim by a run
  // or a status scan, all of them the companion CLI, so a live pid that
  // provably runs something else, or whose identity contradicts the record,
  // belongs to someone else and the record it names is dead. An identity
  // that cannot be checked still counts as alive.
  return processMaybeOurs(pid, PROCESS_MARKERS.worker, { ops, expectedStart: start });
}

// Whether a recorded owner or claimant may still run by the cheap rule the
// stranded-reservation scan uses (recordedProcessGone: no ps or PowerShell
// probe on a status poll).
function mayStillRun(record: { pid?: unknown; pidStart?: unknown }, ops: ProcessOps): boolean {
  return !recordedProcessGone(record.pid, record.pidStart, ops);
}

// The Claude child a dead owner left behind, when it may still be running
// (processMaybeOurs, the identity check): the session it drives cannot be
// handed to a new run until it is stopped, or while it cannot be verified as
// gone.
function liveClaudeChild(
  record: { childPid?: unknown; childPidStart?: unknown },
  ops: ProcessOps,
): number | null {
  const childPid = recordedPid(record.childPid);
  if (childPid === null) {
    return null;
  }
  const alive = processMaybeOurs(childPid, PROCESS_MARKERS.claude, {
    ops,
    expectedStart: optionalString(record.childPidStart),
  });
  return alive ? childPid : null;
}

// The pid named here may not be the Claude process any more (an identity
// that could not be checked counts as possibly running): the user checks it
// before ending it.
function orphanedClaudeChildError(
  owner: { pid?: number | null; jobId?: string | null },
  childPid: number,
  threadId: string,
): Error {
  return new Error(
    `A previous companion run (job ${displayReservationValue(owner.jobId)}, pid ${displayReservationValue(owner.pid)}) is gone, and the Claude process it started (pid ${childPid}) may still be running on thread or session ${threadId}. Check that pid ${childPid} is that Claude process, end it if so (for example \`kill ${childPid}\`, or Task Manager on Windows), then retry.`,
  );
}

function strandedReservationSortPath(entry: StrandedReservationEntry): string {
  return entry.path ?? entry.paths?.[0] ?? '';
}

function unreadableReservationEntry(paths: string[]): StrandedReservationEntry {
  const affectedPaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  return {
    kind: 'unreadable',
    paths: affectedPaths,
  };
}

// The scan's reap of a dead claimant's claim. A claim still there
// afterwards, still naming a claimant that is gone, could not be removed.
function reapDeadClaim(claimPath: string, ops: ProcessOps): void {
  const claimantRuns = (claimant: { pid?: unknown; pidStart?: unknown }): boolean =>
    mayStillRun(claimant, ops);
  if (reapDeadCleanupClaim(claimPath, { isClaimantAlive: claimantRuns })) {
    return;
  }
  const left = readValidatedReservationRecord(claimPath, 'claim');
  if (left.state === 'valid' && !claimantRuns(left.record)) {
    throw new Error('a cleanup claim whose process is gone could not be removed');
  }
}

// The reservations a crash left behind, judged by the cheap rule (a live pid
// that cannot be told apart holds on). What is dead is reaped here, as the
// next acquire would: a dead claimant's claim, and a dead owner's lock unless
// it records a Claude child that is not provably gone. Such a lock stays,
// unlisted, for the next acquire of its thread or session, which checks the
// child's identity. Listed: only what could not be validated or removed.
export function listStrandedThreadReservations(
  ops: ProcessOps = PROCESS_OPS,
): StrandedReservationEntry[] {
  const lockDir = resolveThreadReservationDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(lockDir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    return [
      {
        kind: 'scan-error',
        path: lockDir,
        detail: errorMessage(error),
      },
    ];
  }

  const pairs = new Map<
    string,
    { lockPath: string; claimPath: string; lock: boolean; claim: boolean }
  >();
  for (const entry of entries) {
    let lockName: string;
    let kind: 'lock' | 'claim';
    if (entry.endsWith('.lock.cleanup')) {
      lockName = entry.slice(0, -'.cleanup'.length);
      kind = 'claim';
    } else if (entry.endsWith('.lock')) {
      lockName = entry;
      kind = 'lock';
    } else {
      continue;
    }

    const lockPath = path.join(lockDir, lockName);
    const pair = pairs.get(lockPath) ?? {
      lockPath,
      claimPath: `${lockPath}.cleanup`,
      lock: false,
      claim: false,
    };
    pair[kind] = true;
    pairs.set(lockPath, pair);
  }

  const stranded: StrandedReservationEntry[] = [];
  const attempt = (recordPath: string, reap: () => unknown): void => {
    try {
      reap();
    } catch (error) {
      stranded.push({ kind: 'scan-error', path: recordPath, detail: errorMessage(error) });
    }
  };
  for (const pair of pairs.values()) {
    const lock: ValidatedReservationRecord<ReservationLockRecord> = pair.lock
      ? readValidatedReservationRecord(pair.lockPath, 'lock')
      : { state: 'missing' };
    const claim: ValidatedReservationRecord<ReservationClaimRecord> = pair.claim
      ? readValidatedReservationRecord(pair.claimPath, 'claim')
      : { state: 'missing' };

    const invalidPaths = [];
    if (lock.state === 'invalid') {
      invalidPaths.push(pair.lockPath);
    }
    if (claim.state === 'invalid') {
      invalidPaths.push(pair.claimPath);
    }
    if (invalidPaths.length > 0) {
      stranded.push(unreadableReservationEntry(invalidPaths));
      continue;
    }

    const owner = lock.state === 'valid' ? lock.record : null;
    const claimant = claim.state === 'valid' ? claim.record : null;
    if (claimant) {
      // A claimant that may still run is a cleaner at work: the pair is its
      // to settle.
      if (mayStillRun(claimant, ops)) {
        continue;
      }
      attempt(pair.claimPath, () => reapDeadClaim(pair.claimPath, ops));
    }
    if (
      owner &&
      !mayStillRun(owner, ops) &&
      (recordedPid(owner.childPid) === null ||
        recordedProcessGone(owner.childPid, owner.childPidStart, ops))
    ) {
      attempt(pair.lockPath, () => reapDeadOwnerLock(pair.lockPath, owner, ops));
    }
  }

  return stranded.sort((left, right) => {
    const pathOrder = strandedReservationSortPath(left).localeCompare(
      strandedReservationSortPath(right),
    );
    return pathOrder || left.kind.localeCompare(right.kind);
  });
}

function displayReservationValue(value: unknown): string {
  return value == null || value === '' ? 'unknown' : String(value);
}

function joinCodePaths(paths: string[]): string {
  const rendered = paths.map((entryPath) => `\`${entryPath}\``);
  if (rendered.length <= 1) {
    return rendered[0] ?? 'the affected file';
  }
  if (rendered.length === 2) {
    return `${rendered[0]} and ${rendered[1]}`;
  }
  return `${rendered.slice(0, -1).join(', ')}, and ${rendered.at(-1)}`;
}

export function describeStrandedReservation(
  entry: StrandedReservationEntry | null | undefined,
): string {
  switch (entry?.kind) {
    case 'unreadable':
      return `Thread reservation data at ${joinCodePaths(entry.paths ?? [])} could not be validated. Inspect the affected file${entry.paths?.length === 1 ? '' : 's'}, then delete only invalid records after confirming no live companion run owns them.`;
    case 'scan-error':
      return `Thread reservations could not be scanned at \`${entry.path}\`: ${entry.detail || 'unknown filesystem error'}. Inspect and repair that path.`;
    default:
      return 'An unknown stranded thread reservation was detected. Run `/stereo:setup` again for current details.';
  }
}

// Removes a lock whose recorded owner is dead, under the cleanup claim
// (claimAndDeleteThreadLock), so a concurrent acquirer either wins the claim
// or sees it and waits for the retry; a stale claim's claimant gets the
// identity-checked probe the owner check uses, so a claim whose pid was
// reused is reaped. The caller found this owner dead, and its Claude child
// gone, before the claim: every probe happens there, none under the claim,
// where the record is re-read and its token compared with the one the caller
// judged. A lock the dead owner's successor already replaced (another token)
// is left alone. True when the lock was removed.
function reapDeadOwnerLock(
  lockPath: string,
  owner: { pid?: number | null; token?: string | null },
  ops: ProcessOps,
): boolean {
  return claimAndDeleteThreadLock(lockPath, {
    isClaimantAlive: (claimant) => pidIsAlive(claimant, ops),
    verify: (current) =>
      !current.invalid &&
      typeof current.token === 'string' &&
      current.token === owner.token &&
      current.pid === owner.pid,
  });
}

// `ops`: the process seams the owner, claimant, and child checks go through
// (the host's by default).
export function acquireThreadReservation(
  threadId: string | null | undefined,
  meta: ThreadReservationMeta = {},
  ops: ProcessOps = PROCESS_OPS,
): ThreadReservation {
  const normalizedThreadId = String(threadId ?? '').trim();
  if (!normalizedThreadId) {
    throw new Error('A thread or session id is required to reserve it for a run.');
  }

  const lockDir = resolveThreadReservationDir();
  const lockPath = threadReservationPath(normalizedThreadId);
  const cleanupPath = `${lockPath}.cleanup`;
  const reclaimingError = (): Error =>
    new Error(
      `Session or thread ${normalizedThreadId} is busy or being reclaimed by another companion run; retry in a moment.`,
    );
  const record = {
    token: crypto.randomUUID(),
    ...currentProcessOwner(),
    jobId: meta.jobId ?? null,
    threadId: normalizedThreadId,
    createdAt: new Date().toISOString(),
    ...(meta.child ? { childPid: meta.child.pid, childPidStart: meta.child.start } : {}),
  };
  fs.mkdirSync(lockDir, { recursive: true });

  if (
    fs.existsSync(cleanupPath) &&
    !reapDeadCleanupClaim(cleanupPath, { isClaimantAlive: (claimant) => pidIsAlive(claimant, ops) })
  ) {
    throw new Error(
      `Reservation cleanup is already in progress for thread or session ${normalizedThreadId}. Retry in a moment; if it appears stuck, run \`/stereo:setup\`, which removes what a dead run left behind and lists what it could not read or remove.`,
    );
  }

  const tryAcquire = (): boolean => writeFileExclusive(lockPath, `${JSON.stringify(record)}\n`);
  // A lock the filesystem would not let us read says nothing about its
  // owner, who may well be alive: a retry is asked for, never a delete. Only
  // contents that stay unparsable are damage a delete can repair.
  const unreadableError = (owner: { transient?: true; error?: unknown }): Error =>
    owner.transient
      ? new Error(
          `The reservation for thread or session ${normalizedThreadId} could not be read (${errorMessage(
            owner.error,
          )}). Retry in a moment.`,
        )
      : new Error(
          `A thread or session reservation exists but could not be read. Delete ${lockPath} to release it, then retry.`,
        );
  const busyError = (ownerJob: string | null | undefined): Error =>
    new Error(
      `Thread or session ${normalizedThreadId} is already being used by another companion run (job ${ownerJob ?? 'unknown'}). Wait for it or cancel it first.`,
    );
  // A lock whose run released it between the create and the read is gone by
  // then: the create is tried again, a few times, rather than the missing
  // lock reported as one that could not be read.
  let acquired = tryAcquire();
  let owner: StoredReservationRecord | null = null;
  for (let attempt = 1; !acquired; attempt += 1) {
    owner = readReservationRecord(lockPath);
    if (owner || attempt >= RESERVATION_CREATE_ATTEMPTS) {
      break;
    }
    acquired = tryAcquire();
  }
  if (!acquired) {
    if (!owner) {
      throw reclaimingError();
    }
    if (owner.invalid) {
      throw unreadableError(owner);
    }
    if (pidIsAlive(owner, ops)) {
      throw busyError(owner.jobId);
    }
    const orphanedChild = liveClaudeChild(owner, ops);
    if (orphanedChild !== null) {
      throw orphanedClaudeChildError(owner, orphanedChild, normalizedThreadId);
    }
    // The owner is gone (a killed worker, a crashed foreground run, a
    // cancelled job): take the lock over through the cleanup claim, so two
    // acquirers cannot both reap it, then try once more. A takeover lost to a
    // concurrent acquirer or cleaner asks for a retry.
    if (!reapDeadOwnerLock(lockPath, owner, ops) || !tryAcquire()) {
      throw reclaimingError();
    }
  }

  const reservation = {
    ...record,
    path: lockPath,
    cleanupPath,
  };
  liveReservations.add(reservation);
  return reservation;
}

// Notes the Claude child of a live run (its pid and start token) on its
// lock, so a later acquirer that finds the run dead can refuse the takeover
// while the child still runs. The record is rewritten through a rename
// (readers never see a torn file) and only while the lock still carries this
// run's token. Best effort: a failed rewrite loses the hint, never the run.
export function recordReservationChildPid(
  reservation: Pick<ThreadReservation, 'path' | 'token'>,
  child: RecordedProcess,
): boolean {
  const current = readReservationRecord(reservation.path);
  if (!current || current.invalid || current.token !== reservation.token) {
    return false;
  }
  const next: StoredReservationRecord = {
    ...current,
    childPid: child.pid,
    childPidStart: child.start,
  };
  try {
    writeTextAtomic(reservation.path, `${JSON.stringify(next)}\n`);
  } catch {
    return false;
  }
  return true;
}

function forgetLiveReservation(
  reservation: { path?: string | null; token?: string | null } | null | undefined,
): void {
  if (!reservation?.path || !reservation.token) {
    return;
  }
  for (const liveReservation of liveReservations) {
    if (
      liveReservation === reservation ||
      (liveReservation.path === reservation.path && liveReservation.token === reservation.token)
    ) {
      liveReservations.delete(liveReservation);
    }
  }
}

// Removes the lock only while it still carries this reservation's token.
export function releaseThreadReservation(
  reservation: { path?: string | null; token?: string | null } | null | undefined,
): { released: boolean } {
  forgetLiveReservation(reservation);
  if (!reservation?.path || !reservation.token) {
    return { released: false };
  }
  const current = readReservationRecord(reservation.path);
  if (!current || current.invalid || current.token !== reservation.token) {
    return { released: false };
  }
  try {
    fs.unlinkSync(reservation.path);
    return { released: true };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { released: false };
    }
    throw error;
  }
}

// The signal path: releases every reservation this process holds, each
// only while its lock still carries its token. Best effort per reservation:
// one that fails must not keep the others, and its lock is taken over by the
// next run of its thread or session once this process is gone.
export function releaseLiveReservations(): void {
  for (const reservation of [...liveReservations]) {
    try {
      releaseThreadReservation(reservation);
    } catch {
      // Left for the takeover.
    }
  }
}

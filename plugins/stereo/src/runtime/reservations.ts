import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const THREAD_RESERVATION_DIR = 'companion-thread-locks';
const THREAD_RESERVATION_DEATH_WAIT_MS = 2500;
const THREAD_RESERVATION_POLL_MS = 50;

export interface ThreadReservationMeta {
  pid?: number;
  jobId?: string | null;
}

export interface ThreadReservation {
  token: string;
  pid: number;
  jobId: string | null;
  threadId: string;
  createdAt: string;
  path: string;
  cleanupPath: string;
}

export type LiveReservationPhase = 'pre-turn' | 'in-flight' | 'post-turn';

const liveReservations = new Map<ThreadReservation, LiveReservationPhase>();

export interface ReleaseReservationResult {
  released: boolean;
  status: 'none' | 'missing' | 'token-mismatch' | 'released';
  path?: string;
}

export interface CancelledJobReservationResult {
  released: boolean;
  status:
    | 'none-found'
    | 'owner-still-running'
    | 'claim-skipped'
    | 'mismatch-skipped'
    | 'released'
    | 'scan-released';
  path?: string;
  detail?: string;
}

export interface StrandedReservationEntry {
  kind:
    'stranded-reservation' | 'stranded-cleanup' | 'orphaned-claim' | 'unreadable' | 'scan-error';
  lockPath?: string;
  claimPath?: string;
  threadId?: string;
  jobId?: string | null;
  pid?: number;
  paths?: string[];
  path?: string;
  detail?: string;
}

export interface PidLivenessOptions {
  isProcessAlive?: (pid: number) => unknown;
}

export interface ReservationOwnerDeathOptions extends PidLivenessOptions {
  timeoutMs?: number;
  pollMs?: number;
  duringDeathWait?: () => unknown | Promise<unknown>;
}

export interface CancelledJobCleanupOptions extends ReservationOwnerDeathOptions {
  beforeUnlink?: (context: {
    lockPath: string;
    cleanupPath: string;
    current: StoredReservationRecord;
  }) => unknown | Promise<unknown>;
}

// Unvalidated reservation JSON read back from disk. Field types reflect what
// the plugin writes; foreign or corrupted files may not conform, which every
// consumer guards against.
interface StoredReservationRecord {
  invalid?: true;
  error?: unknown;
  token?: string;
  pid?: number;
  jobId?: string | null;
  threadId?: string;
  createdAt?: string;
}

interface ReservationLockRecord {
  pid: number;
  token: string;
  threadId: string;
  jobId?: string | null;
  createdAt?: string;
}

interface ReservationClaimRecord {
  pid: number;
  jobId?: string | null;
  createdAt?: string;
}

type ValidatedReservationRecord<T> =
  { state: 'valid'; record: T } | { state: 'missing' } | { state: 'invalid'; detail: string };

export function resolveCodexHome(): string {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

function resolveThreadReservationDir(): string {
  return path.join(resolveCodexHome(), THREAD_RESERVATION_DIR);
}

function threadReservationPath(threadId: string): string {
  const digest = crypto.createHash('sha256').update(String(threadId)).digest('hex').slice(0, 32);
  return path.join(resolveThreadReservationDir(), `${digest}.lock`);
}

function readReservationRecord(lockPath: string): StoredReservationRecord | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') {
      return null;
    }
    return { invalid: true, error };
  }
}

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
  try {
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    if (!isValidReservationRecord(record, kind)) {
      return { state: 'invalid', detail: `Invalid ${kind} reservation record.` };
    }
    return { state: 'valid', record };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') {
      return { state: 'missing' };
    }
    return {
      state: 'invalid',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function pidIsAlive(pid: number | null | undefined, options: PidLivenessOptions = {}): boolean {
  if (!Number.isFinite(pid)) {
    return false;
  }
  if (options.isProcessAlive) {
    return Boolean(options.isProcessAlive(pid as number));
  }
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null | undefined)?.code !== 'ESRCH';
  }
}

function strandedReservationSortPath(entry: StrandedReservationEntry): string {
  return entry.lockPath ?? entry.claimPath ?? entry.path ?? entry.paths?.[0] ?? '';
}

function unreadableReservationEntry(paths: string[]): StrandedReservationEntry {
  const affectedPaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  return {
    kind: 'unreadable',
    paths: affectedPaths,
  };
}

export function listStrandedThreadReservations(): StrandedReservationEntry[] {
  const lockDir = resolveThreadReservationDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') {
      return [];
    }
    return [
      {
        kind: 'scan-error',
        path: lockDir,
        detail: error instanceof Error ? error.message : String(error),
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
    const ownerAlive = owner ? pidIsAlive(owner.pid) : false;
    const claimantAlive = claimant ? pidIsAlive(claimant.pid) : false;

    if (owner && claimant) {
      if (claimantAlive) {
        continue;
      }
      if (ownerAlive) {
        stranded.push({
          kind: 'orphaned-claim',
          claimPath: pair.claimPath,
          jobId: claimant.jobId ?? null,
          pid: claimant.pid,
        });
        continue;
      }
      stranded.push({
        kind: 'stranded-cleanup',
        lockPath: pair.lockPath,
        claimPath: pair.claimPath,
        threadId: owner.threadId,
        jobId: owner.jobId ?? null,
        pid: owner.pid,
      });
      continue;
    }

    if (owner) {
      if (!ownerAlive) {
        stranded.push({
          kind: 'stranded-reservation',
          lockPath: pair.lockPath,
          threadId: owner.threadId,
          jobId: owner.jobId ?? null,
          pid: owner.pid,
        });
      }
      continue;
    }

    if (claimant && !claimantAlive) {
      stranded.push({
        kind: 'orphaned-claim',
        claimPath: pair.claimPath,
        jobId: claimant.jobId ?? null,
        pid: claimant.pid,
      });
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
    case 'stranded-reservation':
      return `A crashed Codex run (job ${displayReservationValue(entry.jobId)}, pid ${displayReservationValue(entry.pid)}) left thread ${displayReservationValue(entry.threadId)} reserved. Delete \`${entry.lockPath}\` to release it.`;
    case 'stranded-cleanup':
      return `A crashed Codex run (job ${displayReservationValue(entry.jobId)}, pid ${displayReservationValue(entry.pid)}) left thread ${displayReservationValue(entry.threadId)} reserved with an abandoned cleanup claim. Delete both \`${entry.lockPath}\` and \`${entry.claimPath}\` to release it.`;
    case 'orphaned-claim':
      return `A crashed reservation cleanup (job ${displayReservationValue(entry.jobId)}, pid ${displayReservationValue(entry.pid)}) left an orphaned claim. Delete only \`${entry.claimPath}\`; do not delete any accompanying live thread lock.`;
    case 'unreadable':
      return `Thread reservation data at ${joinCodePaths(entry.paths ?? [])} could not be validated. Inspect the affected file${entry.paths?.length === 1 ? '' : 's'}, then delete only invalid records after confirming no live Codex run owns them.`;
    case 'scan-error':
      return `Thread reservations could not be scanned at \`${entry.path}\`: ${entry.detail || 'unknown filesystem error'}. Inspect and repair that path.`;
    default:
      return 'An unknown stranded thread reservation was detected. Run `/stereo:setup` again for current details.';
  }
}

export function acquireThreadReservation(
  threadId: string | null | undefined,
  meta: ThreadReservationMeta = {},
): ThreadReservation {
  const normalizedThreadId = String(threadId ?? '').trim();
  if (!normalizedThreadId) {
    throw new Error('A thread id is required to reserve a Codex thread.');
  }

  const lockDir = resolveThreadReservationDir();
  const lockPath = threadReservationPath(normalizedThreadId);
  const cleanupPath = `${lockPath}.cleanup`;
  const record = {
    token: crypto.randomUUID(),
    pid: Number.isFinite(meta.pid) ? (meta.pid as number) : process.pid,
    jobId: meta.jobId ?? null,
    threadId: normalizedThreadId,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(lockDir, { recursive: true });

  if (fs.existsSync(cleanupPath)) {
    throw new Error(
      `Reservation cleanup is already in progress for thread ${normalizedThreadId}. Wait for it to finish; if it appears stuck, run \`/stereo:setup\` to list stranded reservations and safe remedies.`,
    );
  }

  try {
    fs.writeFileSync(lockPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'EEXIST') {
      throw error;
    }

    const owner = readReservationRecord(lockPath);
    if (!owner || owner.invalid) {
      throw new Error(
        `A Codex thread reservation exists but could not be read. Delete ${lockPath} to release it, then retry.`,
      );
    }
    const ownerJob = owner.jobId ?? 'unknown';
    if (pidIsAlive(owner.pid)) {
      throw new Error(
        `Thread ${normalizedThreadId} is already being used by another Codex run (job ${ownerJob}). Wait for it or cancel it first.`,
      );
    }
    throw new Error(
      `A previous Codex run (job ${ownerJob}, pid ${owner.pid ?? 'unknown'}) appears to have crashed while reserving thread ${normalizedThreadId}. Delete ${lockPath} to release it, then retry.`,
    );
  }

  const reservation = {
    ...record,
    path: lockPath,
    cleanupPath,
  };
  liveReservations.set(reservation, 'pre-turn');
  return reservation;
}

function forgetLiveReservation(
  reservation: { path?: string | null; token?: string | null } | null | undefined,
): void {
  if (!reservation?.path || !reservation.token) {
    return;
  }
  for (const liveReservation of liveReservations.keys()) {
    if (
      liveReservation === reservation ||
      (liveReservation.path === reservation.path && liveReservation.token === reservation.token)
    ) {
      liveReservations.delete(liveReservation);
    }
  }
}

export function markLiveReservationPhase(
  reservation: ThreadReservation | null | undefined,
  phase: LiveReservationPhase,
): void {
  if (!reservation || !liveReservations.has(reservation)) {
    return;
  }
  liveReservations.set(reservation, phase);
}

export function releaseThreadReservation(
  reservation: { path?: string | null; token?: string | null } | null | undefined,
): ReleaseReservationResult {
  forgetLiveReservation(reservation);
  if (!reservation?.path || !reservation.token) {
    return { released: false, status: 'none' };
  }
  const current = readReservationRecord(reservation.path);
  if (!current) {
    return { released: false, status: 'missing', path: reservation.path };
  }
  if (current.invalid || current.token !== reservation.token) {
    return { released: false, status: 'token-mismatch', path: reservation.path };
  }
  try {
    fs.unlinkSync(reservation.path);
    return { released: true, status: 'released', path: reservation.path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') {
      return { released: false, status: 'missing', path: reservation.path };
    }
    throw error;
  }
}

export function releaseEligibleLiveReservations(): { released: number; retained: number } {
  let released = 0;
  let retained = 0;
  for (const [reservation, phase] of [...liveReservations]) {
    if (phase === 'in-flight') {
      retained += 1;
      continue;
    }
    const current = readReservationRecord(reservation.path);
    if (
      !current ||
      current.invalid ||
      current.token !== reservation.token ||
      current.jobId !== reservation.jobId
    ) {
      retained += 1;
      continue;
    }
    try {
      if (releaseThreadReservation(reservation).released) {
        released += 1;
      } else {
        retained += 1;
      }
    } catch {
      // Signal-time cleanup is best effort per reservation: one bad path
      // must not prevent the remaining eligible locks from being released.
      retained += 1;
    }
  }
  return { released, retained };
}

async function waitForReservationOwnerDeath(
  pid: number | null | undefined,
  options: ReservationOwnerDeathOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? THREAD_RESERVATION_DEATH_WAIT_MS;
  const pollMs = options.pollMs ?? THREAD_RESERVATION_POLL_MS;
  const startedAt = Date.now();
  let hookCalled = false;

  while (pidIsAlive(pid, options)) {
    if (!hookCalled && options.duringDeathWait) {
      hookCalled = true;
      await options.duringDeathWait();
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

interface CancelledJobIdentity {
  threadId?: string | null;
  requestThreadId?: string | null;
  jobId?: string | null;
  pid?: number | null;
}

function candidateReservationPaths({
  threadId,
  requestThreadId,
  jobId,
  pid,
}: CancelledJobIdentity): Array<{
  lockPath: string;
  source: string | undefined;
}> {
  const candidates: string[] = [];
  const sources = new Map<string, string>();
  for (const [source, value] of [
    ['recorded', threadId],
    ['request', requestThreadId],
  ] as Array<[string, string | null | undefined]>) {
    if (!value) {
      continue;
    }
    const candidate = threadReservationPath(value);
    if (!sources.has(candidate)) {
      candidates.push(candidate);
      sources.set(candidate, source);
    }
  }

  const lockDir = resolveThreadReservationDir();
  if (fs.existsSync(lockDir)) {
    for (const entry of fs.readdirSync(lockDir)) {
      if (!entry.endsWith('.lock')) {
        continue;
      }
      const candidate = path.join(lockDir, entry);
      if (sources.has(candidate)) {
        continue;
      }
      const record = readReservationRecord(candidate);
      if (record && !record.invalid && record.jobId === jobId && record.pid === pid) {
        candidates.push(candidate);
        sources.set(candidate, 'scan');
      }
    }
  }

  return candidates.map((lockPath) => ({ lockPath, source: sources.get(lockPath) }));
}

export async function releaseThreadReservationForCancelledJob(
  { threadId = null, requestThreadId = null, jobId, pid }: CancelledJobIdentity,
  options: CancelledJobCleanupOptions = {},
): Promise<CancelledJobReservationResult> {
  if (!Number.isFinite(pid)) {
    return {
      released: false,
      status: 'none-found',
      detail: 'The cancelled job had no worker pid.',
    };
  }

  const ownerDied = await waitForReservationOwnerDeath(pid, options);
  if (!ownerDied) {
    return {
      released: false,
      status: 'owner-still-running',
      detail: `Worker ${pid} did not exit before reservation cleanup timed out.`,
    };
  }

  const candidates = candidateReservationPaths({ threadId, requestThreadId, jobId, pid });
  if (candidates.length === 0) {
    return { released: false, status: 'none-found' };
  }

  let mismatch: CancelledJobReservationResult | null = null;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.lockPath)) {
      continue;
    }
    const cleanupPath = `${candidate.lockPath}.cleanup`;
    try {
      fs.writeFileSync(
        cleanupPath,
        `${JSON.stringify({ pid: process.pid, jobId, createdAt: new Date().toISOString() })}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'EEXIST') {
        return {
          released: false,
          status: 'claim-skipped',
          path: candidate.lockPath,
          detail: `Reservation cleanup is already in progress for ${candidate.lockPath}.`,
        };
      }
      throw error;
    }

    try {
      const current = readReservationRecord(candidate.lockPath);
      if (!current) {
        continue;
      }
      if (current.invalid || current.jobId !== jobId || current.pid !== pid) {
        mismatch = {
          released: false,
          status: 'mismatch-skipped',
          path: candidate.lockPath,
          detail: `Reservation ${candidate.lockPath} belongs to a different owner.`,
        };
        continue;
      }

      await options.beforeUnlink?.({
        lockPath: candidate.lockPath,
        cleanupPath,
        current,
      });
      try {
        fs.unlinkSync(candidate.lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') {
          throw error;
        }
      }
      return {
        released: true,
        status: candidate.source === 'scan' ? 'scan-released' : 'released',
        path: candidate.lockPath,
      };
    } finally {
      try {
        fs.unlinkSync(cleanupPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') {
          // A failed cleanup unlink outranks the loop's pending result on
          // purpose: surfacing it beats silently leaving the claim file.
          // eslint-disable-next-line no-unsafe-finally
          throw error;
        }
      }
    }
  }

  return mismatch ?? { released: false, status: 'none-found' };
}

import { PROCESS_MARKERS, PROCESS_OPS, processVerdict } from '../platform/process.ts';
import type { ProcessOps, ProcessVerdict } from '../platform/process.ts';
import { errorMessage } from '../shared/errors.ts';
import { sleepSync } from '../shared/fs.ts';
import type { FileLockOptions } from '../shared/fs.ts';
import { optionalString, recordedPid } from '../shared/json.ts';
import {
  isTerminalJob,
  nowIso,
  readJobFileTolerant,
  resolveJobFile,
  updateState,
  writeJobFile,
} from '../workspace/state.ts';
import type { JobRecord } from '../workspace/state.ts';

// The one place a job becomes terminal. Every writer of a final status (the
// run itself, cancel, session end, a signal, a failed spawn, a failed worker
// bootstrap) goes through settleJob, so a record that is already terminal is
// never overwritten and no terminal record keeps a worker or Claude pid. A
// stopper (a cancel, a session end) settles first and only then stops the
// processes the settle took off the record (stopJobProcesses), so the
// worker's own signal handler, or a run finishing meanwhile, finds the job
// terminal and leaves the record alone.

export interface JobSettlement {
  /** Fields both the job file and the index row take (status, phase, errorMessage, run facts). */
  terminal: Partial<JobRecord> & { status: string };
  /** Fields only the job file takes (the result, the rendered report). */
  record?: Partial<JobRecord>;
  /** Fields only the index row takes (the run summary). */
  index?: Partial<JobRecord>;
  /** The record to settle when the job file is missing or unreadable. */
  fallback?: Partial<JobRecord> | null;
  /**
   * Write nothing when neither a job file nor an index row exists: the job
   * was swept away meanwhile (a session end), and a late writer (a signal,
   * a worker that never found its record) must not bring it back.
   */
  skipUnknown?: boolean;
}

/**
 * A job's recorded processes, each pid with the start token its record gave
 * it (null when unknown).
 */
export interface JobProcesses {
  pid: number | null;
  pidStart: string | null;
  claudePid: number | null;
  claudePidStart: string | null;
}

export interface SettleJobResult {
  /** True when this call wrote the terminal record. */
  settled: boolean;
  /** The job's terminal status: the one written, or the one it already had. */
  status: string;
  /** The job file's record after the call (null when it was unreadable and nothing was written). */
  record: JobRecord | null;
  /**
   * The processes the record named when this call settled it, read under the
   * index lock (a caller's earlier snapshot may be stale): what a cancel or a
   * session end must stop. All null when the call settled nothing.
   */
  processes: JobProcesses;
  /**
   * Why the job file could not be written, when it could not; the index row
   * settled all the same. Returned, not thrown, so a stopper still stops
   * `processes` before it surfaces the error.
   */
  writeError?: unknown;
}

const NO_PROCESSES: JobProcesses = {
  pid: null,
  pidStart: null,
  claudePid: null,
  claudePidStart: null,
};

type ProcessFields = Partial<Record<keyof JobProcesses, unknown>>;

// Each pid from the first record that names one, with that record's start
// token for it: the job file first (the worker and the progress updater
// write it), then the index row, then a caller's fallback.
export function recordedProcesses(
  ...records: ReadonlyArray<ProcessFields | null | undefined>
): JobProcesses {
  const pick = (
    pidKey: 'pid' | 'claudePid',
    startKey: 'pidStart' | 'claudePidStart',
  ): [number | null, string | null] => {
    for (const record of records) {
      const pid = recordedPid(record?.[pidKey]);
      if (pid !== null) {
        return [pid, optionalString(record?.[startKey])];
      }
    }
    return [null, null];
  };
  const [pid, pidStart] = pick('pid', 'pidStart');
  const [claudePid, claudePidStart] = pick('claudePid', 'claudePidStart');
  return { pid, pidStart, claudePid, claudePidStart };
}

// A terminal record names no process: the pids go, with their start tokens.
export function withoutProcesses<T extends Partial<JobRecord>>(record: T): T {
  const next: T = { ...record, pid: null, claudePid: null };
  delete next.pidStart;
  delete next.claudePidStart;
  return next;
}

// A record brought in line with one that settled elsewhere: that one's
// terminal status and phase, its error and completion time (the record's own
// where it has none), and no processes.
export function withTerminalFields<T extends Partial<JobRecord>>(
  record: T,
  settled: Partial<JobRecord>,
): T {
  return withoutProcesses({
    ...record,
    status: settled.status,
    phase: settled.phase ?? null,
    errorMessage: settled.errorMessage ?? record.errorMessage,
    completedAt: settled.completedAt ?? record.completedAt,
  });
}

// A row built from a job file for an index that lost it: the index carries
// lightweight metadata only.
function indexRowFrom(record: JobRecord): JobRecord {
  const row = { ...record };
  delete row.request;
  delete row.result;
  delete row.rendered;
  return row;
}

// Re-reads the job file and the index row under the index lock and writes
// both terminal only when neither already is. A job file that settled while
// its index row did not (a failed index write) brings the row in line
// instead. A failed job-file write still settles the index row and comes
// back as the result's writeError.
export function settleJob(
  workspaceRoot: string,
  jobId: string,
  settlement: JobSettlement,
  lock: FileLockOptions = {},
): SettleJobResult {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  const completedAt =
    typeof settlement.terminal.completedAt === 'string'
      ? settlement.terminal.completedAt
      : nowIso();
  let outcome: SettleJobResult = {
    settled: false,
    status: settlement.terminal.status,
    record: null,
    processes: NO_PROCESSES,
  };
  const failure: { error: unknown } = { error: null };
  updateState(
    workspaceRoot,
    (state) => {
      const rowIndex = state.jobs.findIndex((job) => job.id === jobId);
      const row = rowIndex === -1 ? null : (state.jobs[rowIndex] ?? null);
      const read = readJobFileTolerant(jobFile);
      const stored = read.record;
      const timestamp = nowIso();
      if (settlement.skipUnknown && !row && read.missing) {
        return false;
      }
      if (stored && isTerminalJob(stored)) {
        outcome = {
          settled: false,
          status: stored.status,
          record: stored,
          processes: NO_PROCESSES,
        };
        if (!row || isTerminalJob(row)) {
          return false;
        }
        state.jobs[rowIndex] = { ...withTerminalFields(row, stored), updatedAt: timestamp };
        return true;
      }
      if (row && isTerminalJob(row)) {
        outcome = { settled: false, status: row.status, record: stored, processes: NO_PROCESSES };
        // Only the index row settled (a job-file write that failed, or a
        // late non-terminal write that raced the settle): bring the job file
        // in line, so it cannot keep a running status and pid forever.
        if (stored) {
          const reconciled = withTerminalFields(stored, row);
          reconciled.completedAt ??= completedAt;
          try {
            writeJobFile(workspaceRoot, jobId, reconciled);
            outcome.record = reconciled;
          } catch (error) {
            failure.error = error;
          }
        }
        return false;
      }

      const processes = recordedProcesses(stored, row, settlement.fallback);
      const cleared = { id: jobId, completedAt };
      const record = withoutProcesses({
        ...(settlement.fallback ?? {}),
        ...(stored ?? {}),
        ...settlement.terminal,
        ...(settlement.record ?? {}),
        ...cleared,
      } as JobRecord);
      try {
        writeJobFile(workspaceRoot, jobId, record);
      } catch (error) {
        failure.error = error;
      }
      const patch = { ...settlement.terminal, ...(settlement.index ?? {}), ...cleared };
      if (row) {
        state.jobs[rowIndex] = withoutProcesses({ ...row, ...patch, updatedAt: timestamp });
      } else {
        state.jobs.unshift(
          withoutProcesses({
            ...indexRowFrom(record),
            ...patch,
            createdAt: record.createdAt ?? timestamp,
            updatedAt: timestamp,
          }),
        );
      }
      outcome = { settled: true, status: settlement.terminal.status, record, processes };
      return true;
    },
    lock,
  );
  return failure.error !== null ? { ...outcome, writeError: failure.error } : outcome;
}

export interface ActiveJobUpdate {
  /** The next record from the current one: applied to the job file's record and to the index row. */
  update: (current: JobRecord) => JobRecord;
  /** The job file's record when it is missing or unreadable; none leaves the file alone then. */
  fallback?: Partial<JobRecord> | null;
  /** Write nothing when neither a job file nor an index row exists (the job was swept away). */
  skipUnknown?: boolean;
}

// The one write of a job that is not terminal yet (a running record, a
// worker pid, a progress patch): re-reads the job file and the index row
// under the index lock and writes both only while neither is terminal, so a
// job settled meanwhile keeps its terminal record with no late pid or phase.
// An index that lost the row gets it back from the job file's record
// (indexRowFrom, as settleJob does), never a stub without a status. A failed
// job-file write still updates the index row, then throws. Returns the
// terminal status that kept the write from happening, or null.
export function updateActiveJob(
  workspaceRoot: string,
  jobId: string,
  request: ActiveJobUpdate,
): string | null {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  let terminalStatus: string | null = null;
  const failure: { error: unknown } = { error: null };
  updateState(workspaceRoot, (state) => {
    const rowIndex = state.jobs.findIndex((job) => job.id === jobId);
    const row = rowIndex === -1 ? null : (state.jobs[rowIndex] ?? null);
    const read = readJobFileTolerant(jobFile);
    const stored = read.record;
    const terminal = [stored, row].find((candidate) => isTerminalJob(candidate));
    if (terminal) {
      terminalStatus = terminal.status;
      return false;
    }
    if (request.skipUnknown && !row && read.missing) {
      return false;
    }
    const base = stored ?? request.fallback ?? null;
    const record = base ? request.update({ ...base, id: jobId } as JobRecord) : null;
    if (record) {
      try {
        writeJobFile(workspaceRoot, jobId, record);
      } catch (error) {
        failure.error = error;
      }
    }
    const timestamp = nowIso();
    if (row) {
      state.jobs[rowIndex] = { ...request.update(row), updatedAt: timestamp };
    } else if (record) {
      state.jobs.unshift({
        ...indexRowFrom(record),
        createdAt: record.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
    } else {
      return false;
    }
    return true;
  });
  if (failure.error) {
    throw failure.error;
  }
  return terminalStatus;
}

/** What happened to one recorded process of a job. */
export type JobProcessStop =
  /** No pid was recorded. */
  | 'none'
  /** The recorded pid no longer runs (dead, or a zombie). */
  | 'exited'
  /** The pid now runs another program, or one started at another time (a reused pid): left alone. */
  | 'foreign'
  /**
   * Signalled, and confirmed gone afterwards: dead, a zombie, or its pid now
   * another process's. Never for a process only asked to stop.
   */
  | 'stopped'
  /** A signal failed; see the matching error. */
  | 'failed'
  /**
   * Not confirmed gone, and never signalled on a guess. With no error: left
   * alone, because the check could not tell whose process it is (a failed or
   * timed-out probe). With an error: signalled, but not confirmed gone (still
   * running after the hard signal or the tree kill, or no longer verifiable
   * after the polite one).
   */
  | 'unconfirmed';

export interface StopJobProcessesOptions {
  /**
   * The process seams (the host's by default). No hard signal on Windows
   * (its platform): its tree kill is forceful already.
   */
  ops?: ProcessOps;
  /**
   * How long a signalled process gets between the polite and the hard signal:
   * WORKER_STOP_GRACE_MS for the worker, 750 ms for the Claude child. Given,
   * it applies to both.
   */
  graceMs?: number;
  /** How long a process gets to go after the hard signal (500 ms). */
  killWaitMs?: number;
}

export interface StopJobProcessesResult {
  worker: JobProcessStop;
  workerError: string | null;
  claude: JobProcessStop;
  claudeError: string | null;
}

/**
 * How long a canceller waits for a signalled worker before the hard signal:
 * longer than the worker's own handler of that signal takes (it stops its
 * Claude children, then settles its job), so a worker that is shutting down
 * cleanly is not killed mid-way.
 */
const WORKER_STOP_GRACE_MS = 3000;
const CLAUDE_KILL_GRACE_MS = 750;
const KILL_WAIT_MS = 500;
const STOP_POLL_MS = 25;

// Why a signalled process was not confirmed gone.
const SURVIVED = {
  unverifiable: 'signalled, but could not be verified as gone afterwards',
  treeKill: 'still running after the tree kill',
  hardSignal: 'still running after the hard signal',
} as const;

// One recorded process on its way through a stop.
interface StopTarget {
  pid: number | null;
  start: string | null;
  marker: string;
  graceMs: number;
  outcome: JobProcessStop | null;
  error: string | null;
  /** After the polite signal (`term`), or after the hard one (`kill`). */
  phase: 'term' | 'kill';
  /** When the current phase's wait ends (epoch ms). */
  until: number;
  /** The pid itself is gone; its group may still have members to sweep. */
  leaderGone: boolean;
}

// The stop of every target at once, in phases whose waits are shared: each
// target is identified (liveness first, the identity probe only for a live
// pid) and, only when it is verdict 'ours', gets the polite signal; then one
// wait, during which each target that is still running when its grace ends
// gets a fresh verdict and, still 'ours', the hard signal (not on Windows);
// then one more short wait and a last verdict. A target counts as stopped
// only once it is confirmed gone. The waits do not grow with the number of
// targets. A group whose leader went gone after the polite signal still gets
// the hard one at the end of its grace while a member remains (the leader
// died in this pid namespace, so the group is still its own).
function stopTargets(targets: StopTarget[], options: StopJobProcessesOptions): void {
  const ops = options.ops ?? PROCESS_OPS;
  const killWaitMs = Math.max(0, options.killWaitMs ?? KILL_WAIT_MS);
  // What a pid is now (liveness first, the identity probe only for a pid
  // that still runs): the recorded process ('ours'), another one
  // ('foreign'), gone ('dead'), or not verifiable ('unknown').
  const verdictOf = (target: StopTarget): ProcessVerdict =>
    processVerdict(target.pid as number, target.marker, { ops, expectedStart: target.start });
  // Windows' tree kill (taskkill /T /F) is forceful already: no hard signal.
  const posix = ops.platform !== 'win32';

  for (const target of targets) {
    if (target.pid === null) {
      target.outcome = 'none';
      continue;
    }
    const verdict = verdictOf(target);
    if (verdict !== 'ours') {
      target.outcome =
        verdict === 'dead' ? 'exited' : verdict === 'foreign' ? 'foreign' : 'unconfirmed';
      continue;
    }
    try {
      ops.terminate(target.pid);
    } catch (error) {
      target.outcome = 'failed';
      target.error = errorMessage(error);
      continue;
    }
    target.phase = 'term';
    target.until = Date.now() + target.graceMs;
  }

  for (;;) {
    const now = Date.now();
    for (const target of targets) {
      if (target.outcome !== null) {
        continue;
      }
      const pid = target.pid as number;
      const due = now >= target.until;
      if (!target.leaderGone && ops.processHasExited(pid)) {
        target.leaderGone = true;
      }
      if (target.leaderGone) {
        if (target.phase === 'term' && posix && ops.groupHasMembers(pid)) {
          if (!due) {
            continue;
          }
          try {
            ops.terminate(pid, { signal: 'SIGKILL', groupOnly: true });
          } catch {
            // The leader is confirmed gone; a group member that survives is not its record's.
          }
        }
        target.outcome = 'stopped';
        continue;
      }
      if (!due) {
        continue;
      }
      // The wait is over: a fresh verdict decides. After the polite signal,
      // a process still verdict 'ours' gets the hard one (POSIX); after the
      // hard one, or with no hard signal to give, it was not confirmed gone.
      const verdict = verdictOf(target);
      if (verdict === 'dead' || verdict === 'foreign') {
        target.outcome = 'stopped';
        continue;
      }
      if (target.phase === 'kill' || verdict === 'unknown' || !posix) {
        target.outcome = 'unconfirmed';
        target.error =
          verdict === 'unknown'
            ? SURVIVED.unverifiable
            : target.phase === 'kill'
              ? SURVIVED.hardSignal
              : SURVIVED.treeKill;
        continue;
      }
      try {
        ops.terminate(pid, { signal: 'SIGKILL' });
      } catch (error) {
        target.outcome = 'failed';
        target.error = errorMessage(error);
        continue;
      }
      target.phase = 'kill';
      target.until = Date.now() + killWaitMs;
    }
    if (targets.every((target) => target.outcome !== null)) {
      return;
    }
    sleepSync(STOP_POLL_MS);
  }
}

function targetsOf(job: ProcessFields, graceMs: number | undefined): [StopTarget, StopTarget] {
  const recorded = recordedProcesses(job);
  const target = (
    pid: number | null,
    start: string | null,
    marker: string,
    defaultGraceMs: number,
  ): StopTarget => ({
    pid,
    start,
    marker,
    graceMs: Math.max(0, graceMs ?? defaultGraceMs),
    outcome: null,
    error: null,
    phase: 'term',
    until: 0,
    leaderGone: false,
  });
  return [
    target(recorded.pid, recorded.pidStart, PROCESS_MARKERS.worker, WORKER_STOP_GRACE_MS),
    target(
      recorded.claudePid,
      recorded.claudePidStart,
      PROCESS_MARKERS.claude,
      CLAUDE_KILL_GRACE_MS,
    ),
  ];
}

// Stops several jobs' processes at once (a session end): every worker and
// Claude child goes through one phased stop (stopTargets), so the waits are
// shared and do not grow with the number of jobs.
export function stopJobsProcesses(
  jobs: readonly ProcessFields[],
  options: StopJobProcessesOptions = {},
): StopJobProcessesResult[] {
  const pairs = jobs.map((job) => targetsOf(job, options.graceMs));
  stopTargets(pairs.flat(), options);
  return pairs.map(([worker, claude]) => ({
    worker: worker.outcome ?? 'unconfirmed',
    workerError: worker.error,
    claude: claude.outcome ?? 'unconfirmed',
    claudeError: claude.error,
  }));
}

// Stops a job's worker (its process tree) and its headless Claude child,
// each only while its pid is verdict 'ours' (processVerdict: the program the
// record named and, where the record says, the process that started then;
// pids are reused). A pid that is dead or foreign is left alone; one whose
// identity could not be checked is never signalled: it is 'unconfirmed'.
// Each signalled process gets the polite signal, its grace, and, still
// verdict 'ours', the hard one (the Claude child leads its own process
// group, so the worker's tree kill does not reach it); it is 'stopped' only
// once confirmed gone.
export function stopJobProcesses(
  job: ProcessFields,
  options: StopJobProcessesOptions = {},
): StopJobProcessesResult {
  return stopJobsProcesses([job], options)[0] as StopJobProcessesResult;
}

function stopUnconfirmed(outcome: JobProcessStop): boolean {
  return outcome === 'failed' || outcome === 'unconfirmed';
}

/** Every recorded process of the stop is confirmed gone (none, exited, foreign, or stopped). */
export function stopConfirmed(stop: StopJobProcessesResult): boolean {
  return !stopUnconfirmed(stop.worker) && !stopUnconfirmed(stop.claude);
}

// A process a stop did not confirm gone, named with its pid and why.
function unconfirmedProcess(
  label: string,
  pid: number | null,
  outcome: JobProcessStop,
  error: string | null,
): { pid: number; text: string } | null {
  if (pid === null || !stopUnconfirmed(outcome)) {
    return null;
  }
  const why =
    outcome === 'failed'
      ? `the signal failed: ${error ?? 'unknown error'}`
      : (error ?? 'not signalled: its identity could not be verified');
  return { pid, text: `${label} pid ${pid} (${why})` };
}

/**
 * What a stop could not confirm gone, for the user to end: each pid and why,
 * or null when every process is confirmed gone. Nothing records these pids
 * for a later stop.
 */
export function unconfirmedStopWarning(
  stop: StopJobProcessesResult,
  processes: JobProcesses,
): string | null {
  const left = [
    unconfirmedProcess('worker', processes.pid, stop.worker, stop.workerError),
    unconfirmedProcess('Claude', processes.claudePid, stop.claude, stop.claudeError),
  ].filter((entry): entry is { pid: number; text: string } => entry !== null);
  if (left.length === 0) {
    return null;
  }
  const one = left.length === 1;
  return `Could not confirm ${left.map((entry) => entry.text).join(' and ')} stopped; end ${
    one ? 'it' : 'them'
  } yourself if ${one ? 'it is' : 'they are'} still running (for example \`kill ${left
    .map((entry) => entry.pid)
    .join(' ')}\`, or Task Manager on Windows).`;
}

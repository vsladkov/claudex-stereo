import fs from 'node:fs';
import process from 'node:process';

import { errorMessage } from '../shared/errors.ts';
import { optionalString, recordedPid } from '../shared/json.ts';
import { currentProcessOwner } from '../platform/process.ts';
import { nowIso, resolveJobLogFile } from '../workspace/state.ts';
import type { JobPatch, JobRecord, JobTokenUsage } from '../workspace/state.ts';
import { recordSessionWorkspace } from '../workspace/session-registry.ts';
import { settleJob, updateActiveJob } from './job-lifecycle.ts';
import type { JobSettlement } from './job-lifecycle.ts';

export const SESSION_ID_ENV = 'CODEX_COMPANION_SESSION_ID';

export interface ProgressEvent {
  message: string;
  phase: string | null;
  threadId: string | null;
  turnId: string | null;
  childPid: number | null;
  /** The child's start token (the runner notes it at spawn). */
  childStart: string | null;
  stderrMessage: string | null;
  logTitle: string | null;
  logBody: string | null;
}

// The runner-result shape runTrackedJob consumes.
export interface JobExecution {
  exitStatus: number;
  threadId?: string | null;
  turnId?: string | null;
  /** The model that actually served the run when it differs from the request (a Claude alias). */
  model?: string | null;
  /** Why a run with a non-zero exit failed; stored on the record and shown by status. */
  errorMessage?: string | null;
  payload?: unknown;
  rendered?: string;
  summary?: string;
  tokenUsage?: JobTokenUsage;
}

// A freshly created record has no status yet: the enqueue/run path assigns
// the first one ("queued"/"running") itself, so only the id is required here.
export interface PendingJobRecord extends Partial<JobRecord> {
  id: string;
}

// A job handed to runTrackedJob must know which workspace owns its artifacts.
export interface TrackedJob extends PendingJobRecord {
  workspaceRoot: string;
}

export interface CreateJobRecordOptions {
  env?: NodeJS.ProcessEnv;
  sessionIdEnv?: string;
}

export interface CreateProgressReporterOptions {
  stderr?: boolean;
  logFile?: string | null;
  onEvent?: ((event: ProgressEvent) => void) | null;
  /** Stderr echo prefix naming the runtime: `[codex]` or `[claude]`. */
  prefix?: string;
}

export function normalizeProgressEvent(value: unknown): ProgressEvent {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const event = value as Record<string, unknown>;
    return {
      message: String(event.message ?? '').trim(),
      phase: typeof event.phase === 'string' && event.phase.trim() ? event.phase.trim() : null,
      threadId:
        typeof event.threadId === 'string' && event.threadId.trim() ? event.threadId.trim() : null,
      turnId: typeof event.turnId === 'string' && event.turnId.trim() ? event.turnId.trim() : null,
      childPid: recordedPid(event.childPid),
      childStart: optionalString(event.childStart),
      stderrMessage: event.stderrMessage == null ? null : String(event.stderrMessage).trim(),
      logTitle:
        typeof event.logTitle === 'string' && event.logTitle.trim() ? event.logTitle.trim() : null,
      logBody: event.logBody == null ? null : String(event.logBody).trimEnd(),
    };
  }

  return {
    message: String(value ?? '').trim(),
    phase: null,
    threadId: null,
    turnId: null,
    childPid: null,
    childStart: null,
    stderrMessage: String(value ?? '').trim(),
    logTitle: null,
    logBody: null,
  };
}

export function appendLogLine(logFile: string | null | undefined, message: unknown): void {
  const normalized = String(message ?? '').trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, 'utf8');
}

export function appendLogBlock(
  logFile: string | null | undefined,
  title: string | null | undefined,
  body: string | null | undefined,
): void {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, 'utf8');
}

export function createJobLogFile(workspaceRoot: string, jobId: string, title?: string): string {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, '', 'utf8');
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord<T extends PendingJobRecord>(
  base: T,
  options: CreateJobRecordOptions = {},
): T & { createdAt: string; sessionId?: string } {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  // Remember where this session launches jobs so SessionEnd can sweep a
  // workspace root that is not the session's cwd.
  const workspaceRoot = (base as { workspaceRoot?: unknown }).workspaceRoot;
  if (sessionId && typeof workspaceRoot === 'string' && workspaceRoot) {
    recordSessionWorkspace(sessionId, workspaceRoot);
  }
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {}),
  };
}

// A progress event's record patch never fails the run: a state write that
// throws (a Windows antivirus scan holding the index, a full disk) is noted
// in the job log when there is one, and what it carried goes out again with
// the next event (the one-time Claude child pid included): a phase, thread,
// or turn counts as recorded only once a write took it.
export function createJobProgressUpdater(
  workspaceRoot: string,
  jobId: string,
  logFile: string | null = null,
): (event: unknown) => void {
  let lastPhase: string | null = null;
  let lastThreadId: string | null = null;
  let lastTurnId: string | null = null;
  // What events reported that no write has taken yet.
  let pending: Partial<JobRecord> = {};
  const track = (
    key: 'phase' | 'threadId' | 'turnId',
    value: string | null,
    last: string | null,
  ): void => {
    if (value === null) {
      return;
    }
    if (value === last) {
      delete pending[key];
    } else {
      pending[key] = value;
    }
  };

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    track('phase', normalized.phase, lastPhase);
    track('threadId', normalized.threadId, lastThreadId);
    track('turnId', normalized.turnId, lastTurnId);
    if (normalized.childPid) {
      pending.claudePid = normalized.childPid;
      pending.claudePidStart = normalized.childStart;
    }
    if (Object.keys(pending).length === 0) {
      return;
    }
    const patch: JobPatch = { ...pending, id: jobId };

    // The job file and the index row are patched under the index lock, the
    // lock settleJob writes under: a job settled meanwhile (a cancel
    // recorded before its kill lands) keeps its terminal row and file, with
    // no late phase or pid on either. A Claude child reported that late is
    // the worker's to stop: its signal handler kills the children it holds.
    // A pruned or half-written job file is left as it is (the index row still
    // takes the patch), and a row the index lost comes back from the job file.
    try {
      updateActiveJob(workspaceRoot, jobId, { update: (current) => ({ ...current, ...patch }) });
    } catch (error) {
      try {
        appendLogLine(logFile, `Could not record progress on job ${jobId}: ${errorMessage(error)}`);
      } catch {
        // Logging is best effort too.
      }
      return;
    }
    lastPhase = patch.phase ?? lastPhase;
    lastThreadId = patch.threadId ?? lastThreadId;
    lastTurnId = patch.turnId ?? lastTurnId;
    pending = {};
  };
}

export function createProgressReporter({
  stderr = false,
  logFile = null,
  onEvent = null,
  prefix = 'codex',
}: CreateProgressReporterOptions = {}): ((eventOrMessage: unknown) => void) | null {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  // Foreground stderr is captured by the calling model's shell tool, so a
  // busy turn's hundreds of per-command events become paid input tokens.
  // Echo the first few for liveness, then sample; the log file keeps every
  // event and the final render summarizes the run.
  const STDERR_VERBATIM_EVENTS = 5;
  const STDERR_SAMPLE_EVERY = 10;
  let stderrEvents = 0;
  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      stderrEvents += 1;
      if (stderrEvents <= STDERR_VERBATIM_EVENTS || stderrEvents % STDERR_SAMPLE_EVERY === 0) {
        process.stderr.write(`[${prefix}] ${stderrMessage}\n`);
      }
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function renderedDuplicatesRawOutput(rendered: string | undefined, payload: unknown): boolean {
  if (typeof rendered !== 'string' || !payload || typeof payload !== 'object') {
    return false;
  }
  const rawOutput = (payload as { rawOutput?: unknown }).rawOutput;
  return typeof rawOutput === 'string' && rawOutput.trim() === rendered.trim();
}

function persistTerminalState(
  workspaceRoot: string,
  jobId: string,
  logFile: string | null,
  settlement: JobSettlement,
): void {
  // A bookkeeping failure must never change the run's outcome: a successful
  // run stays successful and a failed run rethrows its own error. A job
  // settled meanwhile (a cancel) keeps its own record, and one swept away
  // meanwhile (a session end removes a cancelled job's row and file even when
  // it could not confirm this worker stopped) is not brought back; a lost
  // index row alone is rebuilt from the job file. A failed write is logged:
  // a job-file write that failed still settled the index row, and a record
  // left running shows as stalled, for /stereo:cancel to settle.
  try {
    const { writeError } = settleJob(workspaceRoot, jobId, { ...settlement, skipUnknown: true });
    if (writeError) {
      throw writeError;
    }
  } catch (error) {
    const message = `Failed to persist terminal state for job ${jobId}: ${errorMessage(error)}`;
    try {
      appendLogLine(logFile, message);
    } catch {
      process.stderr.write(`${message}\n`);
    }
  }
}

// Writes the running record (job file and index row) under the index lock,
// unless the job already settled: a cancel recorded while the worker booted
// must not be overwritten by a running status the settle never sees. Returns
// the terminal status found, or null when the record was written.
function markJobRunning(workspaceRoot: string, jobId: string, record: JobRecord): string | null {
  return updateActiveJob(workspaceRoot, jobId, {
    update: (current) => ({ ...current, ...record }),
    fallback: record,
  });
}

export async function runTrackedJob(
  job: TrackedJob,
  runner: () => Promise<JobExecution>,
  options: { logFile?: string | null } = {},
): Promise<JobExecution> {
  const runningRecord = {
    ...job,
    status: 'running',
    startedAt: nowIso(),
    phase: 'starting',
    // This process with its start token, so a later probe can tell it from
    // an unrelated process that reuses its pid.
    ...currentProcessOwner(),
    logFile: options.logFile ?? job.logFile ?? null,
  } as JobRecord;
  const finished = markJobRunning(job.workspaceRoot, job.id, runningRecord);
  if (finished) {
    // Settled before it started (a cancel while the worker booted): nothing runs.
    const message = `Job ${job.id} was already ${finished} before it started; nothing ran.`;
    try {
      appendLogLine(runningRecord.logFile, message);
    } catch {
      // Logging is best effort.
    }
    return { exitStatus: 1, errorMessage: message, rendered: `${message}\n`, summary: message };
  }

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? 'completed' : 'failed';
    persistTerminalState(job.workspaceRoot, job.id, options.logFile ?? job.logFile ?? null, {
      terminal: {
        status: completionStatus,
        phase: completionStatus === 'completed' ? 'done' : 'failed',
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        completedAt: nowIso(),
        ...(execution.tokenUsage ? { tokenUsage: execution.tokenUsage } : {}),
        ...(execution.model ? { model: execution.model } : {}),
        ...(completionStatus === 'failed' && execution.errorMessage
          ? { errorMessage: execution.errorMessage }
          : {}),
      },
      record: {
        result: execution.payload,
        // Skip the pre-rendered copy when it adds nothing over rawOutput:
        // renderers fall back to result.rawOutput, and duplicating the final
        // message doubled the stored (and re-printed) size of text-only jobs.
        ...(renderedDuplicatesRawOutput(execution.rendered, execution.payload)
          ? {}
          : { rendered: execution.rendered }),
      },
      index: { summary: execution.summary },
      fallback: runningRecord,
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, 'Final output', execution.rendered);
    return execution;
  } catch (error) {
    const message = errorMessage(error);
    const logFile = options.logFile ?? job.logFile ?? runningRecord.logFile ?? null;
    persistTerminalState(job.workspaceRoot, job.id, logFile, {
      terminal: { status: 'failed', phase: 'failed', errorMessage: message, completedAt: nowIso() },
      record: { logFile },
      fallback: runningRecord,
    });
    throw error;
  }
}

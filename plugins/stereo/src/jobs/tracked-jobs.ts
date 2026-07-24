import fs from 'node:fs';
import process from 'node:process';

import {
  nowIso,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  writeJobFile,
} from '../workspace/state.ts';
import type { JobPatch, JobRecord } from '../workspace/state.ts';

export const SESSION_ID_ENV = 'CODEX_COMPANION_SESSION_ID';

export interface ProgressEvent {
  message: string;
  phase: string | null;
  threadId: string | null;
  turnId: string | null;
  stderrMessage: string | null;
  logTitle: string | null;
  logBody: string | null;
}

// The runner-result shape runTrackedJob consumes.
export interface JobExecution {
  exitStatus: number;
  threadId?: string | null;
  turnId?: string | null;
  payload?: unknown;
  rendered?: string;
  summary?: string;
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
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {}),
  };
}

export function createJobProgressUpdater(
  workspaceRoot: string,
  jobId: string,
): (event: unknown) => void {
  let lastPhase: string | null = null;
  let lastThreadId: string | null = null;
  let lastTurnId: string | null = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch: JobPatch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch,
    });
  };
}

export function createProgressReporter({
  stderr = false,
  logFile = null,
  onEvent = null,
}: CreateProgressReporterOptions = {}): ((eventOrMessage: unknown) => void) | null {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot: string, jobId: string): JobRecord | null {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function persistTerminalState(
  workspaceRoot: string,
  jobId: string,
  logFile: string | null,
  fullRecord: JobRecord,
  indexPatch: JobPatch,
): void {
  // A bookkeeping failure must never change the run's outcome: a successful
  // run stays successful and a failed run rethrows its own error, while the
  // record is degraded to the best terminal state we can still write
  // (otherwise a stale running/pid record survives and later renders as a
  // stalled job).
  try {
    writeJobFile(workspaceRoot, jobId, fullRecord);
    upsertJob(workspaceRoot, indexPatch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      appendLogLine(logFile, `Failed to persist terminal job state: ${message}`);
    } catch {
      // Logging is best effort.
    }
    try {
      upsertJob(workspaceRoot, { id: jobId, status: indexPatch.status, pid: null });
    } catch {
      process.stderr.write(`Failed to persist terminal state for job ${jobId}: ${message}\n`);
    }
  }
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
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null,
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? 'completed' : 'failed';
    const completedAt = nowIso();
    persistTerminalState(
      job.workspaceRoot,
      job.id,
      options.logFile ?? job.logFile ?? null,
      {
        ...runningRecord,
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        pid: null,
        phase: completionStatus === 'completed' ? 'done' : 'failed',
        completedAt,
        result: execution.payload,
        rendered: execution.rendered,
      },
      {
        id: job.id,
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        summary: execution.summary,
        phase: completionStatus === 'completed' ? 'done' : 'failed',
        pid: null,
        completedAt,
      },
    );
    appendLogBlock(options.logFile ?? job.logFile ?? null, 'Final output', execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    persistTerminalState(
      job.workspaceRoot,
      job.id,
      options.logFile ?? job.logFile ?? existing.logFile ?? null,
      {
        ...existing,
        status: 'failed',
        phase: 'failed',
        errorMessage,
        pid: null,
        completedAt,
        logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null,
      },
      {
        id: job.id,
        status: 'failed',
        phase: 'failed',
        pid: null,
        errorMessage,
        completedAt,
      },
    );
    throw error;
  }
}

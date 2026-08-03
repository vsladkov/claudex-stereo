import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import process from 'node:process';

import { getCodexAuthStatus, getCodexAvailability } from '../runtime/index.ts';
import type { ProgressReporter } from '../runtime/index.ts';
import { releaseEligibleLiveReservations } from '../runtime/reservations.ts';
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  runTrackedJob,
} from '../jobs/tracked-jobs.ts';
import type { JobExecution, TrackedJob } from '../jobs/tracked-jobs.ts';
import {
  generateJobId,
  nowIso,
  readStoredJobOrNull,
  TERMINAL_JOB_STATUSES,
  upsertJob,
  writeJobFile,
} from '../workspace/state.ts';
import { COMPANION_ENTRY } from '../shared/paths.ts';
import { outputResult } from '../shared/text.ts';

export type CompanionTerminationSignal = 'SIGTERM' | 'SIGINT';

export interface SignalCleanupContext {
  jobId: string;
  workspaceRoot: string;
}

export interface SignalCleanupResult {
  terminalized: boolean;
  released: number;
  retained: number;
}

export function terminalizeJobForSignal(
  { jobId, workspaceRoot }: SignalCleanupContext,
  signal: CompanionTerminationSignal,
): boolean {
  // A corrupt or concurrently replaced record still gets a minimal terminal replacement below.
  const storedJob = readStoredJobOrNull(workspaceRoot, jobId);
  if (storedJob && TERMINAL_JOB_STATUSES.has(storedJob.status)) {
    return false;
  }

  const completedAt = nowIso();
  const errorMessage = `Terminated by ${signal}.`;
  const terminalRecord = {
    ...(storedJob ?? { id: jobId }),
    id: jobId,
    status: 'cancelled',
    phase: 'cancelled',
    pid: null,
    completedAt,
    errorMessage,
  };

  let firstError: unknown = null;
  try {
    writeJobFile(workspaceRoot, jobId, terminalRecord);
  } catch (error) {
    firstError = error;
  }
  try {
    upsertJob(workspaceRoot, terminalRecord);
  } catch (error) {
    firstError ??= error;
  }
  if (firstError) {
    throw firstError;
  }
  return true;
}

// Exported separately from signal registration so the synchronous cleanup
// body can be exercised without sending a signal to the test process.
export function cleanupCompanionJobForSignal(
  context: SignalCleanupContext,
  signal: CompanionTerminationSignal,
): SignalCleanupResult {
  let terminalized = false;
  let released = 0;
  let retained = 0;
  try {
    terminalized = terminalizeJobForSignal(context, signal);
  } catch {
    // Reservation cleanup must still run when job bookkeeping fails.
  }
  try {
    ({ released, retained } = releaseEligibleLiveReservations());
  } catch {
    // The caller must still re-raise the signal even if the sweep itself fails.
  }
  return { terminalized, released, retained };
}

export function installSignalCleanup(context: SignalCleanupContext): () => void {
  let handlingSignal = false;
  let disposed = false;
  const handlers = new Map<CompanionTerminationSignal, () => void>();
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const handler = (): void => {
      if (handlingSignal) {
        return;
      }
      handlingSignal = true;
      try {
        cleanupCompanionJobForSignal(context, signal);
      } finally {
        dispose();
        process.kill(process.pid, signal);
      }
    };
    handlers.set(signal, handler);
    // Register unconditionally: Windows emulates SIGINT, while unsupported
    // targeted signals continue to fall back to the stale-pid remedies.
    process.once(signal, handler);
  }

  return dispose;
}

// Every workflow runner resolves to a JobExecution enriched with the
// job-classification fields the CLI handlers persist.
export interface CompanionExecution extends JobExecution {
  exitStatus: number;
  threadId: string | null;
  turnId: string | null;
  payload: unknown;
  rendered: string;
  summary: string;
  jobTitle: string;
  jobClass: string;
  targetLabel?: string;
  write?: boolean;
  // Kept explicit at this workflow boundary so tracked-job persistence cannot
  // accidentally drop the capture's per-job/cumulative-thread accounting.
  tokenUsage?: JobExecution['tokenUsage'];
}

export interface CompanionJob extends TrackedJob {
  kind: string;
  kindLabel: string;
  title: string;
  jobClass: string;
  summary: string;
  model: string | null;
  write: boolean;
  createdAt: string;
  sessionId?: string;
}

export function ensureCodexAvailable(cwd: string): void {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      'Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/stereo:setup`.',
    );
  }
}

export const CODEX_NOT_AUTHENTICATED_ERROR =
  'Codex is installed but not authenticated. Run `!codex login`, then rerun `/stereo:setup` to confirm.';

export interface LaunchReadyDeps {
  ensureAvailable: typeof ensureCodexAvailable;
  getAuthStatus: typeof getCodexAuthStatus;
}

export async function ensureCodexLaunchReady(
  cwd: string,
  deps: LaunchReadyDeps = {
    ensureAvailable: ensureCodexAvailable,
    getAuthStatus: getCodexAuthStatus,
  },
): Promise<void> {
  deps.ensureAvailable(cwd);
  const auth = await deps.getAuthStatus(cwd);
  // Only a positive OpenAI-auth requirement is launch-blocking. Custom
  // providers explicitly return false, while broker-busy and transport
  // failures leave the requirement null and must not become false positives.
  if (auth.loggedIn === false && auth.requiresOpenaiAuth === true) {
    throw new Error(CODEX_NOT_AUTHENTICATED_ERROR);
  }
}

export interface ReviewJobMetadata {
  kind: string;
  title: string;
  summary: string;
}

export function buildReviewJobMetadata(
  reviewName: string,
  target: { label: string },
): ReviewJobMetadata {
  return {
    kind: reviewName === 'Adversarial Review' ? 'adversarial-review' : 'review',
    title: reviewName === 'Review' ? 'Codex Review' : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`,
  };
}

function getJobKindLabel(kind: string, jobClass: string): string {
  if (kind === 'adversarial-review') {
    return 'adversarial-review';
  }
  if (kind === 'plan-review') {
    return 'plan-review';
  }
  return jobClass === 'review' ? 'review' : 'rescue';
}

export interface CreateCompanionJobOptions {
  prefix: string;
  kind: string;
  title: string;
  workspaceRoot: string;
  jobClass: string;
  summary: string;
  model: string | null;
  write?: boolean;
}

export function createCompanionJob({
  prefix,
  kind,
  title,
  workspaceRoot,
  jobClass,
  summary,
  model,
  write = false,
}: CreateCompanionJobOptions): CompanionJob {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    model,
    write,
  });
}

export interface CreateTrackedProgressOptions {
  logFile?: string | null;
  stderr?: boolean;
}

export interface TrackedProgress {
  logFile: string;
  progress: ((eventOrMessage: unknown) => void) | null;
}

export function createTrackedProgress(
  job: TrackedJob,
  options: CreateTrackedProgressOptions = {},
): TrackedProgress {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id),
    }),
  };
}

export interface RunForegroundCommandOptions {
  json?: unknown;
  logFile?: string | null;
}

export async function runForegroundCommand(
  job: TrackedJob,
  runner: (progress: ProgressReporter | null) => Promise<JobExecution>,
  options: RunForegroundCommandOptions = {},
): Promise<JobExecution> {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json,
  });
  const disposeSignalCleanup = installSignalCleanup({
    jobId: job.id,
    workspaceRoot: job.workspaceRoot,
  });
  try {
    const execution = await runTrackedJob(job, () => runner(progress), { logFile });
    outputResult(options.json ? execution.payload : execution.rendered, options.json);
    if (execution.exitStatus !== 0) {
      process.exitCode = execution.exitStatus;
    }
    return execution;
  } finally {
    disposeSignalCleanup();
  }
}

export interface SpawnDetachedTaskWorkerOptions {
  spawnImpl?: typeof spawn;
  onSpawnError?: (error: Error) => void;
  workspaceRoot?: string | null;
}

export function spawnDetachedTaskWorker(
  cwd: string,
  jobId: string,
  options: SpawnDetachedTaskWorkerOptions = {},
): ChildProcess {
  const args = [COMPANION_ENTRY, 'task-worker', '--cwd', cwd, '--job-id', jobId];
  if (typeof options.workspaceRoot === 'string' && options.workspaceRoot.trim()) {
    args.push('--workspace', options.workspaceRoot);
  }
  const child = (options.spawnImpl ?? spawn)(process.execPath, args, {
    cwd,
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', (error) => options.onSpawnError?.(error));
  child.unref();
  return child;
}

function failQueuedJobForSpawnError(workspaceRoot: string, jobId: string, message: string): void {
  // A minimal failed record is still preferable to a permanently queued row.
  const storedJob = readStoredJobOrNull(workspaceRoot, jobId);
  const completedAt = nowIso();
  const failedRecord = {
    ...(storedJob ?? { id: jobId }),
    id: jobId,
    status: 'failed',
    phase: 'failed',
    pid: null,
    completedAt,
    errorMessage: message,
  };
  writeJobFile(workspaceRoot, jobId, failedRecord);
  upsertJob(workspaceRoot, failedRecord);
}

export interface QueuedTaskPayload {
  jobId: string;
  status: string;
  title: string;
  summary: string;
  logFile: string;
}

export function enqueueBackgroundTask(
  cwd: string,
  job: CompanionJob,
  request: unknown,
  options: { spawnImpl?: typeof spawn } = {},
): { payload: QueuedTaskPayload; logFile: string } {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, 'Queued for background execution.');

  // Persist the record before spawning: the detached worker reads it
  // immediately on boot, and losing that race left it nothing to run.
  const queuedRecord = {
    ...job,
    status: 'queued',
    phase: 'queued',
    pid: null,
    logFile,
    request,
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  let child: ChildProcess;
  try {
    child = spawnDetachedTaskWorker(cwd, job.id, {
      spawnImpl: options.spawnImpl,
      workspaceRoot: job.workspaceRoot,
      // Best effort: an asynchronous spawn failure may race the detached
      // parent's exit, but a live parent records it immediately.
      onSpawnError: (error) => {
        try {
          failQueuedJobForSpawnError(job.workspaceRoot, job.id, error.message);
        } catch {
          // There is no reliable return channel after the parent exits.
        }
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      failQueuedJobForSpawnError(job.workspaceRoot, job.id, message);
    } catch {
      // Preserve the real spawn failure as the CLI-facing error.
    }
    throw error;
  }
  if (child.pid) {
    // Preserve the previous whole-record fallback when the stored job cannot be read.
    const current = readStoredJobOrNull(job.workspaceRoot, job.id);
    writeJobFile(job.workspaceRoot, job.id, { ...(current ?? queuedRecord), pid: child.pid });
    upsertJob(job.workspaceRoot, { id: job.id, pid: child.pid });
  }

  return {
    payload: {
      jobId: job.id,
      status: 'queued',
      title: job.title,
      summary: job.summary,
      logFile,
    },
    logFile,
  };
}

export function renderQueuedTaskLaunch(payload: QueuedTaskPayload): string {
  return `${payload.title} started in the background as ${payload.jobId}. Check /stereo:status ${payload.jobId} for progress.\n`;
}

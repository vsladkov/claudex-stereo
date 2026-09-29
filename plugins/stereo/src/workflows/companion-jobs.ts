import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import process from 'node:process';

import { loadCodexCatalog } from '../models/catalog.ts';
import type { CodexCatalog } from '../models/catalog.ts';
import {
  CODEX_CLI_MISSING_ERROR,
  cleanupLiveClaudeRuns,
  CLAUDE_MIN_VERSION,
  getClaudeAuthStatus,
  getClaudeAvailability,
  getCodexAuthStatus,
  getCodexAvailability,
  parseStructuredOutput,
  releaseLiveReservations,
  runAppServerTurn,
  runClaudeTurn,
} from '../runtime/index.ts';
import type {
  AppServerTurnResult,
  ClaudeRole,
  CompanionTurn,
  ProgressReporter,
  StructuredOutputResult,
} from '../runtime/index.ts';
import { claudeEnvCredential } from '../runtime/claude-availability.ts';
import type { ClaudeTurnOptions, ClaudeTurnResult } from '../runtime/claude-runner.ts';
import type { RunAppServerTurnOptions } from '../runtime/turn-runner.ts';
import { jobRuntime, runtimeLabel } from '../shared/runtime.ts';
import type { CompanionRuntime } from '../shared/runtime.ts';
import { errorMessage } from '../shared/errors.ts';
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  runTrackedJob,
} from '../jobs/tracked-jobs.ts';
import { jobKindLabel } from '../jobs/job-control.ts';
import { settleJob, updateActiveJob } from '../jobs/job-lifecycle.ts';
import type { JobExecution, TrackedJob } from '../jobs/tracked-jobs.ts';
import { generateJobId, nowIso, upsertJob, writeJobFile } from '../workspace/state.ts';
import type { JobRecord } from '../workspace/state.ts';
import { spawnedProcessIdentity } from '../platform/process.ts';
import type { RecordedProcess } from '../platform/process.ts';
import { COMPANION_ENTRY } from '../shared/paths.ts';
import { outputResult } from '../shared/text.ts';

// SIGHUP is a termination like the others: a companion whose terminal or
// parent shell hangs up must still stop its Claude children and settle its job.
export type CompanionTerminationSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP';
const TERMINATION_SIGNALS: readonly CompanionTerminationSignal[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
// The conventional exit status of a process a signal ended (128 + its number).
const SIGNAL_EXIT_CODES: Record<CompanionTerminationSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export interface SignalCleanupContext {
  jobId: string;
  workspaceRoot: string;
}

export interface SignalCleanupResult {
  terminalized: boolean;
}

// Settles a job whose process received a termination signal. Its Claude
// children were stopped just before (cleanupLiveClaudeRuns). `deadline`
// bounds the index lock wait.
export function terminalizeJobForSignal(
  { jobId, workspaceRoot }: SignalCleanupContext,
  signal: CompanionTerminationSignal,
  deadline: number | null = null,
): boolean {
  // A job already settled (a cancel recorded before its kill) keeps its
  // record; a corrupt record still gets a minimal terminal replacement; a
  // job swept away entirely (session end) is not brought back.
  return settleJob(
    workspaceRoot,
    jobId,
    {
      terminal: {
        status: 'cancelled',
        phase: 'cancelled',
        completedAt: nowIso(),
        errorMessage: `Terminated by ${signal}.`,
      },
      skipUnknown: true,
    },
    deadline === null ? {} : { deadline },
  ).settled;
}

// How long the signal path waits for the index lock, from the start of the
// signal handling: well inside the grace a canceller gives the worker before
// its hard signal, so the reservation sweep and the exit follow in time.
const SIGNAL_SETTLE_LOCK_WAIT_MS = 1500;

// Exported separately from signal registration so the synchronous cleanup
// body can be exercised without sending a signal to the test process.
// `startedAt` is when the signal handling began (the Claude children were
// stopped first): the settle's lock wait ends SIGNAL_SETTLE_LOCK_WAIT_MS after it.
export function cleanupCompanionJobForSignal(
  context: SignalCleanupContext,
  signal: CompanionTerminationSignal,
  startedAt: number = Date.now(),
): SignalCleanupResult {
  let terminalized = false;
  try {
    terminalized = terminalizeJobForSignal(context, signal, startedAt + SIGNAL_SETTLE_LOCK_WAIT_MS);
  } catch {
    // Reservation cleanup must still run when job bookkeeping fails.
  }
  // Every reservation this process holds, one whose turn is in flight
  // included: this process ends next, and the next run of the thread or
  // session takes a dead owner's lock over.
  releaseLiveReservations();
  return { terminalized };
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

  for (const signal of TERMINATION_SIGNALS) {
    const handler = (): void => {
      if (handlingSignal) {
        return;
      }
      handlingSignal = true;
      const startedAt = Date.now();
      try {
        // A foreground companion is no process-group leader: stop its live
        // `claude -p` children explicitly before the process dies.
        cleanupLiveClaudeRuns();
        cleanupCompanionJobForSignal(context, signal, startedAt);
      } finally {
        dispose();
        try {
          // Re-raised with the handlers gone, so the default action ends the process.
          process.kill(process.pid, signal);
        } catch {
          // A platform that cannot raise this signal (SIGHUP on Windows) still exits.
          process.exit(SIGNAL_EXIT_CODES[signal]);
        }
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
  /** Why a run with a non-zero exit failed, for the record and the status line. */
  errorMessage?: string | null;
  // Kept explicit at this workflow boundary so tracked-job persistence cannot
  // accidentally drop the capture's per-job/cumulative-thread accounting.
  tokenUsage?: JobExecution['tokenUsage'];
}

// One role turn on either runtime, as the task, review, and plan-review
// workflows run it: the shared fields go to both runtimes, `claude` and
// `codex` to theirs only.
export interface RoleTurnRequest {
  /** The directory the turn works in: the Claude cwd, the Codex thread cwd. */
  cwd: string;
  model?: string | null;
  effort?: string | null;
  role: ClaudeRole | null;
  prompt: string;
  /** The Claude session or Codex thread the turn resumes. */
  resumeId?: string | null;
  outputSchema?: unknown;
  onProgress?: ProgressReporter | null;
  jobId?: string | null;
  claude?: Pick<ClaudeTurnOptions, 'allow' | 'sandbox'>;
  codex?: Pick<
    RunAppServerTurnOptions,
    'sandbox' | 'brokerCwd' | 'persistThread' | 'threadName' | 'defaultPrompt'
  >;
}

export function runRoleTurn(runtime: 'claude', request: RoleTurnRequest): Promise<ClaudeTurnResult>;
export function runRoleTurn(
  runtime: 'codex',
  request: RoleTurnRequest,
): Promise<AppServerTurnResult>;
export function runRoleTurn(
  runtime: CompanionRuntime,
  request: RoleTurnRequest,
): Promise<CompanionTurn>;
export function runRoleTurn(
  runtime: CompanionRuntime,
  request: RoleTurnRequest,
): Promise<CompanionTurn> {
  if (runtime === 'claude') {
    if (!request.model) {
      throw new Error('A Claude run needs a model selection (claude:<family>[-<version>]).');
    }
    return runClaudeTurn(request.cwd, {
      binary: getClaudeAvailability(request.cwd).binary,
      model: request.model,
      effort: request.effort ?? null,
      role: request.role,
      prompt: request.prompt,
      resumeSessionId: request.resumeId ?? null,
      outputSchema: request.outputSchema,
      onProgress: request.onProgress,
      jobId: request.jobId ?? null,
      ...request.claude,
    });
  }
  return runAppServerTurn(request.cwd, {
    model: request.model,
    effort: request.effort ?? null,
    prompt: request.prompt,
    resumeThreadId: request.resumeId ?? null,
    outputSchema: request.outputSchema,
    onProgress: request.onProgress,
    jobId: request.jobId ?? null,
    ...request.codex,
  });
}

// Why a turn failed: its error's message, else its stderr.
export function turnFailureMessage(result: Pick<CompanionTurn, 'error' | 'stderr'>): string {
  return (result.error as { message?: string } | null | undefined)?.message ?? result.stderr ?? '';
}

// A structured answer parsed from a turn's final message.
export function parseTurnOutput(result: CompanionTurn): StructuredOutputResult {
  return parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: turnFailureMessage(result),
  });
}

// The execution fields every turn's job records: its status, thread, turn,
// and token usage, and on Claude the id that served it.
export function turnExecutionFields(
  result: Pick<CompanionTurn, 'status' | 'threadId' | 'turnId' | 'tokenUsage' | 'servedModel'>,
): Pick<CompanionExecution, 'exitStatus' | 'threadId' | 'turnId' | 'tokenUsage' | 'model'> {
  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
    ...(result.servedModel ? { model: result.servedModel } : {}),
  };
}

// The runtime's own envelope in a payload: a Claude run's cost and denials,
// a Codex turn's status and stderr. The payload's rawOutput and
// reasoningSummary are the canonical copies; an envelope repeating them cost
// thousands of duplicated output tokens per --json read.
export function turnEnvelope(result: CompanionTurn) {
  return result.claude
    ? { claude: result.claude }
    : { codex: { status: result.status, stderr: result.stderr } };
}

// The count of progress notifications the capture dropped, when it dropped any.
export function droppedNotificationsField(result: { droppedNotifications: number }): {
  droppedNotifications?: number;
} {
  return result.droppedNotifications > 0
    ? { droppedNotifications: result.droppedNotifications }
    : {};
}

export interface CompanionJob extends TrackedJob {
  kind: string;
  kindLabel: string;
  title: string;
  jobClass: string;
  summary: string;
  model: string | null;
  runtime: CompanionRuntime;
  write: boolean;
  createdAt: string;
  sessionId?: string;
}

export function ensureCodexAvailable(cwd: string): void {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error(CODEX_CLI_MISSING_ERROR);
  }
}

export const CODEX_NOT_AUTHENTICATED_ERROR =
  'Codex is installed but not authenticated. Run `!codex login`, then rerun `/stereo:setup` to confirm.';

export const CLAUDE_NOT_AUTHENTICATED_ERROR =
  'Claude Code is installed but not logged in. Run `claude auth login`, then rerun `/stereo:setup` to confirm.';

// The Claude counterpart of ensureCodexLaunchReady: both probes are local
// commands (`claude --version`, `claude auth status`), so this is synchronous
// and, like the Codex gate, runs before any job record exists. A credential
// in the environment lets a role run whatever the login says, so the auth
// probe is skipped then (setup still reports it).
export function ensureClaudeLaunchReady(cwd: string): void {
  const availability = getClaudeAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      `Claude roles need the Claude Code CLI (${CLAUDE_MIN_VERSION} or newer) on PATH or CLAUDE_CODE_EXECPATH: ${availability.detail}. Codex roles are unaffected.`,
    );
  }
  if (!claudeEnvCredential() && !getClaudeAuthStatus(cwd).loggedIn) {
    throw new Error(CLAUDE_NOT_AUTHENTICATED_ERROR);
  }
}

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
): Promise<CodexCatalog> {
  deps.ensureAvailable(cwd);
  const auth = await deps.getAuthStatus(cwd);
  // Only a positive OpenAI-auth requirement is launch-blocking. Custom
  // providers explicitly return false, while broker-busy and transport
  // failures leave the requirement null and must not become false positives.
  if (auth.loggedIn === false && auth.requiresOpenaiAuth === true) {
    throw new Error(CODEX_NOT_AUTHENTICATED_ERROR);
  }
  // The auth probe refreshed the catalog (unless the cache is fresh); hand it
  // to the caller so the selection resolves against the same list once.
  return loadCodexCatalog();
}

export interface ReviewJobMetadata {
  kind: string;
  title: string;
  summary: string;
}

export function buildReviewJobMetadata(
  reviewName: string,
  role: string,
  target: { label: string },
  runtime: CompanionRuntime = 'codex',
): ReviewJobMetadata {
  return {
    kind: role === 'adversarial-reviewer' ? 'adversarial-review' : 'review',
    title: `${runtimeLabel(runtime)} ${reviewName}`,
    summary: `${reviewName} ${target.label}`,
  };
}

export interface CreateCompanionJobOptions {
  prefix: string;
  kind: string;
  title: string;
  workspaceRoot: string;
  jobClass: string;
  summary: string;
  model: string | null;
  runtime?: CompanionRuntime;
  write?: boolean;
  role?: string | null;
  /** What launched the job when no user command did (STOP_GATE_ORIGIN). */
  origin?: string | null;
}

export function createCompanionJob({
  prefix,
  kind,
  title,
  workspaceRoot,
  jobClass,
  summary,
  model,
  runtime = 'codex',
  write = false,
  role = null,
  origin = null,
}: CreateCompanionJobOptions): CompanionJob {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: jobKindLabel(kind, jobClass, role, origin),
    title,
    workspaceRoot,
    jobClass,
    summary,
    model,
    runtime,
    write,
    ...(role ? { role } : {}),
    ...(origin ? { origin } : {}),
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
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id, logFile),
      prefix: jobRuntime(job),
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
    outputResult(
      options.json ? slimForegroundPayload(execution.payload) : execution.rendered,
      options.json,
    );
    if (execution.exitStatus !== 0) {
      process.exitCode = execution.exitStatus;
    }
    return execution;
  } finally {
    disposeSignalCleanup();
  }
}

// The bounded command/file-change capture arrays are forensic detail: they
// stay in the persisted job record for /stereo:result, but printing them in
// the foreground --json answer costs the orchestrating model thousands of
// input tokens it rarely consumes inline.
function slimForegroundPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (!('commandExecutions' in record) && !('fileChanges' in record)) {
    return payload;
  }
  const slimmed = { ...record };
  delete slimmed.commandExecutions;
  delete slimmed.fileChanges;
  // The overflow counters describe the deleted arrays; keeping them would
  // present a self-referencing count for data that is not there.
  delete slimmed.commandExecutionsOmitted;
  delete slimmed.fileChangesOmitted;
  return slimmed;
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
  // A minimal failed record is still preferable to a permanently queued row;
  // a job cancelled meanwhile keeps its record.
  settleJob(workspaceRoot, jobId, {
    terminal: { status: 'failed', phase: 'failed', completedAt: nowIso(), errorMessage: message },
  });
}

// Notes the spawned worker's pid and start token on the queued record, under
// the index lock and only while the job is not terminal: a job settled
// meanwhile (a cancel, a failed spawn) keeps its record, and no terminal
// record gains a pid. A worker that already recorded itself running recorded
// this same pid.
function recordQueuedWorkerPid(
  workspaceRoot: string,
  jobId: string,
  queuedRecord: Partial<JobRecord>,
  worker: RecordedProcess,
): void {
  // Swept away meanwhile (a session end): left alone. A stored job that
  // cannot be read gets the whole queued record back.
  updateActiveJob(workspaceRoot, jobId, {
    update: (current) => ({ ...current, pid: worker.pid, pidStart: worker.start }),
    fallback: queuedRecord,
    skipUnknown: true,
  });
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
    const message = errorMessage(error);
    try {
      failQueuedJobForSpawnError(job.workspaceRoot, job.id, message);
    } catch {
      // Preserve the real spawn failure as the CLI-facing error.
    }
    throw error;
  }
  const worker = spawnedProcessIdentity(child.pid);
  if (worker) {
    recordQueuedWorkerPid(job.workspaceRoot, job.id, queuedRecord, worker);
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

import process from 'node:process';

import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  MAX_COMMAND_OUTPUT_CHARS,
  parseStructuredOutput,
} from '../runtime/index.ts';
import type {
  AppServerTurnResult,
  ClaudeRole,
  CompanionTurn,
  ProgressReporter,
} from '../runtime/index.ts';
import { filterJobsForCurrentSession, sortJobsNewestFirst } from '../jobs/job-control.ts';
import { SESSION_ID_ENV } from '../jobs/tracked-jobs.ts';
import { STOP_GATE_ORIGIN, isActiveJob, listJobs } from '../workspace/state.ts';
import type { JobRecord } from '../workspace/state.ts';
import { resolveWorkspaceRoot } from '../workspace/workspace.ts';
import { renderTaskResult } from '../render/render.ts';
import { jobRuntime, runtimeLabel } from '../shared/runtime.ts';
import type { CompanionRuntime } from '../shared/runtime.ts';
import { firstMeaningfulLine, shorten } from '../shared/text.ts';
import {
  droppedNotificationsField,
  runRoleTurn,
  turnExecutionFields,
  turnFailureMessage,
} from './companion-jobs.ts';
import type { CompanionExecution } from './companion-jobs.ts';

// Not a "Codex Companion Task" name: the sessionless --resume-last fallback
// searches Codex's thread list by that prefix and must never find the gate.
const STOP_GATE_THREAD_NAME = 'Codex Companion Stop Gate Review';
export const MAX_CAPTURED_COMMANDS = 100;
export const MAX_CAPTURED_FILE_CHANGES = 500;

export interface CapturedTaskCommandExecution {
  command: string;
  cwd: string;
  status: unknown;
  exitCode: number | null;
  durationMs: number | null;
  output?: string;
}

export interface CapturedTaskFileChange {
  path: string;
  kind: unknown;
  status: unknown;
}

export interface TaskCapturePayload {
  commandExecutions?: CapturedTaskCommandExecution[];
  commandExecutionsOmitted?: number;
  fileChanges?: CapturedTaskFileChange[];
  fileChangesOmitted?: number;
}

// The tail of a run's commands, on either runtime: the last commands are the
// verification, and the count of the ones dropped before them.
function captureCommandTail<T>(executions: readonly T[]): {
  commandExecutions?: T[];
  commandExecutionsOmitted?: number;
} {
  const commandExecutions = executions.slice(-MAX_CAPTURED_COMMANDS);
  const commandExecutionsOmitted = executions.length - commandExecutions.length;
  return {
    ...(commandExecutions.length > 0 ? { commandExecutions } : {}),
    ...(commandExecutionsOmitted > 0 ? { commandExecutionsOmitted } : {}),
  };
}

// This deliberately covers task runs only: review and plan-review are read-only.
// Job files share the job log's trust boundary, but failed-command output may
// still contain secrets, so only a bounded non-zero-exit tail is retained and
// diffs are never stored.
export function buildTaskCapturePayload(
  result: Pick<AppServerTurnResult, 'commandExecutions' | 'fileChanges'>,
): TaskCapturePayload {
  const commands = captureCommandTail(
    result.commandExecutions.map((item): CapturedTaskCommandExecution => ({
      command: item.command,
      cwd: item.cwd,
      status: item.status,
      exitCode: item.exitCode,
      durationMs: item.durationMs,
      ...(typeof item.exitCode === 'number' && item.exitCode !== 0
        ? { output: (item.aggregatedOutput ?? '').slice(-MAX_COMMAND_OUTPUT_CHARS) }
        : {}),
    })),
  );

  const fileChangesByPath = new Map<string, CapturedTaskFileChange>();
  for (const item of result.fileChanges) {
    for (const change of item.changes ?? []) {
      fileChangesByPath.delete(change.path);
      fileChangesByPath.set(change.path, {
        path: change.path,
        kind: change.kind,
        status: item.status,
      });
    }
  }
  const flattenedFileChanges = [...fileChangesByPath.values()];
  const fileChangesOmitted = Math.max(0, flattenedFileChanges.length - MAX_CAPTURED_FILE_CHANGES);
  const fileChanges = flattenedFileChanges.slice(-MAX_CAPTURED_FILE_CHANGES);

  return {
    ...commands,
    ...(fileChanges.length > 0 ? { fileChanges } : {}),
    ...(fileChangesOmitted > 0 ? { fileChangesOmitted } : {}),
  };
}

// A task run with --output-schema reports its parsed answer the way
// plan-review and review do: `result` (the parsed object, or null) and
// `parseError` (why it did not parse, or null). Without a schema the answer
// is free text and neither field is added.
function buildTaskStructuredFields(
  outputSchema: unknown,
  rawOutput: string,
  status: number,
  failureMessage: string,
): { result?: unknown; parseError?: string | null } {
  if (outputSchema === undefined || outputSchema === null) {
    return {};
  }
  const parsed = parseStructuredOutput(rawOutput, { status, failureMessage });
  return { result: parsed.parsed, parseError: parsed.parseError };
}

export function getCurrentClaudeSessionId(): string | null {
  return process.env[SESSION_ID_ENV] ?? null;
}

// The job that produced a thread or session id, as a resume sees it: the
// runtime it ran on and the role it ran as. Null when no record knows the
// id (a Codex thread can exist outside the job index). A job's threadId is a
// Codex thread or a Claude session; only the runtime that produced it can
// resume it.
export interface ResumeOwner {
  job: JobRecord;
  runtime: CompanionRuntime;
  role: string | null;
}

export function describeResumeOwner(jobs: JobRecord[], threadId: string): ResumeOwner | null {
  const job = findTrackedJobByThread(jobs, threadId);
  if (!job) {
    return null;
  }
  return {
    job,
    runtime: jobRuntime(job),
    role: typeof job.role === 'string' && job.role ? job.role : null,
  };
}

// The role a thread's owner ran as: its recorded role, else the role its job
// kind implies (plan reviews and reviews recorded before they carried a
// role). Null for a role-less task (a rescue run, or a task recorded before
// roles were).
export function resumeOwnerRole(owner: ResumeOwner | null): string | null {
  if (!owner) {
    return null;
  }
  if (owner.role) {
    return owner.role;
  }
  const { kind, jobClass } = owner.job;
  if (kind === 'plan-review') {
    return 'plan-reviewer';
  }
  if (kind === 'adversarial-review') {
    return 'adversarial-reviewer';
  }
  if (kind === 'review' || jobClass === 'review') {
    return 'reviewer';
  }
  return null;
}

// A thread or session a role ran is resumed only as that same role: roles
// never share one (a plan reviewer's session continued as the implementer
// would carry the reviewer's context and its framing into the
// implementation), and a run without a role never takes one over. The same
// role may continue its own, as an implementer does for a fix turn. A
// role-less owner (a rescue run, or a record from before roles were
// recorded) is not judged.
export function assertSameRoleResume(
  owner: ResumeOwner | null,
  threadId: string | null,
  role: string | null,
): void {
  const ownerRole = resumeOwnerRole(owner);
  if (!owner || !threadId || !ownerRole || ownerRole === role) {
    return;
  }
  const noun = owner.runtime === 'claude' ? 'Session' : 'Thread';
  throw new Error(
    role
      ? `${noun} ${threadId} belongs to ${ownerRole} job ${owner.job.id}; a role resumes only its own thread or session, so run the ${role} without --thread.`
      : `${noun} ${threadId} belongs to ${ownerRole} job ${owner.job.id}; resume it with --role ${ownerRole}.`,
  );
}

// Claude Code keeps a session under the directory it ran in, so a resume from
// any other directory would find no conversation. A record without a cwd
// (written before task records carried one) is not judged.
export function assertResumeCwd(
  job: JobRecord | null | undefined,
  sessionId: string | null,
  runCwd: string,
): void {
  const recorded = typeof job?.cwd === 'string' && job.cwd ? job.cwd : null;
  if (!sessionId || !recorded || recorded === runCwd) {
    return;
  }
  throw new Error(
    `Session ${sessionId} ran in ${recorded}; resume it from there (pass --cwd '${recorded}').`,
  );
}

export interface ResumeFitInput {
  /** The workspace's jobs, from the same state read as its config. */
  jobs: JobRecord[];
  threadId: string | null;
  /** The role the resume runs as. */
  role: string | null;
  /** The runtime the resume runs on. */
  runtime: CompanionRuntime;
  /** The directory the resume works in. */
  runCwd: string;
}

// A `--thread` resume must fit the job that produced the id: the same role,
// the same runtime, and for a Claude session the directory it ran in.
export function assertResumeFits({ jobs, threadId, role, runtime, runCwd }: ResumeFitInput): void {
  const owner = threadId ? describeResumeOwner(jobs, threadId) : null;
  assertSameRoleResume(owner, threadId, role);
  if (owner && owner.runtime !== runtime) {
    throw new Error(
      `Thread ${threadId} belongs to a ${runtimeLabel(owner.runtime)} job (${owner.job.id}); resume it with a ${runtimeLabel(owner.runtime)} --model.`,
    );
  }
  if (runtime === 'claude') {
    assertResumeCwd(owner?.job, threadId, runCwd);
  }
}

// The job that produced a thread or session id, newest first.
export function findTrackedJobByThread(jobs: JobRecord[], threadId: string): JobRecord | null {
  const wanted = threadId.trim();
  if (!wanted) {
    return null;
  }
  return (
    sortJobsNewestFirst(jobs).find(
      (job) => typeof job.threadId === 'string' && job.threadId === wanted,
    ) ?? null
  );
}

// `--resume-last` continues the last rescue run: a Codex task without a
// role. A role-bearing task belongs to a pair command and is never what
// "continue the last Codex work" means, so the lookup skips it, as it skips
// the Stop hook's review task and every Claude session.
export function findLatestResumableTaskJob(jobs: JobRecord[]): JobRecord | null {
  return (
    jobs.find(
      (job) =>
        job.jobClass === 'task' &&
        job.threadId &&
        jobRuntime(job) === 'codex' &&
        !job.role &&
        job.origin !== STOP_GATE_ORIGIN &&
        job.status !== 'queued' &&
        job.status !== 'running',
    ) ?? null
  );
}

export interface ResolveLatestTaskThreadOptions {
  excludeJobId?: string | null;
  workspaceRoot?: string | null;
}

export async function resolveLatestTrackedTaskThread(
  cwd: string,
  options: ResolveLatestTaskThreadOptions = {},
): Promise<{ id: string; job?: JobRecord } | null> {
  const workspaceRoot = options.workspaceRoot?.trim()
    ? options.workspaceRoot
    : resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter(
    (job) => job.id !== options.excludeJobId,
  );
  const visibleJobs = filterJobsForCurrentSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === 'task' && isActiveJob(job));
  if (activeTask) {
    throw new Error(
      `Task ${activeTask.id} is still running. Use /stereo:status before continuing it.`,
    );
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    // findLatestResumableTaskJob only matches jobs with a truthy threadId.
    return { id: trackedTask.threadId as string, job: trackedTask };
  }

  // Outside a Claude session, Codex's own thread list is searched too.
  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(cwd, { brokerCwd: workspaceRoot });
}

export function requireTaskRequest(prompt: string | null | undefined, resumeLast: boolean): void {
  if (!prompt && !resumeLast) {
    throw new Error('Provide a prompt, a prompt file, piped stdin, or use --resume-last.');
  }
}

export interface TaskRunMetadata {
  title: string;
  summary: string;
}

export function buildTaskRunMetadata({
  prompt,
  resumeLast = false,
  runtime = 'codex',
  origin = null,
}: {
  prompt?: string | null;
  resumeLast?: boolean;
  runtime?: CompanionRuntime;
  /** STOP_GATE_ORIGIN for the Stop hook's review. */
  origin?: string | null;
}): TaskRunMetadata {
  const label = runtimeLabel(runtime);
  if (origin === STOP_GATE_ORIGIN) {
    return {
      title: `${label} Stop Gate Review`,
      summary: 'Stop-gate review of previous Claude turn',
    };
  }

  const title = resumeLast ? `${label} Resume` : `${label} Task`;
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : 'Task';
  return {
    title,
    summary: shorten(prompt || fallbackSummary),
  };
}

export interface TaskRunRequest {
  cwd: string;
  // Durable-state/broker key; defaults to the thread cwd's repository root.
  workspaceRoot?: string | null;
  /** Absent means Codex (records and requests written before Claude jobs existed). */
  runtime?: CompanionRuntime;
  model?: string | null;
  effort?: string | null;
  /** Claude only: the role agent definition the run adopts. */
  role?: ClaudeRole | null;
  /** Claude only: extra permission rules granted for the run. */
  allow?: string[];
  /** Claude only: Claude Code's Bash sandbox in the child. */
  sandbox?: boolean;
  outputSchema?: unknown;
  prompt?: string;
  write?: boolean;
  resumeLast?: boolean;
  threadId?: string | null;
  /** What launched the run when no user command did: STOP_GATE_ORIGIN for the Stop hook. */
  origin?: string | null;
  jobId?: string | null;
  onProgress?: ProgressReporter | null;
}

// The job a task run produces on either runtime: one payload shape, one
// rendering, and one summary; `capture` adds the runtime's own record of the
// commands and files the run touched.
function buildTaskExecution(
  request: TaskRunRequest,
  taskMetadata: TaskRunMetadata,
  result: CompanionTurn & { touchedFiles: string[] },
  capture: object,
): CompanionExecution {
  const { title } = taskMetadata;
  const rawOutput = typeof result.finalMessage === 'string' ? result.finalMessage : '';
  const failureMessage = turnFailureMessage(result);
  const failed = result.status !== 0 && Boolean(failureMessage);
  return {
    ...turnExecutionFields(result),
    ...(failed ? { errorMessage: failureMessage } : {}),
    payload: {
      status: result.status,
      threadId: result.threadId,
      rawOutput,
      touchedFiles: result.touchedFiles,
      reasoningSummary: result.reasoningSummary,
      effort: request.effort ?? null,
      ...buildTaskStructuredFields(request.outputSchema, rawOutput, result.status, failureMessage),
      ...(failed ? { error: failureMessage } : {}),
      ...capture,
      ...droppedNotificationsField(result),
    },
    rendered: renderTaskResult(
      { rawOutput, failureMessage, reasoningSummary: result.reasoningSummary },
      {
        title,
        jobId: request.jobId ?? null,
        write: Boolean(request.write),
        touchedFiles: result.touchedFiles,
        status: result.status,
        deniedTargets: (result.claude?.permissionDenials ?? []).map(
          (denial) => denial.target ?? denial.tool,
        ),
      },
    ),
    summary: failed
      ? firstMeaningfulLine(failureMessage, `${title} failed.`)
      : firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${title} finished.`)),
    jobTitle: title,
    jobClass: 'task',
    write: Boolean(request.write),
  };
}

// A Claude role turn: same request, same payload shape (rawOutput carries the
// final text, so every consumer of a Codex task result reads it unchanged),
// plus the commands it ran and a `claude` envelope with the cost and denials.
// It resumes only the session --thread names (--resume-last is Codex-only).
async function executeClaudeTaskRun(
  request: TaskRunRequest,
  threadCwd: string,
  taskMetadata: TaskRunMetadata,
): Promise<CompanionExecution> {
  const resumeSessionId = request.threadId ?? null;
  requireTaskRequest(request.prompt, Boolean(resumeSessionId));
  const result = await runRoleTurn('claude', {
    cwd: threadCwd,
    model: request.model,
    effort: request.effort,
    role: request.role ?? null,
    prompt: request.prompt || DEFAULT_CONTINUE_PROMPT,
    resumeId: resumeSessionId,
    outputSchema: request.outputSchema,
    onProgress: request.onProgress,
    jobId: request.jobId,
    claude: { allow: request.allow ?? [], sandbox: Boolean(request.sandbox) },
  });
  return buildTaskExecution(request, taskMetadata, result, {
    ...captureCommandTail(result.commandExecutions),
    // Compared with each command's `order`: a check that ran before the last
    // edit did not verify the final tree.
    lastEditOrder: result.lastEditOrder,
    claude: result.claude,
  });
}

export async function executeTaskRun(request: TaskRunRequest): Promise<CompanionExecution> {
  const threadCwd = resolveWorkspaceRoot(request.cwd);
  const workspaceRoot =
    typeof request.workspaceRoot === 'string' && request.workspaceRoot.trim()
      ? request.workspaceRoot
      : threadCwd;

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast,
    runtime: request.runtime,
    origin: request.origin,
  });
  if (request.runtime === 'claude') {
    return executeClaudeTaskRun(request, threadCwd, taskMetadata);
  }

  let resumeThreadId = request.threadId ?? null;
  if (!resumeThreadId && request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(threadCwd, {
      excludeJobId: request.jobId,
      workspaceRoot,
    });
    if (!latestThread) {
      throw new Error('No previous Codex task thread was found for this repository.');
    }
    resumeThreadId = latestThread.id;
  }

  requireTaskRequest(request.prompt, Boolean(resumeThreadId));

  const result = await runRoleTurn('codex', {
    cwd: threadCwd,
    model: request.model,
    effort: request.effort,
    role: null,
    prompt: request.prompt ?? '',
    resumeId: resumeThreadId,
    outputSchema: request.outputSchema,
    onProgress: request.onProgress,
    jobId: request.jobId,
    codex: {
      defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : '',
      sandbox: request.write ? 'workspace-write' : 'read-only',
      persistThread: true,
      threadName: resumeThreadId
        ? null
        : request.origin === STOP_GATE_ORIGIN
          ? STOP_GATE_THREAD_NAME
          : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT),
      brokerCwd: workspaceRoot,
    },
  });
  return buildTaskExecution(request, taskMetadata, result, buildTaskCapturePayload(result));
}

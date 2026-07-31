import path from 'node:path';

import { normalizeReasoningEffort, normalizeRequestedModel } from '../../models/registry.ts';
import {
  filterJobsForCurrentSession,
  readStoredJob,
  sortJobsNewestFirst,
} from '../../jobs/job-control.ts';
import { runTrackedJob } from '../../jobs/tracked-jobs.ts';
import { readOutputSchema } from '../../runtime/index.ts';
import {
  assertSafeJobId,
  listJobs,
  nowIso,
  upsertJob,
  writeJobFile,
} from '../../workspace/state.ts';
import type { JobRecord } from '../../workspace/state.ts';
import {
  createCompanionJob,
  createTrackedProgress,
  ensureCodexAvailable,
  enqueueBackgroundTask,
  installSignalCleanup,
  renderQueuedTaskLaunch,
  runForegroundCommand,
} from '../../workflows/companion-jobs.ts';
import type { CompanionJob } from '../../workflows/companion-jobs.ts';
import { executePlanReviewRun } from '../../workflows/plan-review.ts';
import type { PlanReviewRunRequest } from '../../workflows/plan-review.ts';
import { executeReviewRun } from '../../workflows/review.ts';
import type { ReviewRunRequest } from '../../workflows/review.ts';
import {
  buildTaskRunMetadata,
  executeTaskRun,
  findLatestResumableTaskJob,
  getCurrentClaudeSessionId,
  requireTaskRequest,
} from '../../workflows/task.ts';
import type { TaskRunMetadata, TaskRunRequest } from '../../workflows/task.ts';
import {
  outputCommandResult,
  parseCommandInput,
  readTaskPrompt,
  resolveCommandCwd,
  resolveCommandWorkspace,
} from '../io.ts';

// The request payload persisted for the detached task worker: a task or a
// plan-review/review request distinguished by its optional kind marker.
type PersistedWorkerRequest = TaskRunRequest &
  PlanReviewRunRequest &
  ReviewRunRequest & { kind?: string };

export interface TaskWorkerDeps {
  runTrackedJob: typeof runTrackedJob;
  executeTaskRun: typeof executeTaskRun;
  executePlanReviewRun: typeof executePlanReviewRun;
  executeReviewRun: typeof executeReviewRun;
}

export const defaultTaskWorkerDeps: TaskWorkerDeps = {
  runTrackedJob,
  executeTaskRun,
  executePlanReviewRun,
  executeReviewRun,
};

function buildTaskJob(
  workspaceRoot: string,
  taskMetadata: TaskRunMetadata,
  model: string | null,
  write: boolean,
): CompanionJob {
  return createCompanionJob({
    prefix: 'task',
    kind: 'task',
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: 'task',
    summary: taskMetadata.summary,
    model,
    write,
  });
}

interface BuildTaskRequestInput extends TaskRunRequest {
  cwd: string;
  model: string | null;
  effort: string | null;
  prompt: string;
  write: boolean;
  resumeLast: boolean;
  threadId: string | null;
  jobId: string;
}

function buildTaskRequest({
  cwd,
  model,
  effort,
  outputSchema,
  prompt,
  write,
  resumeLast,
  threadId,
  jobId,
}: BuildTaskRequestInput): TaskRunRequest {
  return {
    cwd,
    model,
    effort,
    outputSchema,
    prompt,
    write,
    resumeLast,
    threadId,
    jobId,
  };
}

export async function handleTask(argv: string[]): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['model', 'effort', 'cwd', 'prompt-file', 'thread', 'output-schema'],
    booleanOptions: ['json', 'write', 'resume-last', 'resume', 'fresh', 'background'],
    aliasMap: {
      m: 'model',
    },
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const outputSchema =
    typeof options['output-schema'] === 'string'
      ? readOutputSchema(path.resolve(cwd, options['output-schema']))
      : undefined;
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options['resume-last'] || options.resume);
  const fresh = Boolean(options.fresh);
  const threadId =
    typeof options.thread === 'string' && options.thread.trim() ? options.thread.trim() : null;
  if (resumeLast && fresh) {
    throw new Error('Choose either --resume/--resume-last or --fresh.');
  }
  if (threadId && (resumeLast || fresh)) {
    throw new Error('Choose either --thread <id> or --resume/--resume-last/--fresh.');
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast,
  });

  // Validate before any job record exists: a foreground invocation with no
  // prompt/resume target must fast-fail like the background path instead of
  // leaving a spurious running->failed job in /stereo:status.
  ensureCodexAvailable(cwd);
  requireTaskRequest(prompt, resumeLast || Boolean(threadId));

  if (options.background) {
    const job = buildTaskJob(workspaceRoot, taskMetadata, model, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      outputSchema,
      prompt,
      write,
      resumeLast,
      threadId,
      jobId: job.id,
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, model, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        outputSchema,
        prompt,
        write,
        resumeLast,
        threadId,
        jobId: job.id,
        onProgress: progress,
      }),
    { json: options.json },
  );
}

export async function handleTaskWorker(
  argv: string[],
  deps: TaskWorkerDeps = defaultTaskWorkerDeps,
): Promise<void> {
  const { options } = parseCommandInput(argv, {
    valueOptions: ['cwd', 'job-id'],
  });

  if (!options['job-id']) {
    throw new Error('Missing required --job-id for task-worker.');
  }

  const jobId = assertSafeJobId(options['job-id'] as string);
  const workspaceRoot = resolveCommandWorkspace(options);
  let storedJob: JobRecord | null = null;
  let request: PersistedWorkerRequest | null = null;
  try {
    storedJob = readStoredJob(workspaceRoot, jobId);
    if (!storedJob) {
      throw new Error(`No stored job found for ${jobId}.`);
    }
    request = storedJob.request as PersistedWorkerRequest | null;
    if (!request || typeof request !== 'object') {
      throw new Error(`Stored job ${jobId} is missing its task request payload.`);
    }
  } catch (error) {
    // The worker runs detached with stdio ignored: an unrecorded bootstrap
    // failure would leave the job queued forever with no visible cause.
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    try {
      writeJobFile(workspaceRoot, jobId, {
        ...(storedJob ?? { id: jobId }),
        id: jobId,
        status: 'failed',
        phase: 'failed',
        errorMessage,
        pid: null,
        completedAt,
      });
    } catch {
      // Best effort; the index update below is the important half.
    }
    try {
      upsertJob(workspaceRoot, {
        id: jobId,
        status: 'failed',
        phase: 'failed',
        errorMessage,
        pid: null,
        completedAt,
      });
    } catch {
      // Nothing else to do from a detached worker.
    }
    throw error;
  }

  // The catch above always rethrows, so both bootstrap values are set here.
  const workerJob = storedJob as JobRecord;
  const workerRequest = request as PersistedWorkerRequest;

  const disposeSignalCleanup = installSignalCleanup({ jobId, workspaceRoot });
  try {
    const { logFile, progress } = createTrackedProgress(
      {
        ...workerJob,
        workspaceRoot,
      },
      {
        logFile: workerJob.logFile ?? null,
      },
    );
    const runner =
      workerRequest.kind === 'plan-review'
        ? deps.executePlanReviewRun
        : workerRequest.kind === 'review'
          ? deps.executeReviewRun
          : deps.executeTaskRun;
    await deps.runTrackedJob(
      {
        ...workerJob,
        workspaceRoot,
        logFile,
      },
      () =>
        runner({
          ...workerRequest,
          onProgress: progress,
        }),
      { logFile },
    );
  } finally {
    disposeSignalCleanup();
  }
}

export function handleTaskResumeCandidate(argv: string[]): void {
  const { options } = parseCommandInput(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json'],
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null,
          },
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : 'No resumable task found for this session.\n';
  outputCommandResult(payload, rendered, options.json);
}

import process from 'node:process';

import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  runAppServerTurn,
} from '../runtime/index.ts';
import type { ProgressReporter } from '../runtime/index.ts';
import {
  buildSingleJobSnapshot,
  filterJobsForCurrentSession,
  sortJobsNewestFirst,
} from '../jobs/job-control.ts';
import type { SingleJobSnapshot } from '../jobs/job-control.ts';
import { SESSION_ID_ENV } from '../jobs/tracked-jobs.ts';
import { listJobs } from '../workspace/state.ts';
import type { JobRecord } from '../workspace/state.ts';
import { resolveWorkspaceRoot } from '../workspace/workspace.ts';
import { renderTaskResult } from '../render/render.ts';
import { firstMeaningfulLine, shorten, sleep } from '../shared/text.ts';
import type { CompanionExecution } from './companion-jobs.ts';

const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const STOP_REVIEW_TASK_MARKER = 'Run a stop-gate review of the previous Claude turn.';

export function getCurrentClaudeSessionId(): string | null {
  return process.env[SESSION_ID_ENV] ?? null;
}

function isActiveJobStatus(status: string): boolean {
  return status === 'queued' || status === 'running';
}

export function findLatestResumableTaskJob(jobs: JobRecord[]): JobRecord | null {
  return (
    jobs.find(
      (job) =>
        job.jobClass === 'task' &&
        job.threadId &&
        job.status !== 'queued' &&
        job.status !== 'running',
    ) ?? null
  );
}

export interface WaitForSingleJobOptions {
  timeoutMs?: unknown;
  pollIntervalMs?: unknown;
  maxProgressLines?: number;
}

export interface AwaitedJobSnapshot extends SingleJobSnapshot {
  waitTimedOut: boolean;
  timeoutMs: number;
}

export async function waitForSingleJobSnapshot(
  cwd: string,
  reference: string,
  options: WaitForSingleJobOptions = {},
): Promise<AwaitedJobSnapshot> {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(
    100,
    Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS,
  );
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference, {
    maxProgressLines: options.maxProgressLines,
  });

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference, {
      maxProgressLines: options.maxProgressLines,
    });
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs,
  };
}

export interface ResolveLatestTaskThreadOptions {
  excludeJobId?: string | null;
}

export async function resolveLatestTrackedTaskThread(
  cwd: string,
  options: ResolveLatestTaskThreadOptions = {},
): Promise<{ id: string } | null> {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter(
    (job) => job.id !== options.excludeJobId,
  );
  const visibleJobs = filterJobsForCurrentSession(jobs);
  const activeTask = visibleJobs.find(
    (job) => job.jobClass === 'task' && (job.status === 'queued' || job.status === 'running'),
  );
  if (activeTask) {
    throw new Error(
      `Task ${activeTask.id} is still running. Use /stereo:status before continuing it.`,
    );
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    // findLatestResumableTaskJob only matches jobs with a truthy threadId.
    return { id: trackedTask.threadId as string };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
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
}: {
  prompt?: string | null;
  resumeLast?: boolean;
}): TaskRunMetadata {
  if (!resumeLast && String(prompt ?? '').includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: 'Codex Stop Gate Review',
      summary: 'Stop-gate review of previous Claude turn',
    };
  }

  const title = resumeLast ? 'Codex Resume' : 'Codex Task';
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : 'Task';
  return {
    title,
    summary: shorten(prompt || fallbackSummary),
  };
}

export interface TaskRunRequest {
  cwd: string;
  model?: string | null;
  effort?: string | null;
  prompt?: string;
  write?: boolean;
  resumeLast?: boolean;
  threadId?: string | null;
  jobId?: string | null;
  onProgress?: ProgressReporter | null;
}

export async function executeTaskRun(request: TaskRunRequest): Promise<CompanionExecution> {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast,
  });

  let resumeThreadId = request.threadId ?? null;
  if (!resumeThreadId && request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId,
    });
    if (!latestThread) {
      throw new Error('No previous Codex task thread was found for this repository.');
    }
    resumeThreadId = latestThread.id;
  }

  requireTaskRequest(request.prompt, Boolean(resumeThreadId));

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : '',
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? 'workspace-write' : 'read-only',
    onProgress: request.onProgress,
    jobId: request.jobId ?? null,
    jobPid: process.pid,
    persistThread: true,
    threadName: resumeThreadId
      ? null
      : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT),
  });

  const rawOutput = typeof result.finalMessage === 'string' ? result.finalMessage : '';
  const failureMessage =
    (result.error as { message?: string } | null | undefined)?.message ?? result.stderr ?? '';
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary,
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write),
      touchedFiles: result.touchedFiles,
    },
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
    payload,
    rendered,
    summary: firstMeaningfulLine(
      rawOutput,
      firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`),
    ),
    jobTitle: taskMetadata.title,
    jobClass: 'task',
    write: Boolean(request.write),
  };
}

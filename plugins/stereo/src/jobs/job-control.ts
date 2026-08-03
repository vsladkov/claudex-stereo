import fs from 'node:fs';
import process from 'node:process';

import { processHasExited } from '../platform/process.ts';
import {
  getSessionRuntimeStatus,
  listStrandedThreadReservations,
  looksLikeVerificationCommand,
} from '../runtime/index.ts';
import type { SessionRuntimeStatus, StrandedReservationEntry } from '../runtime/index.ts';
import {
  getConfig,
  listJobs,
  MAX_JOBS,
  readJobFile,
  readStoredJobOrNull,
  resolveJobFile,
  TERMINAL_JOB_STATUSES,
  upsertJob,
} from '../workspace/state.ts';
import type { JobRecord, StereoConfig } from '../workspace/state.ts';
import { modelProviderFor } from '../models/registry.ts';
import { optionalString, recordLike } from '../shared/json.ts';
import { SESSION_ID_ENV } from './tracked-jobs.ts';
import { resolveWorkspaceRoot } from '../workspace/workspace.ts';

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
export const VERBOSE_MAX_PROGRESS_LINES = 20;

export interface SessionFilterOptions {
  sessionId?: string | null;
  env?: NodeJS.ProcessEnv | null;
  workspaceRoot?: string;
}

export interface EnrichJobOptions {
  maxProgressLines?: number;
  workspaceRoot?: string;
}

export interface StatusSnapshotOptions extends SessionFilterOptions, EnrichJobOptions {
  all?: unknown;
  maxJobs?: number;
}

function jobWorkspaceRoot(cwd: string, options: { workspaceRoot?: string } = {}): string {
  return options.workspaceRoot ?? resolveWorkspaceRoot(cwd);
}

export interface UsageTotals {
  jobs: number;
  jobsWithUsage: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface UsageGroup extends UsageTotals {
  key: string;
}

export interface UsageSnapshot {
  workspaceRoot: string;
  scope: 'session' | 'workspace';
  sessionId: string | null;
  window: {
    retainedJobs: number;
    countedJobs: number;
    maxRetainedJobs: number;
  };
  totals: UsageTotals;
  byKind: UsageGroup[];
  byModel: UsageGroup[];
}

// A job as presented by status/result surfaces: the raw record plus the
// display fields computed on read.
export interface EnrichedJob extends JobRecord {
  kindLabel: string;
  progressPreview: string[];
  elapsed: string | null;
  duration: string | null;
  phase: string;
  model: string | null;
  modelDisplay: string;
}

export interface JobModelLike {
  model?: unknown;
  request?: unknown;
  result?: unknown;
}

export function resolveJobModel(
  job: JobModelLike | null | undefined,
  storedJob: JobModelLike | null | undefined = null,
): string | null {
  const direct = optionalString(job?.model) ?? optionalString(storedJob?.model);
  if (direct) {
    return direct;
  }

  const request = recordLike(storedJob?.request);
  const result = recordLike(storedJob?.result);
  return optionalString(request?.model) ?? optionalString(result?.model);
}

export function formatJobModel(model: unknown): string {
  const normalized = optionalString(model);
  if (!normalized) {
    return '-';
  }
  const provider = modelProviderFor(normalized);
  return provider ? `${normalized}@${provider}` : normalized;
}

export interface StatusSnapshot {
  workspaceRoot: string;
  config: StereoConfig;
  sessionRuntime: SessionRuntimeStatus;
  strandedReservations: StrandedReservationEntry[];
  running: EnrichedJob[];
  latestFinished: EnrichedJob | null;
  recent: EnrichedJob[];
  needsReview: boolean;
}

export interface SingleJobSnapshot {
  workspaceRoot: string;
  strandedReservations: StrandedReservationEntry[];
  job: EnrichedJob;
  // Populated only by the status --wait polling wrapper.
  waitTimedOut?: boolean;
  timeoutMs?: number | null;
}

export function sortJobsNewestFirst(jobs: JobRecord[]): JobRecord[] {
  return [...jobs].sort((left, right) =>
    String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')),
  );
}

function getCurrentSessionId(options: SessionFilterOptions = {}): string | null {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

export function filterJobsForCurrentSession(
  jobs: JobRecord[],
  options: SessionFilterOptions = {},
): JobRecord[] {
  const sessionId = options.sessionId ?? getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function emptyUsageTotals(): UsageTotals {
  return {
    jobs: 0,
    jobsWithUsage: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function finiteNonnegativeUsageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addUsage(totals: UsageTotals, usage: Record<string, unknown> | null): void {
  totals.jobs += 1;
  if (!usage) {
    return;
  }
  totals.jobsWithUsage += 1;
  totals.inputTokens += finiteNonnegativeUsageNumber(usage.inputTokens);
  totals.cachedInputTokens += finiteNonnegativeUsageNumber(usage.cachedInputTokens);
  totals.outputTokens += finiteNonnegativeUsageNumber(usage.outputTokens);
  totals.reasoningOutputTokens += finiteNonnegativeUsageNumber(usage.reasoningOutputTokens);
  totals.totalTokens += finiteNonnegativeUsageNumber(usage.totalTokens);
}

function usageGroup(groups: Map<string, UsageGroup>, key: string): UsageGroup {
  const existing = groups.get(key);
  if (existing) {
    return existing;
  }
  const created = { key, ...emptyUsageTotals() };
  groups.set(key, created);
  return created;
}

function sortedUsageGroups(groups: Map<string, UsageGroup>): UsageGroup[] {
  return [...groups.values()].sort(
    (left, right) => right.totalTokens - left.totalTokens || left.key.localeCompare(right.key),
  );
}

export function buildUsageSnapshot(
  cwd: string,
  options: StatusSnapshotOptions = {},
): UsageSnapshot {
  const workspaceRoot = jobWorkspaceRoot(cwd, options);
  const retained = listJobs(workspaceRoot);
  const retainedJobs = retained.length;
  const sessionId = options.sessionId ?? getCurrentSessionId(options);
  const scope = options.all || !sessionId ? 'workspace' : 'session';
  const jobs = options.all ? retained : filterJobsForCurrentSession(retained, options);
  const totals = emptyUsageTotals();
  const byKind = new Map<string, UsageGroup>();
  const byModel = new Map<string, UsageGroup>();

  for (const job of jobs) {
    let storedJob: JobRecord | null = null;
    if (!job.tokenUsage || !resolveJobModel(job)) {
      // Older or degraded bookkeeping may leave a missing/corrupt job file.
      // Usage reporting remains a best-effort read of the retained index.
      storedJob = readStoredJobOrNull(workspaceRoot, job.id);
    }
    const tokenUsage = recordLike(job.tokenUsage) ?? recordLike(storedJob?.tokenUsage);
    const jobUsage = recordLike(tokenUsage?.job);
    const kind = getJobTypeLabel(job);
    const model = formatJobModel(resolveJobModel(job, storedJob));
    addUsage(totals, jobUsage);
    addUsage(usageGroup(byKind, kind), jobUsage);
    addUsage(usageGroup(byModel, model), jobUsage);
  }

  return {
    workspaceRoot,
    scope,
    sessionId,
    window: {
      retainedJobs,
      countedJobs: jobs.length,
      maxRetainedJobs: MAX_JOBS,
    },
    totals,
    byKind: sortedUsageGroups(byKind),
    byModel: sortedUsageGroups(byModel),
  };
}

export function getJobTypeLabel(job: JobRecord): string {
  if (typeof job.kindLabel === 'string' && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === 'adversarial-review') {
    return 'adversarial-review';
  }
  if (job.kind === 'plan-review') {
    return 'plan-review';
  }
  if (job.jobClass === 'review') {
    return 'review';
  }
  if (job.jobClass === 'task') {
    return 'rescue';
  }
  if (job.kind === 'review') {
    return 'review';
  }
  if (job.kind === 'task') {
    return 'rescue';
  }
  return 'job';
}

function stripLogPrefix(line: string): string {
  return line.replace(/^\[[^\]]+\]\s*/, '').trim();
}

function isProgressBlockTitle(line: string): boolean {
  return (
    ['Final output', 'Assistant message', 'Reasoning summary', 'Review output'].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

const PROGRESS_PREVIEW_TAIL_BYTES = 64 * 1024;

function readLogTail(logFile: string): string {
  const size = fs.statSync(logFile).size;
  if (size <= PROGRESS_PREVIEW_TAIL_BYTES) {
    return fs.readFileSync(logFile, 'utf8');
  }

  const fd = fs.openSync(logFile, 'r');
  try {
    const buffer = Buffer.alloc(PROGRESS_PREVIEW_TAIL_BYTES);
    const bytesRead = fs.readSync(
      fd,
      buffer,
      0,
      PROGRESS_PREVIEW_TAIL_BYTES,
      size - PROGRESS_PREVIEW_TAIL_BYTES,
    );
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    // Drop the leading partial line (and any partial multi-byte character in it).
    const firstNewline = text.indexOf('\n');
    return firstNewline === -1 ? text : text.slice(firstNewline + 1);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJobProgressPreview(
  logFile: string | null | undefined,
  maxLines = DEFAULT_MAX_PROGRESS_LINES,
): string[] {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = readLogTail(logFile)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith('['))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

export function formatElapsedDuration(
  startValue: string | null | undefined,
  endValue: string | null | undefined = null,
): string | null {
  const start = Date.parse(startValue ?? '');
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function inferLegacyJobPhase(job: JobRecord, progressPreview: string[] = []): string {
  switch (job.status) {
    case 'queued':
      return 'queued';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'completed':
      return 'done';
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = (progressPreview[index] ?? '').toLowerCase();
    if (
      line.startsWith('starting codex') ||
      line.startsWith('thread ready') ||
      line.startsWith('turn started')
    ) {
      return 'starting';
    }
    if (line.startsWith('reviewer started') || line.includes('review mode')) {
      return 'reviewing';
    }
    if (
      line.startsWith('searching:') ||
      line.startsWith('calling ') ||
      line.startsWith('running tool:')
    ) {
      return 'investigating';
    }
    if (line.startsWith('starting collaboration tool:')) {
      return 'investigating';
    }
    if (line.startsWith('running command:')) {
      return looksLikeVerificationCommand(line)
        ? 'verifying'
        : job.jobClass === 'review'
          ? 'reviewing'
          : 'investigating';
    }
    if (line.startsWith('command completed:')) {
      return looksLikeVerificationCommand(line) ? 'verifying' : 'running';
    }
    if (line.startsWith('applying ') || line.startsWith('file changes ')) {
      return 'editing';
    }
    if (line.startsWith('turn completed')) {
      return 'finalizing';
    }
    if (line.startsWith('codex error:') || line.startsWith('failed:')) {
      return 'failed';
    }
  }

  return job.jobClass === 'review' ? 'reviewing' : 'running';
}

function isJobProcessGone(job: JobRecord): boolean {
  // Windows process probing remains intentionally disabled for job status.
  if (process.platform === 'win32') {
    return false;
  }
  if (job.status !== 'queued' && job.status !== 'running') {
    return false;
  }
  const pid = job.pid;
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  return processHasExited(pid);
}

export function enrichJob(job: JobRecord, options: EnrichJobOptions = {}): EnrichedJob {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  let storedJob: JobRecord | null = null;
  if (!resolveJobModel(job) && options.workspaceRoot) {
    // Job files are written by another process and may be absent or
    // temporarily incomplete. Model visibility is advisory.
    storedJob = readStoredJobOrNull(options.workspaceRoot, job.id);
  }
  const model = resolveJobModel(job, storedJob);
  const enriched = {
    ...job,
    model,
    modelDisplay: formatJobModel(model),
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === 'queued' || job.status === 'running' || job.status === 'failed'
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration: TERMINAL_JOB_STATUSES.has(job.status)
      ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
      : null,
  };

  return {
    ...enriched,
    phase: isJobProcessGone(enriched)
      ? 'stalled'
      : (enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)),
  };
}

export function readStoredJob(workspaceRoot: string, jobId: string): JobRecord | null {
  // Parse errors intentionally reach CLI cancel and status/result so they can
  // render user-visible warnings, and CLI task-worker so it can record a
  // detached-worker bootstrap failure.
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

interface MatchJobReferenceOptions {
  optional?: boolean;
}

function matchJobReference(
  jobs: JobRecord[],
  reference: string,
  predicate: (job: JobRecord) => boolean = () => true,
  options: MatchJobReferenceOptions = {},
): JobRecord | null {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0] ?? null;
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  if (options.optional) {
    return null;
  }
  throw new Error(`No job found for "${reference}". Run /stereo:status to list known jobs.`);
}

export function buildStatusSnapshot(
  cwd: string,
  options: StatusSnapshotOptions = {},
): StatusSnapshot {
  const workspaceRoot = jobWorkspaceRoot(cwd, options);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === 'queued' || job.status === 'running')
    .map((job) => enrichJob(job, { maxProgressLines, workspaceRoot }));

  const latestFinishedRaw =
    jobs.find((job) => job.status !== 'queued' && job.status !== 'running') ?? null;
  const latestFinished = latestFinishedRaw
    ? enrichJob(latestFinishedRaw, { maxProgressLines, workspaceRoot })
    : null;

  const finishedPastLatest = jobs.filter(
    (job) => job.status !== 'queued' && job.status !== 'running' && job.id !== latestFinished?.id,
  );
  const recent = (options.all ? finishedPastLatest : finishedPastLatest.slice(0, maxJobs)).map(
    (job) => enrichJob(job, { maxProgressLines, workspaceRoot }),
  );

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    strandedReservations: listStrandedThreadReservations(),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate),
  };
}

export function buildSingleJobSnapshot(
  cwd: string,
  reference: string,
  options: EnrichJobOptions = {},
): SingleJobSnapshot {
  const workspaceRoot = jobWorkspaceRoot(cwd, options);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference, () => true, { optional: true });
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /stereo:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    strandedReservations: listStrandedThreadReservations(),
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines, workspaceRoot }),
  };
}

export function resolveResultJob(
  cwd: string,
  reference: string,
  options: { workspaceRoot?: string } = {},
): { workspaceRoot: string; job: JobRecord } {
  const workspaceRoot = jobWorkspaceRoot(cwd, options);
  const jobs = sortJobsNewestFirst(
    reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)),
  );
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => TERMINAL_JOB_STATUSES.has(job.status),
    { optional: true },
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(
    jobs,
    reference,
    (job) => job.status === 'queued' || job.status === 'running',
    {
      optional: true,
    },
  );
  if (active) {
    // A missing or corrupt per-job file preserves the existing active-job error.
    const stored = readStoredJobOrNull(workspaceRoot, active.id);
    if (stored && TERMINAL_JOB_STATUSES.has(stored.status)) {
      const repairedFields = {
        id: stored.id,
        status: stored.status,
        phase: stored.phase,
        pid: null,
        errorMessage: stored.errorMessage,
        completedAt: stored.completedAt,
      };
      upsertJob(workspaceRoot, repairedFields);
      return { workspaceRoot, job: { ...active, ...repairedFields } };
    }
    throw new Error(
      `Job ${active.id} is still ${active.status}. Check /stereo:status and try again once it finishes.`,
    );
  }

  if (reference) {
    throw new Error(
      `No finished job found for "${reference}". Run /stereo:status to inspect active jobs.`,
    );
  }

  throw new Error('No finished Codex jobs found for this repository yet.');
}

export function resolveCancelableJob(
  cwd: string,
  reference: string,
  options: SessionFilterOptions = {},
): { workspaceRoot: string; job: JobRecord } {
  const workspaceRoot = jobWorkspaceRoot(cwd, options);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'running');

  if (reference) {
    const selected = matchJobReference(activeJobs, reference, () => true, { optional: true });
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  const [onlyActiveJob] = sessionScopedActiveJobs;
  if (sessionScopedActiveJobs.length === 1 && onlyActiveJob) {
    return { workspaceRoot, job: onlyActiveJob };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error('Multiple Codex jobs are active. Pass a job id to /stereo:cancel.');
  }

  if (getCurrentSessionId(options)) {
    throw new Error('No active Codex jobs to cancel for this session.');
  }

  throw new Error('No active Codex jobs to cancel.');
}

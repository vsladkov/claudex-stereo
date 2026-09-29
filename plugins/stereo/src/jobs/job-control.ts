import fs from 'node:fs';
import process from 'node:process';

import { recordedProcessGone } from '../platform/process.ts';
import { getSessionRuntimeStatus } from '../runtime/availability.ts';
import type { SessionRuntimeStatus } from '../runtime/availability.ts';
import { listStrandedThreadReservations } from '../runtime/reservations.ts';
import type { StrandedReservationEntry } from '../runtime/reservations.ts';
import { looksLikeVerificationCommand } from '../runtime/turn-capture.ts';
import {
  getConfig,
  isActiveJob,
  isTerminalJob,
  listJobs,
  MAX_JOBS,
  readJobFile,
  readStoredJobOrNull,
  resolveJobFile,
  STOP_GATE_ORIGIN,
  TERMINAL_JOB_STATUSES,
} from '../workspace/state.ts';
import type { JobRecord, StereoConfig } from '../workspace/state.ts';
import { modelProviderFor } from '../models/registry.ts';
import { optionalString, recordLike } from '../shared/json.ts';
import { sleep } from '../shared/text.ts';
import { settleJob, withTerminalFields } from './job-lifecycle.ts';
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

export interface SingleJobSnapshotOptions extends EnrichJobOptions {
  /** Scan for stranded reservations (true by default; the one-line --brief answer shows none). */
  strandedReservations?: boolean;
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

// The label a job shows in status, usage, and announcements: a review kind
// by name, a task by the pair role it ran (a role-less task is a rescue,
// unless the Stop hook launched it).
export function jobKindLabel(
  kind: string | null | undefined,
  jobClass: string | null | undefined,
  role: string | null | undefined,
  origin: string | null | undefined = null,
): string {
  if (kind === 'adversarial-review' || kind === 'plan-review') {
    return kind;
  }
  if (jobClass === 'review' || kind === 'review') {
    return 'review';
  }
  if (jobClass === 'task' || kind === 'task') {
    if (typeof role === 'string' && role) {
      return role;
    }
    return origin === STOP_GATE_ORIGIN ? STOP_GATE_ORIGIN : 'rescue';
  }
  return 'job';
}

export function getJobTypeLabel(job: JobRecord): string {
  if (typeof job.kindLabel === 'string' && job.kindLabel) {
    return job.kindLabel;
  }
  return jobKindLabel(job.kind, job.jobClass, job.role, job.origin);
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
  if (!logFile || maxLines <= 0 || !fs.existsSync(logFile)) {
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

/** The one-line answer of `status <jobId> --brief`, as its `--json` form. */
export interface BriefJobStatus {
  jobId: string;
  status: string;
  phase: string;
  elapsedSeconds: number;
}

// Elapsed whole seconds from the job's start (or creation) to its end: its
// completion, the last update of a finished job with no completion time, or
// now for an active job. An unparsable start counts as 0.
export function buildBriefJobStatus(job: EnrichedJob, now: number = Date.now()): BriefJobStatus {
  const start = Date.parse(job.startedAt ?? job.createdAt ?? '');
  const endValue =
    job.completedAt ?? (TERMINAL_JOB_STATUSES.has(job.status) ? job.updatedAt : null);
  const end = endValue ? Date.parse(endValue) : now;
  const elapsedSeconds =
    Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? Math.round((end - start) / 1000)
      : 0;
  return { jobId: job.id, status: job.status, phase: job.phase, elapsedSeconds };
}

export function renderBriefJobStatus(brief: BriefJobStatus): string {
  return `${brief.status} ${brief.phase} ${brief.elapsedSeconds}s\n`;
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

// An active job whose worker no longer runs (recordedProcessGone: the cheap
// check doctor shares, with no ps or PowerShell probe on a status poll).
function isJobProcessGone(job: JobRecord): boolean {
  return isActiveJob(job) && recordedProcessGone(job.pid, job.pidStart);
}

// A worker that settled its job and exited between the index read and the
// worker check looks gone: the job is read once more (its index row, then
// its job file), and the terminal record found there is what it reports.
// Null when the job is still active on both.
function settledSinceRead(workspaceRoot: string, job: JobRecord): JobRecord | null {
  const row = listJobs(workspaceRoot).find((candidate) => candidate.id === job.id) ?? null;
  if (row && isTerminalJob(row)) {
    return row;
  }
  const stored = readStoredJobOrNull(workspaceRoot, job.id);
  return stored && isTerminalJob(stored) ? withTerminalFields(row ?? job, stored) : null;
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
      isActiveJob(job) || job.status === 'failed'
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration: TERMINAL_JOB_STATUSES.has(job.status)
      ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
      : null,
  };

  const gone = isJobProcessGone(enriched);
  if (gone && options.workspaceRoot) {
    const settled = settledSinceRead(options.workspaceRoot, job);
    if (settled) {
      return enrichJob(settled, options);
    }
  }
  return {
    ...enriched,
    phase: gone
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
  // --all widens the listing to every session's jobs and lifts the cap, so a
  // resumed session can see the work an earlier session left running.
  const retained = listJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(
    options.all ? retained : filterJobsForCurrentSession(retained, options),
  );
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => isActiveJob(job))
    .map((job) => enrichJob(job, { maxProgressLines, workspaceRoot }));

  const latestFinishedRaw = jobs.find((job) => !isActiveJob(job)) ?? null;
  const latestFinished = latestFinishedRaw
    ? enrichJob(latestFinishedRaw, { maxProgressLines, workspaceRoot })
    : null;

  const finishedPastLatest = jobs.filter(
    (job) => !isActiveJob(job) && job.id !== latestFinished?.id,
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
  options: SingleJobSnapshotOptions = {},
): SingleJobSnapshot {
  const workspaceRoot = jobWorkspaceRoot(cwd, options);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference, () => true, { optional: true });
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /stereo:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    strandedReservations:
      options.strandedReservations === false ? [] : listStrandedThreadReservations(),
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines, workspaceRoot }),
  };
}

const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const MIN_STATUS_POLL_INTERVAL_MS = 100;

// A wait option as given, 0 included; the default when it is absent or not a number.
function waitOptionMs(value: unknown, fallback: number): number {
  const parsed = value === undefined || value === null || value === '' ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface WaitForJobOptions extends SingleJobSnapshotOptions {
  timeoutMs?: unknown;
  pollIntervalMs?: unknown;
}

export interface AwaitedJobSnapshot extends SingleJobSnapshot {
  waitTimedOut: boolean;
  timeoutMs: number;
}

// `status <job> --wait`: polls the job until it is terminal, its worker is
// gone (phase `stalled`: nothing but a cancel will settle it, so waiting
// longer only burns the window), or the window ends. A poll is the light
// check: the job's index row, and the cheap worker check (isJobProcessGone);
// the display fields (the log preview, a settled record behind a gone
// worker) and the stranded reservation scan (not at all for --brief) come
// once, after the loop.
export async function waitForJobSnapshot(
  cwd: string,
  reference: string,
  options: WaitForJobOptions = {},
): Promise<AwaitedJobSnapshot> {
  // A 0 timeout answers at once; a poll interval is at least a small minimum.
  const timeoutMs = Math.max(0, waitOptionMs(options.timeoutMs, DEFAULT_STATUS_WAIT_TIMEOUT_MS));
  const pollIntervalMs = Math.max(
    MIN_STATUS_POLL_INTERVAL_MS,
    waitOptionMs(options.pollIntervalMs, DEFAULT_STATUS_POLL_INTERVAL_MS),
  );
  const deadline = Date.now() + timeoutMs;
  const workspaceRoot = jobWorkspaceRoot(cwd, options);
  const polled = (job: JobRecord | null): boolean =>
    job !== null && isActiveJob(job) && !isJobProcessGone(job);
  let row = matchJobReference(sortJobsNewestFirst(listJobs(workspaceRoot)), reference, () => true, {
    optional: true,
  });
  while (polled(row) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    const id = row?.id;
    row = listJobs(workspaceRoot).find((candidate) => candidate.id === id) ?? null;
  }
  const snapshot = buildSingleJobSnapshot(cwd, reference, options);
  return {
    ...snapshot,
    waitTimedOut: isActiveJob(snapshot.job) && snapshot.job.phase !== 'stalled',
    timeoutMs,
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

  const active = matchJobReference(jobs, reference, isActiveJob, { optional: true });
  if (active) {
    // A missing or corrupt per-job file preserves the existing active-job error.
    const stored = readStoredJobOrNull(workspaceRoot, active.id);
    if (stored && TERMINAL_JOB_STATUSES.has(stored.status)) {
      // The job file settled but its index row did not (a lost index
      // write): settleJob brings the row in line under the index lock, and
      // a row that settled meanwhile (a cancel) keeps its own outcome.
      const settled = settleJob(workspaceRoot, active.id, {
        terminal: { status: stored.status },
      });
      return {
        workspaceRoot,
        job: withTerminalFields(active, { ...(settled.record ?? stored), status: settled.status }),
      };
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

  throw new Error('No finished companion jobs found for this repository yet.');
}

export function resolveCancelableJob(
  cwd: string,
  reference: string,
  options: SessionFilterOptions = {},
): { workspaceRoot: string; job: JobRecord } {
  const workspaceRoot = jobWorkspaceRoot(cwd, options);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => isActiveJob(job));

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
    throw new Error('Multiple companion jobs are active. Pass a job id to /stereo:cancel.');
  }

  if (getCurrentSessionId(options)) {
    throw new Error('No active companion jobs to cancel for this session.');
  }

  throw new Error('No active companion jobs to cancel.');
}

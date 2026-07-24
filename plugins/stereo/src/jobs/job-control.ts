import fs from "node:fs";
import process from "node:process";

import {
  getSessionRuntimeStatus,
  listStrandedThreadReservations,
  looksLikeVerificationCommand
} from "../runtime/index.ts";
import type { SessionRuntimeStatus, StrandedReservationEntry } from "../runtime/index.ts";
import { getConfig, listJobs, readJobFile, resolveJobFile } from "../workspace/state.ts";
import type { JobRecord, StereoConfig } from "../workspace/state.ts";
import { SESSION_ID_ENV } from "./tracked-jobs.ts";
import { resolveWorkspaceRoot } from "../workspace/workspace.ts";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
export const VERBOSE_MAX_PROGRESS_LINES = 20;

export interface SessionFilterOptions {
  sessionId?: string | null;
  env?: NodeJS.ProcessEnv | null;
}

export interface EnrichJobOptions {
  maxProgressLines?: number;
}

export interface StatusSnapshotOptions extends SessionFilterOptions, EnrichJobOptions {
  all?: unknown;
  maxJobs?: number;
}

// A job as presented by status/result surfaces: the raw record plus the
// display fields computed on read.
export interface EnrichedJob extends JobRecord {
  kindLabel: string;
  progressPreview: string[];
  elapsed: string | null;
  duration: string | null;
  phase: string;
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
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options: SessionFilterOptions = {}): string | null {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

export function filterJobsForCurrentSession(jobs: JobRecord[], options: SessionFilterOptions = {}): JobRecord[] {
  const sessionId = options.sessionId ?? getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job: JobRecord): string {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.kind === "plan-review") {
    return "plan-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line: string): string {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line: string): boolean {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

const PROGRESS_PREVIEW_TAIL_BYTES = 64 * 1024;

function readLogTail(logFile: string): string {
  const size = fs.statSync(logFile).size;
  if (size <= PROGRESS_PREVIEW_TAIL_BYTES) {
    return fs.readFileSync(logFile, "utf8");
  }

  const fd = fs.openSync(logFile, "r");
  try {
    const buffer = Buffer.alloc(PROGRESS_PREVIEW_TAIL_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, PROGRESS_PREVIEW_TAIL_BYTES, size - PROGRESS_PREVIEW_TAIL_BYTES);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // Drop the leading partial line (and any partial multi-byte character in it).
    const firstNewline = text.indexOf("\n");
    return firstNewline === -1 ? text : text.slice(firstNewline + 1);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJobProgressPreview(logFile: string | null | undefined, maxLines = DEFAULT_MAX_PROGRESS_LINES): string[] {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = readLogTail(logFile)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue: string | null | undefined, endValue: string | null | undefined = null): string | null {
  const start = Date.parse(startValue ?? "");
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
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = (progressPreview[index] ?? "").toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

function isJobProcessGone(job: JobRecord): boolean {
  if (process.platform === "win32") {
    return false;
  }
  if (job.status !== "queued" && job.status !== "running") {
    return false;
  }
  const pid = job.pid;
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means the process exists but belongs to another user: alive.
    return (error as NodeJS.ErrnoException | null | undefined)?.code === "ESRCH";
  }
}

export function enrichJob(job: JobRecord, options: EnrichJobOptions = {}): EnrichedJob {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: isJobProcessGone(enriched)
      ? "stalled"
      : enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot: string, jobId: string): JobRecord | null {
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
  options: MatchJobReferenceOptions = {}
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

export function buildStatusSnapshot(cwd: string, options: StatusSnapshotOptions = {}): StatusSnapshot {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const finishedPastLatest = jobs.filter(
    (job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id
  );
  const recent = (options.all ? finishedPastLatest : finishedPastLatest.slice(0, maxJobs)).map((job) =>
    enrichJob(job, { maxProgressLines })
  );

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    strandedReservations: listStrandedThreadReservations(),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd: string, reference: string, options: EnrichJobOptions = {}): SingleJobSnapshot {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference, () => true, { optional: true });
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /stereo:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    strandedReservations: listStrandedThreadReservations(),
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd: string, reference: string): { workspaceRoot: string; job: JobRecord } {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled",
    { optional: true }
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running", {
    optional: true
  });
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /stereo:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /stereo:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd: string, reference: string, options: SessionFilterOptions = {}): { workspaceRoot: string; job: JobRecord } {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

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
    throw new Error("Multiple Codex jobs are active. Pass a job id to /stereo:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}

import { formatElapsedDuration, getJobTypeLabel, sortJobsNewestFirst } from './job-control.ts';
import type { JobRecord } from '../workspace/state.ts';

export interface SessionJobAnnouncement {
  active: Array<{ id: string; kind: string; elapsed: string | null; status: string }>;
  finished: Array<{ id: string; kind: string; status: string; duration: string | null }>;
  activeOverflow: number;
  finishedOverflow: number;
  nextWatermark: string | null;
  workspaceRoot?: string;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parsedTerminalTimestamp(job: JobRecord): number | null {
  return parseTimestamp(job.completedAt ?? job.updatedAt);
}

function timestampString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function buildSessionJobAnnouncement(
  jobs: JobRecord[],
  options: { watermark?: string | null; now?: number; maxEntries?: number },
): SessionJobAnnouncement | null {
  const requestedNow = options.now ?? Date.now();
  const now = Number.isFinite(requestedNow) ? requestedNow : Date.now();
  const requestedMaxEntries = options.maxEntries ?? 5;
  const maxEntries = Number.isFinite(requestedMaxEntries)
    ? Math.max(1, Math.floor(requestedMaxEntries))
    : 5;
  const parsedWatermark = parseTimestamp(options.watermark);
  const hasWatermark = parsedWatermark !== null;
  const sortedJobs = sortJobsNewestFirst(Array.isArray(jobs) ? jobs : []);

  const allActive = sortedJobs
    .filter((job) => job.status === 'queued' || job.status === 'running')
    .map((job) => ({
      id: job.id,
      kind: getJobTypeLabel(job),
      elapsed: formatElapsedDuration(
        timestampString(job.startedAt ?? job.createdAt),
        new Date(now).toISOString(),
      ),
      status: job.status,
    }));

  const terminalJobs = hasWatermark
    ? sortedJobs
        .filter(
          (job) =>
            job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled',
        )
        .map((job) => ({ job, timestamp: parsedTerminalTimestamp(job) }))
        .filter(
          (entry): entry is { job: JobRecord; timestamp: number } =>
            entry.timestamp !== null && entry.timestamp > (parsedWatermark as number),
        )
        .sort((left, right) => right.timestamp - left.timestamp)
    : [];
  const allFinished = terminalJobs.map(({ job }) => ({
    id: job.id,
    kind: getJobTypeLabel(job),
    status: job.status,
    duration: formatElapsedDuration(
      timestampString(job.startedAt ?? job.createdAt),
      timestampString(job.completedAt ?? job.updatedAt),
    ),
  }));

  const active = allActive.slice(0, maxEntries);
  const finished = allFinished.slice(0, maxEntries);
  const activeOverflow = Math.max(0, allActive.length - active.length);
  const finishedOverflow = Math.max(0, allFinished.length - finished.length);
  let nextWatermark: string | null = null;
  if (!hasWatermark) {
    nextWatermark = new Date(now).toISOString();
  } else if (terminalJobs.length > 0) {
    nextWatermark = new Date(
      Math.max(...terminalJobs.map((entry) => entry.timestamp)),
    ).toISOString();
  }

  if (active.length === 0 && finished.length === 0 && nextWatermark === null) {
    return null;
  }

  return {
    active,
    finished,
    activeOverflow,
    finishedOverflow,
    nextWatermark,
  };
}

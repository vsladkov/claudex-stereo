import {
  buildBriefJobStatus,
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  buildUsageSnapshot,
  readStoredJob,
  renderBriefJobStatus,
  resolveResultJob,
  VERBOSE_MAX_PROGRESS_LINES,
  waitForJobSnapshot,
} from '../../jobs/job-control.ts';
import type { StatusSnapshot } from '../../jobs/job-control.ts';
import type { JobRecord } from '../../workspace/state.ts';
import {
  extractStoredJobReport,
  renderJobStatusReport,
  renderStatusReport,
  renderStoredJobReport,
  renderStoredJobResult,
  renderUsageReport,
} from '../../render/render.ts';
import type { StatusRenderOptions, StoredJobLike } from '../../render/render.ts';
import { resolveJobFile } from '../../workspace/state.ts';
import {
  outputCommandResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
} from '../io.ts';
import { outputResult } from '../../shared/text.ts';
import { errorMessage } from '../../shared/errors.ts';

function renderStatusPayload(
  report: StatusSnapshot,
  asJson: unknown,
  options: StatusRenderOptions = {},
): StatusSnapshot | string {
  return asJson ? report : renderStatusReport(report, options);
}

export async function handleStatus(argv: string[]): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd', 'workspace', 'timeout-ms', 'poll-interval-ms'],
    booleanOptions: ['json', 'all', 'wait', 'verbose', 'usage', 'brief'],
    aliasMap: {
      v: 'verbose',
    },
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = Object.hasOwn(options, 'workspace')
    ? resolveCommandWorkspace(options)
    : undefined;
  if (options.usage) {
    if (options.brief) {
      throw new Error('`status --usage` cannot be combined with --brief.');
    }
    if (positionals.length > 0) {
      throw new Error('`status --usage` does not take a job id.');
    }
    if (options.wait) {
      throw new Error('`status --usage` cannot be combined with --wait.');
    }
    const snapshot = buildUsageSnapshot(cwd, { all: options.all, workspaceRoot });
    outputResult(options.json ? snapshot : renderUsageReport(snapshot), options.json);
    return;
  }
  if (positionals.length > 1) {
    throw new Error(`status takes at most one job id; got ${positionals.length}.`);
  }
  const reference = positionals[0] ?? '';
  if (options.brief && !reference) {
    throw new Error('`status --brief` requires a job id.');
  }
  const verbose = Boolean(options.verbose);
  const maxProgressLines = verbose ? VERBOSE_MAX_PROGRESS_LINES : undefined;
  if (reference) {
    // The one-line --brief answer shows no stranded reservations and no log
    // preview: neither is read.
    const snapshotOptions = {
      maxProgressLines: options.brief ? 0 : maxProgressLines,
      workspaceRoot,
      strandedReservations: !options.brief,
    };
    const snapshot = options.wait
      ? await waitForJobSnapshot(cwd, reference, {
          ...snapshotOptions,
          timeoutMs: options['timeout-ms'],
          pollIntervalMs: options['poll-interval-ms'],
        })
      : buildSingleJobSnapshot(cwd, reference, snapshotOptions);
    if (options.brief) {
      // One line for a poll: `<status> <phase> <elapsedSeconds>s`, printed
      // once the job is terminal or the --wait window ends.
      const brief = buildBriefJobStatus(snapshot.job);
      outputCommandResult(brief, renderBriefJobStatus(brief), options.json);
      return;
    }
    outputCommandResult(
      snapshot,
      renderJobStatusReport(snapshot.job, {
        verbose,
        strandedReservations: snapshot.strandedReservations,
        waitTimedOut: snapshot.waitTimedOut ?? false,
        timeoutMs: snapshot.timeoutMs ?? null,
      }),
      options.json,
    );
    return;
  }

  if (options.wait) {
    throw new Error('`status --wait` requires a job id.');
  }

  const report = buildStatusSnapshot(cwd, { all: options.all, maxProgressLines, workspaceRoot });
  outputResult(renderStatusPayload(report, options.json, { verbose }), options.json);
}

export function handleResult(argv: string[]): void {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd', 'workspace'],
    booleanOptions: ['json', 'report'],
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = Object.hasOwn(options, 'workspace')
    ? resolveCommandWorkspace(options)
    : undefined;
  if (positionals.length > 1) {
    throw new Error(`result takes at most one job id; got ${positionals.length}.`);
  }
  const reference = positionals[0] ?? '';
  const resolved = resolveResultJob(cwd, reference, { workspaceRoot });
  const jobFile = resolveJobFile(resolved.workspaceRoot, resolved.job.id);
  const { job } = resolved;
  let storedJob: (JobRecord & StoredJobLike) | null;
  let storedJobWarning: string | null = null;
  try {
    storedJob = readStoredJob(resolved.workspaceRoot, job.id) as (JobRecord & StoredJobLike) | null;
  } catch (error) {
    storedJob = null;
    const message = errorMessage(error);
    storedJobWarning = `Stored result file is unreadable: ${jobFile} (${message}). Showing index data only.`;
  }
  if (options.report) {
    const report = extractStoredJobReport(storedJob, job.status);
    outputCommandResult(
      {
        jobId: job.id,
        status: job.status,
        report,
        threadId: storedJob?.threadId ?? job.threadId ?? null,
        tokenUsage: storedJob?.tokenUsage ?? job.tokenUsage ?? null,
        effort: appliedEffort(storedJob),
        ...runFacts(storedJob),
        ...(storedJobWarning ? { storedJobWarning } : {}),
      },
      renderStoredJobReport(job, storedJob, storedJobWarning),
      options.json,
    );
    return;
  }
  const payload = {
    job,
    storedJob: slimStoredJobForOutput(storedJob),
    ...(storedJobWarning ? { storedJobWarning } : {}),
  };

  outputCommandResult(
    payload,
    renderStoredJobResult(job, storedJob, storedJobWarning),
    options.json,
  );
}

// What the run's own payload recorded beside its report, when it did: the
// files it touched and how many app-server notifications its capture dropped.
function runFacts(storedJob: JobRecord | null): {
  touchedFiles?: string[];
  droppedNotifications?: number;
} {
  const result = storedJob?.result as
    { touchedFiles?: unknown; droppedNotifications?: unknown } | null | undefined;
  const touchedFiles = result?.touchedFiles;
  const dropped = result?.droppedNotifications;
  return {
    ...(Array.isArray(touchedFiles)
      ? { touchedFiles: touchedFiles.filter((file): file is string => typeof file === 'string') }
      : {}),
    ...(typeof dropped === 'number' && dropped > 0 ? { droppedNotifications: dropped } : {}),
  };
}

// The reasoning effort the run applied: the run's own payload records it,
// else (a review) the request a background job stored. Null when neither
// names one.
function appliedEffort(storedJob: JobRecord | null): string | null {
  const candidates = [
    (storedJob?.result as { effort?: unknown } | null | undefined)?.effort,
    (storedJob?.request as { effort?: unknown } | null | undefined)?.effort,
  ];
  const effort = candidates.find((value) => typeof value === 'string' && value.trim() !== '');
  return typeof effort === 'string' ? effort : null;
}

// The printed --json payload answers "what did the job produce", not "what
// does the persistence layer hold": the job file keeps the caller's own
// request and the pre-rendered report. Re-printing those copies costs the
// orchestrating model thousands of input tokens per fetch, so they are
// dropped here while the on-disk record stays complete.
function slimStoredJobForOutput(
  storedJob: (JobRecord & StoredJobLike) | null,
): (JobRecord & StoredJobLike) | null {
  if (!storedJob) {
    return storedJob;
  }
  const slimmed: JobRecord & StoredJobLike = { ...storedJob };
  delete (slimmed as Record<string, unknown>).request;
  delete (slimmed as Record<string, unknown>).rendered;
  return slimmed;
}

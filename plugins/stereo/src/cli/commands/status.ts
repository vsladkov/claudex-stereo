import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  buildUsageSnapshot,
  readStoredJob,
  resolveResultJob,
  VERBOSE_MAX_PROGRESS_LINES,
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
import { waitForSingleJobSnapshot } from '../../workflows/task.ts';
import {
  outputCommandResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
} from '../io.ts';
import { outputResult } from '../../shared/text.ts';

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
    booleanOptions: ['json', 'all', 'wait', 'verbose', 'usage'],
    aliasMap: {
      v: 'verbose',
    },
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = Object.hasOwn(options, 'workspace')
    ? resolveCommandWorkspace(options)
    : undefined;
  if (options.usage) {
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
  const reference = positionals[0] ?? '';
  const verbose = Boolean(options.verbose);
  const maxProgressLines = verbose ? VERBOSE_MAX_PROGRESS_LINES : undefined;
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options['timeout-ms'],
          pollIntervalMs: options['poll-interval-ms'],
          maxProgressLines,
          workspaceRoot,
        })
      : buildSingleJobSnapshot(cwd, reference, { maxProgressLines, workspaceRoot });
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
    const message = error instanceof Error ? error.message : String(error);
    storedJobWarning = `Stored result file is unreadable: ${jobFile} (${message}). Showing index data only.`;
  }
  if (options.report) {
    const report = extractStoredJobReport(storedJob);
    outputCommandResult(
      {
        jobId: job.id,
        status: job.status,
        report,
        threadId: storedJob?.threadId ?? job.threadId ?? null,
        tokenUsage: storedJob?.tokenUsage ?? job.tokenUsage ?? null,
        ...(storedJobWarning ? { storedJobWarning } : {}),
      },
      renderStoredJobReport(job, storedJob, storedJobWarning),
      options.json,
    );
    return;
  }
  const payload = {
    job,
    storedJob,
    ...(storedJobWarning ? { storedJobWarning } : {}),
  };

  outputCommandResult(
    payload,
    renderStoredJobResult(job, storedJob, storedJobWarning),
    options.json,
  );
}

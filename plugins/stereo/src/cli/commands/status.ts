import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveResultJob,
  VERBOSE_MAX_PROGRESS_LINES,
} from '../../jobs/job-control.ts';
import type { StatusSnapshot } from '../../jobs/job-control.ts';
import type { JobRecord } from '../../workspace/state.ts';
import {
  renderJobStatusReport,
  renderStatusReport,
  renderStoredJobResult,
} from '../../render/render.ts';
import type { StatusRenderOptions, StoredJobLike } from '../../render/render.ts';
import { resolveJobFile } from '../../workspace/state.ts';
import { waitForSingleJobSnapshot } from '../../workflows/task.ts';
import { outputCommandResult, parseCommandInput, resolveCommandCwd } from '../io.ts';
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
    valueOptions: ['cwd', 'timeout-ms', 'poll-interval-ms'],
    booleanOptions: ['json', 'all', 'wait', 'verbose'],
    aliasMap: {
      v: 'verbose',
    },
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? '';
  const verbose = Boolean(options.verbose);
  const maxProgressLines = verbose ? VERBOSE_MAX_PROGRESS_LINES : undefined;
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options['timeout-ms'],
          pollIntervalMs: options['poll-interval-ms'],
          maxProgressLines,
        })
      : buildSingleJobSnapshot(cwd, reference, { maxProgressLines });
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

  const report = buildStatusSnapshot(cwd, { all: options.all, maxProgressLines });
  outputResult(renderStatusPayload(report, options.json, { verbose }), options.json);
}

export function handleResult(argv: string[]): void {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json'],
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? '';
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const jobFile = resolveJobFile(workspaceRoot, job.id);
  let storedJob: (JobRecord & StoredJobLike) | null;
  let storedJobWarning: string | null = null;
  try {
    storedJob = readStoredJob(workspaceRoot, job.id) as (JobRecord & StoredJobLike) | null;
  } catch (error) {
    storedJob = null;
    const message = error instanceof Error ? error.message : String(error);
    storedJobWarning = `Stored result file is unreadable: ${jobFile} (${message}). Showing index data only.`;
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

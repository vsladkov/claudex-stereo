import process from 'node:process';

import {
  interruptAppServerTurn,
  releaseThreadReservationForCancelledJob,
} from '../../runtime/index.ts';
import { processHasExited, terminateProcessTree } from '../../platform/process.ts';
import { readStoredJob, resolveCancelableJob } from '../../jobs/job-control.ts';
import { appendLogLine } from '../../jobs/tracked-jobs.ts';
import { nowIso, resolveJobFile, upsertJob, writeJobFile } from '../../workspace/state.ts';
import type { JobRecord } from '../../workspace/state.ts';
import { renderCancelReport } from '../../render/render.ts';
import {
  outputCommandResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
} from '../io.ts';

export interface CancelDeps {
  interruptAppServerTurn: typeof interruptAppServerTurn;
  terminateProcessTree: typeof terminateProcessTree;
  processHasExited?: typeof processHasExited;
  releaseThreadReservationForCancelledJob: typeof releaseThreadReservationForCancelledJob;
  env?: NodeJS.ProcessEnv;
}

export const defaultCancelDeps: CancelDeps = {
  interruptAppServerTurn,
  terminateProcessTree,
  processHasExited,
  releaseThreadReservationForCancelledJob,
};

export async function handleCancel(
  argv: string[],
  deps: CancelDeps = defaultCancelDeps,
): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd', 'workspace'],
    booleanOptions: ['json'],
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = Object.hasOwn(options, 'workspace')
    ? resolveCommandWorkspace(options)
    : undefined;
  if (positionals.length > 1) {
    throw new Error(
      `cancel takes at most one job id; got ${positionals.length}. Cancel jobs one at a time.`,
    );
  }
  const reference = positionals[0] ?? '';
  const resolved = resolveCancelableJob(cwd, reference, {
    env: deps.env ?? process.env,
    workspaceRoot,
  });
  const { job } = resolved;
  const jobFile = resolveJobFile(resolved.workspaceRoot, job.id);
  let existing: Partial<JobRecord>;
  let storedJobWarning: string | null = null;
  try {
    existing = readStoredJob(resolved.workspaceRoot, job.id) ?? {};
  } catch (error) {
    existing = {};
    const message = error instanceof Error ? error.message : String(error);
    storedJobWarning = `Stored job file is unreadable: ${jobFile} (${message}). Cancelling with index data only.`;
    appendLogLine(job.logFile, storedJobWarning);
  }
  const threadId = existing.threadId ?? job.threadId ?? null;
  const requestThreadId =
    (existing.request as { threadId?: string | null } | null | undefined)?.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await deps.interruptAppServerTurn(workspaceRoot ?? cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : '.'}`,
    );
  }

  const cancelledPid = job.pid ?? Number.NaN;
  let killWarning: string | null = null;
  const pidAlive =
    Number.isInteger(cancelledPid) &&
    cancelledPid > 0 &&
    !(deps.processHasExited ?? processHasExited)(cancelledPid);
  if (pidAlive) {
    try {
      deps.terminateProcessTree(cancelledPid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      killWarning = `Failed to terminate worker pid ${cancelledPid}: ${message}`;
      try {
        appendLogLine(job.logFile, killWarning);
      } catch {
        // A log write must not prevent cancellation bookkeeping.
      }
    }
  } else {
    try {
      appendLogLine(
        job.logFile,
        `Skipped process termination: worker pid ${cancelledPid} is no longer running.`,
      );
    } catch {
      // A log write must not prevent cancellation bookkeeping.
    }
  }
  const reservationCleanup = await deps.releaseThreadReservationForCancelledJob({
    threadId,
    requestThreadId,
    jobId: job.id,
    pid: cancelledPid,
  });
  appendLogLine(
    job.logFile,
    `Thread reservation cleanup: ${reservationCleanup.status}${
      reservationCleanup.detail ? ` (${reservationCleanup.detail})` : ''
    }.`,
  );
  appendLogLine(job.logFile, 'Cancelled by user.');

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: 'cancelled',
    phase: 'cancelled',
    pid: null,
    completedAt,
    errorMessage: 'Cancelled by user.',
  };

  writeJobFile(resolved.workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt,
  });
  upsertJob(resolved.workspaceRoot, {
    id: job.id,
    status: 'cancelled',
    phase: 'cancelled',
    pid: null,
    errorMessage: 'Cancelled by user.',
    completedAt,
  });

  const payload = {
    jobId: job.id,
    status: 'cancelled',
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
    reservationCleanup: reservationCleanup.status,
    ...(storedJobWarning ? { storedJobWarning } : {}),
    ...(killWarning ? { killWarning } : {}),
  };

  outputCommandResult(
    payload,
    renderCancelReport(nextJob, storedJobWarning, killWarning),
    options.json,
  );
}

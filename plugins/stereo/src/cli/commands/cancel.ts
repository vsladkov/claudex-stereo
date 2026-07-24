import process from 'node:process';

import {
  interruptAppServerTurn,
  releaseThreadReservationForCancelledJob,
} from '../../runtime/index.ts';
import { terminateProcessTree } from '../../platform/process.ts';
import { readStoredJob, resolveCancelableJob } from '../../jobs/job-control.ts';
import { appendLogLine } from '../../jobs/tracked-jobs.ts';
import { nowIso, upsertJob, writeJobFile } from '../../workspace/state.ts';
import type { JobRecord } from '../../workspace/state.ts';
import { renderCancelReport } from '../../render/render.ts';
import { outputCommandResult, parseCommandInput, resolveCommandCwd } from '../io.ts';

export async function handleCancel(argv: string[]): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json'],
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? '';
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing: Partial<JobRecord> = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const requestThreadId =
    (existing.request as { threadId?: string | null } | null | undefined)?.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : '.'}`,
    );
  }

  const cancelledPid = job.pid ?? Number.NaN;
  terminateProcessTree(cancelledPid);
  const reservationCleanup = await releaseThreadReservationForCancelledJob({
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

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt,
  });
  upsertJob(workspaceRoot, {
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
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

import process from 'node:process';

import { interruptAppServerTurn } from '../../runtime/index.ts';
import type { ProcessOps } from '../../platform/process.ts';
import { readStoredJob, resolveCancelableJob } from '../../jobs/job-control.ts';
import {
  recordedProcesses,
  settleJob,
  stopJobProcesses,
  unconfirmedStopWarning,
} from '../../jobs/job-lifecycle.ts';
import type { SettleJobResult } from '../../jobs/job-lifecycle.ts';
import { appendLogLine } from '../../jobs/tracked-jobs.ts';
import { resolveJobFile } from '../../workspace/state.ts';
import type { JobRecord } from '../../workspace/state.ts';
import { renderCancelReport } from '../../render/render.ts';
import {
  outputReportResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
} from '../io.ts';
import { errorMessage } from '../../shared/errors.ts';
import { jobRuntime } from '../../shared/runtime.ts';

export interface CancelDeps {
  interruptAppServerTurn: typeof interruptAppServerTurn;
  /** The process seams the stop uses (the host's by default). */
  ops?: ProcessOps;
  env?: NodeJS.ProcessEnv;
}

export const defaultCancelDeps: CancelDeps = { interruptAppServerTurn };

// A job that finished while the cancel ran keeps its own outcome.
function renderAlreadyFinished(jobId: string, status: string): string {
  return `# Stereo Cancel\n\nJob ${jobId} already finished (${status}); nothing to cancel.\n`;
}

function logTo(logFile: string | null | undefined): (line: string) => void {
  return (line) => {
    try {
      appendLogLine(logFile, line);
    } catch {
      // A log write must not prevent cancellation bookkeeping.
    }
  };
}

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
    const message = errorMessage(error);
    storedJobWarning = `Stored job file is unreadable: ${jobFile} (${message}). Cancelling with index data only.`;
    appendLogLine(job.logFile, storedJobWarning);
  }
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  // Record the cancel before stopping anything: the worker's own signal
  // handler, an interrupted turn, or a run finishing in the meantime then
  // finds the job terminal and leaves this record alone. A job that settled
  // on its own before this point keeps its outcome, and nothing is stopped.
  // A job file that cannot be written still leaves the index row settled:
  // the processes are stopped first, then the write error surfaces.
  let settleError: unknown = null;
  let settled: SettleJobResult;
  try {
    settled = settleJob(resolved.workspaceRoot, job.id, {
      terminal: {
        status: 'cancelled',
        phase: 'cancelled',
        errorMessage: 'Cancelled by user.',
      },
      fallback: job,
    });
    settleError = settled.writeError ?? null;
  } catch (error) {
    settleError = error;
    // Only the snapshot is left to say which processes to stop.
    settled = {
      settled: true,
      status: 'cancelled',
      record: null,
      processes: recordedProcesses(existing, job),
    };
  }
  if (!settled.settled) {
    logTo(job.logFile)(`Cancel found the job already ${settled.status}; its record stands.`);
    outputReportResult(
      {
        jobId: job.id,
        status: settled.status,
        title: job.title,
        alreadyFinished: true,
        ...(storedJobWarning ? { storedJobWarning } : {}),
      },
      renderAlreadyFinished(job.id, settled.status),
      options.json,
    );
    return;
  }

  // A Claude job has no app-server turn to interrupt; killing the worker's
  // process tree below ends its `claude -p` child.
  const interrupt =
    jobRuntime(existing.runtime ? existing : job) === 'claude'
      ? { attempted: false, interrupted: false, detail: null }
      : await deps.interruptAppServerTurn(resolved.workspaceRoot, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : '.'}`,
    );
  }

  // The processes the settle took off the record, read under the index lock
  // (a worker that started after the lookup above is included). Pids are
  // reused: a live pid that no longer runs the worker, or that started at
  // another time, is someone else's process, and killing it is not this
  // job's business. A headless Claude child leads its own process group, so
  // the worker's tree kill does not reach it; it is killed by its recorded
  // pid, with escalation. A process the stop cannot confirm gone is named in
  // the warning for the user to end: nothing retries the stop. The job's
  // thread or session reservation is reclaimed by the next run that needs it.
  const pids = settled.processes;
  const logLine = logTo(job.logFile);
  const stop = stopJobProcesses(pids, { ops: deps.ops });
  if (stop.worker === 'none') {
    logLine('Skipped process termination: no worker pid was recorded.');
  } else if (stop.worker === 'exited') {
    logLine(`Skipped process termination: worker pid ${pids.pid} is no longer running.`);
  } else if (stop.worker === 'foreign') {
    logLine(`Skipped process termination: pid ${pids.pid} no longer runs the companion worker.`);
  }
  if (stop.claude === 'stopped') {
    logLine(`Terminated the Claude process ${pids.claudePid}.`);
  }
  const killWarning = unconfirmedStopWarning(stop, pids);
  if (killWarning) {
    logLine(killWarning);
  }

  const interruptFields = {
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
    ...(storedJobWarning ? { storedJobWarning } : {}),
    ...(killWarning ? { killWarning } : {}),
  };
  if (settleError) {
    throw settleError;
  }
  logLine('Cancelled by user.');

  const payload = {
    jobId: job.id,
    status: 'cancelled',
    title: job.title,
    alreadyFinished: false,
    ...interruptFields,
  };

  outputReportResult(payload, renderCancelReport(job, storedJobWarning, killWarning), options.json);
}

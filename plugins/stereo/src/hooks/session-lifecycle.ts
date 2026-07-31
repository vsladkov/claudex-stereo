import fs from 'node:fs';
import process from 'node:process';

import { readStdinJsonIfPiped } from '../shared/fs.ts';
import { terminateProcessTree } from '../platform/process.ts';
import { BROKER_ENDPOINT_ENV } from '../protocol/broker-rpc.ts';
import { releaseThreadReservationForCancelledJob } from '../runtime/index.ts';
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  processHasExited,
  sendBrokerShutdownIfIdle,
  teardownBrokerSession,
} from '../broker/lifecycle.ts';
import type { ShutdownOutcome } from '../broker/lifecycle.ts';
import {
  PLUGIN_DATA_ENV,
  loadState,
  nowIso,
  readJobFile,
  resolveJobFile,
  resolveStateFile,
  saveState,
  writeJobFile,
} from '../workspace/state.ts';
import { SESSION_ID_ENV } from '../jobs/tracked-jobs.ts';

export { SESSION_ID_ENV };
import type { JobRecord } from '../workspace/state.ts';
import { TRANSCRIPT_PATH_ENV } from '../workspace/claude-session-transfer.ts';
import { resolveWorkspaceRoot } from '../workspace/workspace.ts';

// Must stay comfortably below the SessionEnd timeout in hooks.json so every
// awaited step finishes before the hook harness kills this process. A kill
// here lands between the job sweep and teardownBrokerSession, stranding
// broker.json, the cxc-* session dir, and possibly a live broker. In-flight
// clamped waits may finish up to a few seconds past the budget, so hooks.json
// must keep several seconds of headroom beyond SESSION_END_BUDGET_MS.
export const SESSION_END_BUDGET_MS = 20_000;

interface SessionHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  [key: string]: unknown;
}

// The broker fields SessionEnd needs, whether they came from the on-disk
// session record or from this process's environment fallback.
interface SessionBrokerHandle {
  endpoint: string | null;
  pidFile: string | null;
  logFile: string | null;
  sessionDir?: string | null;
  pid?: number | null;
}

function readHookInput(): SessionHookInput {
  return readStdinJsonIfPiped() as SessionHookInput;
}

function shellEscape(value: unknown): string {
  // Byte-exact single-quote escaping, round-trip verified; the escapes are
  // redundant to the parser but deliberately untouched.
  // eslint-disable-next-line no-useless-escape
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name: string, value: string | null | undefined): void {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === '') {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, 'utf8');
}

async function cleanupSessionJobs(
  cwd: string,
  sessionId: string | undefined,
  deadline: number,
): Promise<number> {
  if (!cwd || !sessionId) {
    return 0;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return 0;
  }

  const state = loadState(workspaceRoot);
  // Only this session's still-active jobs are removed; finished jobs keep
  // their records and logs so /stereo:result works after the session ends
  // (they age out through the normal job-index pruning).
  const removedJobs = state.jobs.filter(
    (job) => job.sessionId === sessionId && (job.status === 'queued' || job.status === 'running'),
  );
  if (removedJobs.length === 0) {
    return 0;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === 'queued' || job.status === 'running';
    if (!stillRunning) {
      continue;
    }
    const pid = job.pid ?? Number.NaN;
    let storedJob: JobRecord | null = null;
    try {
      const jobFile = resolveJobFile(workspaceRoot, job.id);
      if (fs.existsSync(jobFile)) {
        storedJob = readJobFile(jobFile);
      }
    } catch {
      // The lock-directory scan remains available when the stored request cannot be read.
    }
    try {
      if (Number.isInteger(pid) && pid > 0 && !processHasExited(pid)) {
        terminateProcessTree(pid);
      }
    } catch {
      // Ignore teardown failures during session shutdown.
    }
    try {
      await releaseThreadReservationForCancelledJob(
        {
          threadId: storedJob?.threadId ?? job.threadId ?? null,
          requestThreadId:
            (storedJob?.request as { threadId?: string | null } | null | undefined)?.threadId ??
            null,
          jobId: job.id,
          pid,
        },
        { timeoutMs: Math.max(0, Math.min(2500, deadline - Date.now())) },
      );
    } catch {
      // Reservation cleanup is best effort during session shutdown.
    }
    try {
      // Mark the killed job terminal on disk: saveState only erases artifacts
      // of terminal jobs, so this both records the cancellation and lets the
      // index removal below clean up the files.
      writeJobFile(workspaceRoot, job.id, {
        ...(storedJob ?? job),
        status: 'cancelled',
        phase: 'cancelled',
        pid: null,
        completedAt: nowIso(),
        errorMessage: 'Cancelled at session end.',
      });
    } catch {
      // Best effort; a failed write leaves the job to the scanner's remedies.
    }
  }

  const removedIds = new Set(removedJobs.map((job) => job.id));
  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => !removedIds.has(job.id)),
  });
  return removedJobs.length;
}

function handleSessionStart(input: SessionHookInput): void {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function sendBrokerShutdownBeforeDeadline(
  endpoint: string,
  deadline: number,
): Promise<ShutdownOutcome> {
  return sendBrokerShutdownIfIdle(endpoint, {
    timeoutMs: Math.max(0, Math.min(1500, deadline - Date.now())),
  });
}

async function handleSessionEnd(input: SessionHookInput): Promise<void> {
  const deadline = Date.now() + SESSION_END_BUDGET_MS;
  const cwd = input.cwd || process.cwd();
  const brokerSession: SessionBrokerHandle | null =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null,
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  // Kill this session's own jobs BEFORE probing the broker: a worker of ours
  // mid-turn would otherwise answer the idle probe with busy and the broker
  // would outlive the session (killing the worker closes its socket, the
  // broker interrupts the orphaned turn, and idleness follows within ~ms-s).
  const killedJobs = await cleanupSessionJobs(
    cwd,
    input.session_id || process.env[SESSION_ID_ENV],
    deadline,
  );

  // Guarded shutdown: the workspace broker is shared by every session in
  // this cwd, so an unconditional kill here would abort another session's
  // in-flight Codex turn. accepted:true additionally means the broker's exit
  // AND closed endpoint were verified, so no kill fallback is needed then.
  let shutdown: ShutdownOutcome | null = null;
  if (brokerEndpoint) {
    shutdown = await sendBrokerShutdownBeforeDeadline(brokerEndpoint, deadline);
    // busy + we just killed jobs = plausibly our own worker's orphaned turn
    // still winding down; retry briefly. busy + nothing killed = another live
    // session owns the broker; leave immediately.
    let retries = killedJobs > 0 ? 6 : 0;
    while (
      retries > 0 &&
      Date.now() < deadline &&
      shutdown &&
      !shutdown.accepted &&
      shutdown.busy
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      shutdown = await sendBrokerShutdownBeforeDeadline(brokerEndpoint, deadline);
      retries -= 1;
    }
  }

  if (shutdown && !shutdown.accepted && shutdown.busy) {
    // Another live session (or an in-flight turn) still owns the broker.
    // Leave the process and its session state for the surviving session's
    // own SessionEnd; interrupting orphaned turns is the lifecycle
    // redesign's territory.
    return;
  }

  // A gracefully-exited broker's pid may already belong to an unrelated
  // process; kill only when the broker is provably still alive (wedged or
  // unresponsive endpoint).
  const brokerStillAlive =
    typeof pid === 'number' && Number.isFinite(pid) && !processHasExited(pid);
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: brokerStillAlive ? terminateProcessTree : null,
  });
  clearBrokerSession(cwd);
}

export async function runSessionLifecycleHook(): Promise<void> {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? '';

  if (eventName === 'SessionStart') {
    handleSessionStart(input);
    return;
  }

  if (eventName === 'SessionEnd') {
    await handleSessionEnd(input);
  }
}

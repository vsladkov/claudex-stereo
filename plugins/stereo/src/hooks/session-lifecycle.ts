import fs from "node:fs";
import process from "node:process";

import { readStdinIfPiped } from "../shared/fs.ts";
import { terminateProcessTree } from "../platform/process.ts";
import { BROKER_ENDPOINT_ENV } from "../transport/app-server-client.ts";
import { releaseThreadReservationForCancelledJob } from "../runtime/index.ts";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "../broker/lifecycle.ts";
import { loadState, nowIso, readJobFile, resolveJobFile, resolveStateFile, saveState, writeJobFile } from "../workspace/state.ts";
import type { JobRecord } from "../workspace/state.ts";
import { TRANSCRIPT_PATH_ENV } from "../workspace/claude-session-transfer.ts";
import { resolveWorkspaceRoot } from "../workspace/workspace.ts";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

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
  const raw = readStdinIfPiped().trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name: string, value: string | null | undefined): void {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

async function cleanupSessionJobs(cwd: string, sessionId: string | undefined): Promise<void> {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  // Only this session's still-active jobs are removed; finished jobs keep
  // their records and logs so /stereo:result works after the session ends
  // (they age out through the normal job-index pruning).
  const removedJobs = state.jobs.filter(
    (job) => job.sessionId === sessionId && (job.status === "queued" || job.status === "running")
  );
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
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
      terminateProcessTree(pid);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
    try {
      await releaseThreadReservationForCancelledJob({
        threadId: storedJob?.threadId ?? job.threadId ?? null,
        requestThreadId: (storedJob?.request as { threadId?: string | null } | null | undefined)?.threadId ?? null,
        jobId: job.id,
        pid
      });
    } catch {
      // Reservation cleanup is best effort during session shutdown.
    }
    try {
      // Mark the killed job terminal on disk: saveState only erases artifacts
      // of terminal jobs, so this both records the cancellation and lets the
      // index removal below clean up the files.
      writeJobFile(workspaceRoot, job.id, {
        ...(storedJob ?? job),
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        completedAt: nowIso(),
        errorMessage: "Cancelled at session end."
      });
    } catch {
      // Best effort; a failed write leaves the job to the scanner's remedies.
    }
  }

  const removedIds = new Set(removedJobs.map((job) => job.id));
  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => !removedIds.has(job.id))
  });
}

function handleSessionStart(input: SessionHookInput): void {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input: SessionHookInput): Promise<void> {
  const cwd = input.cwd || process.cwd();
  const brokerSession: SessionBrokerHandle | null =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  await cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

export async function runSessionLifecycleHook(): Promise<void> {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

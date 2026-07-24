#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { readStdinIfPiped } from "../src/shared/fs.ts";
import { terminateProcessTree } from "../src/platform/process.ts";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import { releaseThreadReservationForCancelledJob } from "./lib/codex.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { loadState, nowIso, readJobFile, resolveJobFile, resolveStateFile, saveState, writeJobFile } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = readStdinIfPiped().trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

async function cleanupSessionJobs(cwd, sessionId) {
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
    let storedJob = null;
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
        requestThreadId: storedJob?.request?.threadId ?? null,
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

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
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

async function main() {
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { readStdinJsonIfPiped } from '../shared/fs.ts';
import { PLUGIN_ROOT } from '../shared/paths.ts';
import { jobRuntime } from '../shared/runtime.ts';
import { shellQuote } from '../shared/text.ts';
import { BROKER_ENDPOINT_ENV } from '../protocol/broker-rpc.ts';
import {
  clearBrokerSession,
  loadBrokerSession,
  sendBrokerShutdownIfIdle,
  teardownBrokerSession,
} from '../broker/lifecycle.ts';
import type { ShutdownOutcome } from '../broker/lifecycle.ts';
import {
  PLUGIN_DATA_ENV,
  disableStateFileWarnings,
  isActiveJob,
  loadState,
  readStoredJobOrNull,
  resolveStateFile,
  setConfig,
  updateState,
} from '../workspace/state.ts';
import {
  recordedProcesses,
  settleJob,
  stopConfirmed,
  stopJobsProcesses,
} from '../jobs/job-lifecycle.ts';
import type {
  JobProcesses,
  SettleJobResult,
  StopJobProcessesOptions,
} from '../jobs/job-lifecycle.ts';
import { SESSION_ID_ENV } from '../jobs/tracked-jobs.ts';
import { buildSessionJobAnnouncement } from '../jobs/job-announcements.ts';
import { renderSessionJobAnnouncement } from '../render/render.ts';

export { SESSION_ID_ENV };
import { TRANSCRIPT_PATH_ENV } from '../workspace/claude-session-transfer.ts';
import { clearSessionWorkspaces, readSessionWorkspaces } from '../workspace/session-registry.ts';
import { resolveWorkspaceRoot } from '../workspace/workspace.ts';

// The hook entry hooks.json runs, which the SessionEnd hook starts once more
// as the sweep.
const SESSION_HOOK_ENTRY = path.join(PLUGIN_ROOT, 'scripts', 'session-lifecycle-hook.cjs');
const SESSION_END_SWEEP_EVENT = 'SessionEndSweep';

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
}

function readHookInput(): SessionHookInput {
  return readStdinJsonIfPiped() as SessionHookInput;
}

function appendEnvVar(name: string, value: string | null | undefined): void {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === '') {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellQuote(value)}\n`, 'utf8');
}

/** The process seams every root's job stop uses (the host's by default). */
export type SessionJobCleanupOptions = Pick<StopJobProcessesOptions, 'ops'>;

export interface SessionJobCleanup {
  /**
   * Codex jobs whose running worker this sweep stopped: only those can have
   * left the shared broker mid-turn (a queued record has no process, and a
   * Claude job never holds the broker).
   */
  codexKilled: number;
}

// A few lock attempts for the SessionStart watermark write: a wedged lock
// costs half a second, and the write still happens unlocked, never the
// hook's whole budget.
const HOOK_LOCK_ATTEMPTS = 20;

// One swept workspace root, and the jobs whose rows leave its index.
interface RootSweep {
  workspaceRoot: string;
  removedIds: Set<string>;
}

// One settled job to stop: the processes the settle took off its record.
interface StopRequest {
  id: string;
  processes: JobProcesses;
  runtime: unknown;
  sweep: RootSweep;
}

// Phase one for one root: this session's still-active jobs are settled
// (cancelled) before anything is signalled, so the worker's own signal
// handler finds its job terminal. A job that finished meanwhile keeps its
// result (finished jobs keep their records and logs, so /stereo:result works
// after the session ends); one already cancelled leaves the index like ours.
// The pids to stop are the ones the settle read under the index lock (a
// worker may have started since the snapshot), and a worker that starts
// after its job's settle finds it terminal and never runs.
function settleRootJobs(sweep: RootSweep, sessionId: string, requests: StopRequest[]): void {
  const { workspaceRoot } = sweep;
  if (!fs.existsSync(resolveStateFile(workspaceRoot))) {
    return;
  }
  const activeJobs = loadState(workspaceRoot).jobs.filter(
    (job) => job.sessionId === sessionId && isActiveJob(job),
  );
  for (const job of activeJobs) {
    let settled: SettleJobResult | null = null;
    try {
      settled = settleJob(workspaceRoot, job.id, {
        terminal: {
          status: 'cancelled',
          phase: 'cancelled',
          errorMessage: 'Cancelled at session end.',
        },
        fallback: job,
      });
    } catch {
      // The index could not be read or written: only the snapshot says what to stop.
    }
    if (settled && !settled.settled) {
      if (settled.status === 'cancelled') {
        sweep.removedIds.add(job.id);
      }
      continue;
    }
    requests.push({
      id: job.id,
      // A settle that threw leaves only the snapshot to go by.
      processes: settled
        ? settled.processes
        : recordedProcesses(readStoredJobOrNull(workspaceRoot, job.id), job),
      runtime: job.runtime,
      sweep,
    });
  }
}

// Sweeps this session's jobs in each workspace root in three phases: every
// root's jobs are settled; then one stop for all their processes, in phases
// whose waits are shared (the polite signal to all, one wait, the hard
// signal to the survivors still verdict 'ours', one more wait), so the time
// spent does not grow with the number of jobs or roots; then each root's
// stopped jobs leave its index. A recorded pid is signalled only while it is
// still the process the record named (pids are reused), and counts as
// stopped only once confirmed gone; a job's reservation is reclaimed by the
// next run of its thread or session. A job whose stop was not confirmed
// keeps its cancelled row, so a worker still running finds its job terminal.
export function cleanupSessionJobs(
  cwds: readonly string[],
  sessionId: string,
  options: SessionJobCleanupOptions = {},
): SessionJobCleanup {
  const sweeps: RootSweep[] = [];
  const requests: StopRequest[] = [];
  for (const cwd of cwds) {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    if (sweeps.some((sweep) => sweep.workspaceRoot === workspaceRoot)) {
      continue;
    }
    const sweep: RootSweep = { workspaceRoot, removedIds: new Set() };
    sweeps.push(sweep);
    try {
      settleRootJobs(sweep, sessionId, requests);
    } catch {
      // An unreadable state file: none of this root's jobs is swept.
    }
  }

  let codexKilled = 0;
  const stops =
    requests.length > 0
      ? stopJobsProcesses(
          requests.map((request) => request.processes),
          options,
        )
      : [];
  for (const [index, request] of requests.entries()) {
    const stop = stops[index];
    if (!stop || !stopConfirmed(stop)) {
      continue;
    }
    if (jobRuntime(request) === 'codex' && stop.worker === 'stopped') {
      codexKilled += 1;
    }
    request.sweep.removedIds.add(request.id);
  }

  for (const { workspaceRoot, removedIds } of sweeps) {
    if (removedIds.size === 0) {
      continue;
    }
    // A fresh load, not the snapshot from before the stop: a config change
    // written meanwhile (role defaults, the announcement watermark) must
    // survive the sweep. The settled rows are terminal, so the removal also
    // deletes their files. A failed write (ENOSPC, EROFS) leaves the rows
    // for pruning and must not cost the registry removal or the broker
    // shutdown that follow.
    try {
      updateState(workspaceRoot, (current) => {
        const before = current.jobs.length;
        current.jobs = current.jobs.filter((job) => !removedIds.has(job.id));
        return current.jobs.length !== before;
      });
    } catch {
      // Best effort, see above.
    }
  }
  return { codexKilled };
}

// SessionStart has a 5 s hook budget. Keep this path to one workspace-root
// resolution, one bounded state-index read, and at most one atomic state
// write. Adding log reads or a broker probe requires raising hooks.json's
// timeout and re-justifying the budget.
function announceWorkspaceJobs(input: SessionHookInput): void {
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (!fs.existsSync(resolveStateFile(workspaceRoot))) {
    return;
  }

  const state = loadState(workspaceRoot);
  const announcement = buildSessionJobAnnouncement(state.jobs, {
    watermark: state.config.lastJobAnnouncementAt,
  });
  if (!announcement) {
    return;
  }
  announcement.workspaceRoot = workspaceRoot;
  if (announcement.active.length + announcement.finished.length > 0) {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: renderSessionJobAnnouncement(announcement),
        },
      })}\n`,
    );
  }
  if (announcement.nextWatermark) {
    // A small lock budget: a wedged index lock must not eat the 5 s hook
    // timeout (the write still happens, unlocked, when the wait runs out).
    setConfig(workspaceRoot, 'lastJobAnnouncementAt', announcement.nextWatermark, {
      attempts: HOOK_LOCK_ATTEMPTS,
    });
  }
}

function handleSessionStart(input: SessionHookInput): void {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  try {
    announceWorkspaceJobs(input);
  } catch {
    // SessionStart must never fail: malformed or unavailable state degrades to silence.
  }
}

// A sweep that throws stopped nothing it can count; the registry removal and
// the broker shutdown still run.
function sweepSessionJobs(
  cwds: readonly string[],
  sessionId: string,
  options: SessionJobCleanupOptions,
): SessionJobCleanup {
  try {
    return cleanupSessionJobs(cwds, sessionId, options);
  } catch {
    return { codexKilled: 0 };
  }
}

// One workspace's broker at the end of a session. Guarded shutdown: the
// broker is shared by every session in its workspace, so an unconditional
// kill here would abort another session's in-flight Codex turn.
// accepted:true additionally means the broker's exit AND closed endpoint
// were verified.
async function shutDownIdleBroker(
  root: string,
  broker: SessionBrokerHandle | null,
  codexKilled: number,
): Promise<void> {
  const endpoint = broker?.endpoint ?? null;
  let shutdown: ShutdownOutcome | null = null;
  if (endpoint) {
    shutdown = await sendBrokerShutdownIfIdle(endpoint);
    // busy + we just killed Codex jobs = plausibly our own worker's orphaned
    // turn still winding down; retry briefly. busy + nothing Codex killed =
    // another live session owns the broker (a Claude job never holds it);
    // leave immediately.
    let retries = codexKilled > 0 ? 6 : 0;
    while (retries > 0 && !shutdown.accepted && shutdown.busy) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      shutdown = await sendBrokerShutdownIfIdle(endpoint);
      retries -= 1;
    }
  }

  // A busy broker serves another live session (or an in-flight turn), and a
  // probe that timed out proves nothing about it: the broker, its record,
  // and its files stay. It reaps itself once idle if its record ever goes
  // away.
  if (shutdown && !shutdown.accepted && (shutdown.busy || shutdown.timedOut)) {
    return;
  }
  // Anything else (the broker exited, nothing listens, or what listens does
  // not answer as an idle broker would) clears the record and the session's
  // files. Nothing is killed from here: the recorded pid may be someone
  // else's by now.
  teardownBrokerSession({
    endpoint,
    pidFile: broker?.pidFile ?? null,
    logFile: broker?.logFile ?? null,
    sessionDir: broker?.sessionDir ?? null,
  });
  clearBrokerSession(root);
}

// The session-end sweep. It runs in a process of its own (SessionEndSweep),
// so it has no time budget: every stop gets its full grace and hard signal,
// and the steps after a slow stop still run.
export async function handleSessionEnd(
  input: SessionHookInput,
  options: SessionJobCleanupOptions = {},
): Promise<void> {
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const brokerSession: SessionBrokerHandle | null =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: null,
          logFile: null,
        }
      : null);

  // Kill this session's own jobs BEFORE probing a broker: a worker of ours
  // mid-turn would otherwise answer the idle probe with busy and the broker
  // would outlive the session (killing the worker closes its socket, the
  // broker interrupts the orphaned turn, and idleness follows within ~ms-s).
  // `/clear` and `/resume` also end the session but keep the user at the
  // keyboard: its jobs keep running and stay resumable; only an idle broker
  // is reaped.
  const spared = input.reason === 'clear' || input.reason === 'resume';
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  // Jobs this session launched in other workspace roots (`--workspace`) live
  // in those roots' state; the per-session registry names them, and goes
  // with the sweep. With the jobs spared it stays: whether the id survives
  // is the harness's business, and a later end of the same id must still
  // find these roots.
  const otherRoots = sessionId ? readSessionWorkspaces(sessionId) : [];
  let codexKilled = 0;
  if (sessionId && !spared) {
    codexKilled = sweepSessionJobs([cwd, ...otherRoots], sessionId, options).codexKilled;
    clearSessionWorkspaces(sessionId);
  }

  // The session directory's broker, then the broker of every other root the
  // session launched jobs in: nothing else would ever ask those to go.
  await shutDownIdleBroker(cwd, brokerSession, codexKilled);
  const ownRoot = resolveWorkspaceRoot(cwd);
  for (const root of otherRoots) {
    const broker = root === ownRoot ? null : loadBrokerSession(root);
    if (broker) {
      await shutDownIdleBroker(root, broker, codexKilled);
    }
  }
}

// Claude Code gives a plugin's SessionEnd hook 1.5 s in total, whatever
// timeout hooks.json asks for, and a stop that waits out a worker's grace
// takes longer. So the hook only starts the sweep as a detached process of
// its own (this entry once more, with the hook input on its stdin) and
// returns. A sweep that cannot be started does not run: nothing falls back
// to sweeping here.
function handOffSessionEnd(input: SessionHookInput): void {
  const child = spawn(process.execPath, [SESSION_HOOK_ENTRY, SESSION_END_SWEEP_EVENT], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(input));
  child.unref();
}

export async function runSessionLifecycleHook(): Promise<void> {
  // Hook stdio is a protocol surface: corrupt-state breadcrumbs stay in CLI
  // invocations only (silence here is pinned by the session-hook tests).
  disableStateFileWarnings();
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? '';

  if (eventName === 'SessionStart') {
    handleSessionStart(input);
    return;
  }

  if (eventName === 'SessionEnd') {
    handOffSessionEnd(input);
    return;
  }

  if (eventName === SESSION_END_SWEEP_EVENT) {
    await handleSessionEnd(input);
  }
}

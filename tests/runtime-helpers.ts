import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { afterEach } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  captureStdout,
  drainCreatedTempDirs,
  initGitRepo,
  makeTempDir,
  run,
  waitFor,
} from './helpers.ts';
import { reapWorkspaceBroker } from './broker-reaper.ts';
import { probeBrokerEndpoint } from '../plugins/stereo/src/broker/lifecycle.ts';
import {
  processVerdict,
  spawnedProcessIdentity,
  terminateProcessTree,
} from '../plugins/stereo/src/platform/process.ts';
import type { RecordedProcess } from '../plugins/stereo/src/platform/process.ts';
import { resolveDurableStateDir } from '../plugins/stereo/src/workspace/state.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every workspace a runtime test file creates gets its broker reaped after
// each test: the companion CLI auto-starts a detached broker per workspace,
// and without a SessionEnd there is nothing else to stop it (one unswept full
// run used to strand ~40 broker processes). Each runtime-*.test.ts file calls
// this once at top level; the afterEach hook registers against the calling
// file's own root suite (test files run in separate processes).
export function registerBrokerReaping(): void {
  afterEach(async () => {
    for (const dir of drainCreatedTempDirs()) {
      await reapWorkspaceBroker(dir);
    }
  });
}

const PLUGIN_ROOT = path.join(ROOT, 'plugins', 'stereo');
export const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'codex-companion.ts');
export const BROKER_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'app-server-broker.ts');
export const STOP_HOOK = path.join(PLUGIN_ROOT, 'scripts', 'stop-review-gate-hook.ts');
export const SESSION_HOOK = path.join(PLUGIN_ROOT, 'scripts', 'session-lifecycle-hook.ts');

export function withCodexHome<T>(codexHome: string, fn: () => T): T {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
  }
}

export function brokerEndpointConnectable(endpoint: string): Promise<boolean> {
  return probeBrokerEndpoint(endpoint);
}

export interface NodeRunOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runNodeWithTimeout(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<NodeRunOutcome> {
  return new Promise<NodeRunOutcome>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 5000);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({
        status: code,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

export function readJsonIfReadable<T = unknown>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ||
      error instanceof SyntaxError
    ) {
      return null;
    }
    throw error;
  }
}

export function readFakeState(binDir: string): Record<string, any> {
  return readJsonIfReadable<Record<string, any>>(path.join(binDir, 'fake-codex-state.json')) ?? {};
}

// The fake app-server rewrites its state file in place (not atomically) and
// stays alive under the broker after a foreground run returns, so a raw read
// can land mid-write and parse as nothing. Wait for a read that carries `key`
// and return that state; the caller asserts on the entry itself.
export function waitForFakeState(binDir: string, key: string): Promise<Record<string, any>> {
  return waitFor(() => {
    const state = readFakeState(binDir);
    return state[key] === undefined ? null : state;
  });
}

// The same wait for the turn a launch started, matched by its model, or by
// its thread when models repeat.
export function waitForTurnStart(
  binDir: string,
  match: { model?: string; threadId?: string },
): Promise<Record<string, any>> {
  return waitFor(() => {
    const turn = readFakeState(binDir).lastTurnStart;
    const matches =
      turn &&
      (match.model === undefined || turn.model === match.model) &&
      (match.threadId === undefined || turn.threadId === match.threadId);
    return matches ? turn : null;
  });
}

export interface CompanionStateFile {
  jobs: Array<Record<string, any>>;
  [key: string]: any;
}

export function resolveCompanionStateDir(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const codexHome = env.CODEX_HOME;
  assert.ok(codexHome, 'Expected CODEX_HOME when resolving durable companion state.');
  return resolveDurableStateDir(cwd, path.resolve(codexHome));
}

export function readCompanionState(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): CompanionStateFile | null {
  return readJsonIfReadable<CompanionStateFile>(
    path.join(resolveCompanionStateDir(cwd, env), 'state.json'),
  );
}

export function requireCompanionState(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): CompanionStateFile {
  const state = readCompanionState(cwd, env);
  assert.ok(state, 'Expected companion state to be readable.');
  return state;
}

export function readJobLog(
  cwd: string,
  jobId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const state = requireCompanionState(cwd, env);
  const job = state.jobs.find((candidate) => candidate.id === jobId);
  assert.ok(job, `Expected job ${jobId} in companion state.`);
  return fs.readFileSync(job.logFile, 'utf8');
}

// The job log as a waitFor predicate needs it: '' while the index row, the
// job, or the log file is not there yet (a worker writes them one after the
// other), never a throw that would abort the wait.
export function readJobLogIfReadable(
  cwd: string,
  jobId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const job = readCompanionState(cwd, env)?.jobs.find((candidate) => candidate.id === jobId);
  if (typeof job?.logFile !== 'string') {
    return '';
  }
  try {
    return fs.readFileSync(job.logFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

// What a stand-in carries on its command line so the identity check a kill
// runs before signalling a recorded pid (a substring match) takes it for a
// process of the marker's kind.
export function standInArgv(marker: string): string[] {
  return [`stand-in:${marker}`];
}

// How long a stand-in lives when nothing stops it: longer than any test, and
// short enough that one a crashed test file left behind goes by itself.
const STAND_IN_LIFETIME_MS = 10 * 60_000;

// Starts a stand-in detached (it leads its own process group, as a worker, a
// broker, and a headless Claude child do), prints its pid, and exits.
const STAND_IN_LAUNCHER = [
  "const { spawn } = require('node:child_process');",
  'const standIn = spawn(process.execPath, process.argv.slice(1), {',
  "  detached: true, stdio: 'ignore', windowsHide: true,",
  '});',
  'standIn.unref();',
  'process.stdout.write(String(standIn.pid));',
].join('\n');

// A sleeper carrying the marker's argv (standInArgv), so the identity check
// a kill runs before signalling a recorded pid finds it; null starts an
// unmarked impostor (a pid some unrelated process reused). It is started by
// a launcher that exits at once, so it is nobody's child here and the system
// reaps it the moment it dies: a child of the test process stays a zombie
// until the test yields to the event loop, and a stop waits its whole grace
// out on a zombie that still leads its group. Returned with the start token
// read as the launcher returned. Stop it with stopStandIn.
export function spawnStandIn(
  marker: string | null,
  options: { cwd?: string } = {},
): RecordedProcess {
  const launched = spawnSync(
    process.execPath,
    [
      '-e',
      STAND_IN_LAUNCHER,
      '--',
      '-e',
      `setTimeout(() => {}, ${STAND_IN_LIFETIME_MS})`,
      ...(marker ? standInArgv(marker) : []),
    ],
    { cwd: options.cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true },
  );
  const standIn = launched.status === 0 ? spawnedProcessIdentity(Number(launched.stdout)) : null;
  assert.ok(standIn, `The stand-in launcher failed: ${launched.error?.message ?? launched.stderr}`);
  return standIn;
}

// Stops a stand-in that still runs. Its pid is signalled only while it names
// the process that was started (its start token): nothing holds the pid of a
// process that is nobody's child.
export function stopStandIn(standIn: RecordedProcess): void {
  if (processVerdict(standIn.pid, null, { expectedStart: standIn.start }) === 'ours') {
    terminateProcessTree(standIn.pid);
  }
}

export function findThreadReservation(
  codexHome: string,
  threadId: string,
): { path: string; record: Record<string, any> } | null {
  const lockDir = path.join(codexHome, 'companion-thread-locks');
  if (!fs.existsSync(lockDir)) {
    return null;
  }
  for (const entry of fs.readdirSync(lockDir)) {
    if (!entry.endsWith('.lock')) {
      continue;
    }
    const lockPath = path.join(lockDir, entry);
    const record = readJsonIfReadable<Record<string, any>>(lockPath);
    if (!record) {
      continue;
    }
    if (record.threadId === threadId) {
      return { path: lockPath, record };
    }
  }
  return null;
}

export function initializeBasicRepo(): string {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  return repo;
}

// A running job seeded straight into a workspace's durable state (its log,
// its job file, and a one-row index) for a hook or a sweep to find; `pid`
// points it at a worker (a stand-in the caller spawned), or none.
export function seedRunningJob(
  repo: string,
  id: string,
  sessionId: string,
  pid?: number,
  extra: Record<string, unknown> = {},
): void {
  const stateDir = resolveDurableStateDir(repo);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  const logFile = path.join(jobsDir, `${id}.log`);
  fs.writeFileSync(logFile, 'running\n', 'utf8');
  const record = {
    id,
    status: 'running',
    title: 'Codex Task',
    jobClass: 'task',
    sessionId,
    ...(pid === undefined ? {} : { pid }),
    logFile,
    createdAt: '2026-03-18T15:32:00.000Z',
    updatedAt: '2026-03-18T15:33:00.000Z',
    ...extra,
  };
  fs.writeFileSync(
    path.join(jobsDir, `${id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [record] }, null, 2)}\n`,
    'utf8',
  );
}

// Runs the session-end sweep for a workspace once the test is over (the
// sweep itself: the SessionEnd hook would only hand it off and return).
export function registerSessionCleanup(t: TestContext, cwd: string, env: NodeJS.ProcessEnv): void {
  t.after(() => {
    run(process.execPath, [SESSION_HOOK, 'SessionEndSweep'], {
      cwd,
      env,
      input: JSON.stringify({
        hook_event_name: 'SessionEnd',
        cwd,
      }),
    });
  });
}

// The companion CLI as a child process; with no env it inherits this one.
export function companion(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return run(process.execPath, [SCRIPT, ...args], { cwd, env });
}

// The error message of a failed --json command (the {"error": message} contract).
export function errorOf(result: { stdout: string }): string {
  return (JSON.parse(result.stdout) as { error: string }).error;
}

// In-process CLI invocation for pure read-back and flag-validation checks:
// spawning a fresh Node per assertion pays full module-graph startup
// (~0.3-0.5s each) to test the same contract runCli exposes directly. Not
// for tests that need real process isolation (detached workers, brokers,
// signal handling).
export async function runCliInProcess(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const { runCli } = await import('../plugins/stereo/src/cli/main.ts');
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previousEnv.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const previousExitCode = process.exitCode;
  const originalStderrWrite = process.stderr.write;
  let stderr = '';
  process.exitCode = undefined;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const stdout = await captureStdout(() => runCli(args));
    return { status: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.stderr.write = originalStderrWrite;
    process.exitCode = previousExitCode;
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

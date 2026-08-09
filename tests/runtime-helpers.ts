import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { afterEach } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { drainCreatedTempDirs, initGitRepo, makeTempDir, run } from './helpers.ts';
import { reapWorkspaceBroker } from './broker-reaper.ts';
import { probeBrokerEndpoint } from '../plugins/stereo/src/broker/lifecycle.ts';
import { resolveDurableStateDir } from '../plugins/stereo/src/workspace/state.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function processIsAlive(pid: number | null | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  { timeoutMs = 5000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<NonNullable<Awaited<T>>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition.');
}

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

export function registerSessionCleanup(t: TestContext, cwd: string, env: NodeJS.ProcessEnv): void {
  t.after(() => {
    run(process.execPath, [SESSION_HOOK, 'SessionEnd'], {
      cwd,
      env,
      input: JSON.stringify({
        hook_event_name: 'SessionEnd',
        cwd,
      }),
    });
  });
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
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalLog = console.log;
  let stdout = '';
  let stderr = '';
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  console.log = (...values: unknown[]) => {
    stdout += `${values.map(String).join(' ')}\n`;
  };
  try {
    await runCli(args);
    return { status: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalLog;
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

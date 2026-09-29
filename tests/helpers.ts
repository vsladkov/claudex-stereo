import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';

import type { DoctorDeps } from '../plugins/stereo/src/cli/commands/doctor.ts';
import type { buildSetupReport } from '../plugins/stereo/src/cli/commands/setup.ts';
import { parseOpenAiModelId } from '../plugins/stereo/src/models/catalog.ts';
import type { CodexCatalog, CodexCatalogModel } from '../plugins/stereo/src/models/catalog.ts';
import type {
  ClaudeAuthStatus,
  ClaudeAvailability,
} from '../plugins/stereo/src/runtime/claude-availability.ts';
import type { Model } from '../plugins/stereo/src/protocol/app-server.ts';
import { PROCESS_OPS, processHasExited } from '../plugins/stereo/src/platform/process.ts';
import type { ProcessOps } from '../plugins/stereo/src/platform/process.ts';
import { threadReservationPath } from '../plugins/stereo/src/workspace/thread-lock-io.ts';
import {
  listJobs,
  updateState,
  upsertJob,
  writeJobFile,
} from '../plugins/stereo/src/workspace/state.ts';
import type {
  JobRecord,
  StereoConfig,
  StereoState,
} from '../plugins/stereo/src/workspace/state.ts';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  shell?: boolean | string;
  /** Kill the command after this many ms (default RUN_TIMEOUT_MS). */
  timeout?: number;
}

export interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

const createdTempDirs: string[] = [];
const allTempDirs: string[] = [];
let exitCleanupInstalled = false;

function installTempDirCleanup(): void {
  if (exitCleanupInstalled || process.env.STEREO_KEEP_TEST_TMP) {
    return;
  }
  exitCleanupInstalled = true;
  // Exit time, not afterEach: registerBrokerReaping() drains dirs during the
  // run and claude-session-transfer.test.ts creates module-scope dirs that
  // must outlive every test in the file.
  process.on('exit', () => {
    for (const dir of allTempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        // Cleanup is best effort; a leaked dir must never fail a test run.
      }
    }
  });
}

// Canonical, not raw: os.tmpdir() is an 8.3 short path on GitHub's Windows
// runners (TEMP=C:\Users\RUNNER~1\...) and a /var symlink on macOS, while
// `git rev-parse --show-toplevel` and every realpath-based resolver report the
// long/physical form. Comparing a raw temp path against a resolved one is a
// whole class of platform-only failures. realpathSync.native, not
// realpathSync: only the native call expands 8.3 short names.
export function makeTempDir(prefix = 'codex-plugin-test-'): string {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let dir = created;
  try {
    dir = fs.realpathSync.native(created);
  } catch {
    dir = created;
  }
  createdTempDirs.push(dir);
  allTempDirs.push(dir);
  installTempDirCleanup();
  return dir;
}

// Give the calling test a CODEX_HOME of its own (catalog caches, reservation
// locks, and durable workspace state all live there), restoring the previous
// value - or its absence - when the test ends. Returns the new home.
export function useTempCodexHome(t: TestContext, prefix = 'codex-home-'): string {
  const previous = process.env.CODEX_HOME;
  const codexHome = makeTempDir(prefix);
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
  });
  return codexHome;
}

// A file-existence probe that knows only the given paths, compared
// case-insensitively the way a Windows PATH lookup compares them.
export function fakeFiles(...files: string[]): (file: string) => boolean {
  const known = new Set(files.map((file) => file.toLowerCase()));
  return (file) => known.has(file.toLowerCase());
}

/**
 * Return the temp dirs created by this test-file process since the last
 * drain. Each test file runs in its own process, so afterEach reapers built
 * on this see only their own file's workspaces - never another file's.
 */
export function drainCreatedTempDirs(): string[] {
  return createdTempDirs.splice(0, createdTempDirs.length);
}

export function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { encoding: 'utf8', mode: 0o755 });
}

// A hung fake or hook must fail its own test, not stall the whole file until
// the CI job limit: every run() is bounded (a timed-out command comes back
// with a null status, a signal, and an ETIMEDOUT error).
export const RUN_TIMEOUT_MS = 120_000;

export function run(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
  return spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    input: options.input,
    shell: options.shell ?? (process.platform === 'win32' && !path.isAbsolute(command)),
    timeout: options.timeout ?? RUN_TIMEOUT_MS,
    windowsHide: true,
  }) as unknown as RunResult;
}

// Whether a pid names a running process, by the production rule
// (processHasExited): on Linux a zombie has exited. A child of the test
// process is a zombie until Node reaps it, so a bare kill(pid, 0) right after
// production reported the exit would still find it.
export function processIsAlive(pid: number | null | undefined): boolean {
  return pid ? !processHasExited(pid) : false;
}

// Poll until the predicate returns something truthy, and return it; throws
// once the timeout passes.
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

// git is a native executable on every platform: no shell, so an argument
// with a space (the user name) reaches it whole on Windows too.
export function initGitRepo(cwd: string): void {
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Codex Plugin Tests'],
    ['config', 'user.email', 'tests@example.com'],
    ['config', 'commit.gpgsign', 'false'],
    ['config', 'tag.gpgsign', 'false'],
  ]) {
    run('git', args, { cwd, shell: false });
  }
}

// Everything an in-process command prints: the JSON path goes through
// console.log, the rendered path through process.stdout.write.
export async function captureStdout(runCommand: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  let stdout = '';
  console.log = (...values: unknown[]) => {
    stdout += `${values.map(String).join(' ')}\n`;
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await runCommand();
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
  return stdout;
}

/** A state index a test writes: its config (over the defaults) and its jobs. */
export interface StateSnapshot {
  version?: number;
  config?: Partial<StereoConfig> | null;
  jobs?: JobRecord[] | null;
}

// Writes a snapshot through the production write path (updateState, under
// the index lock): the snapshot's config over the defaults, and its jobs
// merged per id with the rows on disk the way any stale snapshot is
// (terminal rows absorb, a live job the snapshot drops keeps its row, a
// finished one leaves with its files).
export function seedState(workspace: string, snapshot: StateSnapshot): StereoState {
  return updateState(workspace, (state) => {
    state.config = { stopReviewGate: false, ...(snapshot.config ?? {}) };
    state.jobs = snapshot.jobs ?? [];
  });
}

// A job seeded through the production writers: its job file, then its index
// row (a different index row when a test needs the two to disagree).
export function seedJob(
  workspace: string,
  record: JobRecord,
  indexRecord: JobRecord = record,
): void {
  writeJobFile(workspace, record.id, record);
  upsertJob(workspace, indexRecord);
}

// The index row for one job, or undefined once it has left the index.
export function indexed(workspace: string, id: string): JobRecord | undefined {
  return listJobs(workspace).find((job) => job.id === id);
}

// Run synchronous work with process.stderr captured, returning both.
export function captureStderr<T>(work: () => T): { value: T; stderr: string } {
  const original = process.stderr.write;
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: work(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

// ---- Codex catalog fixtures (shared by the catalog, registry, role-default,
// setup, and doctor tests so one model-shape change lands in one place) ----

export function catalogEntry(
  id: string,
  fields: Partial<CodexCatalogModel> = {},
): CodexCatalogModel {
  const parsed = parseOpenAiModelId(id);
  return {
    id,
    family: parsed?.family ?? null,
    version: parsed?.version ?? null,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    ...fields,
  };
}

// One model as the app-server's model/list returns it; `efforts` lists its
// reasoning tiers, and any other field overrides the default.
export function liveModel(
  id: string,
  {
    efforts = ['low', 'medium', 'high', 'xhigh', 'max'],
    ...fields
  }: Record<string, unknown> & {
    efforts?: string[];
  } = {},
): Model {
  return {
    id,
    model: id,
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: efforts.map((effort) => ({
      reasoningEffort: effort,
      description: '',
    })),
    defaultReasoningEffort: 'medium',
    upgrade: null,
    upgradeInfo: null,
    ...fields,
  } as unknown as Model;
}

export function catalogFixture(
  models: CodexCatalogModel[],
  fields: Partial<CodexCatalog> = {},
): CodexCatalog {
  return {
    source: 'companion',
    path: '/fixture/codex-models.json',
    fetchedAt: '2026-09-24T00:00:00.000Z',
    models,
    problems: [],
    ...fields,
  };
}

const ULTRA: CodexCatalogModel['efforts'] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const MAX: CodexCatalogModel['efforts'] = ['low', 'medium', 'high', 'xhigh', 'max'];

// The account catalog as model/list listed it on 2026-09-24: what the fake
// Codex serves (unless a test writes its own), and, its visible models, what
// accountCatalogModels() gives in-process tests.
export const ACCOUNT_CATALOG: ReadonlyArray<{
  id: string;
  efforts: CodexCatalogModel['efforts'];
  hidden?: boolean;
  isDefault?: boolean;
  defaultEffort?: string;
  upgrade?: string;
  upgradeInfo?: Record<string, unknown>;
}> = [
  { id: 'gpt-6-astra', isDefault: true, efforts: ULTRA },
  { id: 'gpt-6-sol', efforts: ULTRA },
  { id: 'gpt-6-luna', efforts: MAX },
  { id: 'gpt-reserve', hidden: true, efforts: MAX },
  { id: 'gpt-5.6-sol', efforts: ULTRA, defaultEffort: 'low' },
  { id: 'gpt-5.6-terra', efforts: ULTRA },
  { id: 'gpt-5.6-luna', efforts: MAX },
  {
    id: 'gpt-5.5',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    upgrade: 'gpt-5.6-sol',
    upgradeInfo: {
      model: 'gpt-5.6-sol',
      upgradeCopy: null,
      modelLink: null,
      migrationMarkdown:
        'GPT-5.5 retires on October 14, 2026. Switch to GPT-5.6 Sol to continue working in Codex.',
      retirementAt: 1792004400,
    },
  },
  { id: 'codex-auto-review', hidden: true, efforts: MAX },
];

export function accountCatalogModels(): CodexCatalogModel[] {
  return ACCOUNT_CATALOG.filter((entry) => !entry.hidden).map((entry) =>
    catalogEntry(entry.id, { efforts: entry.efforts }),
  );
}

// The effort tiers accountCatalogModels() lists for gpt-6-astra, as the
// catalog refusals name them.
export const ASTRA_TIERS = 'low, medium, high, xhigh, max, ultra';

// ---- Claude fixtures (the fake `claude` as the setup, doctor, and render
// tests describe it, so one identity change lands in one place) ----

export const FAKE_CLAUDE_VERSION = '2.1.281';

// What the availability and auth probes report for the fake CLI.
export function claudeProbeFixture(): { availability: ClaudeAvailability; auth: ClaudeAuthStatus } {
  return {
    availability: {
      available: true,
      detail: `${FAKE_CLAUDE_VERSION} (Claude Code)`,
      version: FAKE_CLAUDE_VERSION,
      binary: 'claude',
    },
    auth: {
      available: true,
      loggedIn: true,
      detail: 'Claude login active for fake@example.com (team)',
    },
  };
}

// The Claude block of a setup report built from those probes.
export function claudeReportFixture(): {
  claude: { available: boolean; detail: string; version: string | null };
  claudeAuth: { loggedIn: boolean; detail: string };
} {
  const { availability, auth } = claudeProbeFixture();
  return {
    claude: {
      available: availability.available,
      detail: availability.detail,
      version: availability.version,
    },
    claudeAuth: { loggedIn: auth.loggedIn, detail: auth.detail },
  };
}

// ---- Doctor fixtures (the doctor and identity call-site tests) ----

// A ready setup report as the doctor embeds it, the fake Claude CLI included.
export function setupReportFixture(): Awaited<ReturnType<typeof buildSetupReport>> {
  return {
    ready: true,
    node: { available: true, detail: 'ok' },
    nodeEngine: {
      version: '24.0.0',
      major: 24,
      supported: true,
      detail: 'v24.0.0 (>= 24 required)',
    },
    npm: { available: true, detail: 'ok' },
    codex: { available: true, detail: 'ok' },
    writeSandbox: { available: true, detail: 'ok' },
    auth: {
      available: true,
      loggedIn: true,
      detail: 'ok',
      source: 'app-server',
      authMethod: 'chatgpt',
      verified: true,
      requiresOpenaiAuth: true,
      provider: 'openai',
      configuredProviders: [],
    },
    ...claudeReportFixture(),
    rateLimits: null,
    providers: { active: 'openai', configured: [], aliases: [] },
    sessionRuntime: {
      mode: 'direct',
      label: 'direct startup',
      detail: 'fixture runtime',
      endpoint: null,
    },
    strandedReservations: [],
    reviewGateEnabled: false,
    roleDefaults: [],
    actionsTaken: [],
    nextSteps: [],
  };
}

// The host's process seams with some replaced.
export function processOps(overrides: Partial<ProcessOps> = {}): ProcessOps {
  return {
    ...PROCESS_OPS,
    // Faked liveness means made-up pids, whose groups are never the host's.
    ...(overrides.processHasExited ? { groupHasMembers: () => false } : {}),
    ...overrides,
  };
}

// Doctor deps that touch nothing real: that setup report, no broker, no
// worktrees, and synthetic pids that are alive and read as a process carrying
// the worker's and the Claude child's markers, with no start; `ops` replaces
// some of those process seams.
export function doctorDeps(
  overrides: Partial<Omit<DoctorDeps, 'ops'>> & { ops?: Partial<ProcessOps> } = {},
): DoctorDeps {
  return {
    buildSetupReport: async () => setupReportFixture(),
    loadBrokerSession: () => null,
    probeBrokerEndpoint: async () => false,
    listWorktrees: () => ({ available: true, entries: [], detail: null }),
    ...overrides,
    ops: processOps({
      processHasExited: () => false,
      readProcessIdentity: () => ({
        commandLine: 'node /plugin/scripts/codex-companion.ts claude -p --permission-prompts none',
        start: null,
      }),
      ...overrides.ops,
    }),
  };
}

// A reservation lock another process holds (an acquire always records this
// one: a dead pid, a stand-in), created as acquireThreadReservation creates
// one; the result releases like a reservation.
export function writeReservationLock(
  threadId: string,
  owner: {
    pid: number;
    jobId?: string | null;
    pidStart?: string;
    childPid?: number;
    childPidStart?: string;
  },
): {
  threadId: string;
  token: string;
  pid: number;
  jobId: string | null;
  path: string;
  cleanupPath: string;
} {
  const lockPath = threadReservationPath(threadId);
  const token = crypto.randomUUID();
  const { pid, jobId = null, ...rest } = owner;
  const record = { token, pid, jobId, threadId, createdAt: new Date().toISOString(), ...rest };
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { threadId, token, pid, jobId, path: lockPath, cleanupPath: `${lockPath}.cleanup` };
}

// ---- Linux start tokens (`linux:<boot_id|->:<ticks>`) ----

export function ticksOf(start: string): number {
  return Number(start.slice(start.lastIndexOf(':') + 1));
}

// The same boot, other start ticks: another process on that pid.
export function withTicks(start: string, ticks: number): string {
  return `${start.slice(0, start.lastIndexOf(':') + 1)}${ticks}`;
}

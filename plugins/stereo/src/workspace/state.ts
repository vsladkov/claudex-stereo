import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TokenUsageBreakdown } from '../protocol/app-server.ts';
import { resolveCodexHome } from './thread-lock-io.ts';
import { resolveWorkspaceRoot } from './workspace.ts';

const STATE_VERSION = 1;
export const PLUGIN_DATA_ENV = 'CLAUDE_PLUGIN_DATA';
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), 'codex-companion');
const DURABLE_STATE_ROOT_DIR = 'companion-state';
const STATE_FILE_NAME = 'state.json';
const JOBS_DIR_NAME = 'jobs';
const PAIR_PLAN_FILE_NAME = 'pair-plan.json';
const PAIR_PLAN_MARKDOWN_FILE_NAME = 'pair-plan.md';
const MAX_JOBS = 50;
const migrationChecked = new Set<string>();

export interface StereoConfig {
  stopReviewGate: boolean;
}

export interface JobRecord {
  id: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  phase?: string | null;
  pid?: number | null;
  threadId?: string | null;
  turnId?: string | null;
  sessionId?: string;
  workspaceRoot?: string;
  title?: string;
  jobClass?: string;
  kind?: string;
  summary?: string;
  model?: string | null;
  errorMessage?: string;
  logFile?: string | null;
  request?: unknown;
  result?: unknown;
  rendered?: string;
  tokenUsage?: JobTokenUsage;
  [key: string]: unknown;
}

export interface JobTokenUsage {
  /** Tokens consumed by every model completion registered to this job capture. */
  job: TokenUsageBreakdown;
  /** Cumulative usage reported by the job's primary Codex thread. */
  thread: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export type JobPatch = Partial<JobRecord> & { id: string };

export interface StereoState {
  version: number;
  config: StereoConfig;
  jobs: JobRecord[];
}

// saveState tolerates stale or partial snapshots, so its input is looser than
// the fully-populated StereoState it returns.
export interface StereoStateInput {
  version?: number;
  config?: Partial<StereoConfig> | null;
  jobs?: JobRecord[] | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

function defaultState(): StereoState {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false,
    },
    jobs: [],
  };
}

// The shared index stores lightweight metadata; full request payloads live only in per-job files.
function stripIndexOnlyFields(job: JobRecord): JobRecord {
  const indexJob = { ...job };
  delete indexJob.request;
  return indexJob;
}

function resolveWorkspaceStateKey(cwd: string): string {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || 'workspace';
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const hash = createHash('sha256').update(canonicalWorkspaceRoot).digest('hex').slice(0, 16);
  return `${slug}-${hash}`;
}

// Ephemeral state must die with the plugin install. Only broker.json belongs
// here; durable config, jobs, logs, and pair-plan state use the resolver below.
export function resolveStateDir(cwd: string): string {
  const workspaceKey = resolveWorkspaceStateKey(cwd);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, 'state') : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, workspaceKey);
}

// Durable state survives plugin reinstalls and must never depend on
// CLAUDE_PLUGIN_DATA. The optional home is for child-process test inspection.
export function resolveDurableStateDir(cwd: string, codexHome = resolveCodexHome()): string {
  return path.join(codexHome, DURABLE_STATE_ROOT_DIR, resolveWorkspaceStateKey(cwd));
}

export function resolveStateFile(cwd: string): string {
  return path.join(resolveDurableStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd: string): string {
  return path.join(resolveDurableStateDir(cwd), JOBS_DIR_NAME);
}

function replaceLegacyLogFile(
  value: unknown,
  legacyJobsDir: string,
  durableJobsDir: string,
): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  if (value === legacyJobsDir) {
    return durableJobsDir;
  }
  const legacyPrefix = `${legacyJobsDir}${path.sep}`;
  return value.startsWith(legacyPrefix)
    ? path.join(durableJobsDir, value.slice(legacyPrefix.length))
    : value;
}

function rewriteJobLogFile(value: unknown, legacyJobsDir: string, durableJobsDir: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = { ...(value as Record<string, unknown>) };
  if (Object.hasOwn(record, 'logFile')) {
    record.logFile = replaceLegacyLogFile(record.logFile, legacyJobsDir, durableJobsDir);
  }
  return record;
}

function rewriteLegacyStateLogFiles(
  value: unknown,
  legacyJobsDir: string,
  durableJobsDir: string,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const state = { ...(value as Record<string, unknown>) };
  if (Array.isArray(state.jobs)) {
    state.jobs = state.jobs.map((job) => rewriteJobLogFile(job, legacyJobsDir, durableJobsDir));
  }
  return state;
}

function writeJsonExclusive(destination: string, value: unknown): void {
  try {
    fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'EEXIST') {
      throw error;
    }
  }
}

function copyFileExclusive(source: string, destination: string): void {
  try {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'EEXIST') {
      throw error;
    }
  }
}

function migrateLegacyJobs(legacyJobsDir: string, durableJobsDir: string, relativeDir = ''): void {
  const sourceDir = path.join(legacyJobsDir, relativeDir);
  if (!fs.existsSync(sourceDir)) {
    return;
  }
  const destinationDir = path.join(durableJobsDir, relativeDir);
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    const source = path.join(legacyJobsDir, relativePath);
    const destination = path.join(durableJobsDir, relativePath);
    if (entry.isDirectory()) {
      migrateLegacyJobs(legacyJobsDir, durableJobsDir, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.endsWith('.json')) {
      const parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
      writeJsonExclusive(destination, rewriteJobLogFile(parsed, legacyJobsDir, durableJobsDir));
      continue;
    }
    copyFileExclusive(source, destination);
  }
}

export function migrateLegacyState(cwd: string): void {
  const durableDir = resolveDurableStateDir(cwd);
  if (migrationChecked.has(durableDir)) {
    return;
  }
  const durableStateFile = path.join(durableDir, STATE_FILE_NAME);
  if (fs.existsSync(durableStateFile)) {
    migrationChecked.add(durableDir);
    return;
  }

  const legacyDir = resolveStateDir(cwd);
  const legacyStateFile = path.join(legacyDir, STATE_FILE_NAME);
  if (!fs.existsSync(legacyStateFile)) {
    migrationChecked.add(durableDir);
    return;
  }

  const legacyJobsDir = path.join(legacyDir, JOBS_DIR_NAME);
  const durableJobsDir = path.join(durableDir, JOBS_DIR_NAME);
  try {
    fs.mkdirSync(durableJobsDir, { recursive: true });
    migrateLegacyJobs(legacyJobsDir, durableJobsDir);

    const legacyPairPlanFile = path.join(legacyDir, PAIR_PLAN_FILE_NAME);
    if (fs.existsSync(legacyPairPlanFile)) {
      const pairPlan = JSON.parse(fs.readFileSync(legacyPairPlanFile, 'utf8'));
      writeJsonExclusive(path.join(durableDir, PAIR_PLAN_FILE_NAME), pairPlan);
    }

    // state.json is the migration marker and is deliberately published last.
    const legacyState = JSON.parse(fs.readFileSync(legacyStateFile, 'utf8'));
    writeJsonExclusive(
      durableStateFile,
      rewriteLegacyStateLogFiles(legacyState, legacyJobsDir, durableJobsDir),
    );
    if (fs.existsSync(durableStateFile)) {
      migrationChecked.add(durableDir);
    }
  } catch {
    // Migration is additive and best effort. Leaving the marker absent lets a
    // later access retry, while callers retain the pre-v1.7 fresh-state fallback.
  }
}

export function ensureStateDir(cwd: string): void {
  migrateLegacyState(cwd);
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd: string): StereoState {
  migrateLegacyState(cwd);
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {}),
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map(stripIndexOnlyFields) : [],
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs: JobRecord[]): JobRecord[] {
  return [...jobs]
    .sort((left, right) =>
      String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')),
    )
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath: string | null | undefined): void {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function readJobFileFresh(jobFile: string): { missing: boolean; record: JobRecord | null } {
  if (!fs.existsSync(jobFile)) {
    return { missing: true, record: null };
  }
  try {
    return { missing: false, record: JSON.parse(fs.readFileSync(jobFile, 'utf8')) };
  } catch {
    return { missing: false, record: null };
  }
}

export function saveState(cwd: string, state: StereoStateInput): StereoState {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []).map(stripIndexOnlyFields);

  // The caller's snapshot may be stale: a concurrent writer can have added or
  // updated a job between the caller's load and this save. Deleting artifacts
  // for any id merely absent from the snapshot would destroy a live job, so a
  // dropped id is deleted only when a fresh read of its own file shows a
  // terminal status; a live or unreadable record keeps its files and is
  // re-added to the written index (which may transiently exceed the prune cap).
  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    const jobFile = resolveJobFile(cwd, job.id);
    const fresh = readJobFileFresh(jobFile);
    if (fresh.missing) {
      continue;
    }
    if (fresh.record && TERMINAL_JOB_STATUSES.has(fresh.record.status)) {
      removeJobFile(jobFile);
      removeFileIfExists(fresh.record.logFile ?? job.logFile);
      continue;
    }
    nextJobs.push(stripIndexOnlyFields(fresh.record ?? job));
    retainedIds.add(job.id);
  }

  const nextState: StereoState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {}),
    },
    jobs: nextJobs,
  };

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
  return nextState;
}

export function updateState(cwd: string, mutate: (state: StereoState) => void): StereoState {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = 'job'): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd: string, jobPatch: JobPatch): StereoState {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch,
      } as JobRecord);
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp,
    } as JobRecord;
  });
}

export function listJobs(cwd: string): JobRecord[] {
  return loadState(cwd).jobs;
}

export function setConfig(cwd: string, key: string, value: unknown): StereoState {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value,
    };
  });
}

export function getConfig(cwd: string): StereoConfig {
  return loadState(cwd).config;
}

export function writeJobFile(cwd: string, jobId: string, payload: unknown): string {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return jobFile;
}

export function readJobFile(jobFile: string): JobRecord {
  return JSON.parse(fs.readFileSync(jobFile, 'utf8'));
}

function removeJobFile(jobFile: string): void {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd: string, jobId: string): string {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd: string, jobId: string): string {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolvePairPlanFile(cwd: string): string {
  return path.join(resolveDurableStateDir(cwd), PAIR_PLAN_FILE_NAME);
}

export function resolvePairPlanMarkdownFile(cwd: string): string {
  return path.join(resolveDurableStateDir(cwd), PAIR_PLAN_MARKDOWN_FILE_NAME);
}

export function savePairPlanState<T>(cwd: string, record: T): T {
  ensureStateDir(cwd);
  fs.writeFileSync(resolvePairPlanFile(cwd), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

export function loadPairPlanState(cwd: string): unknown {
  migrateLegacyState(cwd);
  const pairPlanFile = resolvePairPlanFile(cwd);
  if (!fs.existsSync(pairPlanFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(pairPlanFile, 'utf8'));
  } catch {
    return null;
  }
}

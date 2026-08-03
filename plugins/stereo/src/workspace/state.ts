import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TokenUsageBreakdown } from '../protocol/app-server.ts';
import { optionalString } from '../shared/json.ts';
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
const IMPLEMENT_STATE_FILE_NAME = 'implement-state.json';
const TOURNAMENT_STATE_FILE_NAME = 'tournament-state.json';
export const MAX_JOBS = 50;
const migrationChecked = new Set<string>();
const migrationWarningsEmitted = new Set<string>();

export type StereoRoleKey = 'planner' | 'planReviewer' | 'implementer' | 'implementationReviewer';

export interface StereoRoleDefault {
  model?: string | null;
  effort?: string | null;
}

export type StereoRoleDefaults = Partial<Record<StereoRoleKey, StereoRoleDefault>>;

export interface StereoConfig {
  stopReviewGate: boolean;
  roleDefaults?: StereoRoleDefaults;
  lastJobAnnouncementAt?: string | null;
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
      roleDefaults: {},
      lastJobAnnouncementAt: null,
    },
    jobs: [],
  };
}

const STEREO_ROLE_KEYS: readonly StereoRoleKey[] = [
  'planner',
  'planReviewer',
  'implementer',
  'implementationReviewer',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeRoleDefaults(value: unknown): StereoRoleDefaults {
  if (!isPlainObject(value)) {
    return {};
  }

  const normalized: StereoRoleDefaults = {};
  for (const key of STEREO_ROLE_KEYS) {
    const rawEntry = value[key];
    if (!isPlainObject(rawEntry)) {
      continue;
    }
    const model = optionalString(rawEntry.model);
    const effort = optionalString(rawEntry.effort);
    if (model || effort) {
      normalized[key] = { model, effort };
    }
  }
  return normalized;
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

export function writeTextAtomic(filePath: string, contents: string): void {
  const tempFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempFile, contents, 'utf8');
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Best-effort cleanup: preserve the original write/rename failure.
    }
    throw error;
  }
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function migrateLegacyJobs(
  legacyJobsDir: string,
  durableJobsDir: string,
  skipped: string[],
  relativeDir = '',
): void {
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
      migrateLegacyJobs(legacyJobsDir, durableJobsDir, skipped, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.endsWith('.json')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
      } catch {
        copyFileExclusive(source, destination);
        skipped.push(source);
        continue;
      }
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
  const skipped: string[] = [];
  try {
    fs.mkdirSync(durableJobsDir, { recursive: true });
    migrateLegacyJobs(legacyJobsDir, durableJobsDir, skipped);

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
      if (skipped.length > 0 && !migrationWarningsEmitted.has(durableDir)) {
        migrationWarningsEmitted.add(durableDir);
        process.stderr.write(
          `Stereo: skipped ${skipped.length} unreadable legacy job file(s) during state migration: ${skipped.join(', ')}.\n`,
        );
      }
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
    const parsedConfig = isPlainObject(parsed.config) ? parsed.config : {};
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...parsedConfig,
        roleDefaults: normalizeRoleDefaults(parsedConfig.roleDefaults),
        lastJobAnnouncementAt: optionalString(parsedConfig.lastJobAnnouncementAt),
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

export const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const DEFAULT_PLAN_SLOT = 'default';
const SAFE_PLAN_SLOT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isSafeJobId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_JOB_ID.test(id);
}

export function assertSafeJobId(id: string): string {
  if (!isSafeJobId(id)) {
    throw new Error(
      `Unsupported job id "${id}". Job ids may contain only letters, digits, hyphens, and underscores.`,
    );
  }
  return id;
}

export function normalizePlanSlot(value: unknown): string {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) {
    return DEFAULT_PLAN_SLOT;
  }
  const normalized = raw.toLowerCase();
  if (!SAFE_PLAN_SLOT.test(normalized)) {
    throw new Error(
      `Unsupported plan slot "${raw}". Plan slots may contain only letters, digits, hyphens, and underscores, must start with a letter or digit, and may be at most 64 characters.`,
    );
  }
  return normalized;
}

export function planSlotOrDefault(value: unknown): string {
  try {
    return normalizePlanSlot(value);
  } catch {
    return DEFAULT_PLAN_SLOT;
  }
}

function jobUpdatedAtMs(job: JobRecord): number {
  const parsed = Date.parse(job.updatedAt ?? '');
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function newerJobRecord(previous: JobRecord | undefined, candidate: JobRecord): JobRecord {
  if (!previous) {
    return candidate;
  }

  const previousTerminal = TERMINAL_JOB_STATUSES.has(previous.status);
  const candidateTerminal = TERMINAL_JOB_STATUSES.has(candidate.status);
  if (previousTerminal !== candidateTerminal) {
    return previousTerminal ? previous : candidate;
  }

  return jobUpdatedAtMs(candidate) >= jobUpdatedAtMs(previous) ? candidate : previous;
}

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
  const previousById = new Map(previousJobs.map((job) => [job.id, job]));
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(
    (state.jobs ?? []).map((job) => newerJobRecord(previousById.get(job.id), job)),
  ).map(stripIndexOnlyFields);

  // The caller's snapshot may be stale: a concurrent writer can have added or
  // updated a job between the caller's load and this save. Rows shared by both
  // snapshots are merged per id, with the newer updatedAt record winning within
  // the same terminality class. Terminal status is absorbing for a job id, so
  // no stale non-terminal snapshot can resurrect a completed, failed, or
  // cancelled row. Deleting artifacts for any id merely absent from the
  // snapshot would destroy a live job, so a dropped id is deleted only when a
  // fresh read of its own file shows a terminal status; a live or unreadable
  // record keeps its files and is re-added to the written index (which may
  // transiently exceed the prune cap).
  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    if (!isSafeJobId(job.id)) {
      nextJobs.push(stripIndexOnlyFields(job));
      retainedIds.add(job.id);
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
      roleDefaults: normalizeRoleDefaults(state.config?.roleDefaults),
      lastJobAnnouncementAt: optionalString(state.config?.lastJobAnnouncementAt),
    },
    jobs: nextJobs,
  };

  writeJsonAtomic(resolveStateFile(cwd), nextState);
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
  writeJsonAtomic(jobFile, payload);
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
  assertSafeJobId(jobId);
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd: string, jobId: string): string {
  assertSafeJobId(jobId);
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function readStoredJobOrNull(cwd: string, jobId: string): JobRecord | null {
  const jobFile = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  try {
    return readJobFile(jobFile);
  } catch {
    return null;
  }
}

export function resolvePairPlanFile(cwd: string, slot = DEFAULT_PLAN_SLOT): string {
  const normalizedSlot = normalizePlanSlot(slot);
  const fileName =
    normalizedSlot === DEFAULT_PLAN_SLOT ? PAIR_PLAN_FILE_NAME : `pair-plan-${normalizedSlot}.json`;
  return path.join(resolveDurableStateDir(cwd), fileName);
}

export function resolvePairPlanMarkdownFile(cwd: string, slot = DEFAULT_PLAN_SLOT): string {
  const normalizedSlot = normalizePlanSlot(slot);
  const fileName =
    normalizedSlot === DEFAULT_PLAN_SLOT
      ? PAIR_PLAN_MARKDOWN_FILE_NAME
      : `pair-plan-${normalizedSlot}.md`;
  return path.join(resolveDurableStateDir(cwd), fileName);
}

export function resolveImplementStateFile(cwd: string): string {
  return path.join(resolveDurableStateDir(cwd), IMPLEMENT_STATE_FILE_NAME);
}

export function saveImplementState<T>(cwd: string, record: T): T {
  ensureStateDir(cwd);
  writeJsonAtomic(resolveImplementStateFile(cwd), record);
  return record;
}

export function readImplementStateFile(cwd: string): {
  missing: boolean;
  record: unknown;
  parseError: string | null;
} {
  const implementStateFile = resolveImplementStateFile(cwd);
  if (!fs.existsSync(implementStateFile)) {
    return { missing: true, record: null, parseError: null };
  }
  try {
    return {
      missing: false,
      record: JSON.parse(fs.readFileSync(implementStateFile, 'utf8')),
      parseError: null,
    };
  } catch (error) {
    return {
      missing: false,
      record: null,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function loadImplementState(cwd: string): unknown {
  return readImplementStateFile(cwd).record;
}

export function clearImplementState(cwd: string): string[] {
  const implementStateFile = resolveImplementStateFile(cwd);
  try {
    fs.unlinkSync(implementStateFile);
    return [implementStateFile];
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') {
      throw error;
    }
    return [];
  }
}

export function resolveTournamentStateFile(cwd: string): string {
  return path.join(resolveDurableStateDir(cwd), TOURNAMENT_STATE_FILE_NAME);
}

export function saveTournamentState<T>(cwd: string, record: T): T {
  ensureStateDir(cwd);
  writeJsonAtomic(resolveTournamentStateFile(cwd), record);
  return record;
}

export function readTournamentStateFile(cwd: string): {
  missing: boolean;
  record: unknown;
  parseError: string | null;
} {
  const tournamentStateFile = resolveTournamentStateFile(cwd);
  if (!fs.existsSync(tournamentStateFile)) {
    return { missing: true, record: null, parseError: null };
  }
  try {
    return {
      missing: false,
      record: JSON.parse(fs.readFileSync(tournamentStateFile, 'utf8')),
      parseError: null,
    };
  } catch (error) {
    return {
      missing: false,
      record: null,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function loadTournamentState(cwd: string): unknown {
  return readTournamentStateFile(cwd).record;
}

export function clearTournamentState(cwd: string): string[] {
  const tournamentStateFile = resolveTournamentStateFile(cwd);
  try {
    fs.unlinkSync(tournamentStateFile);
    return [tournamentStateFile];
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') {
      throw error;
    }
    return [];
  }
}

export function fingerprintPlanText(plan: unknown): string | null {
  if (typeof plan !== 'string' || !plan.trim()) {
    return null;
  }
  return createHash('sha256').update(String(plan)).digest('hex').slice(0, 32);
}

export function savePairPlanState<T>(cwd: string, record: T, slot = DEFAULT_PLAN_SLOT): T {
  ensureStateDir(cwd);
  writeJsonAtomic(resolvePairPlanFile(cwd, slot), record);
  return record;
}

export function loadPairPlanState(cwd: string, slot = DEFAULT_PLAN_SLOT): unknown {
  migrateLegacyState(cwd);
  const pairPlanFile = resolvePairPlanFile(cwd, slot);
  if (!fs.existsSync(pairPlanFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(pairPlanFile, 'utf8'));
  } catch {
    return null;
  }
}

export function clearPairPlanState(cwd: string, slot = DEFAULT_PLAN_SLOT): string[] {
  // Clear after the same legacy migration used by loadPairPlanState so a
  // pre-v1.7 record cannot be copied into durable state on a later read.
  migrateLegacyState(cwd);
  const removed: string[] = [];
  for (const filePath of [resolvePairPlanFile(cwd, slot), resolvePairPlanMarkdownFile(cwd, slot)]) {
    try {
      fs.unlinkSync(filePath);
      removed.push(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return removed;
}

export function listPairPlanSlots(cwd: string): string[] {
  migrateLegacyState(cwd);
  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(resolveDurableStateDir(cwd));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const slots = new Set<string>();
  for (const fileName of fileNames) {
    if (fileName === PAIR_PLAN_FILE_NAME) {
      slots.add(DEFAULT_PLAN_SLOT);
      continue;
    }
    const match = /^pair-plan-(.+)\.json$/.exec(fileName);
    const slot = match?.[1];
    if (!slot || slot === DEFAULT_PLAN_SLOT || !SAFE_PLAN_SLOT.test(slot)) {
      continue;
    }
    slots.add(slot);
  }

  return [...slots].sort((left, right) => {
    if (left === DEFAULT_PLAN_SLOT) {
      return right === DEFAULT_PLAN_SLOT ? 0 : -1;
    }
    if (right === DEFAULT_PLAN_SLOT) {
      return 1;
    }
    return left.localeCompare(right);
  });
}

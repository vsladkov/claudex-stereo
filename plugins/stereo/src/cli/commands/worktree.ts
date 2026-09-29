import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { ensureGitRepository, git, gitChecked, listWorktrees } from '../../platform/git.ts';
import type { WorktreeEntry } from '../../platform/git.ts';
import { formatCommandFailure, PROBE_TIMEOUT_MS } from '../../platform/process.ts';
import type { CommandResult, RunCommandOptions } from '../../platform/process.ts';
import { canonicalPath, isWithin } from '../../shared/fs.ts';
import { COMPANION_ENTRY } from '../../shared/paths.ts';
import { shellQuote } from '../../shared/text.ts';
import { outputReportResult, parseCommandInput, resolveCommandCwd } from '../io.ts';
import type { CommandOptions } from '../io.ts';
import { errorCode, errorMessage } from '../../shared/errors.ts';

// Gitignored dependency directories an isolated worktree borrows from the
// main tree instead of reinstalling. `target` (Rust) is deliberately absent:
// it is build output that a cargo run in the worktree rewrites, so sharing it
// would let a contestant's build clobber the main tree's.
const DEPENDENCY_DIRECTORIES = ['node_modules', '.venv', 'venv', 'vendor/bundle'] as const;

const NOT_IGNORED_REASON = 'not ignored by the main tree';
const ALREADY_PRESENT_REASON = 'already present in the worktree';

export interface SkippedDependency {
  name: string;
  reason: string;
}

export interface WorktreeCreateResult {
  /** The worktree path exactly as `git worktree list --porcelain` reports it. */
  path: string;
  /** Dependency directories linked from the main tree, relative, `/`-separated. */
  linked: string[];
  /** Dependency directories present in the main tree but not linked, with why. */
  skipped: SkippedDependency[];
  /** The command that removes this worktree (see worktreeRemoveCommand). */
  removeCommand: string;
}

export interface WorktreeRemoveResult {
  removed: string;
}

// Every git query is bounded like the other git probes, so a hung git (a
// credential helper, a network filesystem) fails the command instead of
// stalling it. The writes (adding a worktree writes a whole checkout,
// removing one deletes it) run unbounded.
const PROBE: RunCommandOptions = { timeout: PROBE_TIMEOUT_MS };

// A git step whose failure says what it was doing: `<failure>: <git's own
// failure text>`.
function gitStep(
  failure: string,
  cwd: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): CommandResult {
  try {
    return gitChecked(cwd, args, options);
  } catch (error) {
    throw new Error(`${failure}: ${errorMessage(error)}`);
  }
}

// The removal command every printed cleanup names: the companion's own
// removal (it unlinks the dependency links before git removes the tree, so a
// forced removal never reaches the main tree's directories through them),
// runnable as printed, with the companion's absolute path.
export function worktreeRemoveCommand(mainRoot: string, worktreePath: string): string {
  return `node ${shellQuote(COMPANION_ENTRY)} worktree remove --main ${shellQuote(mainRoot)} --path ${shellQuote(worktreePath)}`;
}

function pathOption(options: CommandOptions, key: 'main' | 'path'): string | null {
  const raw = typeof options[key] === 'string' ? options[key].trim() : '';
  return raw ? path.resolve(resolveCommandCwd(options), raw) : null;
}

function requirePathOption(options: CommandOptions, key: 'main' | 'path', missing: string): string {
  const resolved = pathOption(options, key);
  if (!resolved) {
    throw new Error(missing);
  }
  return resolved;
}

// Where `worktree create` puts a worktree when --path is omitted: a fresh
// directory under the system temp directory, outside every repository.
function defaultWorktreePath(mainRoot: string): string {
  const slug =
    path
      .basename(mainRoot)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-') || 'repo';
  return path.join(
    os.tmpdir(),
    'stereo-worktrees',
    `${slug}-${crypto.randomBytes(4).toString('hex')}`,
  );
}

// Windows paths compare case-insensitively (git reports `C:/...`, Node
// `c:\...` or `C:\...`); every other platform compares exactly.
function samePath(left: string, right: string): boolean {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

// The canonical form of a path that need not exist yet: its nearest
// existing ancestor resolved (symlinks, Windows short names), the rest
// appended.
function canonicalTarget(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  while (!pathExists(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(canonicalPath(current), ...missing);
}

// The working-tree root of --main, which must be an existing directory
// inside a non-bare Git repository.
function resolveMainRoot(options: CommandOptions): string {
  const main = requirePathOption(options, 'main', 'Provide the main repository root with --main.');
  if (!isDirectory(main)) {
    throw new Error(`--main ${main} is not an existing directory.`);
  }
  return canonicalPath(
    ensureGitRepository(main, `--main ${main} is not inside a Git working tree.`),
  );
}

function listWorktreeEntries(mainRoot: string): WorktreeEntry[] {
  const listing = listWorktrees(mainRoot);
  if (!listing.available) {
    throw new Error(`Could not list the worktrees of ${mainRoot}: ${listing.detail}`);
  }
  return listing.entries;
}

// A symlink (POSIX) or directory junction (Windows) is removed as a link:
// never followed, so the main tree's directory it points at is untouched.
function removeLinkIfPresent(link: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(link);
  } catch {
    return;
  }
  if (!stats.isSymbolicLink()) {
    return;
  }
  try {
    fs.unlinkSync(link);
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'EPERM' && code !== 'EISDIR') {
      throw error;
    }
    fs.rmdirSync(link);
  }
}

function removeDependencyLinks(worktreePath: string): void {
  for (const name of DEPENDENCY_DIRECTORIES) {
    removeLinkIfPresent(path.join(worktreePath, ...name.split('/')));
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function dependencyOrder(skipped: SkippedDependency): number {
  return DEPENDENCY_DIRECTORIES.indexOf(skipped.name as (typeof DEPENDENCY_DIRECTORIES)[number]);
}

// Which of the main tree's dependency directories may be linked, decided
// before the worktree exists. Only a directory the main tree already ignores
// qualifies: the exclude line a link needs lands in the exclude file every
// worktree shares with the main tree, so for any other directory that line
// would change what the main tree's `git status` shows.
function planDependencyLinks(mainRoot: string): {
  candidates: string[];
  skipped: SkippedDependency[];
} {
  const present = DEPENDENCY_DIRECTORIES.filter((name) =>
    isDirectory(path.join(mainRoot, ...name.split('/'))),
  );
  if (present.length === 0) {
    return { candidates: [], skipped: [] };
  }
  // One query for every directory present. The trailing slash asks about the
  // directory, so `node_modules/`-style rules count; git prints the ignored
  // ones as given and exits 1 when none is (a tracked directory is not).
  const result = git(mainRoot, ['check-ignore', '--', ...present.map((name) => `${name}/`)], PROBE);
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(
      `Could not check whether the main tree ignores ${present.join(', ')}: ${result.error?.message ?? formatCommandFailure(result)}`,
    );
  }
  const ignored = new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()));
  return {
    candidates: present.filter((name) => ignored.has(`${name}/`)),
    skipped: present
      .filter((name) => !ignored.has(`${name}/`))
      .map((name) => ({ name, reason: NOT_IGNORED_REASON })),
  };
}

// Each planned directory becomes a relative symlink at the same place in the
// worktree (a junction on Windows, which needs no symlink privilege and
// always stores an absolute target). A path the checkout already holds (a
// post-checkout hook's output) is left alone and reported as skipped.
function linkDependencyDirectories(
  mainRoot: string,
  worktreePath: string,
  candidates: readonly string[],
  skipped: SkippedDependency[],
): string[] {
  const linked: string[] = [];
  for (const name of candidates) {
    const segments = name.split('/');
    const source = path.join(mainRoot, ...segments);
    const link = path.join(worktreePath, ...segments);
    if (pathExists(link)) {
      skipped.push({ name, reason: ALREADY_PRESENT_REASON });
      continue;
    }
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (process.platform === 'win32') {
      fs.symlinkSync(source, link, 'junction');
    } else {
      fs.symlinkSync(path.relative(path.dirname(link), source), link);
    }
    linked.push(name);
  }
  skipped.sort((left, right) => dependencyOrder(left) - dependencyOrder(right));
  return linked;
}

// A symlink is a file to git, so a directory-only ignore rule
// (`node_modules/`) never matches it and the link would surface as untracked
// (and be swept into `git add -A` or a `git diff` of intent-to-add paths).
// Each link gets an anchored, slash-free pattern in the exclude file git
// resolves for the worktree - for a linked worktree, the main repository's
// own info/exclude, shared by every worktree. Only directories the main tree
// already ignores are linked, so each line matches what an existing rule
// already ignores there; lines already present are not repeated.
function excludeLinkedPaths(worktreePath: string, linked: readonly string[]): void {
  if (linked.length === 0) {
    return;
  }
  const gitPath = gitStep(
    `Could not locate the exclude file of ${worktreePath}`,
    worktreePath,
    ['rev-parse', '--git-path', 'info/exclude'],
    PROBE,
  ).stdout.trim();
  const excludeFile = path.resolve(worktreePath, gitPath);
  let existing = '';
  try {
    existing = fs.readFileSync(excludeFile, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = linked.map((name) => `/${name}`).filter((pattern) => !present.has(pattern));
  if (missing.length > 0) {
    const separator = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.appendFileSync(excludeFile, `${separator}${missing.join('\n')}\n`, 'utf8');
  }
}

function findRegisteredEntry(
  entries: readonly WorktreeEntry[],
  worktreePath: string,
): { entry: WorktreeEntry; index: number } | null {
  const index = entries.findIndex((entry) => samePath(entry.path, worktreePath));
  const entry = index === -1 ? undefined : entries[index];
  return entry ? { entry, index } : null;
}

// Best effort after a failed provisioning step: the links go first so a
// removal can never reach through them into the main tree. Returns why the
// rollback did not complete, or null when git removed the worktree again.
function rollBackWorktree(mainRoot: string, worktreePath: string): string | null {
  try {
    removeDependencyLinks(worktreePath);
  } catch {
    // The removal below still runs; a leftover link is reported by git.
  }
  for (const args of [
    ['worktree', 'remove', '--force', worktreePath],
    ['worktree', 'prune'],
  ]) {
    const result = git(mainRoot, args);
    if (result.error || result.status !== 0) {
      return `git ${args.slice(0, 2).join(' ')} failed: ${result.error?.message ?? formatCommandFailure(result)}`;
    }
  }
  return null;
}

function createWorktree(options: CommandOptions): WorktreeCreateResult {
  const mainRoot = resolveMainRoot(options);
  const target = pathOption(options, 'path') ?? defaultWorktreePath(mainRoot);
  // A worktree inside the main tree would show up in its status, and a
  // removal of one could reach the other's files.
  if (isWithin(canonicalTarget(target), mainRoot)) {
    throw new Error(
      `--path ${target} is inside the main working tree ${mainRoot}; create the worktree outside it.`,
    );
  }
  if (pathExists(target)) {
    throw new Error(`--path ${target} already exists; worktree create needs a new path.`);
  }
  const { candidates, skipped } = planDependencyLinks(mainRoot);
  gitStep(`Could not create the worktree at ${target}`, mainRoot, [
    'worktree',
    'add',
    '--detach',
    target,
    'HEAD',
  ]);

  const worktreePath = canonicalPath(target);
  try {
    // Git records the worktree's physical path (macOS /private/var, Windows
    // C:/ form): report that exact string so callers compare like with like.
    const registered = findRegisteredEntry(listWorktreeEntries(mainRoot), worktreePath);
    const linked = linkDependencyDirectories(mainRoot, worktreePath, candidates, skipped);
    excludeLinkedPaths(worktreePath, linked);
    const reportedPath = registered?.entry.path ?? worktreePath;
    return {
      path: reportedPath,
      linked,
      skipped,
      removeCommand: worktreeRemoveCommand(mainRoot, reportedPath),
    };
  } catch (error) {
    const rollbackFailure = rollBackWorktree(mainRoot, worktreePath);
    const message = errorMessage(error);
    throw new Error(
      rollbackFailure === null
        ? `Could not provision the worktree at ${worktreePath} (it was removed again): ${message}`
        : `Could not provision the worktree at ${worktreePath}, and removing it again failed (${rollbackFailure}); remove it with ${worktreeRemoveCommand(mainRoot, worktreePath)}: ${message}`,
    );
  }
}

function removeWorktree(options: CommandOptions): WorktreeRemoveResult {
  const mainRoot = resolveMainRoot(options);
  const target = requirePathOption(options, 'path', 'Provide the worktree path with --path.');
  const registered = findRegisteredEntry(listWorktreeEntries(mainRoot), target);
  if (!registered) {
    throw new Error(`--path ${target} is not a registered worktree of ${mainRoot}.`);
  }
  if (registered.index === 0) {
    throw new Error(
      `--path ${target} is the main working tree of ${mainRoot}; worktree remove only removes linked worktrees.`,
    );
  }
  const reportedPath = registered.entry.path;
  // The exclude lines create wrote stay behind on purpose: they live in the
  // exclude file the main tree and every worktree share, and each was written
  // only for a directory the main tree already ignored, so it is equivalent
  // to an existing ignore and changes no tree's status. The links go before
  // the removal, so it can never reach through them into the main tree (a
  // worktree git refuses to remove, a locked one, keeps its checkout).
  removeDependencyLinks(canonicalPath(target));
  gitStep(
    `Could not remove the worktree at ${reportedPath} after removing its dependency links`,
    mainRoot,
    ['worktree', 'remove', '--force', reportedPath],
  );
  gitStep(`Removed the worktree at ${reportedPath}, but git worktree prune failed`, mainRoot, [
    'worktree',
    'prune',
  ]);
  return { removed: reportedPath };
}

function renderCreate(result: WorktreeCreateResult): string {
  const lines = [`Created detached worktree ${result.path} at HEAD.`];
  if (result.linked.length > 0) {
    lines.push(`Linked from the main tree: ${result.linked.join(', ')}.`);
  } else if (result.skipped.length > 0) {
    lines.push('Linked from the main tree: none.');
  } else {
    lines.push('Linked from the main tree: none (no dependency directories present).');
  }
  if (result.skipped.length > 0) {
    const entries = result.skipped.map((entry) => `${entry.name} (${entry.reason})`);
    lines.push(`Skipped: ${entries.join(', ')}.`);
  }
  lines.push(`Remove it with ${result.removeCommand}.`);
  return `${lines.join('\n')}\n`;
}

export function handleWorktree(argv: string[]): void {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd', 'main', 'path'],
    booleanOptions: ['json'],
  });
  const [action, ...rest] = positionals;
  if (!action) {
    throw new Error('worktree takes an action: create or remove.');
  }
  if (action !== 'create' && action !== 'remove') {
    throw new Error(`Unknown worktree action "${action}"; use create or remove.`);
  }
  if (rest.length > 0) {
    throw new Error(`worktree ${action} takes only flags; unexpected positional arguments.`);
  }

  if (action === 'create') {
    const result = createWorktree(options);
    outputReportResult(result, renderCreate(result), options.json);
    return;
  }
  const result = removeWorktree(options);
  outputReportResult(result, `Removed worktree ${result.removed}.\n`, options.json);
}

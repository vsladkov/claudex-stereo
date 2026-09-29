import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { loadBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import { worktreeRemoveCommand } from '../plugins/stereo/src/cli/commands/worktree.ts';
import { parseWorktreePorcelain } from '../plugins/stereo/src/platform/git.ts';
import { COMPANION_ENTRY } from '../plugins/stereo/src/shared/paths.ts';
import { initGitRepo, makeTempDir, run } from './helpers.ts';
import type { RunResult } from './helpers.ts';
import { SCRIPT, runCliInProcess } from './runtime-helpers.ts';

// `worktree` only runs git: it never launches a runtime or a broker, so this
// file spawns nothing that would need reaping and runs on the Windows lane.
// There a dependency link is a directory junction, whose target Node reports
// in absolute form; the relative-target and symlinked-parent assertions are
// POSIX-only, as is the control that shows git listing an unexcluded link
// (Git for Windows may treat a junction as the ignored directory itself).
const POSIX = process.platform !== 'win32';

function git(cwd: string, args: string[]): RunResult {
  const result = run('git', args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result;
}

function runWorktree(cwd: string, args: string[]): RunResult {
  return run(process.execPath, [SCRIPT, 'worktree', ...args], { cwd });
}

// A committed repository whose .gitignore names its dependency directories
// the usual trailing-slash way, with every candidate directory present.
function makeMainRepo(
  dependencies: readonly string[] = DEPENDENCIES,
  gitignore = 'node_modules/\n.venv/\nvenv/\n/vendor/bundle/\ntarget/\n',
): string {
  const main = path.join(makeTempDir('worktree-main-'), 'main');
  fs.mkdirSync(main);
  initGitRepo(main);
  fs.writeFileSync(path.join(main, '.gitignore'), gitignore);
  fs.writeFileSync(path.join(main, 'app.txt'), 'app\n');
  git(main, ['add', '.']);
  git(main, ['commit', '-q', '-m', 'init']);
  for (const name of dependencies) {
    fs.mkdirSync(path.join(main, ...name.split('/')), { recursive: true });
    fs.writeFileSync(path.join(main, ...name.split('/'), 'marker.txt'), name);
  }
  return main;
}

const DEPENDENCIES = ['node_modules', '.venv', 'venv', 'vendor/bundle', 'target'];

function worktreeEntries(main: string) {
  return parseWorktreePorcelain(git(main, ['worktree', 'list', '--porcelain']).stdout);
}

function excludeFileOf(worktree: string): string {
  const gitPath = git(worktree, ['rev-parse', '--git-path', 'info/exclude']).stdout.trim();
  return path.resolve(worktree, gitPath);
}

function readIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

// Everything the main tree's status shows, ignored entries included.
function mainStatus(main: string): string {
  return git(main, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored']).stdout;
}

function excludeLines(worktree: string): string[] {
  return fs
    .readFileSync(excludeFileOf(worktree), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'));
}

function createJson(main: string, worktree: string) {
  const result = runWorktree(main, ['create', '--main', main, '--path', worktree, '--json']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    path: string;
    linked: string[];
    skipped: Array<{ name: string; reason: string }>;
    removeCommand: string;
    rendered: string;
  };
}

// The line every create report ends with: how to remove the worktree.
function removeLine(main: string, worktreePath: string): string {
  const mainRoot = fs.realpathSync.native(worktreeEntries(main)[0]!.path);
  return `Remove it with ${worktreeRemoveCommand(mainRoot, worktreePath)}.\n`;
}

test('worktree create links dependency directories and remove round-trips', () => {
  const main = makeMainRepo();
  const worktree = path.join(path.dirname(main), 'wt-one');
  const statusBefore = mainStatus(main);

  const created = createJson(main, worktree);
  // target is build output, never linked.
  assert.deepEqual(created.linked, ['node_modules', '.venv', 'venv', 'vendor/bundle']);
  assert.deepEqual(created.skipped, []);
  assert.equal(mainStatus(main), statusBefore, "the main tree's status is unchanged");
  const entries = worktreeEntries(main);
  assert.equal(entries.length, 2);
  assert.equal(created.path, entries[1]!.path, 'the path is the one git reports');
  assert.equal(entries[1]!.detached, true);
  assert.equal(entries[1]!.head, entries[0]!.head, 'detached at the main HEAD');
  const mainRoot = fs.realpathSync.native(entries[0]!.path);
  assert.equal(created.removeCommand, worktreeRemoveCommand(mainRoot, created.path));
  assert.equal(
    created.rendered,
    `Created detached worktree ${created.path} at HEAD.\n` +
      'Linked from the main tree: node_modules, .venv, venv, vendor/bundle.\n' +
      removeLine(main, created.path),
  );

  for (const name of created.linked) {
    const link = path.join(worktree, ...name.split('/'));
    const source = path.join(main, ...name.split('/'));
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, `${name} is a link`);
    assert.equal(fs.realpathSync.native(link), fs.realpathSync.native(source));
    assert.equal(fs.readFileSync(path.join(link, 'marker.txt'), 'utf8'), name);
    if (POSIX) {
      assert.equal(fs.readlinkSync(link), path.relative(path.dirname(link), source));
    }
  }
  assert.equal(fs.existsSync(path.join(worktree, 'target')), false);

  // Each link is excluded once, by an anchored pattern in the shared file.
  const lines = excludeLines(worktree);
  for (const name of created.linked) {
    assert.equal(lines.filter((line) => line === `/${name}`).length, 1, name);
  }
  assert.equal(loadBrokerSession(main), null, 'worktree never starts the workspace broker');
  assert.equal(loadBrokerSession(worktree), null);

  const removed = runWorktree(main, ['remove', '--main', main, '--path', worktree, '--json']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(removed.stdout), {
    removed: created.path,
    rendered: `Removed worktree ${created.path}.\n`,
  });
  assert.equal(fs.existsSync(worktree), false);
  assert.deepEqual(
    worktreeEntries(main).map((entry) => entry.path),
    [entries[0]!.path],
  );
  // Removal unlinks, never follows: the main tree's dependencies survive.
  for (const name of DEPENDENCIES) {
    assert.equal(
      fs.readFileSync(path.join(main, ...name.split('/'), 'marker.txt'), 'utf8'),
      name,
      name,
    );
  }
  assert.equal(loadBrokerSession(main), null);
});

test('a second worktree repeats no exclude line', () => {
  const main = makeMainRepo(['node_modules']);
  const first = createJson(main, path.join(path.dirname(main), 'wt-a'));
  const second = createJson(main, path.join(path.dirname(main), 'wt-b'));

  assert.deepEqual(first.linked, ['node_modules']);
  assert.deepEqual(second.linked, ['node_modules']);
  const lines = excludeLines(path.join(path.dirname(main), 'wt-b'));
  assert.equal(lines.filter((line) => line === '/node_modules').length, 1);
});

test('worktree create with no dependency directories links and excludes nothing', () => {
  const main = makeMainRepo([]);
  const worktree = path.join(path.dirname(main), 'wt-bare');
  const excludeBefore = readIfExists(excludeFileOf(main));

  const result = runWorktree(main, ['create', '--main', main, '--path', worktree]);
  assert.equal(result.status, 0, result.stderr);
  const reported = worktreeEntries(main)[1]!.path;
  assert.equal(
    result.stdout,
    `Created detached worktree ${reported} at HEAD.\n` +
      'Linked from the main tree: none (no dependency directories present).\n' +
      removeLine(main, reported),
  );
  assert.equal(readIfExists(excludeFileOf(worktree)), excludeBefore);
});

test('a dependency directory the main tree does not ignore is neither linked nor excluded', () => {
  const main = makeMainRepo(['node_modules'], 'target/\n');
  const worktree = path.join(path.dirname(main), 'wt-unignored');
  const excludeBefore = readIfExists(excludeFileOf(main));
  const statusBefore = mainStatus(main);
  assert.match(statusBefore, /^\?\? node_modules\/marker\.txt$/m);

  const created = createJson(main, worktree);
  assert.deepEqual(created.linked, []);
  assert.deepEqual(created.skipped, [
    { name: 'node_modules', reason: 'not ignored by the main tree' },
  ]);
  assert.equal(
    created.rendered,
    `Created detached worktree ${created.path} at HEAD.\n` +
      'Linked from the main tree: none.\n' +
      'Skipped: node_modules (not ignored by the main tree).\n' +
      removeLine(main, created.path),
  );
  assert.equal(fs.existsSync(path.join(worktree, 'node_modules')), false);
  assert.equal(readIfExists(excludeFileOf(worktree)), excludeBefore);
  assert.equal(mainStatus(main), statusBefore, "the main tree's status is unchanged");
});

test('worktree create links the ignored directories and skips the rest in order', () => {
  const main = makeMainRepo(['node_modules', '.venv', 'venv'], '.venv/\n');
  const statusBefore = mainStatus(main);

  const created = createJson(main, path.join(path.dirname(main), 'wt-mixed'));
  assert.deepEqual(created.linked, ['.venv']);
  assert.deepEqual(created.skipped, [
    { name: 'node_modules', reason: 'not ignored by the main tree' },
    { name: 'venv', reason: 'not ignored by the main tree' },
  ]);
  assert.equal(
    created.rendered,
    `Created detached worktree ${created.path} at HEAD.\n` +
      'Linked from the main tree: .venv.\n' +
      'Skipped: node_modules (not ignored by the main tree), venv (not ignored by the main tree).\n' +
      removeLine(main, created.path),
  );
  assert.equal(mainStatus(main), statusBefore, "the main tree's status is unchanged");
});

test('worktree create leaves a path the checkout already holds', { skip: !POSIX }, () => {
  // Windows skip: the hook is a POSIX shell script.
  const main = makeMainRepo(['node_modules']);
  const hook = path.join(main, '.git', 'hooks', 'post-checkout');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/bin/sh\nmkdir -p node_modules\n', { mode: 0o755 });
  const worktree = path.join(path.dirname(main), 'wt-hooked');

  const created = createJson(main, worktree);
  assert.deepEqual(created.linked, []);
  assert.deepEqual(created.skipped, [
    { name: 'node_modules', reason: 'already present in the worktree' },
  ]);
  const holder = fs.lstatSync(path.join(worktree, 'node_modules'));
  assert.equal(holder.isSymbolicLink(), false);
  assert.equal(holder.isDirectory(), true);
});

test('worktree create refuses a path that exists', () => {
  const main = makeMainRepo(['node_modules']);
  const worktree = path.join(path.dirname(main), 'taken');
  fs.mkdirSync(worktree);
  const message = `--path ${worktree} already exists; worktree create needs a new path.`;

  const json = runWorktree(main, ['create', '--main', main, '--path', worktree, '--json']);
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stdout), { error: message });
  assert.equal(json.stderr, `${message}\n`);

  const plain = runWorktree(main, ['create', '--main', main, '--path', worktree]);
  assert.equal(plain.status, 1);
  assert.equal(plain.stdout, '');
  assert.equal(plain.stderr, `${message}\n`);

  assert.equal(worktreeEntries(main).length, 1, 'no worktree was added');
  assert.deepEqual(fs.readdirSync(worktree), []);
});

test('worktree create reports the canonical path git records', { skip: !POSIX }, () => {
  // Windows skip: an aliased parent needs a directory symlink (a privilege)
  // or a junction, whose resolution by git differs from a symlink's.
  const main = makeMainRepo(['node_modules']);
  const realParent = makeTempDir('worktree-real-');
  const alias = path.join(path.dirname(main), 'alias');
  fs.symlinkSync(realParent, alias);

  const created = createJson(main, path.join(alias, 'wt'));
  assert.equal(created.path, path.join(realParent, 'wt'));
  assert.equal(created.path, worktreeEntries(main)[1]!.path);

  // Relative --main and --path resolve against --cwd; remove accepts the alias.
  const relative = run(
    process.execPath,
    [SCRIPT, 'worktree', 'create', '--cwd', main, '--main', '.', '--path', '../wt-rel', '--json'],
    { cwd: realParent },
  );
  assert.equal(relative.status, 0, relative.stderr);
  assert.equal(JSON.parse(relative.stdout).path, path.join(path.dirname(main), 'wt-rel'));

  const removed = runWorktree(main, [
    'remove',
    '--main',
    main,
    '--path',
    path.join(alias, 'wt'),
    '--json',
  ]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).removed, path.join(realParent, 'wt'));
});

test('a linked dependency directory stays out of git status and intent-to-add diffs', () => {
  const main = makeMainRepo(['node_modules']);

  if (POSIX) {
    // Control: a plain symlink escapes the directory-only `node_modules/`
    // rule, which is the bug the exclude line fixes.
    const control = path.join(path.dirname(main), 'wt-control');
    git(main, ['worktree', 'add', '--detach', control, 'HEAD']);
    fs.symlinkSync(path.join('..', 'main', 'node_modules'), path.join(control, 'node_modules'));
    assert.match(
      git(control, ['status', '--porcelain=v1', '--untracked-files=all']).stdout,
      /^\?\? node_modules$/m,
    );
    fs.unlinkSync(path.join(control, 'node_modules'));
    git(main, ['worktree', 'remove', '--force', control]);
  }

  const worktree = path.join(path.dirname(main), 'wt-status');
  const created = createJson(main, worktree);
  assert.deepEqual(created.linked, ['node_modules']);
  assert.equal(git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']).stdout, '');

  fs.writeFileSync(path.join(worktree, 'app.txt'), 'changed\n');
  fs.writeFileSync(path.join(worktree, 'new.txt'), 'new\n');
  git(worktree, ['add', '-N', '.']);
  const diff = git(worktree, ['diff', '--binary']).stdout;
  assert.match(diff, /^diff --git a\/app\.txt b\/app\.txt$/m);
  assert.match(diff, /^diff --git a\/new\.txt b\/new\.txt$/m);
  assert.doesNotMatch(diff, /node_modules/);
});

test('worktree failures follow the --json error contract', async () => {
  const main = makeMainRepo([]);
  const notRepo = makeTempDir('worktree-plain-');
  const missing = path.join(notRepo, 'missing');
  const unregistered = path.join(path.dirname(main), 'never-created');
  const mainTop = worktreeEntries(main)[0]!.path;
  const cases: Array<[string[], string]> = [
    [[], 'worktree takes an action: create or remove.'],
    [['prune'], 'Unknown worktree action "prune"; use create or remove.'],
    [
      ['create', 'extra', '--main', main, '--path', unregistered],
      'worktree create takes only flags; unexpected positional arguments.',
    ],
    [['create', '--path', unregistered], 'Provide the main repository root with --main.'],
    [['remove', '--main', main], 'Provide the worktree path with --path.'],
    [
      ['create', '--main', missing, '--path', unregistered],
      `--main ${missing} is not an existing directory.`,
    ],
    [
      ['create', '--main', notRepo, '--path', unregistered],
      `--main ${notRepo} is not inside a Git working tree.`,
    ],
    [
      ['remove', '--main', main, '--path', unregistered],
      `--path ${unregistered} is not a registered worktree of ${fs.realpathSync.native(mainTop)}.`,
    ],
    [
      ['remove', '--main', main, '--path', main],
      `--path ${main} is the main working tree of ${fs.realpathSync.native(mainTop)}; worktree remove only removes linked worktrees.`,
    ],
    [['create', '--main', main, '--path'], 'Missing value for --path'],
  ];

  // The first case through a spawned CLI (its exit code and streams), the
  // rest in process: the same command, without two processes each.
  for (const [index, [args, message]] of cases.entries()) {
    const worktree = (argv: string[]) =>
      index === 0 ? runWorktree(main, argv) : runCliInProcess(['worktree', ...argv]);
    const json = await worktree([...args, '--json']);
    assert.equal(json.status, 1, args.join(' '));
    assert.deepEqual(JSON.parse(json.stdout), { error: message }, args.join(' '));
    assert.equal(json.stderr, `${message}\n`, args.join(' '));

    const plain = await worktree(args);
    assert.equal(plain.status, 1, args.join(' '));
    assert.equal(plain.stdout, '', args.join(' '));
    assert.equal(plain.stderr, `${message}\n`, args.join(' '));
  }
  assert.equal(worktreeEntries(main).length, 1);
  assert.equal(fs.existsSync(unregistered), false);
});

test('worktree create refuses a path inside the main tree, however it is spelled', () => {
  const main = makeMainRepo(['node_modules']);
  const mainRoot = fs.realpathSync.native(worktreeEntries(main)[0]!.path);
  const inside = [path.join(main, 'nested', 'wt'), path.join(main, 'wt')];
  if (POSIX) {
    // A symlinked parent that resolves into the main tree is inside it too.
    const alias = path.join(path.dirname(main), 'into-main');
    fs.symlinkSync(main, alias);
    inside.push(path.join(alias, 'wt'));
  }
  for (const target of inside) {
    const message = `--path ${target} is inside the main working tree ${mainRoot}; create the worktree outside it.`;
    const json = runWorktree(main, ['create', '--main', main, '--path', target, '--json']);
    assert.equal(json.status, 1, target);
    assert.deepEqual(JSON.parse(json.stdout), { error: message }, target);
  }
  assert.equal(worktreeEntries(main).length, 1, 'no worktree was added');
  assert.equal(fs.existsSync(path.join(main, 'nested')), false);
  // A sibling whose name only starts like the main tree's is outside it.
  createJson(main, `${main}-sibling`);
});

// A post-checkout hook that breaks provisioning (the shared exclude file
// becomes a directory) and, when asked, locks the new worktree so the
// rollback's `git worktree remove --force` is refused.
function sabotageProvisioning(main: string, lock: boolean): void {
  const hook = path.join(main, '.git', 'hooks', 'post-checkout');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  const exclude = path.join(main, '.git', 'info', 'exclude');
  fs.writeFileSync(
    hook,
    `#!/bin/sh\nrm -f '${exclude}'\nmkdir -p '${exclude}'\n${lock ? 'git worktree lock --reason held "$(pwd)"\n' : ''}`,
    { mode: 0o755 },
  );
}

test(
  'a failed provisioning says the worktree was removed only when it was',
  { skip: !POSIX },
  () => {
    // Windows skip: the hook is a POSIX shell script.
    const removedMain = makeMainRepo(['node_modules']);
    sabotageProvisioning(removedMain, false);
    const removedTarget = path.join(path.dirname(removedMain), 'wt-rollback');
    const removed = runWorktree(removedMain, [
      'create',
      '--main',
      removedMain,
      '--path',
      removedTarget,
      '--json',
    ]);
    assert.equal(removed.status, 1);
    assert.match(
      JSON.parse(removed.stdout).error,
      new RegExp(
        `^Could not provision the worktree at ${removedTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(it was removed again\\): `,
      ),
    );
    assert.equal(worktreeEntries(removedMain).length, 1);
    assert.equal(fs.existsSync(removedTarget), false);

    const lockedMain = makeMainRepo(['node_modules']);
    sabotageProvisioning(lockedMain, true);
    const lockedTarget = path.join(path.dirname(lockedMain), 'wt-stuck');
    const stuck = runWorktree(lockedMain, [
      'create',
      '--main',
      lockedMain,
      '--path',
      lockedTarget,
      '--json',
    ]);
    assert.equal(stuck.status, 1);
    const error = JSON.parse(stuck.stdout).error as string;
    assert.ok(
      error.startsWith(
        `Could not provision the worktree at ${lockedTarget}, and removing it again failed (git worktree remove failed: `,
      ),
      error,
    );
    assert.ok(
      error.includes(
        `; remove it with node '${COMPANION_ENTRY}' worktree remove --main '${fs.realpathSync.native(lockedMain)}' --path '${lockedTarget}': `,
      ),
      error,
    );
    assert.doesNotMatch(error, /it was removed again/);
    assert.equal(worktreeEntries(lockedMain).length, 2, 'the worktree is still registered');
  },
);

test('worktree remove leaves a locked worktree to git, which refuses it, never the main tree', () => {
  const main = makeMainRepo(['node_modules']);
  const worktree = path.join(path.dirname(main), 'wt-locked');
  const created = createJson(main, worktree);
  git(main, ['worktree', 'lock', '--reason', 'held', worktree]);

  const refused = runWorktree(main, ['remove', '--main', main, '--path', worktree, '--json']);
  assert.equal(refused.status, 1);
  assert.ok(
    JSON.parse(refused.stdout).error.startsWith(
      `Could not remove the worktree at ${created.path} after removing its dependency links: `,
    ),
    refused.stdout,
  );
  assert.equal(worktreeEntries(main).length, 2, 'git kept the locked worktree');
  assert.equal(
    fs.readFileSync(path.join(main, 'node_modules', 'marker.txt'), 'utf8'),
    'node_modules',
  );

  git(main, ['worktree', 'unlock', worktree]);
  const removed = runWorktree(main, ['remove', '--main', main, '--path', worktree, '--json']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(worktree), false);
});

test('worktree create without --path picks a fresh directory under the system temp directory', () => {
  const main = makeMainRepo(['node_modules']);
  const tmp = makeTempDir('worktree-tmpdir-');
  const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  const create = () => {
    const result = run(process.execPath, [SCRIPT, 'worktree', 'create', '--main', main, '--json'], {
      cwd: main,
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as { path: string; linked: string[]; removeCommand: string };
  };
  const first = create();
  const second = create();
  const parent = fs.realpathSync.native(path.join(tmp, 'stereo-worktrees'));
  for (const created of [first, second]) {
    // The path is as git reports it (`C:/...` on Windows): compare canonical forms.
    assert.equal(fs.realpathSync.native(path.dirname(created.path)), parent);
    assert.match(path.basename(created.path), /^main-[0-9a-f]{8}$/);
    assert.deepEqual(created.linked, ['node_modules']);
    assert.equal(
      created.removeCommand,
      worktreeRemoveCommand(fs.realpathSync.native(main), created.path),
    );
  }
  assert.notEqual(first.path, second.path);
  assert.equal(worktreeEntries(main).length, 3);
  for (const created of [first, second]) {
    const removed = runWorktree(main, ['remove', '--main', main, '--path', created.path]);
    assert.equal(removed.status, 0, removed.stderr);
  }
  assert.equal(worktreeEntries(main).length, 1);
});

test(
  'the printed removal command runs as printed, quotes in its paths included',
  { skip: !POSIX },
  () => {
    // Windows skip: the command is quoted for a POSIX shell (Git Bash there).
    const original = makeMainRepo(['node_modules']);
    const main = path.join(path.dirname(original), "it's main");
    fs.renameSync(original, main);
    const created = createJson(main, path.join(path.dirname(main), "wt 'one'"));
    const mainRoot = fs.realpathSync.native(worktreeEntries(main)[0]!.path);

    const command = worktreeRemoveCommand(mainRoot, created.path);
    assert.ok(command.startsWith(`node '${COMPANION_ENTRY}' worktree remove --main `), command);
    const nodeDir = path.dirname(process.execPath);
    const removed = run('sh', ['-c', command], {
      cwd: main,
      env: { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(removed.stdout, `Removed worktree ${created.path}.\n`);
    assert.equal(fs.existsSync(created.path), false);
    assert.equal(worktreeEntries(main).length, 1);
  },
);

test('worktree reports a missing git as not installed', () => {
  const main = makeTempDir('worktree-no-git-');
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== 'PATH') {
      env[key] = value;
    }
  }
  env.PATH = makeTempDir('worktree-empty-path-');
  const result = run(
    process.execPath,
    [SCRIPT, 'worktree', 'create', '--main', main, '--path', path.join(main, '..', 'wt'), '--json'],
    { cwd: main, env },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    error: 'git is not installed. Install Git and retry.',
  });
});

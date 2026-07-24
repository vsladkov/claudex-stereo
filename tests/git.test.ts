import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectReviewContext,
  getWorkingTreeState,
  listRepositoryFiles,
  resolveReviewTarget,
} from '../plugins/stereo/src/platform/git.ts';
import type { RepositoryFilesRunImpl } from '../plugins/stereo/src/platform/git.ts';
import { initGitRepo, makeTempDir, run } from './helpers.ts';

test('getWorkingTreeState preserves non-ASCII and quoted path text', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, 'base.js'), "console.log('v1');\n");
  run('git', ['add', 'base.js'], { cwd });
  run('git', ['commit', '-m', 'init'], { cwd });

  const stagedName = 'moduł-ünïcode.js';
  const unstagedName = 'unstaged-χ.js';
  fs.writeFileSync(path.join(cwd, stagedName), "console.log('v1');\n");
  fs.writeFileSync(path.join(cwd, unstagedName), "console.log('v1');\n");
  run('git', ['add', stagedName, unstagedName], { cwd });
  run('git', ['commit', '-m', 'add unicode'], { cwd });
  fs.writeFileSync(path.join(cwd, stagedName), "console.log('staged change');\n");
  run('git', ['add', stagedName], { cwd });
  fs.writeFileSync(path.join(cwd, unstagedName), "console.log('unstaged change');\n");
  fs.writeFileSync(path.join(cwd, 'untracked spaced ß.txt'), 'new\n');

  const state = getWorkingTreeState(cwd);

  // Without -z, core.quotePath would C-quote these names into escapes.
  assert.deepEqual(state.staged, [stagedName]);
  assert.deepEqual(state.unstaged, [unstagedName]);
  assert.deepEqual(state.untracked, ['untracked spaced ß.txt']);
  assert.equal(state.isDirty, true);
});

test('resolveReviewTarget prefers working tree when repo is dirty', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('v1');\n");
  run('git', ['add', 'app.js'], { cwd });
  run('git', ['commit', '-m', 'init'], { cwd });
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, 'working-tree');
});

test('resolveReviewTarget falls back to branch diff when repo is clean', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('v1');\n");
  run('git', ['add', 'app.js'], { cwd });
  run('git', ['commit', '-m', 'init'], { cwd });
  run('git', ['checkout', '-b', 'feature/test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('v2');\n");
  run('git', ['add', 'app.js'], { cwd });
  run('git', ['commit', '-m', 'change'], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, 'branch');
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

test('default branch names with special characters are passed to git literally', () => {
  const cwd = makeTempDir();
  const branchName = 'main&branch-helper&x';
  const helperOutputPath = path.join(cwd, 'branch-helper-output');
  initGitRepo(cwd);
  fs.writeFileSync(
    path.join(cwd, 'branch-helper.cmd'),
    '@echo branch-helper>branch-helper-output\r\n',
  );
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('base');\n");
  run('git', ['add', 'app.js', 'branch-helper.cmd'], { cwd });
  run('git', ['commit', '-m', 'base'], { cwd });
  run('git', ['branch', '-m', branchName], { cwd, shell: false });
  run('git', ['update-ref', `refs/remotes/origin/${branchName}`, branchName], {
    cwd,
    shell: false,
  });
  run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branchName}`], {
    cwd,
    shell: false,
  });
  run('git', ['checkout', '-b', 'feature/test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('feature');\n");
  run('git', ['add', 'app.js'], { cwd });
  run('git', ['commit', '-m', 'feature'], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, 'branch');
  assert.equal(target.baseRef, branchName);
  assert.match(context.content, /Branch Diff/);
  assert.equal(fs.existsSync(helperOutputPath), false);
});

test('resolveReviewTarget honors explicit base overrides', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('v1');\n");
  run('git', ['add', 'app.js'], { cwd });
  run('git', ['commit', '-m', 'init'], { cwd });
  run('git', ['checkout', '-b', 'feature/test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('v2');\n");
  run('git', ['add', 'app.js'], { cwd });
  run('git', ['commit', '-m', 'change'], { cwd });

  const target = resolveReviewTarget(cwd, { base: 'main' });

  assert.equal(target.mode, 'branch');
  assert.equal(target.baseRef, 'main');
});

test('resolveReviewTarget requires an explicit base when no default branch can be inferred', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('v1');\n");
  run('git', ['add', 'app.js'], { cwd });
  run('git', ['commit', '-m', 'init'], { cwd });
  run('git', ['branch', '-m', 'feature-only'], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./,
  );
});

test('collectReviewContext keeps inline diffs for tiny adversarial reviews', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('v1');\n");
  run('git', ['add', 'app.js'], { cwd });
  run('git', ['commit', '-m', 'init'], { cwd });
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, 'inline-diff');
  assert.equal(context.fileCount, 1);
  assert.match(context.collectionGuidance, /primary evidence/i);
  assert.match(context.content, /INLINE_MARKER/);
});

test('collectReviewContext skips untracked directories in working tree review', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('v1');\n");
  run('git', ['add', 'app.js'], { cwd });
  run('git', ['commit', '-m', 'init'], { cwd });

  const nestedRepoDir = path.join(cwd, '.claude', 'worktrees', 'agent-test');
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const target = resolveReviewTarget(cwd, { scope: 'working-tree' });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(skipped: directory\)/);
});

test('collectReviewContext skips broken untracked symlinks instead of crashing', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('v1');\n");
  run('git', ['add', 'app.js'], { cwd });
  run('git', ['commit', '-m', 'init'], { cwd });
  fs.symlinkSync('missing-target', path.join(cwd, 'broken-link'));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, 'working-tree');
  assert.match(context.content, /### broken-link/);
  assert.match(context.content, /skipped: broken symlink or unreadable file/i);
});

test('collectReviewContext falls back to lightweight context for larger adversarial reviews', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ['a.js', 'b.js', 'c.js']) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run('git', ['add', 'a.js', 'b.js', 'c.js'], { cwd });
  run('git', ['commit', '-m', 'init'], { cwd });
  fs.writeFileSync(path.join(cwd, 'a.js'), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, 'b.js'), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, 'c.js'), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, 'self-collect');
  assert.equal(context.fileCount, 3);
  assert.match(context.collectionGuidance, /lightweight summary/i);
  assert.match(context.collectionGuidance, /read-only git commands/i);
  assert.doesNotMatch(context.content, /SELF_COLLECT_MARKER_[ABC]/);
  assert.match(context.content, /## Changed Files/);
});

test('collectReviewContext falls back to lightweight context for oversized single-file diffs', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, 'app.js'), "export const value = 'v1';\n");
  run('git', ['add', 'app.js'], { cwd });
  run('git', ['commit', '-m', 'init'], { cwd });
  fs.writeFileSync(path.join(cwd, 'app.js'), `export const value = '${'x'.repeat(512)}';\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, 'self-collect');
  assert.ok(context.diffBytes > 128);
  assert.doesNotMatch(context.content, /xxx/);
  assert.match(context.content, /## Changed Files/);
});

test('collectReviewContext keeps untracked file content in lightweight working tree context', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ['a.js', 'b.js']) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run('git', ['add', 'a.js', 'b.js'], { cwd });
  run('git', ['commit', '-m', 'init'], { cwd });
  fs.writeFileSync(path.join(cwd, 'a.js'), 'export const value = "TRACKED_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, 'b.js'), 'export const value = "TRACKED_MARKER_B";\n');
  fs.writeFileSync(
    path.join(cwd, 'new-risk.js'),
    'export const value = "UNTRACKED_RISK_MARKER";\n',
  );

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, 'self-collect');
  assert.equal(context.fileCount, 3);
  assert.doesNotMatch(context.content, /TRACKED_MARKER_[AB]/);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /UNTRACKED_RISK_MARKER/);
});

test('listRepositoryFiles returns tracked and unignored untracked paths', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'ignored.txt\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'tracked\n', 'utf8');
  run('git', ['add', '.gitignore', 'tracked.txt'], { cwd });
  run('git', ['commit', '-m', 'init'], { cwd });
  fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'untracked\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'ignored.txt'), 'ignored\n', 'utf8');

  const listing = listRepositoryFiles(cwd);

  assert.ok(listing);
  assert.equal(listing.root, cwd);
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.files.sort(), ['.gitignore', 'tracked.txt', 'untracked.txt']);
});

test('listRepositoryFiles includes deleted paths that remain in the index', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, 'deleted.txt'), 'tracked then deleted\n', 'utf8');
  run('git', ['add', 'deleted.txt'], { cwd });
  run('git', ['commit', '-m', 'init'], { cwd });
  fs.unlinkSync(path.join(cwd, 'deleted.txt'));

  const listing = listRepositoryFiles(cwd);

  assert.ok(listing);
  assert.equal(listing.files.includes('deleted.txt'), true);
});

test('listRepositoryFiles preserves repository-controlled path text', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, 'a&b.txt'), 'untrusted name\n', 'utf8');

  const listing = listRepositoryFiles(cwd);

  assert.ok(listing);
  assert.equal(listing.files.includes('a&b.txt'), true);
});

test('listRepositoryFiles returns null outside a git repository', () => {
  assert.equal(listRepositoryFiles(makeTempDir()), null);
});

test('listRepositoryFiles salvages complete records after ENOBUFS', () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ['alpha.js', 'beta.js', 'incomplete.js']) {
    fs.writeFileSync(path.join(cwd, name), `${name}\n`, 'utf8');
  }
  let invocation = null as {
    command: string;
    args: readonly string[];
    options: { maxBuffer: number; shell: boolean };
  } | null;
  const overflowError = Object.assign(new Error('stdout maxBuffer length exceeded'), {
    code: 'ENOBUFS',
  });
  const runImpl: RepositoryFilesRunImpl = (command, args, options) => {
    invocation = { command, args, options };
    return {
      error: overflowError,
      status: null,
      stdout: Buffer.from('alpha.js\0beta.js\0incomplete', 'utf8'),
      stderr: Buffer.alloc(0),
    };
  };

  const listing = listRepositoryFiles(cwd, { maxBufferBytes: 32, runImpl });

  assert.ok(listing);
  assert.deepEqual(listing.files, ['alpha.js', 'beta.js']);
  assert.equal(listing.truncated, true);
  assert.ok(invocation);
  assert.equal(invocation.command, 'git');
  assert.deepEqual(invocation.args.slice(-5), [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  assert.equal(invocation.options.maxBuffer, 32);
  assert.equal(invocation.options.shell, false);
});

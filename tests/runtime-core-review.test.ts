import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import {
  accountCatalogModels,
  catalogFixture,
  initGitRepo,
  makeTempDir,
  run,
  waitFor,
} from './helpers.ts';
import {
  SCRIPT,
  companion,
  errorOf,
  initializeBasicRepo,
  readCompanionState,
  readFakeState,
  readJsonIfReadable,
  registerBrokerReaping,
  waitForFakeState,
  withCodexHome,
} from './runtime-helpers.ts';
import { loadBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import {
  defaultModelEffort,
  parseCodexSelection,
  resolveCodexSelection,
} from '../plugins/stereo/src/models/registry.ts';
import { ROLE_DEFINITIONS } from '../plugins/stereo/src/models/role-defaults.ts';
import { resolveJobFile, resolveDurableStateDir } from '../plugins/stereo/src/workspace/state.ts';

registerBrokerReaping();

test('review --native renders a no-findings result from app-server review/start', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const value = 1;\n');
  run('git', ['add', 'src/app.js'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const value = 2;\n');

  const result = run('node', [SCRIPT, 'review', '--native'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
});

test('review --native accepts the quoted raw argument style for built-in base-branch review', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const value = 1;\n');
  run('git', ['add', 'src/app.js'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const value = 2;\n');

  const result = run('node', [SCRIPT, 'review', '--native', '--base', 'main'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
});

test('adversarial review renders structured findings over app-server turn/start', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const value = items[0];\n');
  run('git', ['add', 'src/app.js'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const value = items[0].id;\n');

  const result = run('node', [SCRIPT, 'adversarial-review'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test('adversarial review accepts the same base-branch targeting as review', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const value = items[0];\n');
  run('git', ['add', 'src/app.js'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const value = items[0].id;\n');

  const result = run('node', [SCRIPT, 'adversarial-review', '--base', 'main'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Branch review against main|against main/i);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test('adversarial review asks Codex to inspect larger diffs itself', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, 'src'));
  for (const name of ['a.js', 'b.js', 'c.js']) {
    fs.writeFileSync(path.join(repo, 'src', name), `export const value = "${name}-v1";\n`);
  }
  run('git', ['add', 'src/a.js', 'src/b.js', 'src/c.js'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(
    path.join(repo, 'src', 'a.js'),
    'export const value = "PROMPT_SELF_COLLECT_A";\n',
  );
  fs.writeFileSync(
    path.join(repo, 'src', 'b.js'),
    'export const value = "PROMPT_SELF_COLLECT_B";\n',
  );
  fs.writeFileSync(
    path.join(repo, 'src', 'c.js'),
    'export const value = "PROMPT_SELF_COLLECT_C";\n',
  );

  const result = run('node', [SCRIPT, 'adversarial-review'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  const state = await waitForFakeState(binDir, 'lastTurnStart');
  assert.match(state.lastTurnStart.prompt, /lightweight summary/i);
  assert.match(state.lastTurnStart.prompt, /read-only git commands/i);
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test('review --native includes reasoning output when the app server returns it', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'with-reasoning');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');

  const result = run('node', [SCRIPT, 'review', '--native'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reasoning:/);
  assert.match(
    result.stdout,
    /Reviewed the changed files and checked the likely regression paths first|Reviewed the changed files and checked the likely regression paths/i,
  );
});

test('review --native logs reasoning summaries and review output to the job log', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'with-reasoning');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');

  const env = buildEnv(binDir);
  const result = run('node', [SCRIPT, 'review', '--native'], {
    cwd: repo,
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveDurableStateDir(repo, env.CODEX_HOME);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  assert.equal(state.jobs[0].tokenUsage.job.totalTokens, 350);
  assert.deepEqual(state.jobs[0].tokenUsage.job, state.jobs[0].tokenUsage.thread);
  const log = fs.readFileSync(state.jobs[0].logFile, 'utf8');
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  assert.match(log, /Review output/);
  assert.match(log, /Reviewed uncommitted changes\./);
});

test('review --native rejects focus text and the reviewer role accepts it', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');

  const env = buildEnv(binDir);
  const result = run(
    'node',
    [SCRIPT, 'review', '--native', '--scope', 'working-tree', 'focus on auth'],
    { cwd: repo, env },
  );

  assert.equal(result.status! > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /Drop `--native` for `\/stereo:review focus on auth`/i);

  // Without --native the same command is the reviewer role: the focus text
  // and the review schema reach the prompted turn, exactly as on Claude.
  const prompted = run(
    'node',
    [SCRIPT, 'review', '--scope', 'working-tree', 'focus on auth', '--json'],
    { cwd: repo, env },
  );
  assert.equal(prompted.status, 0, prompted.stderr);
  const fakeState = await waitForFakeState(binDir, 'lastTurnStart');
  const turn = fakeState.lastTurnStart;
  assert.match(turn.prompt, /focus on auth/);
  assert.ok(turn.outputSchema?.properties?.verdict, 'review schema is enforced');
  assert.equal(fakeState.lastReviewStart ?? null, null);
  const payload = JSON.parse(prompted.stdout);
  assert.equal(payload.review, 'Review');
  assert.ok(payload.result?.verdict, 'structured verdict is returned');
});

test('review rejects staged-only scope because it is native-review only', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');
  run('git', ['add', 'README.md'], { cwd: repo });

  const result = run('node', [SCRIPT, 'review', '--scope', 'staged'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status! > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test('adversarial review rejects staged-only scope to match review target selection', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');
  run('git', ['add', 'README.md'], { cwd: repo });

  const result = run('node', [SCRIPT, 'adversarial-review', '--scope', 'staged'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status! > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test('adversarial-review passes explicit and named-model default effort only on its prompted path', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');
  const env = buildEnv(binDir);

  const explicit = run('node', [SCRIPT, 'adversarial-review', '--effort', 'high', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal((await waitForFakeState(binDir, 'lastTurnStart')).lastTurnStart.effort, 'high');

  const modelDefault = run('node', [SCRIPT, 'adversarial-review', '--model', 'sol', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(modelDefault.status, 0, modelDefault.stderr);
  // Effort defaults and the role default resolve against the fake's catalog.
  const catalog = catalogFixture(accountCatalogModels());
  assert.equal(
    (await waitForFakeState(binDir, 'lastTurnStart')).lastTurnStart.effort,
    defaultModelEffort('gpt-6-sol', { catalog }),
  );

  const codexDefault = run('node', [SCRIPT, 'adversarial-review', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(codexDefault.status, 0, codexDefault.stderr);
  // No model: the implementation reviewer's role default (its built-in) at
  // its version default, as plan-review runs the plan reviewer's.
  const builtIn = ROLE_DEFINITIONS.find((role) => role.flag === 'implementation-reviewer')!;
  const builtInModel = resolveCodexSelection(
    parseCodexSelection(builtIn.builtInSelection)!,
    catalog,
  );
  const codexDefaultTurn = (await waitForFakeState(binDir, 'lastTurnStart')).lastTurnStart;
  assert.equal(codexDefaultTurn.model, builtInModel);
  assert.equal(codexDefaultTurn.effort, defaultModelEffort(builtInModel, { catalog }));
});

test('review --native rejects effort before normalization and companion review commands reject --pr', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);
  const effortError =
    "`/stereo:review --native` runs Codex's built-in reviewer, which has no reasoning-effort control. Drop `--native` for an effort-controlled review.";

  for (const effort of ['high', 'bogus']) {
    const result = run('node', [SCRIPT, 'review', '--native', '--effort', effort, '--json'], {
      cwd: repo,
      env,
    });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).error, effortError);
    assert.equal(result.stderr.trim(), effortError);
  }

  const claudeNative = run(
    'node',
    [SCRIPT, 'review', '--native', '--model', 'claude:fable', '--json'],
    {
      cwd: repo,
      env,
    },
  );
  assert.notEqual(claudeNative.status, 0);
  assert.match(JSON.parse(claudeNative.stdout).error, /pass a Codex selection or drop `--native`/);

  const adversarialNative = run('node', [SCRIPT, 'adversarial-review', '--native', '--json'], {
    cwd: repo,
    env,
  });
  assert.notEqual(adversarialNative.status, 0);
  assert.match(JSON.parse(adversarialNative.stdout).error, /applies to `\/stereo:review` only/);

  const prError =
    '--pr is resolved by /stereo:review and /stereo:adversarial-review, not by the companion CLI. Check out the pull request branch and pass --base <ref>.';
  for (const command of ['review', 'adversarial-review']) {
    const result = run('node', [SCRIPT, command, '--pr', '12', '--json'], {
      cwd: repo,
      env,
    });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).error, prError);
    assert.equal(result.stderr.trim(), prError);
  }
});

test('review --native with a named model succeeds foreground and background without persisted effort', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');
  const env = buildEnv(binDir);

  const foreground = run('node', [SCRIPT, 'review', '--native', '--model', 'sol', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(foreground.status, 0, foreground.stderr);

  const launched = run(
    'node',
    [SCRIPT, 'review', '--native', '--background', '--model', 'sol', '--json'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId as string;
  const jobFile = path.join(resolveDurableStateDir(repo, env.CODEX_HOME), 'jobs', `${jobId}.json`);
  const stored = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  // The native reviewer takes no effort: none is resolved, so none is persisted.
  assert.equal(stored.request.effort ?? null, null);

  const status = run(
    'node',
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '15000', '--json'],
    { cwd: repo, env },
  );
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.status, 'completed');
});

test('review --background returns a queued detached job', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');

  const env = buildEnv(binDir);
  const launched = run('node', [SCRIPT, 'review', '--background', '--json'], {
    cwd: repo,
    env,
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, 'queued');
  assert.match(launchPayload.jobId, /^review-/);
  // The launch payload carries the text the plain run prints, naming the job.
  assert.match(
    launchPayload.rendered,
    new RegExp(`started in the background as ${launchPayload.jobId}\\.`),
  );
  assert.match(launchPayload.rendered, new RegExp(`/stereo:status ${launchPayload.jobId}`));

  const status = run(
    'node',
    [SCRIPT, 'status', launchPayload.jobId, '--wait', '--timeout-ms', '15000', '--json'],
    { cwd: repo, env },
  );

  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.status, 'completed');
});

test('review rejects --background together with --wait', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');

  const result = run('node', [SCRIPT, 'review', '--background', '--wait', '--json'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose either --background or --wait/);
  assert.match(JSON.parse(result.stdout).error, /Choose either --background or --wait/);
});

test('adversarial-review --background stores a structured detached result', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = items[0];\n');
  run('git', ['add', 'app.js'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = items[0].id;\n');
  const env = buildEnv(binDir);

  const launched = run('node', [SCRIPT, 'adversarial-review', '--background', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  const status = run(
    'node',
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '15000', '--json'],
    { cwd: repo, env },
  );
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.status, 'completed');

  const result = run('node', [SCRIPT, 'result', jobId, '--json'], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.status, 'completed');
  assert.equal(payload.storedJob.result.result.verdict, 'needs-attention');
});

test('adversarial-review --background persists and replays explicit effort', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 1;\n');
  run('git', ['add', 'app.js'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 2;\n');
  const env = buildEnv(binDir);

  const launched = run(
    'node',
    [SCRIPT, 'adversarial-review', '--background', '--effort', 'high', '--json'],
    { cwd: repo, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId as string;
  const jobFile = path.join(resolveDurableStateDir(repo, env.CODEX_HOME), 'jobs', `${jobId}.json`);
  const queued = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  assert.equal(queued.request.effort, 'high');

  const status = run(
    'node',
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '15000', '--json'],
    { cwd: repo, env },
  );
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.status, 'completed');
  assert.equal((await waitForFakeState(binDir, 'lastTurnStart')).lastTurnStart.effort, 'high');
});

test('a review launched from a worktree with --workspace shares the repository broker', () => {
  const repo = initializeBasicRepo();
  const worktree = path.join(makeTempDir(), 'wt');
  const added = run('git', ['worktree', 'add', '-b', 'stereo-review-wt', worktree], { cwd: repo });
  assert.equal(added.status, 0, added.stderr);
  fs.writeFileSync(path.join(worktree, 'README.md'), 'hello from the worktree\n');
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  const launchDir = makeTempDir();

  const launched = run(
    'node',
    [SCRIPT, 'review', '--background', '--json', '--cwd', worktree, '--workspace', repo],
    { cwd: launchDir, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId as string;
  const waited = run(
    'node',
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '20000', '--json', '--workspace', repo],
    { cwd: launchDir, env },
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, 'completed');

  // One broker per repository: neither the worktree nor the launch
  // directory gets a record of its own.
  assert.ok(loadBrokerSession(repo), 'the repository owns the broker record');
  assert.equal(loadBrokerSession(worktree), null);
  assert.equal(loadBrokerSession(launchDir), null);
  // The record is the repository's; the review itself read the worktree.
  const job = readCompanionState(repo, env)?.jobs.find((candidate) => candidate.id === jobId);
  assert.equal(job?.status, 'completed');
  assert.equal(job?.jobClass, 'review');
  assert.equal(readCompanionState(worktree, env), null);
  assert.equal(readCompanionState(launchDir, env), null);
  const stored = readJsonIfReadable<{ result?: { context?: { repoRoot?: string } } }>(
    withCodexHome(env.CODEX_HOME, () => resolveJobFile(repo, jobId)),
  );
  assert.equal(fs.realpathSync.native(String(stored?.result?.context?.repoRoot)), worktree);
});

test('review takes its focus text from --focus-file, never together with positional text', async () => {
  const repo = initializeBasicRepo();
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');
  fs.writeFileSync(path.join(repo, 'focus.md'), '  Check the retry loop.\n');
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const both = companion(
    ['review', '--json', '--focus-file', 'focus.md', 'and', 'more'],
    repo,
    env,
  );
  assert.equal(both.status, 1);
  assert.equal(errorOf(both), 'Choose either --focus-file <path> or positional focus text.');
  const outside = companion(
    [
      'adversarial-review',
      '--json',
      '--focus-file',
      path.join(path.dirname(repo), '..', 'etc', 'passwd'),
    ],
    repo,
    env,
  );
  assert.equal(outside.status, 1);
  assert.match(errorOf(outside), /--focus-file/);
  assert.equal(readCompanionState(repo, env), null, 'no refusal left a record');

  const reviewed = companion(
    ['adversarial-review', '--json', '--focus-file', 'focus.md'],
    repo,
    env,
  );
  assert.equal(reviewed.status, 0, reviewed.stderr);
  const turn = await waitFor(() => readFakeState(binDir).lastTurnStart);
  assert.match(String(turn.prompt), /Check the retry loop\./);
});

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { reapWorkspaceBroker } from './broker-reaper.ts';
import { initGitRepo, makeTempDir, run } from './helpers.ts';
import {
  ROOT,
  SCRIPT,
  SESSION_HOOK,
  initializeBasicRepo,
  readCompanionState,
  readFakeState,
  registerBrokerReaping,
  registerSessionCleanup,
  waitFor,
} from './runtime-helpers.ts';
import { loadBrokerSession, saveBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import type { BrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import {
  resolveJobFile,
  resolveDurableStateDir,
  upsertJob,
  writeJobFile,
} from '../plugins/stereo/src/workspace/state.ts';
import { handleCancel, type CancelDeps } from '../plugins/stereo/src/cli/commands/cancel.ts';
import { handleTaskWorker, type TaskWorkerDeps } from '../plugins/stereo/src/cli/commands/task.ts';

registerBrokerReaping();

test('readFakeState treats missing and partially written fixture state as not ready', async () => {
  const binDir = makeTempDir();
  const statePath = path.join(binDir, 'fake-codex-state.json');
  let pollCount = 0;

  assert.deepEqual(readFakeState(binDir), {});
  fs.writeFileSync(statePath, '{', 'utf8');
  assert.deepEqual(readFakeState(binDir), {});
  setTimeout(
    () =>
      fs.writeFileSync(
        statePath,
        `${JSON.stringify({ turnStarts: [{ threadId: 'thr_ready' }] })}\n`,
        'utf8',
      ),
    20,
  );

  const state = await waitFor(
    () => {
      pollCount += 1;
      const current = readFakeState(binDir);
      return current.turnStarts?.length ? current : null;
    },
    { timeoutMs: 1000, intervalMs: 5 },
  );

  assert.equal(state.turnStarts[0].threadId, 'thr_ready');
  assert.equal(pollCount > 1, true);
});

test('setup reports ready when fake codex is installed and authenticated', () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: ROOT,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.codex.detail, /advanced runtime available/);
  assert.equal(payload.sessionRuntime.mode, 'direct');
  assert.equal(payload.rateLimits.planType, 'plus');
  assert.equal(payload.rateLimits.primary.usedPercent, 37);
  if (process.platform !== 'win32') {
    assert.equal(payload.writeSandbox.available, true);
  }
});

test('setup omits rate limits when the app-server method is unsupported', () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'rate-limits-fail');
  const env = buildEnv(binDir);

  const jsonResult = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: ROOT,
    env,
  });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  assert.equal(JSON.parse(jsonResult.stdout).rateLimits, null);

  const renderedResult = run('node', [SCRIPT, 'setup'], {
    cwd: ROOT,
    env,
  });
  assert.equal(renderedResult.status, 0, renderedResult.stderr);
  assert.doesNotMatch(renderedResult.stdout, /\nRate limits:\n/);
});

test('setup reports a blocked write sandbox', { skip: process.platform === 'win32' }, () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'sandbox-blocked');
  const env = buildEnv(binDir);

  const jsonResult = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: ROOT,
    env,
  });

  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const payload = JSON.parse(jsonResult.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.writeSandbox.available, false);
  assert.match(payload.writeSandbox.detail, /bwrap/);
  assert.equal(
    payload.nextSteps.some((step: string) => /task --write|\/stereo:implement/.test(step)),
    true,
  );

  const renderedResult = run('node', [SCRIPT, 'setup'], {
    cwd: ROOT,
    env,
  });
  assert.equal(renderedResult.status, 0, renderedResult.stderr);
  assert.match(renderedResult.stdout, /- write sandbox: blocked/);
});

test(
  'setup treats an unsupported sandbox probe as inconclusive',
  { skip: process.platform === 'win32' },
  () => {
    const binDir = makeTempDir();
    installFakeCodex(binDir, 'sandbox-unsupported');
    const env = buildEnv(binDir);

    const jsonResult = run('node', [SCRIPT, 'setup', '--json'], {
      cwd: ROOT,
      env,
    });

    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    const payload = JSON.parse(jsonResult.stdout);
    assert.equal(payload.writeSandbox.available, null);
    assert.match(payload.writeSandbox.detail, /unsupported/i);
    assert.equal(
      payload.nextSteps.some((step: string) => /task --write|\/stereo:implement/.test(step)),
      false,
    );

    const renderedResult = run('node', [SCRIPT, 'setup'], {
      cwd: ROOT,
      env,
    });
    assert.equal(renderedResult.status, 0, renderedResult.stderr);
    assert.match(renderedResult.stdout, /- write sandbox: .*unsupported/i);
  },
);

test('setup is ready without npm when Codex is already installed and authenticated', () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, 'node'));

  const result = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test('setup trusts app-server API key auth even when login status alone would fail', () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'api-key-account-only');

  const result = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: ROOT,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, 'apiKey');
  assert.equal(payload.auth.source, 'app-server');
  assert.match(payload.auth.detail, /API key configured \(unverified\)/);
});

test('setup is ready when the active provider does not require OpenAI login', () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'provider-no-auth');

  const result = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: ROOT,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, 'app-server');
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test('setup treats custom providers with app-server-ready config as ready', () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'env-key-provider');
  const env = {
    ...buildEnv(binDir),
    CUSTOM_KEY: 'test-key',
  };

  const result = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: ROOT,
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, 'app-server');
  assert.deepEqual(payload.auth.configuredProviders, [
    { id: 'openai-custom', envKey: 'CUSTOM_KEY' },
  ]);
  assert.equal(payload.providers.active, 'openai-custom');
  assert.deepEqual(payload.providers.configured, [
    { id: 'openai-custom', envKey: 'CUSTOM_KEY', keySet: true },
  ]);
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);

  const rendered = run('node', [SCRIPT, 'setup'], {
    cwd: ROOT,
    env,
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Model provider: openai-custom \(default\)/);
  assert.match(rendered.stdout, /Custom provider openai-custom: CUSTOM_KEY set/);
});

test('setup preserves configured providers when OpenAI auth is logged out', () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'refreshable-auth');
  const env = {
    ...buildEnv(binDir),
    MOONSHOT_API_KEY: 'test-key',
  };

  const result = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: ROOT,
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.auth.loggedIn, false);
  assert.deepEqual(payload.auth.configuredProviders, [
    { id: 'moonshot', envKey: 'MOONSHOT_API_KEY' },
  ]);
  assert.equal(
    payload.providers.aliases.find((entry: Record<string, unknown>) => entry.alias === 'kimi')
      .configured,
    true,
  );
});

test('setup reports not ready when app-server config read fails', () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'config-read-fails');

  const result = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: ROOT,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, 'app-server');
  assert.match(payload.auth.detail, /config\/read failed for cwd/);
});

test('review renders a no-findings result from app-server review/start', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const value = 1;\n');
  run('git', ['add', 'src/app.js'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const value = 2;\n');

  const result = run('node', [SCRIPT, 'review'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
});

test('--json inside prompt text does not switch error output to JSON', () => {
  const repo = makeTempDir();
  initGitRepo(repo);

  // Two argv entries so normalizeArgv keeps them as separate tokens and the
  // prompt text stays a positional (a single raw string would flag-parse it).
  // process.execPath (not PATH-resolved "node"): the stripped PATH exists to
  // hide codex, but must not swap in an older system node that cannot run .ts.
  const result = run(
    process.execPath,
    [SCRIPT, 'task', '--prompt-file', 'does-not-exist.md', 'explain the --json flag'],
    {
      cwd: repo,
      env: { ...process.env, PATH: '/usr/bin:/bin' },
    },
  );

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /\{"error"/);
  assert.match(result.stderr, /Could not read --prompt-file/);
});

test('a foreground task with no prompt fast-fails without creating a job record', () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const result = run(process.execPath, [SCRIPT, 'task'], { cwd: repo, env });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Provide a prompt, a prompt file, piped stdin, or use --resume-last\./,
  );
  // Validation must run before any job exists: the background path already
  // fast-failed here, the foreground path used to leave a failed job behind.
  const statusResult = run(process.execPath, [SCRIPT, 'status', '--all', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(statusResult.status, 0, statusResult.stderr);
  const snapshot = JSON.parse(statusResult.stdout);
  assert.deepEqual(snapshot.jobs ?? [], []);
});

test('a pre-parse failure with a real --json flag still emits stdout JSON', () => {
  const result = run('node', [SCRIPT, 'definitely-not-a-subcommand', '--json'], {
    cwd: makeTempDir(),
  });

  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).error, /./);
});

test('review accepts the quoted raw argument style for built-in base-branch review', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const value = 1;\n');
  run('git', ['add', 'src/app.js'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const value = 2;\n');

  const result = run('node', [SCRIPT, 'review', '--base main'], {
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

test('adversarial review asks Codex to inspect larger diffs itself', () => {
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
  const state = JSON.parse(fs.readFileSync(path.join(binDir, 'fake-codex-state.json'), 'utf8'));
  assert.match(state.lastTurnStart.prompt, /lightweight summary/i);
  assert.match(state.lastTurnStart.prompt, /read-only git commands/i);
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test('review includes reasoning output when the app server returns it', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'with-reasoning');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');

  const result = run('node', [SCRIPT, 'review'], {
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

test('review logs reasoning summaries and review output to the job log', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'with-reasoning');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');

  const env = buildEnv(binDir);
  const result = run('node', [SCRIPT, 'review'], {
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

test('review rejects focus text because it is native-review only', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');

  const result = run('node', [SCRIPT, 'review', '--scope working-tree focus on auth'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status! > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /\/stereo:adversarial-review focus on auth/i);
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

test('adversarial-review passes explicit and named-model default effort only on its prompted path', () => {
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
  assert.equal(readFakeState(binDir).lastTurnStart.effort, 'high');

  const modelDefault = run('node', [SCRIPT, 'adversarial-review', '--model', 'sol', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(modelDefault.status, 0, modelDefault.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.effort, 'max');

  const codexDefault = run('node', [SCRIPT, 'adversarial-review', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(codexDefault.status, 0, codexDefault.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.effort, null);
});

test('native review rejects effort before normalization and companion review commands reject --pr', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);
  const effortError =
    "`/stereo:review` maps to Codex's built-in reviewer, which has no reasoning-effort control. Retry with `/stereo:adversarial-review --effort <effort>` for an effort-controlled review.";

  for (const effort of ['high', 'bogus']) {
    const result = run('node', [SCRIPT, 'review', '--effort', effort, '--json'], {
      cwd: repo,
      env,
    });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).error, effortError);
    assert.equal(result.stderr.trim(), effortError);
  }

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

test('native review with a named model succeeds foreground and background without persisted effort', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');
  const env = buildEnv(binDir);

  const foreground = run('node', [SCRIPT, 'review', '--model', 'sol', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(foreground.status, 0, foreground.stderr);

  const launched = run('node', [SCRIPT, 'review', '--background', '--model', 'sol', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId as string;
  const jobFile = path.join(resolveDurableStateDir(repo, env.CODEX_HOME), 'jobs', `${jobId}.json`);
  const stored = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  assert.equal(Object.hasOwn(stored.request, 'effort'), false);

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

test('adversarial-review --background persists and replays explicit effort', () => {
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
  assert.equal(readFakeState(binDir).lastTurnStart.effort, 'high');
});

test('status --usage aggregates retained job usage and rejects job ids or --wait', () => {
  const repo = makeTempDir();
  const stateHome = makeTempDir('usage-state-home-');
  initGitRepo(repo);
  const env = {
    ...process.env,
    CODEX_HOME: stateHome,
    CODEX_COMPANION_SESSION_ID: 'sess-usage',
  };
  const stateDir = resolveDurableStateDir(repo, stateHome);
  fs.mkdirSync(path.join(stateDir, 'jobs'), { recursive: true });
  const usage = {
    job: {
      inputTokens: 80,
      cachedInputTokens: 20,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      totalTokens: 100,
      cacheWriteInputTokens: 0,
    },
    thread: {
      inputTokens: 8000,
      cachedInputTokens: 2000,
      outputTokens: 2000,
      reasoningOutputTokens: 500,
      totalTokens: 10000,
      cacheWriteInputTokens: 0,
    },
    modelContextWindow: 258000,
  };
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'review-usage',
            status: 'completed',
            kind: 'review',
            jobClass: 'review',
            sessionId: 'sess-usage',
            model: 'gpt-5.6-sol',
            tokenUsage: usage,
          },
          {
            id: 'task-no-usage',
            status: 'completed',
            kind: 'task',
            jobClass: 'task',
            sessionId: 'sess-usage',
            model: null,
          },
          {
            id: 'other-session',
            status: 'completed',
            kind: 'review',
            jobClass: 'review',
            sessionId: 'sess-other',
            model: 'gpt-5.6-terra',
            tokenUsage: usage,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'status', '--usage', '--json'], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.scope, 'session');
  assert.deepEqual(snapshot.window, {
    retainedJobs: 3,
    countedJobs: 2,
    maxRetainedJobs: 50,
  });
  assert.equal(snapshot.totals.jobs, 2);
  assert.equal(snapshot.totals.jobsWithUsage, 1);
  assert.equal(snapshot.totals.totalTokens, 100);
  assert.equal(
    snapshot.byKind.find((group: { key: string }) => group.key === 'review').totalTokens,
    100,
  );
  assert.equal(snapshot.byModel.find((group: { key: string }) => group.key === '-').jobs, 1);

  for (const [args, expected] of [
    [['status', '--usage', 'review-usage', '--json'], '`status --usage` does not take a job id.'],
    [['status', '--usage', '--wait', '--json'], '`status --usage` cannot be combined with --wait.'],
  ] as const) {
    const invalid = run('node', [SCRIPT, ...args], { cwd: repo, env });
    assert.notEqual(invalid.status, 0);
    assert.equal(JSON.parse(invalid.stdout).error, expected);
    assert.equal(invalid.stderr.trim(), expected);
  }
});

test('status shows a provider-qualified model for an active background task', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'interruptible-slow-task');
  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: 'sess-model-background',
  };
  registerSessionCleanup(t, repo, env);

  const launched = run(
    'node',
    [SCRIPT, 'task', '--background', '--model', 'kimi', '--json', 'inspect model routing'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId as string;

  await waitFor(
    () => {
      return readCompanionState(repo, env)?.jobs.find(
        (job: Record<string, unknown>) => job.id === jobId && job.status === 'running',
      );
    },
    { timeoutMs: 10000 },
  );

  const jsonStatus = run('node', [SCRIPT, 'status', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(jsonStatus.status, 0, jsonStatus.stderr);
  const snapshot = JSON.parse(jsonStatus.stdout);
  const job = snapshot.running.find((entry: Record<string, unknown>) => entry.id === jobId);
  assert.equal(job.model, 'kimi-k3');
  assert.equal(job.modelDisplay, 'kimi-k3@moonshot');

  const renderedStatus = run('node', [SCRIPT, 'status'], {
    cwd: repo,
    env,
  });
  assert.equal(renderedStatus.status, 0, renderedStatus.stderr);
  assert.match(
    renderedStatus.stdout,
    new RegExp(`\\| ${jobId} \\| rescue \\| kimi-k3@moonshot \\| running \\|`),
  );

  const cancelled = run('node', [SCRIPT, 'cancel', jobId, '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(cancelled.status, 0, cancelled.stderr);
});

test('foreground task status and result retain the provider-qualified model', () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const task = run('node', [SCRIPT, 'task', '--model', 'kimi', 'inspect model routing'], {
    cwd: repo,
    env,
  });
  assert.equal(task.status, 0, task.stderr);

  const jsonStatus = run('node', [SCRIPT, 'status', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(jsonStatus.status, 0, jsonStatus.stderr);
  const snapshot = JSON.parse(jsonStatus.stdout);
  assert.equal(snapshot.latestFinished.model, 'kimi-k3');
  assert.equal(snapshot.latestFinished.modelDisplay, 'kimi-k3@moonshot');

  const renderedStatus = run('node', [SCRIPT, 'status'], {
    cwd: repo,
    env,
  });
  assert.equal(renderedStatus.status, 0, renderedStatus.stderr);
  assert.match(renderedStatus.stdout, /Model: kimi-k3@moonshot/);

  const result = run('node', [SCRIPT, 'result'], {
    cwd: repo,
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Model: kimi-k3@moonshot/);
});

test('status shows phases, hints, and the latest finished job', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, 'review-live.log');
  const progressMessages = [
    'Starting Codex Review.',
    'Thread ready (thr_1).',
    'Turn started (turn_1).',
    'Searching: status implementation',
    'Running command: npm test',
    'Reviewer started: current changes',
  ];
  fs.writeFileSync(
    logFile,
    progressMessages
      .map((message, index) => `[2026-03-18T15:30:0${index}.000Z] ${message}`)
      .join('\n'),
    'utf8',
  );

  const finishedLogFile = path.join(jobsDir, 'review-done.log');
  fs.writeFileSync(finishedLogFile, '[2026-03-18T15:11:10.000Z] Review output\n', 'utf8');
  const finishedJobFile = path.join(jobsDir, 'review-done.json');
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: 'review-done',
        status: 'completed',
        title: 'Codex Review',
        rendered: '# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n',
      },
      null,
      2,
    ),
    'utf8',
  );

  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'review-live',
            kind: 'review',
            kindLabel: 'review',
            status: 'running',
            title: 'Codex Review',
            jobClass: 'review',
            phase: 'reviewing',
            threadId: 'thr_1',
            summary: 'Review working tree diff',
            logFile,
            createdAt: '2026-03-18T15:30:00.000Z',
            startedAt: '2026-03-18T15:30:01.000Z',
            updatedAt: '2026-03-18T15:30:03.000Z',
          },
          {
            id: 'review-done',
            status: 'completed',
            title: 'Codex Review',
            jobClass: 'review',
            threadId: 'thr_done',
            summary: 'Review main...HEAD',
            logFile: finishedLogFile,
            createdAt: '2026-03-18T15:10:00.000Z',
            startedAt: '2026-03-18T15:10:05.000Z',
            completedAt: '2026-03-18T15:11:10.000Z',
            updatedAt: '2026-03-18T15:11:10.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'status'], {
    cwd: workspace,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(
    result.stdout,
    /\| Job \| Kind \| Model \| Status \| Phase \| Elapsed \| Codex Session ID \| Summary \| Actions \|/,
  );
  assert.match(
    result.stdout,
    /\| review-live \| review \| - \| running \| reviewing \| .* \| thr_1 \| Review working tree diff \|/,
  );
  assert.match(result.stdout, /`\/stereo:status review-live`<br>`\/stereo:cancel review-live`/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Session runtime: direct startup/);
  // Non-verbose output is the documented compact shape: the table carries the
  // running job; Live details and Progress blocks are verbose-only.
  assert.doesNotMatch(result.stdout, /Live details:/);
  assert.doesNotMatch(result.stdout, /Progress:/);
  for (const message of progressMessages) {
    assert.equal(result.stdout.includes(message), false);
  }
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /Codex session ID: thr_done/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_done/);
  assert.doesNotMatch(result.stdout, / {2}(?:Created|Started|Completed):/);
  assert.equal(result.stdout.includes(finishedLogFile), false);

  const verboseResult = run('node', [SCRIPT, 'status', '--verbose'], {
    cwd: workspace,
  });

  assert.equal(verboseResult.status, 0, verboseResult.stderr);
  assert.match(verboseResult.stdout, /Live details:/);
  assert.match(verboseResult.stdout, /Progress:/);
  assert.match(verboseResult.stdout, /Phase: reviewing/);
  assert.match(verboseResult.stdout, /Codex session ID: thr_1/);
  assert.match(verboseResult.stdout, /Resume in Codex: codex resume thr_1/);
  for (const message of progressMessages) {
    assert.equal(verboseResult.stdout.includes(message), true);
  }
  assert.match(verboseResult.stdout, / {2}Created: 2026-03-18T15:30:00\.000Z/);
  assert.match(verboseResult.stdout, / {2}Completed: 2026-03-18T15:11:10\.000Z/);
  assert.equal(verboseResult.stdout.includes(finishedLogFile), true);

  const verboseJsonResult = run('node', [SCRIPT, 'status', '--verbose', '--json'], {
    cwd: workspace,
  });

  assert.equal(verboseJsonResult.status, 0, verboseJsonResult.stderr);
  const verbosePayload = JSON.parse(verboseJsonResult.stdout);
  assert.equal(verbosePayload.running[0].progressPreview.length, 6);

  const singleRunningResult = run('node', [SCRIPT, 'status', 'review-live', '--verbose'], {
    cwd: workspace,
  });

  assert.equal(singleRunningResult.status, 0, singleRunningResult.stderr);
  for (const message of progressMessages) {
    assert.equal(singleRunningResult.stdout.includes(message), true);
  }
  assert.match(singleRunningResult.stdout, / {2}Created: 2026-03-18T15:30:00\.000Z/);
  assert.match(singleRunningResult.stdout, / {2}Started: 2026-03-18T15:30:01\.000Z/);

  const waitResult = run(
    'node',
    [SCRIPT, 'status', 'review-live', '--verbose', '--wait', '--timeout-ms', '25', '--json'],
    { cwd: workspace },
  );

  assert.equal(waitResult.status, 0, waitResult.stderr);
  const waitPayload = JSON.parse(waitResult.stdout);
  assert.equal(waitPayload.waitTimedOut, true);
  assert.equal(waitPayload.job.progressPreview.length, 6);

  const singleCompletedResult = run('node', [SCRIPT, 'status', 'review-done', '--verbose'], {
    cwd: workspace,
  });

  assert.equal(singleCompletedResult.status, 0, singleCompletedResult.stderr);
  assert.match(singleCompletedResult.stdout, / {2}Completed: 2026-03-18T15:11:10\.000Z/);

  const aliasResult = run('node', [SCRIPT, 'status', '-v'], {
    cwd: workspace,
  });

  assert.equal(aliasResult.status, 0, aliasResult.stderr);
  assert.match(aliasResult.stdout, / {2}Created: 2026-03-18T15:30:00\.000Z/);
});

test('status without a job id only shows jobs from the current Claude session', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, 'review-current.log');
  const otherLog = path.join(jobsDir, 'review-other.log');
  fs.writeFileSync(
    currentLog,
    '[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n',
    'utf8',
  );
  fs.writeFileSync(otherLog, '[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n', 'utf8');

  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'review-current',
            kind: 'review',
            kindLabel: 'review',
            status: 'running',
            title: 'Codex Review',
            jobClass: 'review',
            phase: 'reviewing',
            sessionId: 'sess-current',
            threadId: 'thr_current',
            summary: 'Current session review',
            logFile: currentLog,
            createdAt: '2026-03-18T15:30:00.000Z',
            updatedAt: '2026-03-18T15:30:00.000Z',
          },
          {
            id: 'review-other',
            kind: 'review',
            kindLabel: 'review',
            status: 'completed',
            title: 'Codex Review',
            jobClass: 'review',
            sessionId: 'sess-other',
            threadId: 'thr_other',
            summary: 'Previous session review',
            createdAt: '2026-03-18T15:20:00.000Z',
            startedAt: '2026-03-18T15:20:05.000Z',
            completedAt: '2026-03-18T15:21:00.000Z',
            updatedAt: '2026-03-18T15:21:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'status'], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: 'sess-current',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ['review-current'],
  );
});

test('status preserves adversarial review kind labels', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, 'review-adv.log');
  fs.writeFileSync(
    logFile,
    '[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n',
    'utf8',
  );

  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'review-adv-live',
            kind: 'adversarial-review',
            status: 'running',
            title: 'Codex Adversarial Review',
            jobClass: 'review',
            phase: 'reviewing',
            threadId: 'thr_adv_live',
            summary: 'Adversarial review current changes',
            logFile,
            createdAt: '2026-03-18T15:30:00.000Z',
            updatedAt: '2026-03-18T15:30:00.000Z',
          },
          {
            id: 'review-adv',
            kind: 'adversarial-review',
            status: 'completed',
            title: 'Codex Adversarial Review',
            jobClass: 'review',
            threadId: 'thr_adv_done',
            summary: 'Adversarial review working tree diff',
            createdAt: '2026-03-18T15:10:00.000Z',
            startedAt: '2026-03-18T15:10:05.000Z',
            completedAt: '2026-03-18T15:11:10.000Z',
            updatedAt: '2026-03-18T15:11:10.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'status'], {
    cwd: workspace,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /\| review-adv-live \| adversarial-review \| - \| running \| reviewing \|/,
  );
  assert.match(
    result.stdout,
    /- review-adv \| completed \| adversarial-review \| Codex Adversarial Review/,
  );
  // The running job's session id lives in the table cell (details are
  // verbose-only); the finished job keeps its detail line.
  assert.match(result.stdout, /\| thr_adv_live \|/);
  assert.match(result.stdout, /Codex session ID: thr_adv_done/);
});

test('status --wait times out cleanly when a job is still active', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, 'task-live.log');
  fs.writeFileSync(logFile, '[2026-03-18T15:30:00.000Z] Starting Codex Task.\n', 'utf8');
  fs.writeFileSync(
    path.join(jobsDir, 'task-live.json'),
    JSON.stringify(
      {
        id: 'task-live',
        status: 'running',
        title: 'Codex Task',
        logFile,
      },
      null,
      2,
    ),
    'utf8',
  );

  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'task-live',
            status: 'running',
            title: 'Codex Task',
            jobClass: 'task',
            summary: 'Investigate flaky test',
            logFile,
            createdAt: '2026-03-18T15:30:00.000Z',
            startedAt: '2026-03-18T15:30:01.000Z',
            updatedAt: '2026-03-18T15:30:02.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run(
    'node',
    [SCRIPT, 'status', 'task-live', '--wait', '--timeout-ms', '25', '--json'],
    {
      cwd: workspace,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, 'task-live');
  assert.equal(payload.job.status, 'running');
  assert.equal(payload.waitTimedOut, true);
});

test('status treats a truncated legacy job file as an unknown model', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, 'task-truncated.json'), '{"request":', 'utf8');
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'task-truncated',
            status: 'completed',
            title: 'Codex Task',
            jobClass: 'task',
            updatedAt: '2026-03-18T15:30:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'status', 'task-truncated', '--json'], {
    cwd: workspace,
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.model, null);
  assert.equal(payload.job.modelDisplay, '-');
});

test('result falls back to index data when the stored job file is unreadable', () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const task = run('node', [SCRIPT, 'task', 'inspect the stored result fallback'], {
    cwd: repo,
    env,
  });
  assert.equal(task.status, 0, task.stderr);

  const stateDir = resolveDurableStateDir(repo, env.CODEX_HOME);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  const job = state.jobs.find(
    (candidate: Record<string, unknown>) => candidate.jobClass === 'task',
  );
  assert.ok(job);
  const jobId = job.id as string;
  const jobFile = path.join(stateDir, 'jobs', `${jobId}.json`);

  const control = run('node', [SCRIPT, 'result', jobId, '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(control.status, 0, control.stderr);
  const controlPayload = JSON.parse(control.stdout);
  assert.equal(controlPayload.storedJob.id, jobId);
  assert.equal(Object.hasOwn(controlPayload, 'storedJobWarning'), false);

  fs.writeFileSync(jobFile, '{not-json', 'utf8');

  const jsonResult = run('node', [SCRIPT, 'result', jobId, '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const payload = JSON.parse(jsonResult.stdout);
  assert.equal(payload.storedJob, null);
  assert.equal(payload.storedJobWarning.includes(jobFile), true);
  assert.match(payload.storedJobWarning, /^Stored result file is unreadable:/);
  assert.match(payload.storedJobWarning, /Showing index data only\.$/);

  const renderedResult = run('node', [SCRIPT, 'result', jobId], {
    cwd: repo,
    env,
  });
  assert.equal(renderedResult.status, 0, renderedResult.stderr);
  assert.match(renderedResult.stdout, /^# Codex Task/);
  assert.equal(renderedResult.stdout.includes(`Job: ${jobId}`), true);
  assert.match(renderedResult.stdout, /Status: completed/);
  assert.match(renderedResult.stdout, /No captured result payload was stored for this job\./);
  assert.match(renderedResult.stdout, /\nWarnings:\n- Stored result file is unreadable:/);
  assert.equal(renderedResult.stdout.includes(jobFile), true);
  assert.match(renderedResult.stdout, /Showing index data only\./);
});

test('result returns the stored output for the latest finished job by default', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, 'review-finished.json'),
    JSON.stringify(
      {
        id: 'review-finished',
        status: 'completed',
        title: 'Codex Review',
        rendered: '# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n',
        result: {
          codex: {
            stdout: 'Reviewed uncommitted changes.\nNo material issues found.',
          },
        },
        threadId: 'thr_review_finished',
      },
      null,
      2,
    ),
    'utf8',
  );

  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'review-finished',
            status: 'completed',
            title: 'Codex Review',
            jobClass: 'review',
            threadId: 'thr_review_finished',
            summary: 'Review working tree diff',
            createdAt: '2026-03-18T15:00:00.000Z',
            updatedAt: '2026-03-18T15:01:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'result'], {
    cwd: workspace,
  });

  assert.equal(result.status, 0, result.stderr);
  // The stored rendering (with its heading) is preferred over raw stdout for
  // review-class jobs.
  assert.equal(
    result.stdout,
    '# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n\nModel: -\nCodex session ID: thr_review_finished\nResume in Codex: codex resume thr_review_finished\n',
  );
});

test('result without a job id prefers the latest finished job from the current Claude session', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, 'review-current.json'),
    JSON.stringify(
      {
        id: 'review-current',
        status: 'completed',
        title: 'Codex Review',
        threadId: 'thr_current',
        result: {
          codex: {
            stdout: 'Current session output.',
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  fs.writeFileSync(
    path.join(jobsDir, 'review-other.json'),
    JSON.stringify(
      {
        id: 'review-other',
        status: 'completed',
        title: 'Codex Review',
        threadId: 'thr_other',
        result: {
          codex: {
            stdout: 'Old session output.',
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'review-current',
            status: 'completed',
            title: 'Codex Review',
            jobClass: 'review',
            sessionId: 'sess-current',
            threadId: 'thr_current',
            summary: 'Current session review',
            createdAt: '2026-03-18T15:10:00.000Z',
            updatedAt: '2026-03-18T15:11:00.000Z',
          },
          {
            id: 'review-other',
            status: 'completed',
            title: 'Codex Review',
            jobClass: 'review',
            sessionId: 'sess-other',
            threadId: 'thr_other',
            summary: 'Old session review',
            createdAt: '2026-03-18T15:20:00.000Z',
            updatedAt: '2026-03-18T15:21:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'result'], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: 'sess-current',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    'Current session output.\n\nModel: -\nCodex session ID: thr_current\nResume in Codex: codex resume thr_current\n',
  );
});

test('result for a finished write-capable task returns the raw Codex final response', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const taskRun = run('node', [SCRIPT, 'task', '--write', 'fix the flaky integration test'], {
    cwd: repo,
    env: buildEnv(binDir),
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run('node', [SCRIPT, 'result'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(result.stdout, /Note: this write-capable run reported no file changes\./);
  assert.match(result.stdout, /Codex session ID: thr_[a-z0-9]+/i);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_[a-z0-9]+/i);
});

test('cancel stops an active background job and marks it cancelled', async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: workspace,
    detached: true,
    stdio: 'ignore',
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid!, 'SIGTERM');
    } catch {
      try {
        process.kill(sleeper.pid!, 'SIGTERM');
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, 'task-live.log');
  const jobFile = path.join(jobsDir, 'task-live.json');
  fs.writeFileSync(logFile, '[2026-03-18T15:30:00.000Z] Starting Codex Task.\n', 'utf8');
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: 'task-live',
        status: 'running',
        title: 'Codex Task',
        logFile,
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'task-live',
            status: 'running',
            title: 'Codex Task',
            jobClass: 'task',
            summary: 'Investigate flaky test',
            pid: sleeper.pid,
            logFile,
            createdAt: '2026-03-18T15:30:00.000Z',
            startedAt: '2026-03-18T15:30:01.000Z',
            updatedAt: '2026-03-18T15:30:02.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const cancelResult = run('node', [SCRIPT, 'cancel', 'task-live', '--json'], {
    cwd: workspace,
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, 'cancelled');

  await waitFor(() => {
    try {
      process.kill(sleeper.pid!, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException | null)?.code === 'ESRCH';
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  const cancelled = state.jobs.find((job: Record<string, any>) => job.id === 'task-live');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  assert.equal(stored.status, 'cancelled');
  assert.match(fs.readFileSync(logFile, 'utf8'), /Cancelled by user/);
});

test('cancel degrades to index data when the stored job file is corrupt', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobs = ['task-corrupt-json', 'task-corrupt-text'].map((id, index) => {
    const logFile = path.join(jobsDir, `${id}.log`);
    fs.writeFileSync(logFile, '', 'utf8');
    fs.writeFileSync(resolveJobFile(workspace, id), '{', 'utf8');
    return {
      id,
      status: 'running',
      title: 'Codex Task',
      jobClass: 'task',
      summary: `Corrupt stored job ${index + 1}`,
      pid: null,
      logFile,
      createdAt: `2026-03-18T15:3${index}:00.000Z`,
      updatedAt: `2026-03-18T15:3${index}:01.000Z`,
    };
  });
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const jsonCancel = run(process.execPath, [SCRIPT, 'cancel', 'task-corrupt-json', '--json'], {
    cwd: workspace,
  });
  assert.equal(jsonCancel.status, 0, jsonCancel.stderr);
  const jsonPayload = JSON.parse(jsonCancel.stdout);
  assert.equal(jsonPayload.status, 'cancelled');
  assert.match(
    jsonPayload.storedJobWarning,
    new RegExp(
      `^Stored job file is unreadable: ${resolveJobFile(workspace, 'task-corrupt-json').replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      )} \\(.+\\)\\. Cancelling with index data only\\.$`,
    ),
  );

  const textCancel = run(process.execPath, [SCRIPT, 'cancel', 'task-corrupt-text'], {
    cwd: workspace,
  });
  assert.equal(textCancel.status, 0, textCancel.stderr);
  assert.match(textCancel.stdout, /Warnings:\n- Stored job file is unreadable:/);
  assert.match(textCancel.stdout, /Cancelling with index data only\./);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  assert.deepEqual(
    state.jobs.map((job: Record<string, unknown>) => job.status),
    ['cancelled', 'cancelled'],
  );
  for (const job of jobs) {
    const log = fs.readFileSync(job.logFile, 'utf8');
    assert.match(log, /Stored job file is unreadable:/);
    assert.match(log, /Thread reservation cleanup: none-found/);
    assert.match(log, /Cancelled by user/);
  }
});

test('handleCancel dependency injection preserves interrupt, kill, and release order', async () => {
  const workspace = makeTempDir();
  const jobId = 'task-di-cancel';
  const logFile = path.join(resolveDurableStateDir(workspace), 'jobs', `${jobId}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, '', 'utf8');
  const job = {
    id: jobId,
    status: 'running',
    title: 'Codex Task',
    jobClass: 'task',
    pid: 4242,
    threadId: 'thr-index',
    turnId: 'turn-index',
    logFile,
    createdAt: '2026-03-18T15:30:00.000Z',
    updatedAt: '2026-03-18T15:30:01.000Z',
  };
  writeJobFile(workspace, jobId, {
    ...job,
    threadId: 'thr-stored',
    turnId: 'turn-stored',
    request: { threadId: 'thr-request' },
  });
  upsertJob(workspace, job);

  const calls: string[] = [];
  const deps: CancelDeps = {
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: 'sess-di' },
    interruptAppServerTurn: async (cwd, target) => {
      calls.push('interrupt');
      assert.equal(cwd, workspace);
      assert.deepEqual(target, { threadId: 'thr-stored', turnId: 'turn-stored' });
      return {
        attempted: true,
        interrupted: true,
        transport: 'fake',
        detail: 'interrupted',
      };
    },
    terminateProcessTree: (pid) => {
      calls.push('kill');
      assert.equal(pid, 4242);
      return { attempted: true, delivered: true, method: 'kill' };
    },
    processHasExited: () => false,
    releaseThreadReservationForCancelledJob: async (identity) => {
      calls.push('release');
      assert.deepEqual(identity, {
        threadId: 'thr-stored',
        requestThreadId: 'thr-request',
        jobId,
        pid: 4242,
      });
      return { released: true, status: 'released' };
    },
  };

  const originalLog = console.log;
  console.log = () => {};
  try {
    await handleCancel(['--cwd', workspace, '--json', jobId], deps);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(calls, ['interrupt', 'kill', 'release']);
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), 'utf8'));
  assert.equal(stored.status, 'cancelled');
});

test('handleCancel skips a dead worker pid and still terminalizes the job', async () => {
  const workspace = makeTempDir();
  const jobId = 'task-dead-pid';
  const job = {
    id: jobId,
    status: 'running',
    title: 'Dead worker task',
    jobClass: 'task',
    pid: 2147483647,
    createdAt: '2026-03-18T15:30:00.000Z',
    updatedAt: '2026-03-18T15:30:01.000Z',
  };
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);
  let killCalls = 0;
  const deps: CancelDeps = {
    interruptAppServerTurn: async () => ({
      attempted: false,
      interrupted: false,
      transport: null,
      detail: '',
    }),
    terminateProcessTree: () => {
      killCalls += 1;
      return { attempted: true, delivered: true, method: 'kill' };
    },
    releaseThreadReservationForCancelledJob: async () => ({
      released: false,
      status: 'none-found',
    }),
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    await handleCancel(['--cwd', workspace, '--json', jobId], deps);
  } finally {
    console.log = originalLog;
  }

  assert.equal(killCalls, 0);
  assert.equal(
    readCompanionState(workspace)?.jobs.find((entry) => entry.id === jobId)?.status,
    'cancelled',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), 'utf8')).status,
    'cancelled',
  );
});

test('handleCancel reports a kill warning but still terminalizes after EPERM', async () => {
  const workspace = makeTempDir();
  const jobId = 'task-kill-eperm';
  const job = {
    id: jobId,
    status: 'running',
    title: 'Protected worker task',
    jobClass: 'task',
    pid: 4243,
    createdAt: '2026-03-18T15:30:00.000Z',
    updatedAt: '2026-03-18T15:30:01.000Z',
  };
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);
  const deps: CancelDeps = {
    interruptAppServerTurn: async () => ({
      attempted: false,
      interrupted: false,
      transport: null,
      detail: '',
    }),
    processHasExited: () => false,
    terminateProcessTree: () => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    },
    releaseThreadReservationForCancelledJob: async () => ({
      released: false,
      status: 'none-found',
    }),
  };
  let output = '';
  const originalLog = console.log;
  console.log = (value: unknown) => {
    output += `${String(value)}\n`;
  };
  try {
    await handleCancel(['--cwd', workspace, '--json', jobId], deps);
  } finally {
    console.log = originalLog;
  }

  const payload = JSON.parse(output);
  assert.match(payload.killWarning, /operation not permitted/);
  assert.equal(
    JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), 'utf8')).status,
    'cancelled',
  );
});

test('handleTaskWorker dependency injection dispatches task, plan-review, and review requests', async () => {
  const workspace = makeTempDir();
  const worktree = makeTempDir();
  const seedWorker = (id: string, request: Record<string, unknown>) => {
    const job = {
      id,
      status: 'queued',
      title: 'Queued worker',
      jobClass: 'task',
      workspaceRoot: workspace,
      request,
      createdAt: '2026-03-18T15:30:00.000Z',
      updatedAt: '2026-03-18T15:30:01.000Z',
    };
    writeJobFile(workspace, id, job);
    upsertJob(workspace, job);
  };
  seedWorker('task-worker-di', {
    cwd: worktree,
    prompt: 'run the task branch',
  });
  seedWorker('plan-worker-di', {
    kind: 'plan-review',
    cwd: workspace,
    plan: 'Review this plan.',
    round: 1,
  });
  seedWorker('review-worker-di', {
    kind: 'review',
    cwd: workspace,
    reviewName: 'Adversarial Review',
    focusText: 'Review the edge cases.',
  });

  const calls: string[] = [];
  const deps: TaskWorkerDeps = {
    runTrackedJob: async (_job, runner) => {
      calls.push('tracked');
      return runner();
    },
    executeTaskRun: async (request) => {
      calls.push('task');
      assert.equal(request.cwd, worktree);
      assert.equal(request.workspaceRoot, workspace);
      assert.equal(request.prompt, 'run the task branch');
      assert.equal(typeof request.onProgress, 'function');
      return {
        exitStatus: 0,
        threadId: 'thr-task',
        turnId: null,
        payload: {},
        rendered: 'task\n',
        summary: 'task',
        jobTitle: 'Codex Task',
        jobClass: 'task',
      };
    },
    executePlanReviewRun: async (request) => {
      calls.push('plan');
      assert.equal(request.plan, 'Review this plan.');
      assert.equal(typeof request.onProgress, 'function');
      return {
        exitStatus: 0,
        threadId: 'thr-plan',
        turnId: null,
        payload: {},
        rendered: 'plan\n',
        summary: 'plan',
        jobTitle: 'Codex Plan Review',
        jobClass: 'review',
      };
    },
    executeReviewRun: async (request) => {
      calls.push('review');
      assert.equal(request.reviewName, 'Adversarial Review');
      assert.equal(typeof request.onProgress, 'function');
      return {
        exitStatus: 0,
        threadId: 'thr-review',
        turnId: null,
        payload: {},
        rendered: 'review\n',
        summary: 'review',
        jobTitle: 'Codex Adversarial Review',
        jobClass: 'review',
      };
    },
  };

  await handleTaskWorker(
    ['--cwd', worktree, '--workspace', workspace, '--job-id', 'task-worker-di'],
    deps,
  );
  await handleTaskWorker(['--cwd', workspace, '--job-id', 'plan-worker-di'], deps);
  await handleTaskWorker(['--cwd', workspace, '--job-id', 'review-worker-di'], deps);

  assert.deepEqual(calls, ['tracked', 'task', 'tracked', 'plan', 'tracked', 'review']);
});

test('handleTaskWorker records a bootstrap failure when --workspace is invalid', async () => {
  const workspace = makeTempDir();
  const jobId = 'task-worker-invalid-workspace';
  const job = {
    id: jobId,
    status: 'queued',
    title: 'Queued worker',
    jobClass: 'task',
    workspaceRoot: workspace,
    request: { cwd: workspace, prompt: 'run the task branch' },
  };
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);
  const missingWorkspace = path.join(workspace, 'missing-workspace');

  await assert.rejects(
    handleTaskWorker(['--cwd', workspace, '--workspace', missingWorkspace, '--job-id', jobId]),
    (error: unknown) =>
      error instanceof Error &&
      error.message === `--workspace ${missingWorkspace} is not an existing directory.`,
  );

  const failed = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), 'utf8'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.phase, 'failed');
  assert.equal(
    failed.errorMessage,
    `--workspace ${missingWorkspace} is not an existing directory.`,
  );
});

test('handleTaskWorker rejects an unsafe job id before bootstrap failure persistence', async () => {
  const workspace = makeTempDir();

  await assert.rejects(
    handleTaskWorker(['--cwd', workspace, '--job-id', '../escape']),
    /Unsupported job id "\.\.\/escape"/,
  );

  assert.equal(fs.existsSync(path.join(resolveDurableStateDir(workspace), 'escape.json')), false);
});

test('cancel without a job id ignores active jobs from other Claude sessions', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, 'task-other.log');
  fs.writeFileSync(logFile, '', 'utf8');
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'task-other',
            status: 'running',
            title: 'Codex Task',
            jobClass: 'task',
            sessionId: 'sess-other',
            summary: 'Other session run',
            updatedAt: '2026-03-24T20:05:00.000Z',
            logFile,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: 'sess-current',
  };
  const status = run('node', [SCRIPT, 'status', '--json'], {
    cwd: workspace,
    env,
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run('node', [SCRIPT, 'cancel', '--json'], {
    cwd: workspace,
    env,
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active Codex jobs to cancel for this session\./);
  assert.match(
    JSON.parse(cancel.stdout).error,
    /No active Codex jobs to cancel for this session\./,
  );

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  assert.equal(state.jobs[0].status, 'running');
});

test('cancel with a job id can still target an active job from another Claude session', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, 'task-other.log');
  fs.writeFileSync(logFile, '', 'utf8');
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'task-other',
            status: 'running',
            title: 'Codex Task',
            jobClass: 'task',
            sessionId: 'sess-other',
            summary: 'Other session run',
            updatedAt: '2026-03-24T20:05:00.000Z',
            logFile,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: 'sess-current',
  };
  const cancel = run('node', [SCRIPT, 'cancel', 'task-other', '--json'], {
    cwd: workspace,
    env,
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, 'task-other');

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  assert.equal(state.jobs[0].status, 'cancelled');
});

test('cancel sends turn interrupt to the shared app-server before killing a brokered task', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'interruptible-slow-task');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run(
    'node',
    [SCRIPT, 'task', '--background', '--json', 'investigate the flaky worker timeout'],
    {
      cwd: repo,
      env,
    },
  );

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const runningJob = await waitFor(
    () => {
      const job = readCompanionState(repo, env)?.jobs.find(
        (candidate: Record<string, any>) => candidate.id === jobId,
      );
      if (job?.status === 'running' && job.threadId && job.turnId) {
        return job;
      }
      return null;
    },
    { timeoutMs: 15000 },
  );

  const cancelResult = run('node', [SCRIPT, 'cancel', jobId, '--json'], {
    cwd: repo,
    env,
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, 'cancelled');
  assert.equal(cancelPayload.turnInterruptAttempted, true);
  assert.equal(cancelPayload.turnInterrupted, true);

  const lastInterrupt = await waitFor(() => readFakeState(binDir).lastInterrupt ?? null);
  assert.deepEqual(lastInterrupt, {
    threadId: runningJob.threadId,
    turnId: runningJob.turnId,
  });

  const cleanup = run('node', [SESSION_HOOK, 'SessionEnd'], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: 'SessionEnd',
      cwd: repo,
    }),
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test('setup preserves an existing shared broker while probing rate limits privately', (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  t.after(async () => {
    await reapWorkspaceBroker(repo);
  });

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');

  const env = buildEnv(binDir);

  const review = run('node', [SCRIPT, 'review'], {
    cwd: repo,
    env,
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }
  const appServerStartsBefore = readFakeState(binDir).appServerStarts;

  const setup = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).sessionRuntime.mode, 'shared');

  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.appServerStarts, appServerStartsBefore + 1);
  assert.deepEqual(loadBrokerSession(repo), brokerSession);

  const cleanup = run('node', [SESSION_HOOK, 'SessionEnd'], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: 'SessionEnd',
      cwd: repo,
    }),
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test('status reports shared session runtime when a lazy broker is active', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');

  const review = run('node', [SCRIPT, 'review'], {
    cwd: repo,
    env: buildEnv(binDir),
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run('node', [SCRIPT, 'status'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: shared session/);
});

test('setup and status honor --cwd when reading shared session runtime', () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();

  saveBrokerSession(targetWorkspace, {
    endpoint: 'unix:/tmp/fake-broker.sock',
  } as BrokerSession);

  const status = run('node', [SCRIPT, 'status', '--cwd', targetWorkspace], {
    cwd: invocationWorkspace,
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: shared session/);

  const setup = run('node', [SCRIPT, 'setup', '--cwd', targetWorkspace, '--json'], {
    cwd: invocationWorkspace,
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, 'shared');
  assert.equal(payload.sessionRuntime.endpoint, 'unix:/tmp/fake-broker.sock');
});

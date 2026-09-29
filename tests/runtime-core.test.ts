import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { buildClaudeEnv, installFakeClaude } from './fake-claude-fixture.ts';
import { reapWorkspaceBroker } from './broker-reaper.ts';
import { initGitRepo, makeTempDir, run, waitFor } from './helpers.ts';
import {
  ROOT,
  SCRIPT,
  SESSION_HOOK,
  initializeBasicRepo,
  readFakeState,
  registerBrokerReaping,
  waitForFakeState,
} from './runtime-helpers.ts';
import { loadBrokerSession, saveBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import type { BrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import type { SetupRenderReport } from '../plugins/stereo/src/render/render.ts';

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
  installFakeClaude(binDir);

  const result = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: ROOT,
    env: buildClaudeEnv(binDir, buildEnv(binDir)),
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

test('setup --json carries the exact text the plain run prints', () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  installFakeClaude(binDir);
  const env = buildClaudeEnv(binDir, buildEnv(binDir));
  const cwd = initializeBasicRepo();

  const plain = run('node', [SCRIPT, 'setup'], { cwd, env });
  assert.equal(plain.status, 0, plain.stderr);
  const json = run('node', [SCRIPT, 'setup', '--json'], { cwd, env });
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout) as SetupRenderReport & { rendered: string };
  assert.equal(payload.ready, true);
  assert.match(plain.stdout, /^# Stereo Setup\n/);
  // The model listing is rendered text only, never a JSON field.
  assert.equal('models' in payload, false);
  assert.match(
    payload.rendered,
    /\nModels \(efforts are role-launch defaults;[^\n]*\n- Codex catalog: /,
  );
  // Every setup run refreshes the Codex catalog, so the two invocations can
  // differ only in the fetch timestamp on the catalog line.
  const stable = (text: string): string => text.replace(/fetched \S+/g, 'fetched <time>');
  assert.equal(stable(payload.rendered), stable(plain.stdout));
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
  installFakeClaude(binDir);
  const env = buildClaudeEnv(binDir, buildEnv(binDir));

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
  installFakeClaude(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, 'node'));

  const result = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir,
      CLAUDE_CODE_EXECPATH: path.join(binDir, 'claude'),
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
  installFakeClaude(binDir);

  const result = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: ROOT,
    env: buildClaudeEnv(binDir, buildEnv(binDir)),
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
  installFakeClaude(binDir);

  const result = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: ROOT,
    env: buildClaudeEnv(binDir, buildEnv(binDir)),
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
  installFakeClaude(binDir);
  const env = {
    ...buildClaudeEnv(binDir, buildEnv(binDir)),
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
  installFakeCodex(binDir, 'logged-out');
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

test('--json inside prompt text does not switch error output to JSON', () => {
  const repo = makeTempDir();
  initGitRepo(repo);

  // The prompt text is one argument and stays a positional.
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

test('setup preserves an existing shared broker while probing rate limits privately', async (t) => {
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
  const appServerStartsBefore = (await waitForFakeState(binDir, 'appServerStarts')).appServerStarts;

  const setup = run('node', [SCRIPT, 'setup', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).sessionRuntime.mode, 'shared');

  const fakeState = await waitForFakeState(binDir, 'appServerStarts');
  assert.equal(fakeState.appServerStarts, appServerStartsBefore + 1);
  assert.deepEqual(loadBrokerSession(repo), brokerSession);

  const cleanup = run('node', [SESSION_HOOK, 'SessionEndSweep'], {
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

  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const setup = run('node', [SCRIPT, 'setup', '--cwd', targetWorkspace, '--json'], {
    cwd: invocationWorkspace,
    env: buildEnv(binDir),
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, 'shared');
  assert.equal(payload.sessionRuntime.endpoint, 'unix:/tmp/fake-broker.sock');
});

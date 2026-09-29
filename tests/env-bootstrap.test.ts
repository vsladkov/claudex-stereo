import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installFakeClaude } from './fake-claude-fixture.ts';
import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { makeTempDir, run } from './helpers.ts';
import { resolveStateDir } from '../plugins/stereo/src/workspace/state.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP = path.join(ROOT, 'tests', 'env-bootstrap.cjs');
const STATE_MODULE_URL = pathToFileURL(
  path.join(ROOT, 'plugins', 'stereo', 'src', 'workspace', 'state.ts'),
).href;

test('preload strips leaked session variables', () => {
  const expression = [
    'CODEX_COMPANION_SESSION_ID',
    'CODEX_COMPANION_TRANSCRIPT_PATH',
    'CLAUDE_ENV_FILE',
    'CLAUDE_PROJECT_DIR',
    'CODEX_COMPANION_APP_SERVER_ENDPOINT',
  ]
    .map((name) => `process.env.${name} ?? "unset"`)
    .join(',');
  const result = run(
    process.execPath,
    ['--require', BOOTSTRAP, '-p', `[${expression}].join(",")`],
    {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: '/tmp/plugin-data',
        CODEX_COMPANION_SESSION_ID: 'leaked-session',
        CODEX_COMPANION_TRANSCRIPT_PATH: '/tmp/transcript.jsonl',
        CLAUDE_ENV_FILE: '/tmp/session-env.sh',
        CLAUDE_PROJECT_DIR: '/tmp/project-dir',
        CODEX_COMPANION_APP_SERVER_ENDPOINT: 'unix:/tmp/developer-broker.sock',
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'unset,unset,unset,unset,unset');
});

test('preload scrubs the turn inactivity timeout a developer shell may export', () => {
  // It changes what a spawned companion does (the turn watchdogs), so a
  // leaked value would silently change the behaviour every test pins.
  const expression = 'process.env.STEREO_TURN_INACTIVITY_TIMEOUT_MS ?? "unset"';
  const result = run(process.execPath, ['--require', BOOTSTRAP, '-p', expression], {
    env: { ...process.env, STEREO_TURN_INACTIVITY_TIMEOUT_MS: '1' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'unset');
});

test('preload drops a leaked Claude exec path and scrubs the effort markers', () => {
  const expression =
    'JSON.stringify({ execPath: process.env.CLAUDE_CODE_EXECPATH ?? "unset", effort: process.env.CLAUDE_EFFORT ?? "unset", level: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? "unset" })';
  const result = run(process.execPath, ['--require', BOOTSTRAP, '-p', expression], {
    env: {
      ...process.env,
      CLAUDE_CODE_EXECPATH: path.join(os.tmpdir(), 'developer-claude-binary'),
      CLAUDE_EFFORT: 'max',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  // The developer's binary is never named: a bare `claude` is the decoy.
  assert.deepEqual(JSON.parse(result.stdout), {
    execPath: 'unset',
    effort: 'unset',
    level: 'unset',
  });
});

test('preload always replaces leaked state homes with isolated temp directories', () => {
  const expression =
    'JSON.stringify({ pluginData: process.env.CLAUDE_PLUGIN_DATA, codexHome: process.env.CODEX_HOME })';
  const leakedPluginData = path.join(os.tmpdir(), 'developer-plugin-data');
  const leakedCodexHome = path.join(os.tmpdir(), 'developer-codex-home');
  const result = run(process.execPath, ['--require', BOOTSTRAP, '-p', expression], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: leakedPluginData,
      CODEX_HOME: leakedCodexHome,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const isolated = JSON.parse(result.stdout);
  assert.equal(
    isolated.pluginData.startsWith(path.join(os.tmpdir(), 'stereo-test-plugin-data-')),
    true,
  );
  assert.equal(
    isolated.codexHome.startsWith(path.join(os.tmpdir(), 'stereo-test-codex-home-')),
    true,
  );
  assert.notEqual(isolated.pluginData, leakedPluginData);
  assert.notEqual(isolated.codexHome, leakedCodexHome);
});

test('spawned CLI children inherit the test process plugin-data root', () => {
  const workspace = makeTempDir();
  const parentStateDir = resolveStateDir(workspace);
  const expression = `const { resolveStateDir } = await import(${JSON.stringify(STATE_MODULE_URL)}); console.log(resolveStateDir(${JSON.stringify(workspace)}));`;
  const result = run(process.execPath, ['--input-type=module', '-e', expression], {
    env: { ...process.env },
  });

  assert.equal(result.status, 0, result.stderr);
  const childStateDir = result.stdout.trim();
  assert.equal(childStateDir.startsWith(path.join(process.env.CLAUDE_PLUGIN_DATA!, 'state')), true);
  assert.equal(childStateDir, parentStateDir);
});

test('the runner mints a fresh run id that every process under it inherits', () => {
  const expression = 'process.env.STEREO_TEST_RUN_ID';
  const ownRunId = process.env.STEREO_TEST_RUN_ID;
  assert.ok(ownRunId, 'this test process carries its run id');

  // A test process (NODE_TEST_CONTEXT set) keeps the run it belongs to.
  const inherited = run(process.execPath, ['--require', BOOTSTRAP, '-p', expression], {
    env: { ...process.env },
  });
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.equal(inherited.stdout.trim(), ownRunId);

  // A runner (no NODE_TEST_CONTEXT) never adopts a leaked id.
  const runnerEnv: NodeJS.ProcessEnv = { ...process.env, STEREO_TEST_RUN_ID: 'leaked-run' };
  delete runnerEnv.NODE_TEST_CONTEXT;
  const fresh = run(process.execPath, ['--require', BOOTSTRAP, '-p', expression], {
    env: runnerEnv,
  });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.notEqual(fresh.stdout.trim(), 'leaked-run');
  assert.notEqual(fresh.stdout.trim(), ownRunId);
  assert.match(fresh.stdout.trim(), /^\d+-[0-9a-f]{12}$/);
});

test('decoy codex and claude binaries lead PATH and fail loudly; a fake bin still wins', () => {
  // This process ran the preload: a bare `codex` or `claude` is a decoy,
  // never the developer's CLI.
  for (const name of ['codex', 'claude']) {
    const decoy = run(name, ['--version'], { env: process.env });
    assert.equal(decoy.status, 127, name);
    assert.match(
      decoy.stderr,
      new RegExp(`stereo test decoy: the real ${name} must not run in tests`),
    );
    assert.equal(decoy.stdout, '');
  }

  const fakeBin = makeTempDir();
  installFakeCodex(fakeBin);
  installFakeClaude(fakeBin);
  for (const name of ['codex', 'claude']) {
    const fake = run(name, ['--version'], { env: buildEnv(fakeBin) });
    assert.equal(fake.status, 0, fake.stderr);
    assert.doesNotMatch(fake.stderr, /stereo test decoy/);
  }

  // A preloaded child under a fake bin keeps the fake ahead of the decoy.
  const child = run(
    process.execPath,
    [
      '--require',
      BOOTSTRAP,
      '-e',
      'const r = require("node:child_process").spawnSync("codex", ["--version"], { encoding: "utf8" }); process.stdout.write(String(r.status));',
    ],
    { env: buildEnv(fakeBin) },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '0');
});

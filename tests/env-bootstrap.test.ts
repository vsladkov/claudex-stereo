import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'unset,unset,unset,unset');
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

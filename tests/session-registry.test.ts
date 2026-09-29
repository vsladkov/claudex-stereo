import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createJobRecord } from '../plugins/stereo/src/jobs/tracked-jobs.ts';
import {
  clearSessionWorkspaces,
  readSessionWorkspaces,
  recordSessionWorkspace,
  resolveSessionRegistryFile,
} from '../plugins/stereo/src/workspace/session-registry.ts';
import { makeTempDir } from './helpers.ts';

const REGISTRY_MODULE_URL = pathToFileURL(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'plugins',
    'stereo',
    'src',
    'workspace',
    'session-registry.ts',
  ),
).href;

test('a session registry records, dedupes, reads back, and clears its workspace roots', () => {
  const codexHome = makeTempDir();
  const rootA = path.join(codexHome, 'repo-a');
  const rootB = path.join(codexHome, 'repo-b');
  const file = resolveSessionRegistryFile('sess-1', codexHome);
  assert.equal(file, path.join(codexHome, 'companion-state', 'session-workspaces', 'sess-1.json'));
  assert.ok(file);
  assert.deepEqual(readSessionWorkspaces('sess-1', codexHome), []);

  assert.equal(recordSessionWorkspace('sess-1', rootA, codexHome), true);
  assert.equal(recordSessionWorkspace('sess-1', rootB, codexHome), true);
  assert.equal(recordSessionWorkspace('sess-1', rootA, codexHome), true, 'a repeat is a no-op');
  assert.deepEqual(readSessionWorkspaces('sess-1', codexHome), [rootA, rootB]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    version: 1,
    roots: [rootA, rootB],
  });
  // Sessions never see each other's roots.
  assert.deepEqual(readSessionWorkspaces('sess-2', codexHome), []);

  clearSessionWorkspaces('sess-1', codexHome);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(readSessionWorkspaces('sess-1', codexHome), []);
  // Clearing an absent registry is fine.
  clearSessionWorkspaces('sess-1', codexHome);
});

test('an unsafe session id is ignored by every registry operation', () => {
  const codexHome = makeTempDir();
  for (const sessionId of ['', ' ', 'sess/1', '../escape', 'sess 1', 'a'.repeat(129)]) {
    const label = JSON.stringify(sessionId);
    assert.equal(resolveSessionRegistryFile(sessionId, codexHome), null, label);
    assert.equal(recordSessionWorkspace(sessionId, '/some/root', codexHome), false, label);
    assert.deepEqual(readSessionWorkspaces(sessionId, codexHome), [], label);
    clearSessionWorkspaces(sessionId, codexHome);
  }
  // An empty root is not worth a file either.
  assert.equal(recordSessionWorkspace('sess-ok', '', codexHome), false);
  assert.equal(fs.existsSync(path.join(codexHome, 'companion-state')), false);

  // The whole safe alphabet is accepted, up to the length cap.
  const longest = 'a'.repeat(128);
  assert.equal(recordSessionWorkspace(longest, '/some/root', codexHome), true);
  assert.equal(recordSessionWorkspace('Sess.1_x-2', '/some/root', codexHome), true);
  assert.deepEqual(readSessionWorkspaces(longest, codexHome), ['/some/root']);
  assert.deepEqual(readSessionWorkspaces('Sess.1_x-2', codexHome), ['/some/root']);
});

test('a damaged or foreign registry file reads as empty and is rewritten on the next record', () => {
  const codexHome = makeTempDir();
  const file = resolveSessionRegistryFile('sess-damaged', codexHome);
  assert.ok(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const cases: Array<[string, string[]]> = [
    ['{not json', []],
    ['[]', []],
    ['null', []],
    [JSON.stringify({ version: 2, roots: ['/x'] }), []],
    [JSON.stringify({ version: 1, roots: '/x' }), []],
    [JSON.stringify({ version: 1, roots: ['/x', 7, '', null, '/y'] }), ['/x', '/y']],
  ];
  for (const [contents, expected] of cases) {
    fs.writeFileSync(file, contents, 'utf8');
    assert.deepEqual(readSessionWorkspaces('sess-damaged', codexHome), expected, contents);
  }

  fs.writeFileSync(file, '{not json', 'utf8');
  assert.equal(recordSessionWorkspace('sess-damaged', '/fresh', codexHome), true);
  assert.deepEqual(readSessionWorkspaces('sess-damaged', codexHome), ['/fresh']);
});

test('createJobRecord registers the job workspace root for the launching Claude session', () => {
  // The default registry lives under the process CODEX_HOME, which the test
  // bootstrap points at a fresh temporary directory.
  const workspaceRoot = makeTempDir();
  const file = resolveSessionRegistryFile('sess-x');
  assert.ok(file);
  assert.equal(fs.existsSync(file), false);

  const record = createJobRecord(
    { id: 'job-registered', workspaceRoot, title: 'Codex Task' },
    { env: { CODEX_COMPANION_SESSION_ID: 'sess-x' } },
  );
  assert.equal(record.sessionId, 'sess-x');
  assert.equal(record.workspaceRoot, workspaceRoot);
  assert.deepEqual(readSessionWorkspaces('sess-x'), [workspaceRoot]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).roots, [workspaceRoot]);

  // Another job in the same root adds nothing; another root is appended.
  createJobRecord(
    { id: 'job-again', workspaceRoot },
    { env: { CODEX_COMPANION_SESSION_ID: 'sess-x' } },
  );
  const otherRoot = makeTempDir();
  createJobRecord(
    { id: 'job-other', workspaceRoot: otherRoot },
    { env: { CODEX_COMPANION_SESSION_ID: 'sess-x' } },
  );
  assert.deepEqual(readSessionWorkspaces('sess-x'), [workspaceRoot, otherRoot]);

  // No session id, or no workspace root: nothing to register.
  const anonymous = createJobRecord({ id: 'job-anonymous', workspaceRoot }, { env: {} });
  assert.equal(anonymous.sessionId, undefined);
  createJobRecord({ id: 'job-rootless' }, { env: { CODEX_COMPANION_SESSION_ID: 'sess-rootless' } });
  const rootless = resolveSessionRegistryFile('sess-rootless');
  assert.ok(rootless);
  assert.equal(fs.existsSync(rootless), false);

  // The variable that names the session is configurable.
  createJobRecord(
    { id: 'job-custom', workspaceRoot },
    { env: { STEREO_TEST_SESSION: 'sess-custom' }, sessionIdEnv: 'STEREO_TEST_SESSION' },
  );
  assert.deepEqual(readSessionWorkspaces('sess-custom'), [workspaceRoot]);
});

test('two processes recording different roots for one session both survive', async () => {
  // Two launches from one session into two roots, in two companion processes
  // at once: the read-modify-write runs under the file lock, so neither
  // entry is lost to the other's write.
  const codexHome = makeTempDir();
  const rootA = path.join(codexHome, 'repo-a');
  const rootB = path.join(codexHome, 'repo-b');
  const script = path.join(makeTempDir(), 'record.mjs');
  fs.writeFileSync(
    script,
    [
      `import { recordSessionWorkspace } from ${JSON.stringify(REGISTRY_MODULE_URL)};`,
      'const [sessionId, root, home] = process.argv.slice(2);',
      'process.exit(recordSessionWorkspace(sessionId, root, home) ? 0 : 1);',
      '',
    ].join('\n'),
    'utf8',
  );
  const record = (root: string): Promise<{ code: number | null; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, 'sess-lock', root, codexHome], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stderr }));
    });

  const [first, second] = await Promise.all([record(rootA), record(rootB)]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual([...readSessionWorkspaces('sess-lock', codexHome)].sort(), [rootA, rootB]);
  const file = resolveSessionRegistryFile('sess-lock', codexHome);
  assert.ok(file);
  assert.equal(fs.existsSync(`${file}.lock`), false, 'both writers released the lock');
});

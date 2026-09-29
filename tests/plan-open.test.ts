import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import process from 'node:process';
import test from 'node:test';

import { openInVsCode } from '../plugins/stereo/src/cli/commands/plan.ts';
import type { EditorChild } from '../plugins/stereo/src/cli/commands/plan.ts';
import { fakeFiles } from './helpers.ts';

// `/stereo:plan --open` hands the plan file to VS Code: the launch is checked
// against a recorded spawn, so nothing is started and the file runs on every
// platform.

interface RecordedSpawn {
  file: string;
  args: string[];
  shell: unknown;
}

function fakeSpawner(event: 'spawn' | 'error') {
  const calls: RecordedSpawn[] = [];
  let unrefs = 0;
  const spawnImpl = (file: string, args: string[], options: { shell?: unknown }): EditorChild => {
    calls.push({ file, args, shell: options.shell });
    const child = new EventEmitter() as EventEmitter & EditorChild;
    child.unref = () => {
      unrefs += 1;
    };
    process.nextTick(() => child.emit(event));
    return child;
  };
  return { calls, spawnImpl, unrefs: () => unrefs };
}

test('plan --open hands cmd.exe the quoted path when code is a Windows shim', async () => {
  const { calls, spawnImpl, unrefs } = fakeSpawner('spawn');
  const planPath = 'C:\\Users\\A B\\plans\\plan & notes.md';
  const opened = await openInVsCode(planPath, {
    platform: 'win32',
    env: { PATH: 'C:\\VS Code\\bin' },
    fileExists: fakeFiles('C:\\VS Code\\bin\\code.cmd'),
    spawnImpl,
  });
  assert.equal(opened, true);
  assert.deepEqual(calls, [
    { file: 'code "C:\\Users\\A B\\plans\\plan & notes.md"', args: [], shell: true },
  ]);
  assert.equal(unrefs(), 1);
});

test('plan --open passes the path as a plain argument elsewhere and reports a missing editor', async () => {
  const posix = fakeSpawner('spawn');
  assert.equal(
    await openInVsCode('/tmp/a b/plan.md', { platform: 'linux', spawnImpl: posix.spawnImpl }),
    true,
  );
  assert.deepEqual(posix.calls, [{ file: 'code', args: ['/tmp/a b/plan.md'], shell: false }]);

  // No code on the Windows PATH: no shell (which would "succeed" as cmd.exe),
  // so the spawn error reports the editor missing.
  const missing = fakeSpawner('error');
  assert.equal(
    await openInVsCode('C:\\plan.md', {
      platform: 'win32',
      env: { PATH: 'C:\\nothing' },
      fileExists: fakeFiles(),
      spawnImpl: missing.spawnImpl,
    }),
    false,
  );
  assert.deepEqual(missing.calls, [{ file: 'code', args: ['C:\\plan.md'], shell: false }]);

  const throwing = await openInVsCode('/tmp/plan.md', {
    platform: 'linux',
    spawnImpl: () => {
      throw new Error('spawn EACCES');
    },
  });
  assert.equal(throwing, false);
});

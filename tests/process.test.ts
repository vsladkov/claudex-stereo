import test from 'node:test';
import assert from 'node:assert/strict';

import { terminateProcessTree } from '../plugins/stereo/src/platform/process.ts';

test('terminateProcessTree rejects non-positive, non-integer, and non-finite pids', () => {
  for (const pid of [0, -1, 12.5, Number.NaN]) {
    let killCalls = 0;
    let runCommandCalls = 0;

    for (const platform of ['linux', 'win32'] as const) {
      const outcome = terminateProcessTree(pid, {
        platform,
        runCommandImpl() {
          runCommandCalls += 1;
          throw new Error('runCommandImpl must not run for an invalid pid');
        },
        killImpl() {
          killCalls += 1;
          throw new Error('killImpl must not run for an invalid pid');
        },
      });

      assert.deepEqual(outcome, {
        attempted: false,
        delivered: false,
        method: null,
      });
    }

    assert.equal(runCommandCalls, 0);
    assert.equal(killCalls, 0);
  }
});

test('terminateProcessTree uses taskkill on Windows', () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: 'win32',
    runCommandImpl(command: string, args: readonly string[] = []) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: '',
        stderr: '',
        error: null,
      };
    },
    killImpl() {
      throw new Error('kill fallback should not run');
    },
  });

  assert.deepEqual(captured, {
    command: 'taskkill',
    args: ['/PID', '1234', '/T', '/F'],
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, 'taskkill');
});

test('terminateProcessTree treats missing Windows processes as already stopped', () => {
  const outcome = terminateProcessTree(1234, {
    platform: 'win32',
    runCommandImpl(command: string, args: readonly string[] = []) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: 'ERROR: The process "1234" not found.',
        stderr: '',
        error: null,
      };
    },
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, 'taskkill');
  assert.ok(outcome.result);
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

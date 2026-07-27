import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import {
  getCodexAvailability,
  resetCodexAvailabilityCache,
} from '../plugins/stereo/src/runtime/availability.ts';
import { binaryAvailable } from '../plugins/stereo/src/platform/process.ts';

test('injected Codex availability probes are never memoized', (t) => {
  resetCodexAvailabilityCache();
  t.after(resetCodexAvailabilityCache);
  let probes = 0;
  const probeImpl: typeof binaryAvailable = (_command, args = []) => {
    probes += 1;
    return {
      available: true,
      detail: args[0] === '--version' ? 'codex test version' : 'app-server test help',
    };
  };

  const first = getCodexAvailability(process.cwd(), { probeImpl });
  const second = getCodexAvailability(process.cwd(), { probeImpl });

  assert.equal(probes, 4);
  assert.notStrictEqual(first, second);
  assert.deepEqual(first, {
    available: true,
    detail: 'codex test version; advanced runtime available',
  });
});

test('default Codex availability probes are memoized by cwd and resettable', (t) => {
  if (!binaryAvailable('codex').available) {
    t.skip('codex is not available on PATH');
    return;
  }

  resetCodexAvailabilityCache();
  t.after(resetCodexAvailabilityCache);
  const first = getCodexAvailability(process.cwd());
  const cached = getCodexAvailability(process.cwd());
  assert.strictEqual(cached, first);

  resetCodexAvailabilityCache();
  const afterReset = getCodexAvailability(process.cwd());
  assert.notStrictEqual(afterReset, first);
});

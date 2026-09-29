import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import {
  getCodexAvailability,
  resetCodexAvailabilityCache,
} from '../plugins/stereo/src/runtime/availability.ts';
import { PROBE_TIMEOUT_MS } from '../plugins/stereo/src/platform/process.ts';
import type { binaryAvailable } from '../plugins/stereo/src/platform/process.ts';
import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { makeTempDir } from './helpers.ts';

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

test('Codex availability probes are bounded, and a hung one is unavailable', () => {
  const timeouts: Array<number | undefined> = [];
  const probeImpl: typeof binaryAvailable = (command, args = [], options = {}) => {
    timeouts.push(options.timeout);
    return args[0] === '--version'
      ? { available: true, detail: 'codex test version' }
      : { available: false, detail: `${command} ${args.join(' ')} timed out after 15000 ms` };
  };
  assert.deepEqual(getCodexAvailability(process.cwd(), { probeImpl }), {
    available: false,
    detail:
      'codex test version; advanced runtime unavailable: codex app-server --help timed out after 15000 ms',
  });
  assert.deepEqual(timeouts, [PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS]);
});

test('default Codex availability probes are memoized by cwd and resettable', (t) => {
  // The default probes spawn `codex` from PATH: the fake, never the real CLI.
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const previousPath = process.env.PATH;
  process.env.PATH = buildEnv(binDir).PATH;
  t.after(() => {
    process.env.PATH = previousPath;
  });

  resetCodexAvailabilityCache();
  t.after(resetCodexAvailabilityCache);
  const first = getCodexAvailability(process.cwd());
  assert.equal(first.available, true, first.detail);
  const cached = getCodexAvailability(process.cwd());
  assert.strictEqual(cached, first);

  resetCodexAvailabilityCache();
  const afterReset = getCodexAvailability(process.cwd());
  assert.notStrictEqual(afterReset, first);
});

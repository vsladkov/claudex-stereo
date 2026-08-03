import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

interface NodeVersionStatus {
  supported: boolean;
  version: string;
  major: number | null;
  message: string;
}

interface NodeVersionGuard {
  MINIMUM_NODE_MAJOR: number;
  checkNodeVersion(version?: string): NodeVersionStatus;
}

const require = createRequire(import.meta.url);
const guard = require('../plugins/stereo/scripts/node-version-guard.cjs') as NodeVersionGuard;

test('Node version guard rejects Node 22 with actionable type-stripping guidance', () => {
  const status = guard.checkNodeVersion('22.14.0');

  assert.equal(status.supported, false);
  assert.equal(status.major, 22);
  assert.match(status.message, /22\.14\.0/);
  assert.match(status.message, /Node 24/);
  assert.match(status.message, /type stripping/);
});

test('Node version guard accepts the minimum supported major', () => {
  const status = guard.checkNodeVersion('24.0.0');

  assert.equal(guard.MINIMUM_NODE_MAJOR, 24);
  assert.equal(status.supported, true);
  assert.equal(status.major, 24);
});

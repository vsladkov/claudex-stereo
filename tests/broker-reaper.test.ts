import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { makeTempDir } from './helpers.ts';
import { reapLeakedTestBrokers, reapWorkspaceBroker } from './broker-reaper.ts';
import {
  BROKER_SESSION_DIR_PREFIX,
  saveBrokerSession,
  spawnBrokerProcess,
  waitForBrokerEndpoint,
} from '../plugins/stereo/src/broker/lifecycle.ts';
import { createBrokerEndpoint } from '../plugins/stereo/src/broker/endpoint.ts';
import { terminateProcessTree } from '../plugins/stereo/src/platform/process.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROKER_SCRIPT = path.join(ROOT, 'plugins', 'stereo', 'scripts', 'app-server-broker.ts');
const IS_LINUX = process.platform === 'linux';

function processAlive(pid: number | undefined | null): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

interface SpawnedBroker {
  pid: number;
  endpoint: string;
  pidFile: string;
  logFile: string;
  sessionDir: string;
}

function spawnRealBroker(cwd: string): SpawnedBroker {
  const binDir = makeTempDir('reaper-bin-');
  installFakeCodex(binDir);
  // Session dirs use the production prefix in the real tmpdir so the sweep
  // sees exactly what a leak looks like.
  const sessionDir = fs.mkdtempSync(path.join(path.dirname(binDir), BROKER_SESSION_DIR_PREFIX));
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, 'broker.pid');
  const logFile = path.join(sessionDir, 'broker.log');
  const child = spawnBrokerProcess({
    scriptPath: BROKER_SCRIPT,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: buildEnv(binDir),
  });
  assert.ok(child.pid);
  return { pid: child.pid, endpoint, pidFile, logFile, sessionDir };
}

test('reapWorkspaceBroker gracefully reaps a live broker and cleans its files', async () => {
  const repo = makeTempDir('reaper-workspace-');
  const broker = spawnRealBroker(repo);
  try {
    assert.equal(await waitForBrokerEndpoint(broker.endpoint, 4000), true);
    saveBrokerSession(repo, broker);

    const reaped = await reapWorkspaceBroker(repo);
    assert.equal(reaped, true);
    assert.equal(await waitUntil(() => !processAlive(broker.pid), 4000), true);
    assert.equal(fs.existsSync(broker.pidFile), false);
    assert.equal(fs.existsSync(broker.sessionDir), false);
  } finally {
    if (processAlive(broker.pid)) {
      terminateProcessTree(broker.pid);
    }
  }
});

test('reapWorkspaceBroker is a safe no-op without a broker session', async () => {
  const empty = makeTempDir('reaper-empty-');
  assert.equal(await reapWorkspaceBroker(empty), false);

  // A stale record whose process is already gone still cleans up its files.
  const repo = makeTempDir('reaper-stale-');
  const sessionDir = makeTempDir('reaper-stale-session-');
  const pidFile = path.join(sessionDir, 'broker.pid');
  fs.writeFileSync(pidFile, '99999999', 'utf8');
  saveBrokerSession(repo, {
    endpoint: `unix:${path.join(sessionDir, 'gone.sock')}`,
    pid: 99999999,
    pidFile,
    logFile: path.join(sessionDir, 'broker.log'),
    sessionDir,
  });
  assert.equal(await reapWorkspaceBroker(repo), true);
  assert.equal(fs.existsSync(pidFile), false);
});

test(
  'reapLeakedTestBrokers kills tmp-cwd brokers and spares real workspaces',
  { skip: !IS_LINUX },
  async () => {
    // A "leaked" broker: cwd under os.tmpdir(), pid file in a cxc-* session dir.
    const leakedCwd = makeTempDir('reaper-leaked-cwd-');
    const leaked = spawnRealBroker(leakedCwd);

    // A "real" workspace broker: cwd outside the tmpdir (the repo checkout).
    const realBroker = spawnRealBroker(ROOT);

    try {
      assert.equal(await waitForBrokerEndpoint(leaked.endpoint, 4000), true);
      assert.equal(await waitForBrokerEndpoint(realBroker.endpoint, 4000), true);

      const sweep = reapLeakedTestBrokers();
      assert.ok(
        sweep.details.some((detail) => detail.includes(`pid ${leaked.pid}`)),
        `sweep must report the leaked broker (got: ${sweep.details.join(', ') || 'nothing'})`,
      );
      assert.equal(await waitUntil(() => !processAlive(leaked.pid), 4000), true);
      assert.equal(fs.existsSync(leaked.sessionDir), false);

      // The non-tmp cwd broker must be untouched by the sweep.
      assert.equal(
        processAlive(realBroker.pid),
        true,
        'sweep must never touch a real-workspace broker',
      );
    } finally {
      for (const broker of [leaked, realBroker]) {
        if (processAlive(broker.pid)) {
          terminateProcessTree(broker.pid);
        }
        fs.rmSync(broker.sessionDir, { recursive: true, force: true });
      }
    }
  },
);

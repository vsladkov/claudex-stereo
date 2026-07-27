import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { makeTempDir } from './helpers.ts';
import { reapLeakedTestBrokers, reapWorkspaceBroker } from './broker-reaper.ts';
import {
  BROKER_SESSION_DIR_PREFIX,
  probeBrokerEndpointOutcome,
  saveBrokerSession,
  spawnBrokerProcess,
  waitForBrokerEndpoint,
  waitForBrokerEndpointClosed,
} from '../plugins/stereo/src/broker/lifecycle.ts';
import type { ProbeSocket } from '../plugins/stereo/src/broker/lifecycle.ts';
import {
  createBrokerEndpoint,
  parseBrokerEndpoint,
} from '../plugins/stereo/src/broker/endpoint.ts';
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

type ProbeEvent = 'connect' | 'error' | 'close';

class FakeProbeSocket implements ProbeSocket {
  destroyed = false;
  readonly listeners = new Map<ProbeEvent, () => void>();

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  once(event: ProbeEvent, listener: () => void): this {
    this.listeners.set(event, listener);
    return this;
  }

  emit(event: ProbeEvent): void {
    const listener = this.listeners.get(event);
    if (!listener) {
      return;
    }
    this.listeners.delete(event);
    listener();
  }
}

async function withTestTimeout<T>(promise: Promise<T>, timeoutMs = 1500): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Broker probe test exceeded its ${timeoutMs}ms guard.`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

interface EndpointServerFixture {
  endpoint: string;
  sessionDir: string;
  close: () => Promise<void>;
}

async function createEndpointServer(
  t: TestContext,
  prefix = 'broker-probe-',
): Promise<EndpointServerFixture> {
  const sessionDir = makeTempDir(prefix);
  const endpoint = createBrokerEndpoint(sessionDir);
  const target = parseBrokerEndpoint(endpoint);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.resume();
  });

  try {
    await withTestTimeout(
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(target.path, () => {
          server.off('error', onError);
          resolve();
        });
      }),
    );
  } catch (error) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    throw error;
  }

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      if (server.listening) {
        await withTestTimeout(new Promise<void>((resolve) => server.close(() => resolve())));
      }
      if (target.kind === 'unix') {
        fs.rmSync(target.path, { force: true });
      }
      fs.rmSync(sessionDir, { recursive: true, force: true });
    })();
    return closing;
  };
  t.after(close);
  return { endpoint, sessionDir, close };
}

function createUnusedEndpoint(t: TestContext): string {
  const sessionDir = makeTempDir('broker-probe-missing-');
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  return createBrokerEndpoint(sessionDir);
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

test('probeBrokerEndpointOutcome settles a close-only socket as closed', async () => {
  const socket = new FakeProbeSocket();
  const pending = probeBrokerEndpointOutcome('fake:close-only', 250, {
    connect: () => socket,
  });

  socket.emit('close');

  assert.equal(await withTestTimeout(pending), 'closed');
  assert.equal(socket.destroyed, true);
});

test('probeBrokerEndpointOutcome times out a socket that emits nothing', async () => {
  const socket = new FakeProbeSocket();
  const timeoutMs = 30;
  const startedAt = Date.now();

  const outcome = await withTestTimeout(
    probeBrokerEndpointOutcome('fake:silent', timeoutMs, {
      connect: () => socket,
    }),
  );

  assert.equal(outcome, 'timeout');
  assert.equal(socket.destroyed, true);
  assert.equal(Date.now() - startedAt >= timeoutMs - 5, true);
});

test('probeBrokerEndpointOutcome resolves a connection only after its socket closes', async () => {
  const socket = new FakeProbeSocket();
  let settled = false;
  const pending = probeBrokerEndpointOutcome('fake:connected', 250, {
    connect: () => socket,
  });
  void pending.then(() => {
    settled = true;
  });

  socket.emit('connect');
  await Promise.resolve();
  assert.equal(socket.destroyed, true);
  assert.equal(settled, false);

  socket.emit('close');
  assert.equal(await withTestTimeout(pending), 'connected');
  assert.equal(settled, true);
});

test('real endpoint probes distinguish missing and listening endpoints', async (t) => {
  const missingEndpoint = createUnusedEndpoint(t);
  assert.equal(await withTestTimeout(probeBrokerEndpointOutcome(missingEndpoint, 250)), 'closed');

  const fixture = await createEndpointServer(t);
  assert.equal(await withTestTimeout(probeBrokerEndpointOutcome(fixture.endpoint)), 'connected');
});

test('waitForBrokerEndpoint respects its outer deadline for a missing endpoint', async (t) => {
  const endpoint = createUnusedEndpoint(t);
  const timeoutMs = 120;
  const startedAt = Date.now();

  assert.equal(await withTestTimeout(waitForBrokerEndpoint(endpoint, timeoutMs)), false);
  const elapsed = Date.now() - startedAt;
  assert.equal(elapsed >= timeoutMs - 20, true);
  assert.equal(elapsed < timeoutMs + 1000, true);
});

test('waitForBrokerEndpointClosed detects a listener that has closed', async (t) => {
  const fixture = await createEndpointServer(t);
  assert.equal(await withTestTimeout(probeBrokerEndpointOutcome(fixture.endpoint)), 'connected');

  await fixture.close();

  assert.equal(await withTestTimeout(waitForBrokerEndpointClosed(fixture.endpoint, 300)), true);
});

test('waitForBrokerEndpointClosed returns false at its bound for a live listener', async (t) => {
  const fixture = await createEndpointServer(t);
  const timeoutMs = 120;
  const startedAt = Date.now();

  assert.equal(
    await withTestTimeout(waitForBrokerEndpointClosed(fixture.endpoint, timeoutMs)),
    false,
  );
  const elapsed = Date.now() - startedAt;
  assert.equal(elapsed >= timeoutMs - 20, true);
  assert.equal(elapsed < timeoutMs + 1000, true);
});

test('waitForBrokerEndpointClosed never treats a silent attempt as closure', async () => {
  const sockets: FakeProbeSocket[] = [];
  const timeoutMs = 80;
  const startedAt = Date.now();

  const closed = await withTestTimeout(
    waitForBrokerEndpointClosed('fake:silent-wait', timeoutMs, {
      connect: () => {
        const socket = new FakeProbeSocket();
        sockets.push(socket);
        return socket;
      },
    }),
  );

  assert.equal(closed, false);
  assert.equal(Date.now() - startedAt >= timeoutMs - 20, true);
  assert.equal(sockets.length > 0, true);
  assert.equal(
    sockets.every((socket) => socket.destroyed),
    true,
  );
});

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
  'dead session-dir cleanup requires teardown opt-in and spares live sockets',
  { skip: !IS_LINUX },
  async (t) => {
    const sweepRoot = makeTempDir('reaper-sweep-root-');
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = sweepRoot;
    t.after(() => {
      if (previousTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpdir;
      }
    });
    // Keep the production age and runner-start checks intact while making
    // this isolated fixture represent a runner that has been alive >10 s.
    t.mock.method(process, 'uptime', () => 60);

    const deadSessionDir = makeTempDir(BROKER_SESSION_DIR_PREFIX);
    fs.writeFileSync(path.join(deadSessionDir, 'broker.pid'), '99999999', 'utf8');
    const staleTime = new Date(Date.now() - 11_000);
    fs.utimesSync(deadSessionDir, staleTime, staleTime);

    const freshDeadSessionDir = makeTempDir(BROKER_SESSION_DIR_PREFIX);
    fs.writeFileSync(path.join(freshDeadSessionDir, 'broker.pid'), '99999999', 'utf8');

    const listening = await createEndpointServer(t, BROKER_SESSION_DIR_PREFIX);
    fs.utimesSync(listening.sessionDir, staleTime, staleTime);

    const defaultSweep = await reapLeakedTestBrokers({
      cwdFilter: () => false,
    });
    assert.equal(defaultSweep.reaped, 0);
    assert.equal(fs.existsSync(deadSessionDir), true);

    const teardownSweep = await reapLeakedTestBrokers({
      cwdFilter: () => false,
      removeDeadSessionDirs: true,
    });
    assert.equal(teardownSweep.reaped, 1);
    assert.ok(
      teardownSweep.details.some((detail) => detail.includes(deadSessionDir)),
      `sweep must report the dead session dir (got: ${teardownSweep.details.join(', ')})`,
    );
    assert.equal(fs.existsSync(deadSessionDir), false);
    assert.equal(fs.existsSync(freshDeadSessionDir), true, 'fresh startup dir must be spared');
    assert.equal(fs.existsSync(listening.sessionDir), true, 'live socket dir must be spared');
  },
);

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

      const sweep = await reapLeakedTestBrokers({
        cwdFilter: (brokerCwd) => brokerCwd === leakedCwd,
      });
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

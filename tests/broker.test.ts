import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import test, { afterEach } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { makeTempDir } from './helpers.ts';
import { drainCreatedTempDirs } from './helpers.ts';
import { reapWorkspaceBroker } from './broker-reaper.ts';
import { readJsonIfReadable } from './runtime-helpers.ts';
import { terminateProcessTree } from '../plugins/stereo/src/platform/process.ts';
import {
  createBrokerEndpoint,
  parseBrokerEndpoint,
} from '../plugins/stereo/src/broker/endpoint.ts';
import { BROKER_BUSY_RPC_CODE } from '../plugins/stereo/src/protocol/broker-rpc.ts';
import {
  clearBrokerSession,
  ensureBrokerSession,
  loadBrokerSession,
  probeBrokerEndpoint,
  saveBrokerSession,
  sendBrokerShutdown,
  sendBrokerShutdownIfIdle,
  spawnBrokerProcess,
  waitForBrokerEndpoint,
} from '../plugins/stereo/src/broker/lifecycle.ts';
import type { BrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import { resolveStateDir } from '../plugins/stereo/src/workspace/state.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every workspace this file created gets its broker reaped after each test:
// the companion CLI auto-starts a detached broker per workspace, and without
// a SessionEnd there is nothing else to stop it (one unswept full run used
// to strand ~40 broker processes).
afterEach(async () => {
  for (const dir of drainCreatedTempDirs()) {
    await reapWorkspaceBroker(dir);
  }
});
const BROKER_SCRIPT = path.join(ROOT, 'plugins', 'stereo', 'scripts', 'app-server-broker.ts');
const DEAD_PID = 2147483647;

// Minimal shape of the JSONL frames the broker exchanges; payloads stay loose
// on purpose so assertions read exactly like the pre-migration test.
interface BrokerMessage {
  id?: number | null;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: any;
}

interface PendingWaiter {
  resolve: (message: BrokerMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface NotificationWaiter {
  predicate: (message: BrokerMessage) => boolean;
  resolve: (message: BrokerMessage) => void;
  timeout: NodeJS.Timeout;
}

// The union hides accepted-variant fields behind the discriminant; the tests
// assert on both variants' fields, so widen to one shape locally.
interface ShutdownOutcomeShape {
  accepted: boolean;
  pid?: number;
  busy?: boolean;
  detail?: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestBrokerShutdownBounded(endpoint: string, timeoutMs = 750): Promise<void> {
  return new Promise<void>((resolve) => {
    const target = parseBrokerEndpoint(endpoint);
    const socket = net.createConnection({ path: target.path });
    let settled = false;
    const timeout = setTimeout(finish, timeoutMs);

    function finish(): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (!socket.destroyed) {
        socket.destroy();
      }
      resolve();
    }

    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, method: 'broker/shutdown', params: {} })}\n`);
    });
    socket.once('data', finish);
    socket.once('error', finish);
    socket.once('close', finish);
  });
}

function processIsAlive(pid: number | undefined): boolean {
  try {
    process.kill(pid!, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== 'ESRCH';
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await delay(intervalMs);
  }
  throw new Error('Timed out waiting for broker test condition.');
}

function createJsonlClient(endpoint: string) {
  const target = parseBrokerEndpoint(endpoint);
  const socket = net.createConnection({ path: target.path });
  socket.setEncoding('utf8');
  let nextId = 1;
  let buffer = '';
  let connected = false;
  let closed = false;
  const pending = new Map<number, PendingWaiter>();
  const notifications: BrokerMessage[] = [];
  const notificationWaiters: NotificationWaiter[] = [];

  const ready = new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      connected = true;
      resolve();
    });
    socket.once('error', reject);
  });
  const closedPromise = new Promise<void>((resolve) => {
    socket.once('close', () => {
      closed = true;
      resolve();
    });
  });

  function dispatch(message: BrokerMessage) {
    if (message.id !== undefined) {
      const waiter = pending.get(message.id!);
      if (waiter) {
        pending.delete(message.id!);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      }
      return;
    }
    notifications.push(message);
    for (const waiter of [...notificationWaiters]) {
      if (waiter.predicate(message)) {
        notificationWaiters.splice(notificationWaiters.indexOf(waiter), 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      }
    }
  }

  socket.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) {
        dispatch(JSON.parse(line));
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });
  socket.on('close', () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('Broker socket closed before the response arrived.'));
    }
    pending.clear();
  });

  async function request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 4000,
  ): Promise<BrokerMessage> {
    await ready;
    const id = nextId;
    nextId += 1;
    const response = new Promise<BrokerMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
    });
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return response;
  }

  async function sendAndDestroy(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    await ready;
    await new Promise<void>((resolve, reject) => {
      socket.write(
        `${JSON.stringify({ id: 1_000_000, method, params })}\n`,
        (error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }
          socket.destroy();
          resolve();
        },
      );
    });
  }

  function waitForNotification(
    predicate: (message: BrokerMessage) => boolean,
    timeoutMs = 4000,
  ): Promise<BrokerMessage> {
    const existing = notifications.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise<BrokerMessage>((resolve, reject) => {
      const waiter: NotificationWaiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          const index = notificationWaiters.indexOf(waiter);
          if (index !== -1) {
            notificationWaiters.splice(index, 1);
          }
          reject(new Error('Timed out waiting for broker notification.'));
        }, timeoutMs),
      };
      notificationWaiters.push(waiter);
    });
  }

  return {
    socket,
    ready,
    closed: closedPromise,
    get connected() {
      return connected;
    },
    get notifications() {
      return notifications;
    },
    get isClosed() {
      return closed;
    },
    request,
    sendAndDestroy,
    waitForNotification,
    close() {
      socket.end();
    },
  };
}

type JsonlClient = ReturnType<typeof createJsonlClient>;

function seedBrokerReservation(
  t: TestContext,
  codexHome: string,
  threadId: string,
  pid = DEAD_PID,
): { path: string; token: string } {
  const digest = crypto.createHash('sha256').update(threadId).digest('hex').slice(0, 32);
  const lockPath = path.join(codexHome, 'companion-thread-locks', `${digest}.lock`);
  const token = `broker-test-${crypto.randomUUID()}`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      token,
      pid,
      jobId: 'broker-test-owner',
      threadId,
      createdAt: new Date().toISOString(),
    })}\n`,
    'utf8',
  );
  t.after(() => {
    for (const target of [lockPath, `${lockPath}.cleanup`]) {
      try {
        fs.unlinkSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  });
  return { path: lockPath, token };
}

async function initializeClient(client: JsonlClient): Promise<void> {
  const response = await client.request('initialize', {
    clientInfo: { name: 'broker-test', version: '1' },
    capabilities: { experimentalApi: true },
  });
  assert.equal(response.error, undefined);
  client.socket.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
}

async function startBroker(
  t: TestContext,
  behavior = 'review-ok',
  options: {
    cwd?: string;
    binDir?: string;
    saveState?: boolean;
    managedByWorkspaceRecord?: boolean;
    selfCheckMs?: number;
  } = {},
) {
  const cwd = options.cwd ?? makeTempDir('broker-workspace-');
  const binDir = options.binDir ?? makeTempDir('broker-bin-');
  const sessionDir = makeTempDir('broker-session-');
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, 'broker.pid');
  const logFile = path.join(sessionDir, 'broker.log');
  installFakeCodex(binDir, behavior);
  const env = {
    ...buildEnv(binDir),
    ...(options.selfCheckMs
      ? { CODEX_COMPANION_BROKER_SELF_CHECK_MS: String(options.selfCheckMs) }
      : {}),
  };
  const child = spawnBrokerProcess({
    scriptPath: BROKER_SCRIPT,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env,
    managedByWorkspaceRecord: options.managedByWorkspaceRecord,
  });
  const session = {
    endpoint,
    pid: child.pid!,
    pidFile,
    logFile,
    sessionDir,
  };
  t.after(async () => {
    if (processIsAlive(child.pid)) {
      await requestBrokerShutdownBounded(endpoint);
      await waitFor(() => !processIsAlive(child.pid), { timeoutMs: 3000 }).catch(() => {});
    }
    // Graceful shutdown can be refused (busy broker) or lost; never leave
    // the detached session leader running.
    if (processIsAlive(child.pid)) {
      terminateProcessTree(child.pid!);
    }
  });

  // Owned self-checks can use a shortened interval in tests, so publish their
  // ownership record before waiting for the first readiness connection.
  if (options.saveState && options.managedByWorkspaceRecord) {
    saveBrokerSession(cwd, session);
  }
  if (options.managedByWorkspaceRecord) {
    await waitFor(() => probeBrokerEndpoint(endpoint, 250), {
      timeoutMs: 4000,
      intervalMs: 25,
    });
  } else {
    assert.equal(await waitForBrokerEndpoint(endpoint, 4000), true);
  }
  await delay(25);
  if (options.saveState && !options.managedByWorkspaceRecord) {
    saveBrokerSession(cwd, session);
  }

  return {
    cwd,
    binDir,
    env,
    child,
    ...session,
  };
}

test('saveBrokerSession writes exact JSON bytes atomically', () => {
  const cwd = makeTempDir('broker-state-workspace-');
  const session: BrokerSession = {
    endpoint: 'unix:/tmp/example.sock',
    pid: 1234,
    pidFile: '/tmp/example.pid',
    logFile: '/tmp/example.log',
    sessionDir: '/tmp/example-session',
  };

  saveBrokerSession(cwd, session);

  const stateDir = resolveStateDir(cwd);
  assert.equal(
    fs.readFileSync(path.join(stateDir, 'broker.json'), 'utf8'),
    `${JSON.stringify(session, null, 2)}\n`,
  );
  assert.equal(
    fs.readdirSync(stateDir).some((file) => file.endsWith('.tmp')),
    false,
  );
});

test('an owned idle broker survives matching checks and exits after its record is replaced', async (t) => {
  const broker = await startBroker(t, 'review-ok', {
    saveState: true,
    managedByWorkspaceRecord: true,
    selfCheckMs: 75,
  });
  const target = parseBrokerEndpoint(broker.endpoint);
  t.after(() => clearBrokerSession(broker.cwd));
  await delay(300);
  assert.equal(processIsAlive(broker.child.pid), true);
  assert.equal(loadBrokerSession(broker.cwd)?.endpoint, broker.endpoint);
  assert.equal(fs.existsSync(broker.pidFile), true);
  if (target.kind === 'unix') {
    assert.equal(fs.existsSync(target.path), true);
  }
  assert.equal(await probeBrokerEndpoint(broker.endpoint), true);
  await delay(100);
  assert.equal(processIsAlive(broker.child.pid), true);
  saveBrokerSession(broker.cwd, {
    endpoint: `${broker.endpoint}-replacement`,
    pid: null,
    pidFile: `${broker.pidFile}.replacement`,
    logFile: `${broker.logFile}.replacement`,
    sessionDir: `${broker.sessionDir}-replacement`,
  });
  await waitFor(() => !processIsAlive(broker.child.pid), { timeoutMs: 3000 });
  assert.equal(await probeBrokerEndpoint(broker.endpoint), false);
  assert.equal(fs.existsSync(broker.pidFile), false);
  if (target.kind === 'unix') {
    assert.equal(fs.existsSync(target.path), false);
  }
  assert.match(
    fs.readFileSync(broker.logFile, 'utf8'),
    /broker self-check: workspace record no longer points here; exiting idle broker/,
  );
});

test('an owned broker waits for a slow turn to drain before reacting to a wiped record', async (t) => {
  const broker = await startBroker(t, 'slow-turn', {
    saveState: true,
    managedByWorkspaceRecord: true,
    selfCheckMs: 75,
  });
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const threadId = started.result.thread.id;
  const turn = await owner.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'finish before self-check shutdown', text_elements: [] }],
  });
  assert.equal(turn.error, undefined);
  await owner.waitForNotification(
    (message) => message.method === 'turn/started' && message.params?.threadId === threadId,
  );

  clearBrokerSession(broker.cwd);
  await delay(350);
  assert.equal(processIsAlive(broker.child.pid), true);

  await owner.waitForNotification(
    (message) => message.method === 'turn/completed' && message.params?.threadId === threadId,
  );
  owner.close();
  await owner.closed;
  await waitFor(() => !processIsAlive(broker.child.pid), { timeoutMs: 3000 });
  assert.equal(await waitForBrokerEndpoint(broker.endpoint, 150), false);
});

test('an unmanaged record-less broker ignores the self-check interval setting', async (t) => {
  const broker = await startBroker(t, 'review-ok', {
    selfCheckMs: 50,
  });

  assert.equal(loadBrokerSession(broker.cwd), null);
  await delay(250);
  assert.equal(processIsAlive(broker.child.pid), true);
  assert.equal(await waitForBrokerEndpoint(broker.endpoint, 150), true);
});

test('a client that vanishes mid-turn gets its turn interrupted and the broker recovers', async (t) => {
  const broker = await startBroker(t, 'slow-turn');
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const threadId = started.result.thread.id;
  const reservation = seedBrokerReservation(t, broker.env.CODEX_HOME, threadId);
  const turn = await owner.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'abandon this stream', text_elements: [] }],
  });
  assert.equal(turn.error, undefined);
  await owner.waitForNotification(
    (message) => message.method === 'turn/started' && message.params?.threadId === threadId,
  );

  // The owner dies mid-turn (crashed CLI, killed worker, stop-gate timeout).
  owner.socket.destroy();

  // The broker must interrupt the abandoned turn on codex's side...
  await waitFor(() => {
    const stateFile = path.join(broker.binDir, 'fake-codex-state.json');
    const state = readJsonIfReadable<Record<string, any>>(stateFile);
    return state?.lastInterrupt?.threadId === threadId;
  });
  await waitFor(() => !fs.existsSync(reservation.path));

  // ...and become usable again for the next client once the turn resolves.
  const successor = createJsonlClient(broker.endpoint);
  t.after(() => successor.close());
  await initializeClient(successor);
  await waitFor(
    async () => {
      const restarted = await successor.request('thread/start', {
        cwd: broker.cwd,
        sandbox: 'read-only',
        ephemeral: false,
      });
      if (restarted.error) {
        // Still inside the abandoned-turn grace window for streaming work.
        return false;
      }
      const retry = await successor.request('turn/start', {
        threadId: restarted.result.thread.id,
        input: [{ type: 'text', text: 'fresh turn after recovery', text_elements: [] }],
      });
      return retry.error === undefined;
    },
    { timeoutMs: 8000, intervalMs: 200 },
  );
  assert.equal(processIsAlive(broker.child.pid), true);
});

test('an owner dying before turn/started still gets its turn interrupted', async (t) => {
  const broker = await startBroker(t, 'slow-turn');
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const threadId = started.result.thread.id;
  const turn = await owner.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'die before turn/started lands', text_elements: [] }],
  });
  assert.equal(turn.error, undefined);

  // Destroy WITHOUT waiting for turn/started: the orphan marker is armed
  // before any runningTurns entry exists, so the interrupt must be issued
  // late, when turn/started arrives.
  owner.socket.destroy();

  await waitFor(() => {
    const stateFile = path.join(broker.binDir, 'fake-codex-state.json');
    const state = readJsonIfReadable<Record<string, any>>(stateFile);
    return state?.lastInterrupt?.threadId === threadId;
  });
  assert.equal(processIsAlive(broker.child.pid), true);
});

test('disconnecting before a delayed turn/start response arms recovery and frees ownership', async (t) => {
  const broker = await startBroker(t, 'slow-start-response');
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const threadId = started.result.thread.id;
  const reservation = seedBrokerReservation(t, broker.env.CODEX_HOME, threadId);
  const abandonedResponse = owner
    .request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'disconnect before the response', text_elements: [] }],
    })
    .catch(() => null);
  await waitFor(() => {
    const stateFile = path.join(broker.binDir, 'fake-codex-state.json');
    const state = readJsonIfReadable<Record<string, any>>(stateFile);
    return (
      state?.turnStarts?.some((entry: Record<string, unknown>) => entry.threadId === threadId) ??
      false
    );
  });
  owner.socket.destroy();
  await abandonedResponse;

  await waitFor(() => {
    const stateFile = path.join(broker.binDir, 'fake-codex-state.json');
    const state = readJsonIfReadable<Record<string, any>>(stateFile);
    return state?.lastInterrupt?.threadId === threadId;
  });
  await waitFor(() => !fs.existsSync(reservation.path));

  const successor = createJsonlClient(broker.endpoint);
  t.after(() => successor.close());
  await initializeClient(successor);
  const successorThread = await successor.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const successorTurn = await successor.request('turn/start', {
    threadId: successorThread.result.thread.id,
    input: [{ type: 'text', text: 'stream after pre-response recovery', text_elements: [] }],
  });
  assert.equal(successorTurn.error, undefined);
});

test('a dead client whose turn completes before the start response does not arm an orphan gate', async (t) => {
  const broker = await startBroker(t, 'fast-turn');
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const threadId = started.result.thread.id;
  const reservation = seedBrokerReservation(t, broker.env.CODEX_HOME, threadId);
  await owner.sendAndDestroy('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'complete before response continuation', text_elements: [] }],
  });
  await waitFor(() => !fs.existsSync(reservation.path));

  const successor = createJsonlClient(broker.endpoint);
  t.after(() => successor.close());
  await initializeClient(successor);
  const successorThread = await successor.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const successorTurn = await successor.request('turn/start', {
    threadId: successorThread.result.thread.id,
    input: [{ type: 'text', text: 'fast successor', text_elements: [] }],
  });
  assert.equal(successorTurn.error, undefined);
});

test('a detached review completion before its delayed response uses the review thread id', async (t) => {
  const broker = await startBroker(t, 'slow-start-response');
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const sourceThreadId = started.result.thread.id;
  const reservation = seedBrokerReservation(t, broker.env.CODEX_HOME, sourceThreadId);
  const abandonedResponse = owner
    .request('review/start', {
      threadId: sourceThreadId,
      delivery: 'detached',
      target: { type: 'uncommittedChanges' },
    })
    .catch(() => null);
  await waitFor(() => {
    const stateFile = path.join(broker.binDir, 'fake-codex-state.json');
    const state = readJsonIfReadable<Record<string, any>>(stateFile);
    return state?.lastReviewStart?.sourceThreadId === sourceThreadId;
  });
  owner.socket.destroy();
  await abandonedResponse;
  await waitFor(() => !fs.existsSync(reservation.path));

  const successor = createJsonlClient(broker.endpoint);
  t.after(() => successor.close());
  await initializeClient(successor);
  const successorThread = await successor.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const successorTurn = await successor.request('turn/start', {
    threadId: successorThread.result.thread.id,
    input: [{ type: 'text', text: 'stream after detached review', text_elements: [] }],
  });
  assert.equal(successorTurn.error, undefined);
});

test('same-socket streaming pipelining receives the broker busy error', async (t) => {
  const broker = await startBroker(t, 'slow-start-response');
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const threadId = started.result.thread.id;
  const firstTurn = owner.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'first pipelined turn', text_elements: [] }],
  });
  await waitFor(() => {
    const stateFile = path.join(broker.binDir, 'fake-codex-state.json');
    const state = readJsonIfReadable<Record<string, any>>(stateFile);
    return (
      state?.turnStarts?.some((entry: Record<string, unknown>) => entry.threadId === threadId) ??
      false
    );
  });

  const rejected = await owner.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'second pipelined turn', text_elements: [] }],
  });
  assert.equal(rejected.error?.code, BROKER_BUSY_RPC_CODE);
  assert.equal((await firstTurn).error, undefined);
  await owner.waitForNotification(
    (message) => message.method === 'turn/completed' && message.params?.threadId === threadId,
  );
});

test('a disconnected request with no response transitions through the watchdog', async (t) => {
  const broker = await startBroker(t, 'withheld-start-response');
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const threadId = started.result.thread.id;
  const reservation = seedBrokerReservation(t, broker.env.CODEX_HOME, threadId);
  const abandonedResponse = owner
    .request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'withhold this response', text_elements: [] }],
    })
    .catch(() => null);
  await waitFor(() => {
    const stateFile = path.join(broker.binDir, 'fake-codex-state.json');
    const state = readJsonIfReadable<Record<string, any>>(stateFile);
    return (
      state?.turnStarts?.some((entry: Record<string, unknown>) => entry.threadId === threadId) ??
      false
    );
  });
  owner.socket.destroy();
  await abandonedResponse;

  const successor = createJsonlClient(broker.endpoint);
  t.after(() => successor.close());
  await initializeClient(successor);
  const successorThread = await successor.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  await waitFor(
    async () => {
      const response = await successor.request('turn/start', {
        threadId: successorThread.result.thread.id,
        input: [{ type: 'text', text: 'stream after watchdog recovery', text_elements: [] }],
      });
      return response.error === undefined;
    },
    { timeoutMs: 15_000, intervalMs: 200 },
  );
  await waitFor(() => !fs.existsSync(reservation.path));
  const interrupted = await waitFor(() => {
    const state = readJsonIfReadable<Record<string, any>>(
      path.join(broker.binDir, 'fake-codex-state.json'),
    );
    return state?.lastInterrupt?.threadId === threadId;
  });
  assert.equal(interrupted, true);
});

test("an orphaned turn's completion is not forwarded to an unrelated client", async (t) => {
  const broker = await startBroker(t, 'slow-turn');
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const threadId = started.result.thread.id;
  const turn = await owner.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'abandon and leak nothing', text_elements: [] }],
  });
  assert.equal(turn.error, undefined);
  await owner.waitForNotification(
    (message) => message.method === 'turn/started' && message.params?.threadId === threadId,
  );

  owner.socket.destroy();

  // A bystander issues non-streaming requests during the orphan recovery so
  // it holds activeRequestSocket when the interrupt completion arrives.
  const bystander = createJsonlClient(broker.endpoint);
  t.after(() => bystander.close());
  await initializeClient(bystander);
  await waitFor(
    async () => {
      const probe = await bystander.request('thread/start', {
        cwd: broker.cwd,
        sandbox: 'read-only',
        ephemeral: true,
      });
      if (probe.error) {
        return false;
      }
      // The orphan resolves once its interrupt-induced completion lands; keep
      // probing until the fixture records it.
      const stateFile = path.join(broker.binDir, 'fake-codex-state.json');
      const state = readJsonIfReadable<Record<string, any>>(stateFile);
      return state?.lastInterrupt?.threadId === threadId;
    },
    { timeoutMs: 8000, intervalMs: 100 },
  );

  // Give any wrongly-forwarded notification time to arrive, then assert the
  // bystander never saw the foreign thread's lifecycle.
  await delay(200);
  const foreign = bystander.notifications.filter(
    (message) => message.method === 'turn/completed' && message.params?.threadId === threadId,
  );
  assert.deepEqual(foreign, []);
});

test('guarded broker shutdown refuses while another client owns an active stream', async (t) => {
  const broker = await startBroker(t, 'slow-turn');
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const threadId = started.result.thread.id;
  const turn = await owner.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'hold the stream', text_elements: [] }],
  });
  assert.equal(turn.error, undefined);

  const outcome: ShutdownOutcomeShape = await sendBrokerShutdownIfIdle(broker.endpoint);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.busy, true);
  await owner.waitForNotification(
    (message) => message.method === 'turn/completed' && message.params?.threadId === threadId,
  );
  assert.equal(processIsAlive(broker.child.pid), true);
});

test('guarded broker shutdown refuses in the inter-RPC resume window', async (t) => {
  const broker = await startBroker(t);
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const threadId = started.result.thread.id;
  const resumed = await owner.request('thread/resume', {
    threadId,
    cwd: broker.cwd,
    sandbox: 'read-only',
  });
  assert.equal(resumed.error, undefined);

  const outcome: ShutdownOutcomeShape = await sendBrokerShutdownIfIdle(broker.endpoint);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.busy, true);
  assert.equal(processIsAlive(broker.child.pid), true);
});

test('guarded idle shutdown returns only after broker teardown is complete', async (t) => {
  const broker = await startBroker(t);
  const target = parseBrokerEndpoint(broker.endpoint);
  const outcome: ShutdownOutcomeShape = await sendBrokerShutdownIfIdle(broker.endpoint);

  assert.equal(outcome.accepted, true);
  assert.equal(outcome.pid, broker.child.pid);
  assert.equal(processIsAlive(broker.child.pid), false);
  assert.equal(await waitForBrokerEndpoint(broker.endpoint, 150), false);
  assert.equal(fs.existsSync(broker.pidFile), false);
  if (target.kind === 'unix') {
    assert.equal(fs.existsSync(target.path), false);
  }
});

test('guarded idle shutdown waits for a slow child exit before stale-session recovery', async (t) => {
  const broker = await startBroker(t, 'slow-exit', { saveState: true });
  const startedAt = Date.now();
  const outcome = await sendBrokerShutdownIfIdle(broker.endpoint, { timeoutMs: 5000 });

  assert.equal(outcome.accepted, true);
  assert.equal(Date.now() - startedAt >= 750, true);
  assert.equal(processIsAlive(broker.child.pid), false);

  const replacement = await ensureBrokerSession(broker.cwd, {
    env: broker.env,
    scriptPath: BROKER_SCRIPT,
    timeoutMs: 4000,
  });
  assert.notEqual(replacement!.endpoint, broker.endpoint);
  assert.equal(await waitForBrokerEndpoint(replacement!.endpoint, 1000), true);
  await sendBrokerShutdown(replacement!.endpoint);
});

test('broker propagates an unexpected child app-server death to front clients', async (t) => {
  const broker = await startBroker(t, 'die-mid-turn');
  const client = createJsonlClient(broker.endpoint);
  t.after(() => client.close());
  await initializeClient(client);
  const started = await client.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const threadId = started.result.thread.id;
  const turn = await client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'die during this turn', text_elements: [] }],
  });
  assert.equal(turn.error, undefined);

  await Promise.race([
    client.closed,
    delay(4000).then(() => {
      throw new Error('Front client stayed connected after child app-server death.');
    }),
  ]);
  await waitFor(() => !processIsAlive(broker.child.pid), { timeoutMs: 4000 });
  assert.equal(client.isClosed, true);
});

test('parameterless broker shutdown remains unconditional with another client connected', async (t) => {
  const broker = await startBroker(t);
  const owner = createJsonlClient(broker.endpoint);
  const shutdownClient = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  t.after(() => shutdownClient.close());
  await initializeClient(owner);
  await initializeClient(shutdownClient);

  const response = await shutdownClient.request('broker/shutdown', {});
  assert.deepEqual(response.result, {});
  await waitFor(() => !processIsAlive(broker.child.pid));
  await owner.closed;
});

test('busy guarded drain leaves the companion broker state untouched', async (t) => {
  const broker = await startBroker(t, 'review-ok', { saveState: true });
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);
  const before = loadBrokerSession(broker.cwd);

  const outcome: ShutdownOutcomeShape = await sendBrokerShutdownIfIdle(broker.endpoint);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.busy, true);
  assert.deepEqual(loadBrokerSession(broker.cwd), before);
  assert.equal(processIsAlive(broker.child.pid), true);
});

test('a busy broker rejects rival RPCs but passes their turn/interrupt through', async (t) => {
  const broker = await startBroker(t, 'slow-turn');
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const threadId = started.result.thread.id;
  const turn = await owner.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'hold the stream', text_elements: [] }],
  });
  assert.equal(turn.error, undefined);
  const turnId = turn.result.turn.id;

  const rival = createJsonlClient(broker.endpoint);
  t.after(() => rival.close());
  await initializeClient(rival);

  const rejected = await rival.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  assert.equal(rejected.error?.code, BROKER_BUSY_RPC_CODE);

  const interrupt = await rival.request('turn/interrupt', { threadId, turnId });
  assert.equal(interrupt.error, undefined);
  await owner.waitForNotification(
    (message) => message.method === 'turn/completed' && message.params?.threadId === threadId,
  );
});

test('garbage input gets a -32700 reply and cannot crash the shared broker', async (t) => {
  const broker = await startBroker(t);
  const target = parseBrokerEndpoint(broker.endpoint);

  const lines: BrokerMessage[] = [];
  const raw = net.createConnection({ path: target.path });
  raw.setEncoding('utf8');
  let rawBuffer = '';
  raw.on('data', (chunk) => {
    rawBuffer += chunk;
    let index = rawBuffer.indexOf('\n');
    while (index !== -1) {
      const line = rawBuffer.slice(0, index);
      rawBuffer = rawBuffer.slice(index + 1);
      if (line.trim()) {
        lines.push(JSON.parse(line));
      }
      index = rawBuffer.indexOf('\n');
    }
  });
  await new Promise((resolve, reject) => {
    raw.once('connect', resolve);
    raw.once('error', reject);
  });
  raw.write('this is not json\n');
  await waitFor(() => lines.length > 0);
  assert.equal(lines[0]!.id, null);
  assert.equal(lines[0]!.error.code, -32700);
  assert.match(lines[0]!.error.message, /Invalid JSON/);

  // Half-close immediately after another garbage line; the broker's reply
  // write must not become an unhandled rejection that kills the process.
  raw.write('more garbage\n');
  raw.destroy();

  const survivor = createJsonlClient(broker.endpoint);
  t.after(() => survivor.close());
  await initializeClient(survivor);
  const started = await survivor.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  assert.equal(started.error, undefined);
  assert.equal(processIsAlive(broker.child.pid), true);
});

test('an oversized unterminated client line is disconnected without stopping the broker', async (t) => {
  const broker = await startBroker(t);
  const oversized = createJsonlClient(broker.endpoint);
  t.after(() => oversized.close());
  await initializeClient(oversized);

  oversized.socket.write('x'.repeat(8 * 1024 * 1024 + 1));
  await waitFor(() => oversized.isClosed);
  assert.equal(processIsAlive(broker.child.pid), true);

  const survivor = createJsonlClient(broker.endpoint);
  t.after(() => survivor.close());
  await initializeClient(survivor);
  assert.equal(processIsAlive(broker.child.pid), true);
});

test('a turn that completes inside its start response does not wedge the broker busy', async (t) => {
  const broker = await startBroker(t, 'fast-turn');
  const first = createJsonlClient(broker.endpoint);
  t.after(() => first.close());
  await initializeClient(first);

  const started = await first.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  const threadId = started.result.thread.id;
  const turn = await first.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'finish instantly', text_elements: [] }],
  });
  assert.equal(turn.error, undefined);
  await first.waitForNotification(
    (message) => message.method === 'turn/completed' && message.params?.threadId === threadId,
  );

  const second = createJsonlClient(broker.endpoint);
  t.after(() => second.close());
  await initializeClient(second);
  const rivalStart = await second.request('thread/start', {
    cwd: broker.cwd,
    sandbox: 'read-only',
    ephemeral: false,
  });
  assert.equal(rivalStart.error, undefined);
});

test('the broker unix socket is owner-only', { skip: process.platform === 'win32' }, async (t) => {
  const broker = await startBroker(t);
  const target = parseBrokerEndpoint(broker.endpoint);
  assert.equal(target.kind, 'unix');
  assert.equal(fs.statSync(target.path).mode & 0o777, 0o600);
});

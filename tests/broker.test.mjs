import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.ts";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/stereo/src/broker/endpoint.ts";
import { BROKER_BUSY_RPC_CODE } from "../plugins/stereo/src/transport/app-server-client.ts";
import {
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  sendBrokerShutdown,
  sendBrokerShutdownIfIdle,
  spawnBrokerProcess,
  waitForBrokerEndpoint
} from "../plugins/stereo/src/broker/lifecycle.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SCRIPT = path.join(ROOT, "plugins", "stereo", "scripts", "app-server-broker.mjs");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await delay(intervalMs);
  }
  throw new Error("Timed out waiting for broker test condition.");
}

function createJsonlClient(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  const socket = net.createConnection({ path: target.path });
  socket.setEncoding("utf8");
  let nextId = 1;
  let buffer = "";
  let connected = false;
  let closed = false;
  const pending = new Map();
  const notifications = [];
  const notificationWaiters = [];

  const ready = new Promise((resolve, reject) => {
    socket.once("connect", () => {
      connected = true;
      resolve();
    });
    socket.once("error", reject);
  });
  const closedPromise = new Promise((resolve) => {
    socket.once("close", () => {
      closed = true;
      resolve();
    });
  });

  function dispatch(message) {
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
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

  socket.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) {
        dispatch(JSON.parse(line));
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
  socket.on("close", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Broker socket closed before the response arrived."));
    }
    pending.clear();
  });

  async function request(method, params = {}, timeoutMs = 4000) {
    await ready;
    const id = nextId;
    nextId += 1;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
    });
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return response;
  }

  function waitForNotification(predicate, timeoutMs = 4000) {
    const existing = notifications.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          const index = notificationWaiters.indexOf(waiter);
          if (index !== -1) {
            notificationWaiters.splice(index, 1);
          }
          reject(new Error("Timed out waiting for broker notification."));
        }, timeoutMs)
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
    get isClosed() {
      return closed;
    },
    request,
    waitForNotification,
    close() {
      socket.end();
    }
  };
}

async function initializeClient(client) {
  const response = await client.request("initialize", {
    clientInfo: { name: "broker-test", version: "1" },
    capabilities: { experimentalApi: true }
  });
  assert.equal(response.error, undefined);
  client.socket.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
}

async function startBroker(t, behavior = "review-ok", options = {}) {
  const cwd = options.cwd ?? makeTempDir("broker-workspace-");
  const binDir = options.binDir ?? makeTempDir("broker-bin-");
  const sessionDir = makeTempDir("broker-session-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  installFakeCodex(binDir, behavior);
  const env = buildEnv(binDir);
  const child = spawnBrokerProcess({
    scriptPath: BROKER_SCRIPT,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env
  });
  assert.equal(await waitForBrokerEndpoint(endpoint, 4000), true);
  await delay(25);

  const session = {
    endpoint,
    pid: child.pid,
    pidFile,
    logFile,
    sessionDir
  };
  if (options.saveState) {
    saveBrokerSession(cwd, session);
  }

  t.after(async () => {
    if (processIsAlive(child.pid)) {
      await sendBrokerShutdown(endpoint).catch(() => {});
      await waitFor(() => !processIsAlive(child.pid), { timeoutMs: 3000 }).catch(() => {});
    }
  });

  return {
    cwd,
    binDir,
    env,
    child,
    ...session
  };
}

test("guarded broker shutdown refuses while another client owns an active stream", async (t) => {
  const broker = await startBroker(t, "slow-turn");
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request("thread/start", {
    cwd: broker.cwd,
    sandbox: "read-only",
    ephemeral: false
  });
  const threadId = started.result.thread.id;
  const turn = await owner.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "hold the stream", text_elements: [] }]
  });
  assert.equal(turn.error, undefined);

  const outcome = await sendBrokerShutdownIfIdle(broker.endpoint);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.busy, true);
  await owner.waitForNotification(
    (message) => message.method === "turn/completed" && message.params?.threadId === threadId
  );
  assert.equal(processIsAlive(broker.child.pid), true);
});

test("guarded broker shutdown refuses in the inter-RPC resume window", async (t) => {
  const broker = await startBroker(t);
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request("thread/start", {
    cwd: broker.cwd,
    sandbox: "read-only",
    ephemeral: false
  });
  const threadId = started.result.thread.id;
  const resumed = await owner.request("thread/resume", {
    threadId,
    cwd: broker.cwd,
    sandbox: "read-only"
  });
  assert.equal(resumed.error, undefined);

  const outcome = await sendBrokerShutdownIfIdle(broker.endpoint);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.busy, true);
  assert.equal(processIsAlive(broker.child.pid), true);
});

test("guarded idle shutdown returns only after broker teardown is complete", async (t) => {
  const broker = await startBroker(t);
  const target = parseBrokerEndpoint(broker.endpoint);
  const outcome = await sendBrokerShutdownIfIdle(broker.endpoint);

  assert.equal(outcome.accepted, true);
  assert.equal(outcome.pid, broker.child.pid);
  assert.equal(processIsAlive(broker.child.pid), false);
  assert.equal(await waitForBrokerEndpoint(broker.endpoint, 150), false);
  assert.equal(fs.existsSync(broker.pidFile), false);
  if (target.kind === "unix") {
    assert.equal(fs.existsSync(target.path), false);
  }
});

test("guarded idle shutdown waits for a slow child exit before stale-session recovery", async (t) => {
  const broker = await startBroker(t, "slow-exit", { saveState: true });
  const startedAt = Date.now();
  const outcome = await sendBrokerShutdownIfIdle(broker.endpoint, { timeoutMs: 5000 });

  assert.equal(outcome.accepted, true);
  assert.equal(Date.now() - startedAt >= 750, true);
  assert.equal(processIsAlive(broker.child.pid), false);

  const replacement = await ensureBrokerSession(broker.cwd, {
    env: broker.env,
    scriptPath: BROKER_SCRIPT,
    timeoutMs: 4000
  });
  assert.notEqual(replacement.endpoint, broker.endpoint);
  assert.equal(await waitForBrokerEndpoint(replacement.endpoint, 1000), true);
  await sendBrokerShutdown(replacement.endpoint);
});

test("broker propagates an unexpected child app-server death to front clients", async (t) => {
  const broker = await startBroker(t, "die-mid-turn");
  const client = createJsonlClient(broker.endpoint);
  t.after(() => client.close());
  await initializeClient(client);
  const started = await client.request("thread/start", {
    cwd: broker.cwd,
    sandbox: "read-only",
    ephemeral: false
  });
  const threadId = started.result.thread.id;
  const turn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "die during this turn", text_elements: [] }]
  });
  assert.equal(turn.error, undefined);

  await Promise.race([
    client.closed,
    delay(4000).then(() => {
      throw new Error("Front client stayed connected after child app-server death.");
    })
  ]);
  await waitFor(() => !processIsAlive(broker.child.pid), { timeoutMs: 4000 });
  assert.equal(client.isClosed, true);
});

test("parameterless broker shutdown remains unconditional with another client connected", async (t) => {
  const broker = await startBroker(t);
  const owner = createJsonlClient(broker.endpoint);
  const shutdownClient = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  t.after(() => shutdownClient.close());
  await initializeClient(owner);
  await initializeClient(shutdownClient);

  const response = await shutdownClient.request("broker/shutdown", {});
  assert.deepEqual(response.result, {});
  await waitFor(() => !processIsAlive(broker.child.pid));
  await owner.closed;
});

test("busy guarded drain leaves the companion broker state untouched", async (t) => {
  const broker = await startBroker(t, "review-ok", { saveState: true });
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);
  const before = loadBrokerSession(broker.cwd);

  const outcome = await sendBrokerShutdownIfIdle(broker.endpoint);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.busy, true);
  assert.deepEqual(loadBrokerSession(broker.cwd), before);
  assert.equal(processIsAlive(broker.child.pid), true);
});

test("a busy broker rejects rival RPCs but passes their turn/interrupt through", async (t) => {
  const broker = await startBroker(t, "slow-turn");
  const owner = createJsonlClient(broker.endpoint);
  t.after(() => owner.close());
  await initializeClient(owner);

  const started = await owner.request("thread/start", {
    cwd: broker.cwd,
    sandbox: "read-only",
    ephemeral: false
  });
  const threadId = started.result.thread.id;
  const turn = await owner.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "hold the stream", text_elements: [] }]
  });
  assert.equal(turn.error, undefined);
  const turnId = turn.result.turn.id;

  const rival = createJsonlClient(broker.endpoint);
  t.after(() => rival.close());
  await initializeClient(rival);

  const rejected = await rival.request("thread/start", {
    cwd: broker.cwd,
    sandbox: "read-only",
    ephemeral: false
  });
  assert.equal(rejected.error?.code, BROKER_BUSY_RPC_CODE);

  const interrupt = await rival.request("turn/interrupt", { threadId, turnId });
  assert.equal(interrupt.error, undefined);
  await owner.waitForNotification(
    (message) => message.method === "turn/completed" && message.params?.threadId === threadId
  );
});

test("garbage input gets a -32700 reply and cannot crash the shared broker", async (t) => {
  const broker = await startBroker(t);
  const target = parseBrokerEndpoint(broker.endpoint);

  const lines = [];
  const raw = net.createConnection({ path: target.path });
  raw.setEncoding("utf8");
  let rawBuffer = "";
  raw.on("data", (chunk) => {
    rawBuffer += chunk;
    let index = rawBuffer.indexOf("\n");
    while (index !== -1) {
      const line = rawBuffer.slice(0, index);
      rawBuffer = rawBuffer.slice(index + 1);
      if (line.trim()) {
        lines.push(JSON.parse(line));
      }
      index = rawBuffer.indexOf("\n");
    }
  });
  await new Promise((resolve, reject) => {
    raw.once("connect", resolve);
    raw.once("error", reject);
  });
  raw.write("this is not json\n");
  await waitFor(() => lines.length > 0);
  assert.equal(lines[0].id, null);
  assert.equal(lines[0].error.code, -32700);
  assert.match(lines[0].error.message, /Invalid JSON/);

  // Half-close immediately after another garbage line; the broker's reply
  // write must not become an unhandled rejection that kills the process.
  raw.write("more garbage\n");
  raw.destroy();

  const survivor = createJsonlClient(broker.endpoint);
  t.after(() => survivor.close());
  await initializeClient(survivor);
  const started = await survivor.request("thread/start", {
    cwd: broker.cwd,
    sandbox: "read-only",
    ephemeral: false
  });
  assert.equal(started.error, undefined);
  assert.equal(processIsAlive(broker.child.pid), true);
});

test("a turn that completes inside its start response does not wedge the broker busy", async (t) => {
  const broker = await startBroker(t, "fast-turn");
  const first = createJsonlClient(broker.endpoint);
  t.after(() => first.close());
  await initializeClient(first);

  const started = await first.request("thread/start", {
    cwd: broker.cwd,
    sandbox: "read-only",
    ephemeral: false
  });
  const threadId = started.result.thread.id;
  const turn = await first.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "finish instantly", text_elements: [] }]
  });
  assert.equal(turn.error, undefined);
  await first.waitForNotification(
    (message) => message.method === "turn/completed" && message.params?.threadId === threadId
  );

  const second = createJsonlClient(broker.endpoint);
  t.after(() => second.close());
  await initializeClient(second);
  const rivalStart = await second.request("thread/start", {
    cwd: broker.cwd,
    sandbox: "read-only",
    ephemeral: false
  });
  assert.equal(rivalStart.error, undefined);
});

test("the broker unix socket is owner-only", { skip: process.platform === "win32" }, async (t) => {
  const broker = await startBroker(t);
  const target = parseBrokerEndpoint(broker.endpoint);
  assert.equal(target.kind, "unix");
  assert.equal(fs.statSync(target.path).mode & 0o777, 0o600);
});

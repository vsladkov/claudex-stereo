import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createBrokerEndpoint, parseBrokerEndpoint } from './endpoint.ts';
import { childTarget, processHasExited, terminateProcessTree } from '../platform/process.ts';
import { errorCode } from '../shared/errors.ts';
import { writeJsonAtomic } from '../shared/fs.ts';
import { BROKER_ENTRY } from '../shared/paths.ts';
import { resolveStateDir } from '../workspace/state.ts';

const BROKER_STATE_FILE = 'broker.json';

export interface BrokerSession {
  endpoint: string;
  pid: number | null;
  pidFile: string;
  logFile: string;
  sessionDir: string;
}

export type ShutdownOutcome =
  | { accepted: true; pid: number }
  | { accepted: false; detail: string; busy?: boolean; timedOut?: boolean };

export interface SpawnBrokerProcessOptions {
  scriptPath: string;
  cwd: string;
  endpoint: string;
  pidFile: string;
  logFile: string;
  env?: NodeJS.ProcessEnv;
  managedByWorkspaceRecord?: boolean;
}

export interface EnsureBrokerSessionOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  scriptPath?: string;
  platform?: NodeJS.Platform;
  createBrokerEndpoint?: (sessionDir: string, platform?: NodeJS.Platform) => string;
  killProcess?: ((pid: number) => unknown) | null;
}

export interface TeardownBrokerSessionOptions {
  endpoint?: string | null;
  pidFile: string | null;
  logFile: string | null;
  sessionDir?: string | null;
  pid?: number | null;
  /**
   * Kills the pid; null kills nothing. Only for a pid the caller knows is
   * still the broker's (a child whose handle it holds): a pid read from disk
   * may name another process by now.
   */
  killProcess?: ((pid: number) => unknown) | null;
}

export type BrokerEndpointProbeOutcome = 'connected' | 'closed' | 'timeout';

export interface ProbeSocket {
  readonly destroyed: boolean;
  destroy(): unknown;
  once(event: 'connect' | 'error' | 'close', listener: () => void): unknown;
}

export interface ProbeBrokerEndpointOptions {
  connect?: (endpoint: string) => ProbeSocket;
}

export const BROKER_SESSION_DIR_PREFIX = 'cxc-';

export function createBrokerSessionDir(prefix = BROKER_SESSION_DIR_PREFIX): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint: string): net.Socket {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export function probeBrokerEndpointOutcome(
  endpoint: string,
  timeoutMs = 500,
  options: ProbeBrokerEndpointOptions = {},
): Promise<BrokerEndpointProbeOutcome> {
  return new Promise<BrokerEndpointProbeOutcome>((resolve) => {
    const socket: ProbeSocket = (options.connect ?? connectToEndpoint)(endpoint);
    let connected = false;
    let settled = false;
    const timeout = setTimeout(() => finish('timeout'), timeoutMs);

    function finish(outcome: BrokerEndpointProbeOutcome): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (!socket.destroyed) {
        socket.destroy();
      }
      resolve(outcome);
    }

    socket.once('connect', () => {
      if (settled) {
        return;
      }
      connected = true;
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
    socket.once('error', () => finish('closed'));
    socket.once('close', () => finish(connected ? 'connected' : 'closed'));
  });
}

export async function probeBrokerEndpoint(endpoint: string, timeoutMs = 500): Promise<boolean> {
  return (await probeBrokerEndpointOutcome(endpoint, timeoutMs)) === 'connected';
}

async function sleepUntilNextProbe(deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
  }
}

// Probes the endpoint until it reports the wanted outcome or the deadline
// passes.
async function waitForEndpointOutcome(
  endpoint: string,
  wanted: BrokerEndpointProbeOutcome,
  timeoutMs: number,
  options: ProbeBrokerEndpointOptions,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const outcome = await probeBrokerEndpointOutcome(endpoint, Math.min(500, remaining), options);
    if (outcome === wanted) {
      return true;
    }
    await sleepUntilNextProbe(deadline);
  }
  return false;
}

export function waitForBrokerEndpoint(
  endpoint: string,
  timeoutMs = 2000,
  options: ProbeBrokerEndpointOptions = {},
): Promise<boolean> {
  return waitForEndpointOutcome(endpoint, 'connected', timeoutMs, options);
}

export function waitForBrokerEndpointClosed(
  endpoint: string,
  timeoutMs: number,
  options: ProbeBrokerEndpointOptions = {},
): Promise<boolean> {
  return waitForEndpointOutcome(endpoint, 'closed', timeoutMs, options);
}

// How one broker/shutdown request ended: the broker's first reply line, the
// timeout, a socket error, or a close before any reply.
type ShutdownExchange =
  | { kind: 'reply'; line: string }
  | { kind: 'timeout' }
  | { kind: 'error'; error: NodeJS.ErrnoException }
  | { kind: 'closed' };

// Sends one broker/shutdown request and waits, at most timeoutMs, for the
// first reply line. The socket is always destroyed, never ended: a half-close
// waits on the peer, and a listener that accepted but never reads would hold
// the caller until it is killed.
function exchangeShutdown(
  endpoint: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<ShutdownExchange> {
  return new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    let buffer = '';
    let settled = false;
    const finish = (exchange: ShutdownExchange): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(exchange);
    };
    const timeout = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    timeout.unref?.();
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, method: 'broker/shutdown', params })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        finish({ kind: 'reply', line: buffer.slice(0, newlineIndex) });
      }
    });
    socket.on('error', (error) => finish({ kind: 'error', error }));
    socket.on('close', () => finish({ kind: 'closed' }));
  });
}

// The unconditional shutdown. A broker that accepts the connection but never
// replies must not hang the caller (the test reaper calls this
// unconditionally).
export async function sendBrokerShutdown(endpoint: string, timeoutMs = 2000): Promise<void> {
  await exchangeShutdown(endpoint, {}, timeoutMs);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (processHasExited(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return processHasExited(pid);
}

function readGuardedShutdownReply(exchange: ShutdownExchange): ShutdownOutcome {
  switch (exchange.kind) {
    case 'timeout':
      return {
        accepted: false,
        detail: 'Timed out waiting for the broker shutdown response.',
        timedOut: true,
      };
    case 'closed':
      return {
        accepted: false,
        detail: 'The broker connection closed before acknowledging shutdown.',
      };
    case 'error':
      return { accepted: false, detail: exchange.error.message };
    case 'reply':
      break;
  }
  try {
    const message = JSON.parse(exchange.line);
    if (message.error) {
      return { accepted: false, detail: message.error.message ?? 'Broker shutdown was rejected.' };
    }
    if (message.result?.busy) {
      return { accepted: false, busy: true, detail: 'The shared broker is busy.' };
    }
    if (!message.result?.ok || !Number.isFinite(message.result?.pid)) {
      return {
        accepted: false,
        detail: 'The broker returned an invalid guarded-shutdown response.',
      };
    }
    return { accepted: true, pid: message.result.pid };
  } catch (error) {
    return {
      accepted: false,
      detail: `Invalid broker shutdown response: ${(error as Error).message}`,
    };
  }
}

export async function sendBrokerShutdownIfIdle(
  endpoint: string,
  options: { timeoutMs?: number } = {},
): Promise<ShutdownOutcome> {
  const timeoutMs = options.timeoutMs ?? 4000;
  // One deadline governs all three phases (response, process exit, endpoint
  // close), so the worst case stays ~timeoutMs instead of the phases each
  // spending their own copy of the budget.
  const deadline = Date.now() + timeoutMs;
  const response = readGuardedShutdownReply(
    await exchangeShutdown(endpoint, { ifIdle: true }, Math.min(timeoutMs, 2000)),
  );

  if (!response.accepted) {
    return response;
  }

  const exitBudget = Math.max(deadline - Date.now(), 250);
  const exited = await waitForProcessExit(response.pid, exitBudget);
  if (!exited) {
    return {
      accepted: false,
      detail: `Broker ${response.pid} accepted the drain but did not exit within ${exitBudget}ms.`,
    };
  }

  const endpointClosed = await waitForBrokerEndpointClosed(
    endpoint,
    Math.max(Math.min(deadline - Date.now(), 1000), 250),
  );
  if (!endpointClosed) {
    return {
      accepted: false,
      detail: 'The broker exited, but its endpoint remained connectable.',
    };
  }

  return { accepted: true, pid: response.pid };
}

export function spawnBrokerProcess({
  scriptPath,
  cwd,
  endpoint,
  pidFile,
  logFile,
  env = process.env,
  managedByWorkspaceRecord = false,
}: SpawnBrokerProcessOptions): ChildProcess {
  const logFd = fs.openSync(logFile, 'a');
  const brokerArgv = [
    scriptPath,
    'serve',
    '--endpoint',
    endpoint,
    '--cwd',
    cwd,
    '--pid-file',
    pidFile,
  ];
  if (managedByWorkspaceRecord) {
    brokerArgv.push('--workspace-record-owned');
  }
  try {
    const child = spawn(process.execPath, brokerArgv, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.once('error', (error) => {
      try {
        fs.appendFileSync(
          logFile,
          `[${new Date().toISOString()}] Failed to spawn broker process: ${error.message}\n`,
          'utf8',
        );
      } catch {
        // The broker readiness probe remains the authoritative failure channel.
      }
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(logFd);
  }
}

export function resolveBrokerStateFile(cwd: string): string {
  // broker.json is intentionally ephemeral and tied to the plugin install:
  // durable workspace data uses resolveDurableStateDir, but an upgrade must
  // discard this old-code broker record so the next command starts fresh.
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd: string): BrokerSession | null {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd: string, session: BrokerSession): void {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  writeJsonAtomic(resolveBrokerStateFile(cwd), session);
}

export function clearBrokerSession(cwd: string): void {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint: string): Promise<boolean> {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(
  cwd: string,
  options: EnsureBrokerSessionOptions = {},
): Promise<BrokerSession | null> {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null,
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, 'broker.pid');
  const logFile = path.join(sessionDir, 'broker.log');
  const scriptPath = options.scriptPath ?? BROKER_ENTRY;

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env,
    managedByWorkspaceRecord: true,
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    // The child may have exited during the wait and its pid been reused: the
    // handle this process holds says whether it still runs (an exited child's
    // pid is never signalled). The stale-session teardown above keeps
    // killProcess null: its pid comes from disk. hasOwn: an explicit
    // killProcess: null still suppresses the kill.
    const stillOurs = childTarget(child)?.isRunning() ?? false;
    const kill = Object.hasOwn(options, 'killProcess') ? options.killProcess : terminateProcessTree;
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: stillOurs ? kill : null,
    });
    return null;
  }

  const session: BrokerSession = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  pid = null,
  killProcess = null,
}: TeardownBrokerSessionOptions): void {
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  // Only files directly inside the session's own directory are the
  // companion's to remove. An endpoint pinned through
  // CODEX_COMPANION_APP_SERVER_ENDPOINT arrives with no session directory,
  // and a socket recorded elsewhere belongs to whoever listens there.
  const resolvedSessionDir =
    sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  const ownsFile = (file: string): boolean =>
    resolvedSessionDir !== null &&
    path.dirname(path.resolve(file)) === path.resolve(resolvedSessionDir);

  for (const file of [pidFile, logFile]) {
    if (!file || !ownsFile(file)) {
      continue;
    }
    try {
      fs.unlinkSync(file);
    } catch (error) {
      // A concurrent teardown (second SessionEnd, reaper, or the broker's own
      // SIGTERM cleanup) may have removed the file between checks.
      if (errorCode(error) !== 'ENOENT') {
        throw error;
      }
    }
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === 'unix' && ownsFile(target.path) && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}

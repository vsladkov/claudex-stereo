import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createBrokerEndpoint, parseBrokerEndpoint } from './endpoint.ts';
import { terminateProcessTree } from '../platform/process.ts';
import { BROKER_ENTRY } from '../shared/paths.ts';
import { resolveStateDir } from '../workspace/state.ts';

export const PID_FILE_ENV = 'CODEX_COMPANION_APP_SERVER_PID_FILE';
export const LOG_FILE_ENV = 'CODEX_COMPANION_APP_SERVER_LOG_FILE';
const BROKER_STATE_FILE = 'broker.json';

export interface BrokerSession {
  endpoint: string;
  pid: number | null;
  pidFile: string;
  logFile: string;
  sessionDir: string;
}

export type ShutdownOutcome =
  { accepted: true; pid: number } | { accepted: false; detail: string; busy?: boolean };

export interface SpawnBrokerProcessOptions {
  scriptPath: string;
  cwd: string;
  endpoint: string;
  pidFile: string;
  logFile: string;
  env?: NodeJS.ProcessEnv;
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
  killProcess?: ((pid: number) => unknown) | null;
}

export const BROKER_SESSION_DIR_PREFIX = 'cxc-';

export function createBrokerSessionDir(prefix = BROKER_SESSION_DIR_PREFIX): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint: string): net.Socket {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint: string, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint: string): Promise<void> {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, method: 'broker/shutdown', params: {} })}\n`);
    });
    socket.on('data', () => {
      socket.end();
      resolve(undefined);
    });
    socket.on('error', resolve);
    socket.on('close', resolve);
  });
}

export function processHasExited(pid: number): boolean {
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null | undefined)?.code === 'ESRCH';
  }
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

async function waitForBrokerEndpointClosed(endpoint: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const connectable = await new Promise<boolean>((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (!connectable) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdownIfIdle(
  endpoint: string,
  options: { timeoutMs?: number } = {},
): Promise<ShutdownOutcome> {
  const timeoutMs = options.timeoutMs ?? 4000;
  const response = await new Promise<ShutdownOutcome>((resolve) => {
    const socket = connectToEndpoint(endpoint);
    let buffer = '';
    let settled = false;
    const timeout = setTimeout(
      () => {
        finish({ accepted: false, detail: 'Timed out waiting for the broker shutdown response.' });
      },
      Math.min(timeoutMs, 2000),
    );
    timeout.unref?.();

    function finish(result: ShutdownOutcome): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.end();
      resolve(result);
    }

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ id: 1, method: 'broker/shutdown', params: { ifIdle: true } })}\n`,
      );
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      try {
        const message = JSON.parse(buffer.slice(0, newlineIndex));
        if (message.error) {
          finish({
            accepted: false,
            detail: message.error.message ?? 'Broker shutdown was rejected.',
          });
          return;
        }
        if (message.result?.busy) {
          finish({ accepted: false, busy: true, detail: 'The shared broker is busy.' });
          return;
        }
        if (!message.result?.ok || !Number.isFinite(message.result?.pid)) {
          finish({
            accepted: false,
            detail: 'The broker returned an invalid guarded-shutdown response.',
          });
          return;
        }
        finish({ accepted: true, pid: message.result.pid });
      } catch (error) {
        finish({
          accepted: false,
          detail: `Invalid broker shutdown response: ${(error as Error).message}`,
        });
      }
    });
    socket.on('error', (error) => {
      finish({ accepted: false, detail: error.message });
    });
    socket.on('close', () => {
      if (!settled) {
        finish({
          accepted: false,
          detail: 'The broker connection closed before acknowledging shutdown.',
        });
      }
    });
  });

  if (!response.accepted) {
    return response;
  }

  const exited = await waitForProcessExit(response.pid, timeoutMs);
  if (!exited) {
    return {
      accepted: false,
      detail: `Broker ${response.pid} accepted the drain but did not exit within ${timeoutMs}ms.`,
    };
  }

  const endpointClosed = await waitForBrokerEndpointClosed(endpoint, Math.min(timeoutMs, 1000));
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
}: SpawnBrokerProcessOptions): ChildProcess {
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(
    process.execPath,
    [scriptPath, 'serve', '--endpoint', endpoint, '--cwd', cwd, '--pid-file', pidFile],
    {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    },
  );
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd: string): string {
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
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
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
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      // This pid is our own just-spawned child (a live owned handle), so a
      // default kill is safe here; the stale-session teardown above must keep
      // killProcess null because its pid comes from disk and may be reused.
      // hasOwn: an explicit killProcess: null still suppresses the kill.
      killProcess: Object.hasOwn(options, 'killProcess')
        ? options.killProcess
        : terminateProcessTree,
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
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid as number);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  for (const file of [pidFile, logFile]) {
    if (!file) {
      continue;
    }
    try {
      fs.unlinkSync(file);
    } catch (error) {
      // A concurrent teardown (second SessionEnd, reaper, or the broker's own
      // SIGTERM cleanup) may have removed the file between checks.
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === 'unix' && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir =
    sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}

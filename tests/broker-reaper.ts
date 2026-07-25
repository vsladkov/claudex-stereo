import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  BROKER_SESSION_DIR_PREFIX,
  loadBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession,
} from '../plugins/stereo/src/broker/lifecycle.ts';
import { terminateProcessTree } from '../plugins/stereo/src/platform/process.ts';

// The companion CLI auto-starts a detached, session-leader broker per
// workspace; production tears it down via the SessionEnd hook, but a test
// that merely runs the CLI has no session end. Left alone, one full suite
// run strands ~40 broker processes. These reapers keep test machines clean.

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processAlive(pid);
}

/**
 * Tear down the broker recorded for one workspace directory: graceful
 * shutdown first, hard process-tree kill if it lingers, then file cleanup.
 * Safe to call on directories that never hosted a broker.
 */
export async function reapWorkspaceBroker(cwd: string): Promise<boolean> {
  let session;
  try {
    session = loadBrokerSession(cwd);
  } catch {
    return false;
  }
  if (!session) {
    return false;
  }

  const pid = Number(session.pid);
  if (Number.isFinite(pid) && pid > 0 && processAlive(pid)) {
    await sendBrokerShutdown(session.endpoint).catch(() => {});
    if (!(await waitForDeath(pid, 1500))) {
      try {
        terminateProcessTree(pid);
      } catch {
        // Best effort: teardownBrokerSession below retries the kill.
      }
      await waitForDeath(pid, 1500);
    }
  }

  teardownBrokerSession({
    endpoint: session.endpoint,
    pidFile: session.pidFile,
    logFile: session.logFile,
    sessionDir: session.sessionDir,
    pid: Number.isFinite(pid) && pid > 0 ? pid : null,
    killProcess: (target: number) => terminateProcessTree(target),
  });
  return true;
}

function readCommandLine(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
  } catch {
    return null;
  }
}

export interface LeakSweepResult {
  reaped: number;
  details: string[];
}

/**
 * Tmpdir-wide safety net for the suite's global teardown: kill any broker
 * whose pid file lives in a cxc-* session dir AND whose --cwd is itself under
 * os.tmpdir() (a live user session serves a real workspace and never matches).
 * Linux-only (/proc cmdline verification); other platforms rely on the
 * per-file afterEach reapers, which cover every leak path the suite has.
 */
export function reapLeakedTestBrokers(): LeakSweepResult {
  const result: LeakSweepResult = { reaped: 0, details: [] };
  if (process.platform !== 'linux') {
    return result;
  }

  const tmp = os.tmpdir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(BROKER_SESSION_DIR_PREFIX)) {
      continue;
    }
    const sessionDir = path.join(tmp, entry.name);
    let pid = NaN;
    try {
      pid = Number(fs.readFileSync(path.join(sessionDir, 'broker.pid'), 'utf8').trim());
    } catch {
      continue;
    }
    if (!Number.isFinite(pid) || pid <= 0 || !processAlive(pid)) {
      continue;
    }

    const cmdline = readCommandLine(pid);
    if (!cmdline) {
      continue;
    }
    if (!cmdline.includes('app-server-broker') || !cmdline.includes(' serve ')) {
      continue;
    }
    const cwdMatch = / --cwd (\S+)/.exec(cmdline);
    if (!cwdMatch || !cwdMatch[1] || !cwdMatch[1].startsWith(tmp + path.sep)) {
      continue;
    }

    try {
      terminateProcessTree(pid);
    } catch {
      continue;
    }
    result.reaped += 1;
    result.details.push(`pid ${pid} (cwd ${cwdMatch[1]})`);
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // The socket/pid files die with the process; directory cleanup is best effort.
    }
  }

  return result;
}

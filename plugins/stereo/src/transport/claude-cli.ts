import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

import {
  PROBE_TIMEOUT_MS,
  childTarget,
  resolveCommandLaunch,
  runCommand,
  signalProcessGroup,
  signalThenEscalate,
} from '../platform/process.ts';
import type { CommandResult, EscalationTarget, RunCommandFn } from '../platform/process.ts';
import { recordLike } from '../shared/json.ts';

// The headless Claude Code transport: one `claude -p` process per turn,
// prompt on stdin, `--output-format stream-json` events on stdout. How the
// CLI is started (a native binary directly, an npm `.cmd` shim's script under
// this Node, a JavaScript entry under this Node) is resolveCommandLaunch's.

export const CLAUDE_EXECPATH_ENV = 'CLAUDE_CODE_EXECPATH';
const MAX_STDERR_BYTES = 64 * 1024;
// How long a stopped child has between the polite signal and SIGKILL.
const DEFAULT_KILL_GRACE_MS = 3000;
// The synchronous grace a signal handler can afford before escalating.
const SIGNAL_KILL_GRACE_MS = 750;
// How long a child that has already reported its result may linger before it
// is stopped: the result stands either way, so this is not a timeout. One
// fixed deadline from the result event, whatever the child writes afterwards.
const DEFAULT_POST_RESULT_GRACE_MS = 10_000;
// How long an exited child's pipes may stay open before the run stops
// waiting for them: a descendant outside its process group (a detached
// helper, or any descendant on Windows) can hold them for as long as it runs.
const EXIT_DRAIN_MS = 2000;

// Claude Code answers `--version` with `<version> (Claude Code)`.
const CLAUDE_CODE_VERSION = /\(Claude Code\)/;

export interface ClaudeBinaryProbe {
  /** The binary a launch runs. */
  binary: string;
  /** Its `--version` answer. */
  version: CommandResult;
}

export interface ProbeClaudeBinaryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  run?: RunCommandFn;
}

// The binary Claude runs use, and its `--version` answer, asked once. A
// nested session inherits the parent's exact binary through
// CLAUDE_CODE_EXECPATH (an .exe on Windows, so no shell shim is needed);
// outside Claude Code the CLI on PATH is used. A parent started as
// `node cli.js` (an npm install, a source checkout, a wrapper) names its Node
// binary here under whatever name it has (`node`, `nodejs`, `node24`), which
// is no Claude at all; the CLI on PATH is. So the exec path counts only when
// its `--version` names Claude Code; one that fails to answer is kept, so the
// failure is reported against it.
export function probeClaudeBinary(options: ProbeClaudeBinaryOptions = {}): ClaudeBinaryProbe {
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const askVersion = (binary: string): CommandResult =>
    run(binary, ['--version'], { cwd: options.cwd, env, timeout: PROBE_TIMEOUT_MS });
  const execPath = env[CLAUDE_EXECPATH_ENV]?.trim();
  const base = execPath ? path.basename(execPath).toLowerCase() : '';
  if (execPath && base !== 'node' && base !== 'node.exe') {
    const version = askVersion(execPath);
    if (version.error || version.status !== 0 || CLAUDE_CODE_VERSION.test(version.stdout)) {
      return { binary: execPath, version };
    }
  }
  return { binary: 'claude', version: askVersion('claude') };
}

export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

export interface ClaudePermissionDenial {
  tool_name: string;
  tool_use_id?: string;
  tool_input?: unknown;
}

export interface ClaudeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
  costUSD?: number;
  canonicalModel?: string;
}

export interface ClaudeResultRecord extends ClaudeStreamEvent {
  type: 'result';
  subtype: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  session_id?: string;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, ClaudeModelUsage>;
  permission_denials?: ClaudePermissionDenial[];
  terminal_reason?: string;
  errors?: string[];
}

export interface SpawnClaudePrintOptions {
  /** The binary to run, as probeClaudeBinary resolved it. */
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Everything after `-p`. */
  args: readonly string[];
  prompt: string;
  onEvent?: (event: ClaudeStreamEvent) => void;
  /** The child's pid, once it exists: recorded on the job so a cancel can reach it. */
  onSpawn?: (pid: number) => void;
  /** 0 disables the inactivity kill (never the post-result deadline). */
  inactivityTimeoutMs?: number;
  /** How long the child may linger after its result (DEFAULT_POST_RESULT_GRACE_MS by default). */
  postResultGraceMs?: number;
  /** How long an exited child's pipes may stay open (EXIT_DRAIN_MS by default). */
  exitDrainMs?: number;
  /** How long a stopped child has before SIGKILL (DEFAULT_KILL_GRACE_MS by default). */
  killGraceMs?: number;
}

export interface ClaudePrintOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  result: ClaudeResultRecord | null;
  /** The first stdout line that was not JSON (bounded), for a run that reported no result. */
  firstUnparsedLine: string | null;
  stderr: string;
  /** The run went silent before reporting a result and was stopped. */
  timedOut: boolean;
  /** The transport stopped the child, before (timedOut) or after its result. */
  exitForced: boolean;
  spawnError: Error | null;
  /** The first error an onSpawn or onEvent callback threw; the stream was still read to the end. */
  callbackError: Error | null;
}

// Every `claude -p` child of this process whose run has not settled. A
// foreground companion is not a process-group leader, so a cancel or
// session-end signal that kills the companion would otherwise leave the child
// running until it hits EPIPE. A child stays listed after it exits until its
// pipes close: its group may still hold them.
const liveChildren = new Set<ChildProcess>();

// On POSIX the child leads its own process group, so a signal reaches the
// subprocesses it started (a hung test runner), not just the CLI, and the
// group is signalled even after the child exited: a helper still holding the
// pipes goes too. On Windows the whole tree goes while the child still runs
// (through the shim the child is cmd.exe). The child's own handle says
// whether it exited (childTarget): its pid may already name an unrelated
// process.
function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  const target = childTarget(child);
  if (target) {
    signalProcessGroup(target, signal);
  }
}

// A companion that dies another way than through the signal path (an
// uncaught exception, an explicit exit) must not orphan its headless
// children: their groups die with it. Registered once, on the first spawn.
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const child of liveChildren) {
      killChild(child, 'SIGKILL');
    }
  });
}

// Called from signal handlers, which re-raise the signal as soon as they
// return: a deferred SIGKILL would never run, so the grace is waited out
// synchronously and the kill is unconditional (on POSIX it still reaches the
// group of a child that already exited but whose pipes stay open). The
// session reservation is released afterwards, which is safe only because the
// child is gone by then.
export function terminateLiveClaudeRuns(): void {
  const targets = [...liveChildren]
    .map(childTarget)
    .filter((target): target is EscalationTarget => target !== null);
  signalThenEscalate(targets, { graceMs: SIGNAL_KILL_GRACE_MS, wait: 'sync' });
}

export function spawnClaudePrint(options: SpawnClaudePrintOptions): Promise<ClaudePrintOutcome> {
  const argv = ['-p', ...options.args];
  const outcome: ClaudePrintOutcome = {
    exitCode: null,
    signal: null,
    result: null,
    firstUnparsedLine: null,
    stderr: '',
    timedOut: false,
    exitForced: false,
    spawnError: null,
    callbackError: null,
  };
  installExitHook();

  return new Promise((resolve) => {
    let settled = false;
    let resultSeen = false;
    let exited = false;
    let child: ChildProcess | null = null;
    // Three independent timers: inactivity before the result, one fixed
    // deadline after it, and the wait for an exited child's pipes.
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
    let postResultTimer: ReturnType<typeof setTimeout> | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = (): void => {
      for (const timer of [inactivityTimer, postResultTimer, drainTimer]) {
        if (timer) {
          clearTimeout(timer);
        }
      }
      inactivityTimer = null;
      postResultTimer = null;
      drainTimer = null;
    };
    const finish = (): void => {
      if (!settled) {
        settled = true;
        clearTimers();
        if (child) {
          liveChildren.delete(child);
        }
        resolve(outcome);
      }
    };
    // A throwing callback is the caller's bug, not the child's: the stream is
    // still read to the end, so the child exits and is reaped as usual.
    const noteCallbackError = (error: unknown): void => {
      outcome.callbackError ??= error instanceof Error ? error : new Error(String(error));
    };

    // The polite signal, then the hard one for a child that ignores it.
    const stopChild = (child: ChildProcess): void => {
      outcome.exitForced = true;
      const target = childTarget(child);
      if (target) {
        signalThenEscalate(target, {
          graceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
          wait: 'timer',
          stillNeeded: () => !settled,
        });
      }
    };

    const inactivityMs = options.inactivityTimeoutMs ?? 0;
    // Re-armed by every stdout line and stderr chunk until the result; once
    // the result is in (or the child is gone) only the post-result deadline
    // and the drain remain.
    const armInactivity = (target: ChildProcess): void => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
      if (inactivityMs <= 0 || resultSeen || exited || settled) {
        return;
      }
      inactivityTimer = setTimeout(() => {
        inactivityTimer = null;
        outcome.timedOut = true;
        stopChild(target);
      }, inactivityMs);
      inactivityTimer.unref?.();
    };
    // Armed once, when the result arrives, and never re-armed: a child that
    // keeps writing (stderr noise, a helper's output) cannot extend it.
    const armPostResultDeadline = (target: ChildProcess): void => {
      if (postResultTimer || settled) {
        return;
      }
      postResultTimer = setTimeout(() => {
        postResultTimer = null;
        stopChild(target);
      }, options.postResultGraceMs ?? DEFAULT_POST_RESULT_GRACE_MS);
      postResultTimer.unref?.();
    };

    let spawned: ChildProcess;
    try {
      // Inside the try: a command line the cmd.exe fallback cannot carry
      // intact is refused, as a spawn error.
      const launch = resolveCommandLaunch(options.binary, argv, { env: options.env });
      spawned = spawn(launch.file, launch.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: launch.shell,
        windowsHide: true,
        // A group of its own: see killChild. The parent still awaits the
        // pipes, so nothing is unref'd.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      outcome.spawnError = error instanceof Error ? error : new Error(String(error));
      finish();
      return;
    }
    child = spawned;

    liveChildren.add(spawned);
    if (typeof spawned.pid === 'number') {
      try {
        options.onSpawn?.(spawned.pid);
      } catch (error) {
        noteCallbackError(error);
      }
    }
    spawned.on('error', (error) => {
      outcome.spawnError = error;
      finish();
    });

    // A write racing child death fails asynchronously on the stdin stream;
    // the exit handler owns the failure.
    spawned.stdin?.on('error', () => {});
    spawned.stdin?.end(options.prompt);

    spawned.stderr?.setEncoding('utf8');
    spawned.stderr?.on('data', (chunk: string) => {
      outcome.stderr = (outcome.stderr + chunk).slice(-MAX_STDERR_BYTES);
      armInactivity(spawned);
    });

    if (spawned.stdout) {
      spawned.stdout.setEncoding('utf8');
      const lines = readline.createInterface({ input: spawned.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        armInactivity(spawned);
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          outcome.firstUnparsedLine ??= trimmed.slice(0, 200);
          return;
        }
        const record = recordLike(parsed);
        if (!record || typeof record.type !== 'string') {
          return;
        }
        const event = record as ClaudeStreamEvent;
        if (event.type === 'result') {
          outcome.result = event as ClaudeResultRecord;
          resultSeen = true;
          armInactivity(spawned);
          armPostResultDeadline(spawned);
        }
        try {
          options.onEvent?.(event);
        } catch (error) {
          noteCallbackError(error);
        }
      });
    }

    // Whatever the child left running in its group (a dev server, a watcher
    // it started in the background) dies with the job. Called once, when the
    // child exited, so only its group is signalled (a no-op on Windows); never
    // again at close, when the reaped leader's pid (and so its group id) may
    // already name another process group.
    const killLeftoverGroup = (): void => {
      if (typeof spawned.pid === 'number') {
        signalProcessGroup({ pid: spawned.pid, isRunning: () => false }, 'SIGKILL');
      }
    };

    spawned.on('exit', (code, signal) => {
      exited = true;
      outcome.exitCode = code;
      outcome.signal = signal;
      armInactivity(spawned);
      // A member of the group still holding the pipes would otherwise keep
      // the run open until it ended by itself.
      killLeftoverGroup();
      if (!settled && !drainTimer) {
        drainTimer = setTimeout(() => {
          drainTimer = null;
          // Only a holder outside the group is left: what the child wrote
          // has been read by now, so stop waiting for the pipes.
          spawned.stdout?.destroy();
          spawned.stderr?.destroy();
          finish();
        }, options.exitDrainMs ?? EXIT_DRAIN_MS);
        drainTimer.unref?.();
      }
    });

    spawned.on('close', (code, signal) => {
      if (!settled) {
        outcome.exitCode = code;
        outcome.signal = signal;
      }
      finish();
    });
    armInactivity(spawned);
  });
}

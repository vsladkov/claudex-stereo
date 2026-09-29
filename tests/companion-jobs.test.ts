import fs from 'node:fs';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SpawnOptions, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  CODEX_NOT_AUTHENTICATED_ERROR,
  cleanupCompanionJobForSignal,
  createCompanionJob,
  enqueueBackgroundTask,
  ensureCodexLaunchReady,
  installSignalCleanup,
  terminalizeJobForSignal,
} from '../plugins/stereo/src/workflows/companion-jobs.ts';
import type { CodexAuthStatus } from '../plugins/stereo/src/runtime/index.ts';
import {
  acquireThreadReservation,
  releaseThreadReservation,
} from '../plugins/stereo/src/runtime/reservations.ts';
import { COMPANION_ENTRY } from '../plugins/stereo/src/shared/paths.ts';
import { settleJob } from '../plugins/stereo/src/jobs/job-lifecycle.ts';
import {
  listJobs,
  loadState,
  readJobFile,
  resolveJobFile,
  upsertJob,
  writeJobFile,
} from '../plugins/stereo/src/workspace/state.ts';
import type { JobRecord } from '../plugins/stereo/src/workspace/state.ts';
import { sleepSync } from '../plugins/stereo/src/shared/fs.ts';
import { makeTempDir, useTempCodexHome } from './helpers.ts';

// The epoch ms of a `wall:<ms>` start token (NaN for anything else).
function wallStartMs(start: unknown): number {
  const match = /^wall:(\d+)$/.exec(String(start));
  return match ? Number(match[1]) : Number.NaN;
}

function launchAuthStatus(requiresOpenaiAuth: boolean | null): CodexAuthStatus {
  return {
    available: true,
    loggedIn: false,
    detail: 'fixture auth status',
    source: 'app-server',
    authMethod: null,
    verified: null,
    requiresOpenaiAuth,
    provider: requiresOpenaiAuth === false ? 'custom' : 'openai',
    configuredProviders: [],
  };
}

test('launch readiness blocks only a definite unmet OpenAI auth requirement', async () => {
  const deps = (requiresOpenaiAuth: boolean | null) => ({
    ensureAvailable: () => {},
    getAuthStatus: async () => launchAuthStatus(requiresOpenaiAuth),
  });

  await assert.rejects(
    ensureCodexLaunchReady('/fixture', deps(true)),
    new RegExp(CODEX_NOT_AUTHENTICATED_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  await assert.doesNotReject(ensureCodexLaunchReady('/fixture', deps(false)));
  await assert.doesNotReject(ensureCodexLaunchReady('/fixture', deps(null)));
});

test('signal cleanup handlers dispose without outliving their job', (t) => {
  // A hang-up ends a companion like a termination: its handler is the same.
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  const before = signals.map((signal) => process.listenerCount(signal));
  const dispose = installSignalCleanup({
    jobId: 'listener-job',
    workspaceRoot: makeTempDir('companion-signal-listeners-'),
  });
  t.after(dispose);

  assert.deepEqual(
    signals.map((signal) => process.listenerCount(signal)),
    before.map((count) => count + 1),
  );

  dispose();
  dispose();
  assert.deepEqual(
    signals.map((signal) => process.listenerCount(signal)),
    before,
  );
});

test('a hang-up settles the job it interrupts', (t) => {
  useTempCodexHome(t);
  const workspaceRoot = makeTempDir('companion-sighup-');
  const jobId = 'task-hung-up';
  writeJobFile(workspaceRoot, jobId, { id: jobId, status: 'running', pid: process.pid });
  upsertJob(workspaceRoot, { id: jobId, status: 'running', pid: process.pid });

  const result = cleanupCompanionJobForSignal({ jobId, workspaceRoot }, 'SIGHUP');
  assert.equal(result.terminalized, true);
  const stored = readJobFile(resolveJobFile(workspaceRoot, jobId));
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.errorMessage, 'Terminated by SIGHUP.');
  assert.equal(stored.pid, null);
});

test('a synchronous detached-worker spawn failure terminalizes the queued job', (t) => {
  useTempCodexHome(t);
  const workspaceRoot = makeTempDir('companion-spawn-sync-');
  const job = createCompanionJob({
    prefix: 'task',
    kind: 'task',
    title: 'Spawn failure task',
    workspaceRoot,
    jobClass: 'task',
    summary: 'Exercise synchronous spawn failure',
    model: null,
  });

  assert.throws(
    () =>
      enqueueBackgroundTask(
        workspaceRoot,
        job,
        { prompt: 'run' },
        {
          spawnImpl: (() => {
            throw new Error('spawn EAGAIN');
          }) as unknown as typeof spawn,
        },
      ),
    /spawn EAGAIN/,
  );

  const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
  assert.equal(stored.status, 'failed');
  assert.equal(stored.phase, 'failed');
  assert.equal(stored.pid, null);
  assert.equal(stored.errorMessage, 'spawn EAGAIN');
  assert.equal(
    loadState(workspaceRoot).jobs.find((entry) => entry.id === job.id)?.status,
    'failed',
  );
});

test('an asynchronous detached-worker spawn error terminalizes the queued job', (t) => {
  useTempCodexHome(t);
  const workspaceRoot = makeTempDir('companion-spawn-async-');
  const job = createCompanionJob({
    prefix: 'task',
    kind: 'task',
    title: 'Async spawn failure task',
    workspaceRoot,
    jobClass: 'task',
    summary: 'Exercise asynchronous spawn failure',
    model: null,
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 7654,
    unref: () => child,
  });

  enqueueBackgroundTask(
    workspaceRoot,
    job,
    { prompt: 'run' },
    {
      spawnImpl: (() => child) as unknown as typeof spawn,
    },
  );
  child.emit('error', new Error('spawn EMFILE'));

  const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
  assert.equal(stored.status, 'failed');
  assert.equal(stored.phase, 'failed');
  assert.equal(stored.pid, null);
  assert.equal(stored.errorMessage, 'spawn EMFILE');
  assert.equal(
    loadState(workspaceRoot).jobs.find((entry) => entry.id === job.id)?.status,
    'failed',
  );
});

test('the post-spawn pid patch touches no job that settled meanwhile', (t) => {
  useTempCodexHome(t);
  const workspaceRoot = makeTempDir('companion-spawn-race-');
  const enqueueWith = (id: string, meanwhile: (queued: JobRecord) => void): JobRecord => {
    const job = createCompanionJob({
      prefix: id,
      kind: 'task',
      title: 'Spawn race task',
      workspaceRoot,
      jobClass: 'task',
      summary: 'Preserve the worker transition',
      model: null,
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 2147483765,
      unref: () => child,
    });
    const spawnImpl = (() => {
      meanwhile(readJobFile(resolveJobFile(workspaceRoot, job.id)));
      return child;
    }) as unknown as typeof spawn;
    const startedAt = Date.now();
    enqueueBackgroundTask(workspaceRoot, job, { prompt: 'run' }, { spawnImpl });
    const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
    const row = listJobs(workspaceRoot).find((entry) => entry.id === job.id);
    if (stored.status === 'queued') {
      // Still queued: the spawned worker's pid and start land on both records
      // (no process has the synthetic pid: its start is the spawn's wall time).
      for (const record of [stored, row]) {
        assert.equal(record?.pid, 2147483765);
        assert.ok(wallStartMs(record?.pidStart) >= startedAt - 1000);
      }
    }
    return stored;
  };

  enqueueWith('task-queued', () => {});

  // The worker recorded itself running before the patch: the patch names the
  // same process and leaves its status alone.
  const running = enqueueWith('task-running', (queued) => {
    writeJobFile(workspaceRoot, queued.id, {
      ...queued,
      status: 'running',
      phase: 'running',
      pid: 2147483765,
    });
  });
  assert.equal(running.status, 'running');
  assert.equal(running.phase, 'running');
  assert.equal(running.pid, 2147483765);

  // A job cancelled before the patch gains no pid.
  const cancelled = enqueueWith('task-cancelled', (queued) => {
    settleJob(workspaceRoot, queued.id, { terminal: { status: 'cancelled', phase: 'cancelled' } });
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.pid, null);
  assert.equal(listJobs(workspaceRoot).find((job) => job.id === cancelled.id)?.pid, null);
});

test("a slow spawn's queued worker start is taken after the spawn returns", (t) => {
  useTempCodexHome(t);
  const workspaceRoot = makeTempDir('companion-slow-spawn-');
  const job = createCompanionJob({
    prefix: 'task',
    kind: 'task',
    title: 'Slow spawn task',
    workspaceRoot,
    jobClass: 'task',
    summary: 'Record the start after the spawn',
    model: null,
  });
  const child = Object.assign(new EventEmitter(), { pid: 2147483766, unref: () => child });
  let spawnReturnedAt = 0;
  const spawnImpl = (() => {
    // A slow spawn: a start taken before it could fall past the start
    // window's forward half on macOS and Windows.
    sleepSync(50);
    spawnReturnedAt = Date.now();
    return child;
  }) as unknown as typeof spawn;
  enqueueBackgroundTask(workspaceRoot, job, { prompt: 'run' }, { spawnImpl });
  const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
  assert.equal(stored.pid, 2147483766);
  assert.ok(wallStartMs(stored.pidStart) >= spawnReturnedAt);
});

test('a detached task worker receives the authoritative workspace without changing spawn cwd', (t) => {
  useTempCodexHome(t);
  const workspaceRoot = makeTempDir('companion-worker-workspace-');
  const threadCwd = makeTempDir('companion-worker-cwd-');
  const job = createCompanionJob({
    prefix: 'task',
    kind: 'task',
    title: 'Isolated worker task',
    workspaceRoot,
    jobClass: 'task',
    summary: 'Forward the workspace key',
    model: null,
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 0,
    unref: () => child,
  });
  let capturedArgv: readonly string[] = [];
  let capturedOptions: SpawnOptions | undefined;
  const spawnImpl = ((
    _command: string,
    argv: readonly string[] = [],
    options: SpawnOptions = {},
  ) => {
    capturedArgv = argv;
    capturedOptions = options;
    return child;
  }) as unknown as typeof spawn;

  enqueueBackgroundTask(threadCwd, job, { prompt: 'run' }, { spawnImpl });

  assert.deepEqual(capturedArgv, [
    COMPANION_ENTRY,
    'task-worker',
    '--cwd',
    threadCwd,
    '--job-id',
    job.id,
    '--workspace',
    workspaceRoot,
  ]);
  assert.equal(capturedOptions?.cwd, threadCwd);
});

test('signal terminalization cancels an active job and is idempotent', () => {
  const workspaceRoot = makeTempDir('companion-signal-terminal-');
  const jobId = 'running-signal-job';
  const running = {
    id: jobId,
    status: 'running',
    phase: 'running',
    pid: process.pid,
    claudePid: 2147483600,
    title: 'Signal target',
    kind: 'task',
    logFile: '/tmp/signal-target.log',
    result: { partial: true },
  };
  writeJobFile(workspaceRoot, jobId, running);

  assert.equal(terminalizeJobForSignal({ jobId, workspaceRoot }, 'SIGTERM'), true);
  const stored = readJobFile(resolveJobFile(workspaceRoot, jobId));
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.phase, 'cancelled');
  assert.equal(stored.pid, null);
  assert.equal(stored.claudePid, null, 'a terminal record names no process');
  assert.equal(stored.errorMessage, 'Terminated by SIGTERM.');
  assert.deepEqual(stored.result, { partial: true });
  const indexed = loadState(workspaceRoot).jobs.find((job) => job.id === jobId);
  assert.equal(indexed?.status, 'cancelled');
  assert.equal(indexed?.pid, null);
  assert.equal(indexed?.title, 'Signal target');
  assert.equal(indexed?.kind, 'task');
  assert.equal(indexed?.logFile, '/tmp/signal-target.log');

  assert.equal(terminalizeJobForSignal({ jobId, workspaceRoot }, 'SIGINT'), false);
  assert.equal(
    readJobFile(resolveJobFile(workspaceRoot, jobId)).errorMessage,
    'Terminated by SIGTERM.',
  );
});

test('signal cleanup releases the reservation it holds and preserves a completed record', (t) => {
  useTempCodexHome(t);
  const workspaceRoot = makeTempDir('companion-signal-release-');
  const jobId = 'completed-signal-job';
  const completedJob = {
    id: jobId,
    status: 'completed',
    phase: 'done',
    pid: null,
    result: { verdict: 'approve' },
    rendered: 'approved',
  };
  writeJobFile(workspaceRoot, jobId, completedJob);
  upsertJob(workspaceRoot, completedJob);

  const reservation = acquireThreadReservation('signal-thread', { jobId });
  t.after(() => releaseThreadReservation(reservation));

  const cleanup = cleanupCompanionJobForSignal({ jobId, workspaceRoot }, 'SIGTERM');
  assert.deepEqual(cleanup, { terminalized: false });
  assert.equal(fs.existsSync(reservation.path), false);
  const stored = readJobFile(resolveJobFile(workspaceRoot, jobId));
  assert.equal(stored.status, 'completed');
  assert.deepEqual(stored.result, { verdict: 'approve' });
  assert.equal(stored.rendered, 'approved');
});

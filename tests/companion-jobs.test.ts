import fs from 'node:fs';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { TestContext } from 'node:test';

import {
  cleanupCompanionJobForSignal,
  createCompanionJob,
  enqueueBackgroundTask,
  installSignalCleanup,
  terminalizeJobForSignal,
} from '../plugins/stereo/src/workflows/companion-jobs.ts';
import {
  acquireThreadReservation,
  markLiveReservationPhase,
  releaseThreadReservation,
} from '../plugins/stereo/src/runtime/reservations.ts';
import {
  applyTurnNotification,
  createTurnCaptureState,
} from '../plugins/stereo/src/runtime/turn-capture.ts';
import type { AppServerNotification } from '../plugins/stereo/src/protocol/app-server.ts';
import {
  loadState,
  readJobFile,
  resolveJobFile,
  upsertJob,
  writeJobFile,
} from '../plugins/stereo/src/workspace/state.ts';
import { makeTempDir } from './helpers.ts';

const notification = (value: unknown) => value as AppServerNotification;

function useTempCodexHome(t: TestContext): void {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = makeTempDir('companion-signal-codex-home-');
  t.after(() => {
    if (previous === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
  });
}

test('signal cleanup handlers dispose without outliving their job', (t) => {
  const beforeTerm = process.listenerCount('SIGTERM');
  const beforeInterrupt = process.listenerCount('SIGINT');
  const dispose = installSignalCleanup({
    jobId: 'listener-job',
    workspaceRoot: makeTempDir('companion-signal-listeners-'),
  });
  t.after(dispose);

  assert.equal(process.listenerCount('SIGTERM'), beforeTerm + 1);
  assert.equal(process.listenerCount('SIGINT'), beforeInterrupt + 1);

  dispose();
  dispose();
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  assert.equal(process.listenerCount('SIGINT'), beforeInterrupt);
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

test('signal terminalization cancels an active job and is idempotent', () => {
  const workspaceRoot = makeTempDir('companion-signal-terminal-');
  const jobId = 'running-signal-job';
  const running = {
    id: jobId,
    status: 'running',
    phase: 'running',
    pid: process.pid,
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

test('proven post-turn cleanup releases the lock and preserves a completed record', async (t) => {
  useTempCodexHome(t);
  const workspaceRoot = makeTempDir('companion-signal-post-turn-');
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

  const reservation = acquireThreadReservation('post-turn-signal-thread', {
    jobId,
    pid: process.pid,
  });
  t.after(() => releaseThreadReservation(reservation));
  const capture = createTurnCaptureState('post-turn-signal-thread');
  applyTurnNotification(
    capture,
    notification({
      method: 'turn/completed',
      params: {
        threadId: 'post-turn-signal-thread',
        turn: { id: 'turn-post', status: 'completed' },
      },
    }),
  );
  const completedCapture = await capture.completion;
  assert.equal(completedCapture.inferredCompletion, false);
  markLiveReservationPhase(
    reservation,
    completedCapture.inferredCompletion ? 'in-flight' : 'post-turn',
  );

  const cleanup = cleanupCompanionJobForSignal({ jobId, workspaceRoot }, 'SIGTERM');
  assert.deepEqual(cleanup, { terminalized: false, released: 1, retained: 0 });
  assert.equal(fs.existsSync(reservation.path), false);
  const stored = readJobFile(resolveJobFile(workspaceRoot, jobId));
  assert.equal(stored.status, 'completed');
  assert.deepEqual(stored.result, { verdict: 'approve' });
  assert.equal(stored.rendered, 'approved');
});

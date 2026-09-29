import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { makeTempDir, processIsAlive, run, waitFor, writeReservationLock } from './helpers.ts';
import {
  SCRIPT,
  SESSION_HOOK,
  findThreadReservation,
  initializeBasicRepo,
  readCompanionState,
  readFakeState,
  registerBrokerReaping,
  registerSessionCleanup,
  requireCompanionState,
  spawnStandIn,
  stopStandIn,
  waitForFakeState,
  withCodexHome,
} from './runtime-helpers.ts';
import { PROCESS_MARKERS } from '../plugins/stereo/src/platform/process.ts';
import { releaseThreadReservation } from '../plugins/stereo/src/runtime/index.ts';
import { resolveDurableStateDir } from '../plugins/stereo/src/workspace/state.ts';

registerBrokerReaping();

async function waitForChildExit<T>(exitPromise: Promise<T>, timeoutMs = 10000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      exitPromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Timed out waiting for child process exit.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

test('setup and status surface stranded thread reservations on every route', (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  const stateDir = resolveDurableStateDir(repo, env.CODEX_HOME);
  const jobsDir = path.join(stateDir, 'jobs');
  const jobId = 'reservation-status-job';
  const logFile = path.join(jobsDir, `${jobId}.log`);
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(logFile, '[2026-07-20T12:00:00.000Z] Waiting for status poll\n', 'utf8');
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: 'running',
            title: 'Codex Task',
            jobClass: 'task',
            summary: 'Reservation visibility fixture',
            logFile,
            createdAt: '2026-07-20T12:00:00.000Z',
            startedAt: '2026-07-20T12:00:01.000Z',
            updatedAt: '2026-07-20T12:00:02.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const reservations = withCodexHome(env.CODEX_HOME, () => {
    const dead = writeReservationLock('status-dead-thread', {
      jobId: 'status-dead-job',
      pid: 2147483647,
    });
    const deadCleanup = writeReservationLock('status-dead-cleanup-thread', {
      jobId: 'status-dead-cleanup-job',
      pid: 2147483647,
    });
    fs.writeFileSync(
      deadCleanup.cleanupPath,
      `${JSON.stringify({
        pid: 2147483647,
        jobId: 'status-dead-cleanup-job',
        createdAt: '2026-07-20T12:00:00.000Z',
      })}\n`,
      'utf8',
    );
    // The scan judges by liveness alone: any live pid holds its lock.
    const liveOwner = writeReservationLock('status-live-owner-thread', {
      jobId: 'status-live-owner-job',
      pid: process.pid,
    });
    fs.writeFileSync(
      liveOwner.cleanupPath,
      `${JSON.stringify({
        pid: 2147483647,
        jobId: 'status-dead-claim-job',
        createdAt: '2026-07-20T12:00:00.000Z',
      })}\n`,
      'utf8',
    );
    // A record that cannot be validated is all the scan lists.
    const unreadable = path.join(path.dirname(liveOwner.path), 'status-unreadable.lock');
    fs.writeFileSync(unreadable, '{}\n', 'utf8');
    return { dead, deadCleanup, liveOwner, unreadable };
  });

  t.after(() => {
    for (const target of [
      reservations.dead.path,
      reservations.dead.cleanupPath,
      reservations.deadCleanup.path,
      reservations.deadCleanup.cleanupPath,
      reservations.liveOwner.cleanupPath,
      reservations.unreadable,
    ]) {
      try {
        fs.unlinkSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
          throw error;
        }
      }
    }
    releaseThreadReservation(reservations.liveOwner);
  });

  const setupJson = run(process.execPath, [SCRIPT, 'setup', '--json'], { cwd: repo, env });
  assert.equal(setupJson.status, 0, setupJson.stderr);
  assert.ok(setupJson.stdout.trim(), JSON.stringify(setupJson));
  const setupPayload = JSON.parse(setupJson.stdout);
  // The scan reaps the dead owners' locks and every dead claim, and lists
  // only the record it could not validate.
  assert.deepEqual(setupPayload.strandedReservations, [
    { kind: 'unreadable', paths: [reservations.unreadable] },
  ]);
  for (const target of [
    reservations.dead.path,
    reservations.deadCleanup.path,
    reservations.deadCleanup.cleanupPath,
    reservations.liveOwner.cleanupPath,
  ]) {
    assert.equal(fs.existsSync(target), false, `${target} reaped`);
  }
  assert.equal(fs.existsSync(reservations.liveOwner.path), true, 'a live owner keeps its lock');

  const unreadableStep = setupPayload.nextSteps.find((step: string) =>
    step.includes(`\`${reservations.unreadable}\``),
  );
  assert.ok(unreadableStep);
  assert.equal(unreadableStep.includes(`\`${reservations.liveOwner.path}\``), false);

  const renderedSetup = run(process.execPath, [SCRIPT, 'setup'], { cwd: repo, env });
  assert.equal(renderedSetup.status, 0, renderedSetup.stderr);
  assert.match(renderedSetup.stdout, /- thread reservations: 1 stranded \(see next steps\)/);

  const aggregateStatus = run(process.execPath, [SCRIPT, 'status'], { cwd: repo, env });
  assert.equal(aggregateStatus.status, 0, aggregateStatus.stderr);
  assert.match(aggregateStatus.stdout, /Warnings:/);
  assert.ok(aggregateStatus.stdout.includes(`\`${reservations.unreadable}\``));
  assert.equal(aggregateStatus.stdout.includes(`\`${reservations.liveOwner.path}\``), false);

  const referencedStatus = run(process.execPath, [SCRIPT, 'status', jobId], { cwd: repo, env });
  assert.equal(referencedStatus.status, 0, referencedStatus.stderr);
  assert.match(referencedStatus.stdout, /# Stereo Job Status[\s\S]*Warnings:/);
  assert.ok(referencedStatus.stdout.includes(`\`${reservations.unreadable}\``));

  const referencedJson = run(process.execPath, [SCRIPT, 'status', jobId, '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(referencedJson.status, 0, referencedJson.stderr);
  assert.equal(JSON.parse(referencedJson.stdout).strandedReservations.length, 1);

  const waitedJson = run(
    process.execPath,
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '25', '--json'],
    { cwd: repo, env },
  );
  assert.equal(waitedJson.status, 0, waitedJson.stderr);
  const waitedPayload = JSON.parse(waitedJson.stdout);
  assert.equal(waitedPayload.waitTimedOut, true);
  assert.equal(waitedPayload.strandedReservations.length, 1);

  fs.unlinkSync(reservations.unreadable);

  const clearedSetup = run(process.execPath, [SCRIPT, 'setup'], { cwd: repo, env });
  assert.equal(clearedSetup.status, 0, clearedSetup.stderr);
  assert.match(clearedSetup.stdout, /- thread reservations: none stranded/);

  const clearedAggregate = run(process.execPath, [SCRIPT, 'status'], { cwd: repo, env });
  assert.equal(clearedAggregate.status, 0, clearedAggregate.stderr);
  assert.doesNotMatch(clearedAggregate.stdout, /Warnings:/);
  const clearedReferenced = run(process.execPath, [SCRIPT, 'status', jobId], { cwd: repo, env });
  assert.equal(clearedReferenced.status, 0, clearedReferenced.stderr);
  assert.doesNotMatch(clearedReferenced.stdout, /Warnings:/);
});

test('a resumed thread is reserved for exactly one run', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-turn');
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, 'plan-review', '--json', 'Reservation target plan'], {
    cwd: repo,
    env,
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;

  // The holder is a stand-in companion: the competing run checks that the
  // recorded pid still runs the worker before honouring the reservation.
  const holder = spawnStandIn(PROCESS_MARKERS.worker, { cwd: repo });
  assert.ok(holder.pid);
  t.after(() => stopStandIn(holder));
  const live = withCodexHome(env.CODEX_HOME, () =>
    writeReservationLock(threadId, { jobId: 'holding-job', pid: holder.pid! }),
  );
  const blocked = run(
    process.execPath,
    [SCRIPT, 'task', '--thread', threadId, '--role', 'plan-reviewer', 'competing run'],
    {
      cwd: repo,
      env,
    },
  );
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /already being used by another companion run \(job holding-job\)/);
  releaseThreadReservation(live);

  const dead = withCodexHome(env.CODEX_HOME, () =>
    writeReservationLock(threadId, { jobId: 'crashed-job', pid: 2147483647 }),
  );
  // A lock left by a dead owner is taken over: the retry runs instead of
  // asking the user to delete a hashed file.
  const stale = run(
    process.execPath,
    [SCRIPT, 'task', '--thread', threadId, '--role', 'plan-reviewer', 'retry after crash'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(stale.status, 0, stale.stderr);
  // The run released the lock it took over; the dead owner's handle is stale.
  assert.equal(fs.existsSync(dead.path), false);
  assert.equal(releaseThreadReservation(dead).released, false);

  const normal = run(
    process.execPath,
    [SCRIPT, 'task', '--thread', threadId, '--role', 'plan-reviewer', 'normal resume'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(fs.existsSync(dead.path), false);

  const launched = run(
    process.execPath,
    [
      SCRIPT,
      'task',
      '--background',
      '--json',
      '--thread',
      threadId,
      '--role',
      'plan-reviewer',
      'slow reserved resume',
    ],
    { cwd: repo, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  // Conjunction gate (not just "a reservation exists"): the reservation must
  // belong to THIS job and its turn must have started, otherwise a lingering
  // reservation from the earlier foreground run can satisfy the wait early
  // and the post-completion null assertion races the release.
  await waitFor(
    () => {
      const reservation = findThreadReservation(env.CODEX_HOME, threadId);
      const job = readCompanionState(repo, env)?.jobs.find((candidate) => candidate.id === jobId);
      return reservation?.record.jobId === jobId && job?.turnId ? reservation : null;
    },
    { timeoutMs: 10000 },
  );
  const waited = run(
    process.execPath,
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '15000', '--json'],
    { cwd: repo, env },
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(findThreadReservation(env.CODEX_HOME, threadId), null);
});

test('a fresh persistent thread is reserved before its id is published', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-turn');
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const launched = run(
    process.execPath,
    [SCRIPT, 'task', '--background', '--json', 'start a slow fresh thread'],
    { cwd: repo, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const running = await waitFor(
    () => {
      const job = readCompanionState(repo, env)?.jobs.find((candidate) => candidate.id === jobId);
      const reservation = job?.threadId
        ? findThreadReservation(env.CODEX_HOME, job.threadId)
        : null;
      const turnStarts: Array<Record<string, any>> = readFakeState(binDir).turnStarts ?? [];
      const turnStarted = job?.threadId
        ? turnStarts.some((entry) => entry.threadId === job.threadId)
        : false;
      return job?.status === 'running' && job.threadId && reservation && turnStarted
        ? { job, reservation }
        : null;
    },
    { timeoutMs: 10000 },
  );

  const competitor = run(
    process.execPath,
    [SCRIPT, 'task', '--thread', running.job.threadId, 'compete with the fresh owner'],
    { cwd: repo, env },
  );
  assert.notEqual(competitor.status, 0);
  assert.match(
    competitor.stderr,
    new RegExp(`job ${jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  assert.equal(fs.existsSync(path.join(binDir, 'fake-codex-state.json')), true);
  const turnStarts: Array<Record<string, any>> = (await waitForFakeState(binDir, 'turnStarts'))
    .turnStarts;
  assert.equal(turnStarts.filter((entry) => entry.threadId === running.job.threadId).length, 1);

  const waited = run(
    process.execPath,
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '15000', '--json'],
    { cwd: repo, env },
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(findThreadReservation(env.CODEX_HOME, running.job.threadId), null);

  const resumed = run(
    process.execPath,
    [SCRIPT, 'task', '--thread', running.job.threadId, 'resume after the owner finishes'],
    { cwd: repo, env },
  );
  assert.equal(resumed.status, 0, resumed.stderr);
});

test(
  'SIGTERM terminalizes a background job and releases its reservation, its turn in flight',
  { skip: process.platform === 'win32' },
  async (t) => {
    const repo = initializeBasicRepo();
    const binDir = makeTempDir();
    installFakeCodex(binDir, 'slow-turn');
    const env = buildEnv(binDir);

    const seed = run(
      process.execPath,
      [SCRIPT, 'plan-review', '--json', 'Signal retention target'],
      { cwd: repo, env },
    );
    assert.equal(seed.status, 0, seed.stderr);
    const threadId = JSON.parse(seed.stdout).threadId;

    const launched = run(
      process.execPath,
      [
        SCRIPT,
        'task',
        '--background',
        '--json',
        '--thread',
        threadId,
        '--role',
        'plan-reviewer',
        'signal this slow task',
      ],
      { cwd: repo, env },
    );
    assert.equal(launched.status, 0, launched.stderr);
    const jobId = JSON.parse(launched.stdout).jobId;
    let workerPid: number | null = null;
    let ownedReservation: ReturnType<typeof findThreadReservation> = null;
    t.after(async () => {
      if (workerPid && processIsAlive(workerPid)) {
        try {
          process.kill(workerPid, 'SIGKILL');
        } catch {
          // The worker may have exited between the liveness probe and kill.
        }
        await waitFor(() => !processIsAlive(workerPid), { timeoutMs: 3000 }).catch(() => null);
      }
      if (ownedReservation) {
        releaseThreadReservation({
          path: ownedReservation.path,
          token: ownedReservation.record.token,
        });
      }
    });

    const running = await waitFor(
      () => {
        const job = readCompanionState(repo, env)?.jobs.find((candidate) => candidate.id === jobId);
        const reservation = findThreadReservation(env.CODEX_HOME, threadId);
        const turnStarts: Array<Record<string, any>> = readFakeState(binDir).turnStarts ?? [];
        const started = turnStarts.some(
          (entry) => entry.threadId === threadId && entry.turnId === job?.turnId,
        );
        if (
          !job ||
          job.status !== 'running' ||
          typeof job.pid !== 'number' ||
          !reservation ||
          reservation.record.jobId !== jobId ||
          !job.turnId ||
          !started
        ) {
          return null;
        }
        return { job, reservation };
      },
      { timeoutMs: 10000 },
    );
    const runningWorkerPid = running.job.pid as number;
    workerPid = runningWorkerPid;
    ownedReservation = running.reservation;

    process.kill(runningWorkerPid, 'SIGTERM');
    const cancelled = await waitFor(
      () => {
        const job = readCompanionState(repo, env)?.jobs.find((candidate) => candidate.id === jobId);
        const fakeState = readFakeState(binDir);
        return job?.status === 'cancelled' &&
          job.errorMessage === 'Terminated by SIGTERM.' &&
          !processIsAlive(workerPid) &&
          fakeState.lastInterrupt?.threadId === threadId &&
          fakeState.lastInterrupt?.turnId === running.job.turnId
          ? job
          : null;
      },
      { timeoutMs: 10000 },
    );
    assert.equal(cancelled.pid, null);
    // The worker's signal handler released the reservation before the worker
    // died; the broker only interrupts the turn it left behind.
    assert.equal(fs.existsSync(running.reservation.path), false);

    const successor = run(
      process.execPath,
      [
        SCRIPT,
        'task',
        '--thread',
        threadId,
        '--role',
        'plan-reviewer',
        'resume after the signalled worker',
      ],
      { cwd: repo, env },
    );
    assert.equal(successor.status, 0, successor.stderr);
  },
);

test(
  'foreground SIGINT releases its reservation, its turn in flight',
  { skip: process.platform === 'win32' },
  async (t) => {
    const repo = initializeBasicRepo();
    const binDir = makeTempDir();
    installFakeCodex(binDir, 'slow-turn');
    const env = buildEnv(binDir);

    const seed = run(
      process.execPath,
      [SCRIPT, 'plan-review', '--json', 'Foreground signal target'],
      { cwd: repo, env },
    );
    assert.equal(seed.status, 0, seed.stderr);
    const threadId = JSON.parse(seed.stdout).threadId;

    const child = spawn(
      process.execPath,
      [
        SCRIPT,
        'task',
        '--json',
        '--thread',
        threadId,
        '--role',
        'plan-reviewer',
        'interrupt this foreground task',
      ],
      {
        cwd: repo,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );

    let ownedReservation: ReturnType<typeof findThreadReservation> = null;
    t.after(async () => {
      if (child.pid && processIsAlive(child.pid)) {
        child.kill('SIGKILL');
        await waitForChildExit(childExit, 3000).catch(() => null);
      }
      if (ownedReservation) {
        releaseThreadReservation({
          path: ownedReservation.path,
          token: ownedReservation.record.token,
        });
      }
    });

    const running = await waitFor(
      () => {
        const job = readCompanionState(repo, env)?.jobs.find(
          (candidate) => candidate.status === 'running' && candidate.pid === child.pid,
        );
        const reservation = findThreadReservation(env.CODEX_HOME, threadId);
        const turnStarts: Array<Record<string, any>> = readFakeState(binDir).turnStarts ?? [];
        const started = turnStarts.some(
          (entry) => entry.threadId === threadId && entry.turnId === job?.turnId,
        );
        if (
          !job ||
          job.threadId !== threadId ||
          !reservation ||
          reservation.record.jobId !== job.id ||
          !job.turnId ||
          !started
        ) {
          return null;
        }
        return { job, reservation };
      },
      { timeoutMs: 10000 },
    );
    ownedReservation = running.reservation;

    child.kill('SIGINT');
    const exit = await waitForChildExit(childExit);
    assert.equal(exit.code, null, JSON.stringify({ stdout, stderr }));
    assert.equal(exit.signal, 'SIGINT', JSON.stringify({ stdout, stderr }));
    // Released by the signal handler, before the process ended.
    assert.equal(fs.existsSync(running.reservation.path), false);

    const cancelled = await waitFor(
      () => {
        const job = readCompanionState(repo, env)?.jobs.find(
          (candidate) => candidate.id === running.job.id,
        );
        const fakeState = readFakeState(binDir);
        return job?.status === 'cancelled' &&
          job.errorMessage === 'Terminated by SIGINT.' &&
          fakeState.lastInterrupt?.threadId === threadId &&
          fakeState.lastInterrupt?.turnId === running.job.turnId
          ? job
          : null;
      },
      { timeoutMs: 10000 },
    );
    assert.equal(cancelled.pid, null);

    const successor = run(
      process.execPath,
      [
        SCRIPT,
        'task',
        '--thread',
        threadId,
        '--role',
        'plan-reviewer',
        'resume after the foreground signal',
      ],
      { cwd: repo, env },
    );
    assert.equal(successor.status, 0, successor.stderr);
  },
);

test('/stereo:cancel leaves task and plan-review threads free for the next run', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-turn');
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(
    process.execPath,
    [SCRIPT, 'plan-review', '--json', 'Cancellation target plan'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;

  const taskLaunch = run(
    process.execPath,
    [
      SCRIPT,
      'task',
      '--background',
      '--json',
      '--thread',
      threadId,
      '--role',
      'plan-reviewer',
      'slow cancellable task',
    ],
    { cwd: repo, env },
  );
  assert.equal(taskLaunch.status, 0, taskLaunch.stderr);
  const taskJobId = JSON.parse(taskLaunch.stdout).jobId;
  await waitFor(
    () => {
      const reservation = findThreadReservation(env.CODEX_HOME, threadId);
      const job = readCompanionState(repo, env)?.jobs.find(
        (candidate) => candidate.id === taskJobId,
      );
      return reservation?.record.jobId === taskJobId && job?.turnId ? reservation : null;
    },
    { timeoutMs: 10000 },
  );

  const taskCancel = run(process.execPath, [SCRIPT, 'cancel', taskJobId, '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(taskCancel.status, 0, taskCancel.stderr);

  // The cancelled run's lock, if its worker left one, is taken over at once.
  const resumed = run(
    process.execPath,
    [SCRIPT, 'task', '--thread', threadId, '--role', 'plan-reviewer', 'resume immediately'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(resumed.status, 0, resumed.stderr);

  const planLaunch = run(
    process.execPath,
    [
      SCRIPT,
      'plan-review',
      '--background',
      '--json',
      '--thread',
      threadId,
      '--round',
      '2',
      'slow cancellable plan review',
    ],
    { cwd: repo, env },
  );
  assert.equal(planLaunch.status, 0, planLaunch.stderr);
  const planJobId = JSON.parse(planLaunch.stdout).jobId;
  await waitFor(
    () => {
      const reservation = findThreadReservation(env.CODEX_HOME, threadId);
      const job = readCompanionState(repo, env)?.jobs.find(
        (candidate) => candidate.id === planJobId,
      );
      return reservation?.record.jobId === planJobId && job?.turnId ? reservation : null;
    },
    { timeoutMs: 10000 },
  );

  const planCancel = run(process.execPath, [SCRIPT, 'cancel', planJobId, '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(planCancel.status, 0, planCancel.stderr);
  const resumedAgain = run(
    process.execPath,
    [
      SCRIPT,
      'task',
      '--thread',
      threadId,
      '--role',
      'plan-reviewer',
      'resume after the plan-review cancel',
    ],
    { cwd: repo, env },
  );
  assert.equal(resumedAgain.status, 0, resumedAgain.stderr);
  assert.equal(findThreadReservation(env.CODEX_HOME, threadId), null);
});

test('cancel never removes a foreign thread reservation', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-turn');
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, 'plan-review', '--json', 'Foreign lock target'], {
    cwd: repo,
    env,
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;
  const launched = run(
    process.execPath,
    [
      SCRIPT,
      'task',
      '--background',
      '--json',
      '--thread',
      threadId,
      '--role',
      'plan-reviewer',
      'own the reservation briefly',
    ],
    { cwd: repo, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const reservation = await waitFor(
    () => {
      const lock = findThreadReservation(env.CODEX_HOME, threadId);
      const job = readCompanionState(repo, env)?.jobs.find((candidate) => candidate.id === jobId);
      return lock && job?.turnId ? lock : null;
    },
    { timeoutMs: 10000 },
  );
  const foreignRecord = {
    ...reservation.record,
    jobId: 'foreign-job',
    token: 'foreign-token',
  };
  fs.writeFileSync(reservation.path, `${JSON.stringify(foreignRecord)}\n`, 'utf8');

  const cancelled = run(process.execPath, [SCRIPT, 'cancel', jobId, '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(fs.existsSync(reservation.path), true);
  releaseThreadReservation({
    path: reservation.path,
    token: foreignRecord.token,
  });
});

test('SessionEnd leaves the threads of the session jobs it kills free for the next run', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-turn');
  const sessionId = 'session-reservation-cleanup';
  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: sessionId,
  };
  // The successor below starts a broker of its own.
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, 'plan-review', '--json', 'Session cleanup target'], {
    cwd: repo,
    env,
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;
  const launched = run(
    process.execPath,
    [
      SCRIPT,
      'task',
      '--background',
      '--json',
      '--thread',
      threadId,
      '--role',
      'plan-reviewer',
      'session-owned work',
    ],
    { cwd: repo, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  await waitFor(
    () => {
      const lock = findThreadReservation(env.CODEX_HOME, threadId);
      const job = readCompanionState(repo, env)?.jobs.find((candidate) => candidate.id === jobId);
      return lock && job?.turnId ? lock : null;
    },
    { timeoutMs: 10000 },
  );

  const ended = run(process.execPath, [SESSION_HOOK, 'SessionEndSweep'], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      cwd: repo,
    }),
  });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(
    requireCompanionState(repo, env).jobs.some((job) => job.id === jobId),
    false,
  );
  // The killed run's lock, if it left one, is taken over by the next run.
  const successor = run(
    process.execPath,
    [SCRIPT, 'task', '--thread', threadId, '--role', 'plan-reviewer', 'next run'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(successor.status, 0, successor.stderr);
  assert.equal(findThreadReservation(env.CODEX_HOME, threadId), null);
});

test('the same thread is exclusive across workspaces and plugin state roots', (t) => {
  const workspaceA = initializeBasicRepo();
  const workspaceB = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const codexHome = path.join(binDir, 'shared-codex-home');
  const holder = spawnStandIn(PROCESS_MARKERS.worker, { cwd: workspaceA });
  assert.ok(holder.pid);
  t.after(() => stopStandIn(holder));
  const reservation = withCodexHome(codexHome, () =>
    writeReservationLock('cross-workspace-thread', { jobId: 'workspace-a-job', pid: holder.pid! }),
  );

  const result = run(
    process.execPath,
    [SCRIPT, 'task', '--thread', 'cross-workspace-thread', 'competing workspace B run'],
    {
      cwd: workspaceB,
      env: {
        ...buildEnv(binDir),
        CODEX_HOME: codexHome,
        CLAUDE_PLUGIN_DATA: path.join(workspaceB, '.plugin-data-b'),
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /already being used by another companion run \(job workspace-a-job\)/,
  );
  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastResume, undefined);
  assert.equal(fakeState.lastThreadStart, undefined);
  assert.deepEqual(fakeState.turnStarts ?? [], []);
  assert.equal(path.dirname(reservation.path), path.join(codexHome, 'companion-thread-locks'));
  releaseThreadReservation(reservation);

  assert.notEqual(workspaceA, workspaceB);
});

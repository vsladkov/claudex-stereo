import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { loadBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import { findStalledJobs } from '../plugins/stereo/src/cli/commands/doctor.ts';
import { handleCancel } from '../plugins/stereo/src/cli/commands/cancel.ts';
import type { CancelDeps } from '../plugins/stereo/src/cli/commands/cancel.ts';
import { cleanupSessionJobs } from '../plugins/stereo/src/hooks/session-lifecycle.ts';
import { enrichJob } from '../plugins/stereo/src/jobs/job-control.ts';
import { stopJobProcesses } from '../plugins/stereo/src/jobs/job-lifecycle.ts';
import {
  PROCESS_MARKERS,
  currentProcessStartToken,
  processHasExited,
} from '../plugins/stereo/src/platform/process.ts';
import type { ProcessIdentity } from '../plugins/stereo/src/platform/process.ts';
import {
  acquireThreadReservation,
  releaseThreadReservation,
} from '../plugins/stereo/src/runtime/reservations.ts';
import {
  acquireCleanupClaim,
  releaseCleanupClaim,
  threadReservationPath,
} from '../plugins/stereo/src/workspace/thread-lock-io.ts';
import { readJobFile, resolveJobFile } from '../plugins/stereo/src/workspace/state.ts';
import type { JobRecord } from '../plugins/stereo/src/workspace/state.ts';
import {
  captureStdout,
  doctorDeps,
  indexed,
  makeTempDir,
  processOps,
  seedJob,
  ticksOf,
  useTempCodexHome,
  withTicks,
} from './helpers.ts';
import { spawnStandIn, standInArgv, stopStandIn } from './runtime-helpers.ts';

// Process identity at its call sites: the kill primitive, cancel, the
// doctor's stall check, and SessionEnd, each driven through its injected
// identity seams (readProcessIdentity, processHasExited, and the terminate
// that would deliver a signal), with synthetic pids: nothing is spawned or
// signalled. The rule under test: a signal only for 'ours'; 'unknown' is
// never signalled and never treated as dead (no stall); 'foreign' and
// 'dead' are left alone. Then two holders judged on the host itself, with
// live `node` stand-ins (never claude or codex) and their real start tokens:
// a cleanup claim and a running job's status, each held only while its
// recorded process may still run. Reservation owners and their Claude
// children are judged through the seams in thread-reservation.test.ts.
//
// The synthetic records carry Linux start tokens with no boot id (`-`), which
// no host reads as an earlier boot's, so the seam-driven tests run on every
// platform; the holders and the recorded tokens need real Linux tokens, which
// exist only on Linux, and run there. What a running job, its progress, and
// the Claude runner record is in tracked-jobs.test.ts and
// claude-runner.test.ts. Nothing here starts a broker.

const LINUX = process.platform === 'linux';
const onLinux = { skip: !LINUX };

const WORKER_PID = 2147483101;
const CLAUDE_PID = 2147483102;
const DEAD_PID = 2147483103;

const SELF_ID: string = LINUX ? currentProcessStartToken() : '';

const recordedWorker = (): string => 'linux:-:111111';
const recordedClaude = (): string => 'linux:-:222222';

function identityOf(start: string | null, marker: string | null): ProcessIdentity {
  const argv = marker ? ['/usr/bin/node', ...standInArgv(marker)] : ['/usr/bin/vim', 'notes.txt'];
  return { commandLine: argv.join(' '), start };
}

interface FakeProc {
  exited: boolean;
  identity: ProcessIdentity | null;
  /** Whether a signal ends it (a stop that works). */
  exitOnSignal: boolean;
  /** The identity it shows once signalled but still running. */
  afterSignal?: ProcessIdentity | null;
}

// Synthetic processes answering the three seams.
function makeWorld() {
  const procs = new Map<number, FakeProc>();
  const signals: Array<[number, string]> = [];
  const world = {
    procs,
    signals,
    set(pid: number, proc: Partial<FakeProc>) {
      procs.set(pid, { exited: false, identity: null, exitOnSignal: true, ...proc });
    },
    read: (pid: number): ProcessIdentity | null => {
      const proc = procs.get(pid);
      return proc && !proc.exited ? proc.identity : null;
    },
    hasExited: (pid: number): boolean => procs.get(pid)?.exited ?? true,
    terminate: (pid: number, options?: { signal?: string; groupOnly?: boolean }) => {
      signals.push([pid, options?.signal ?? 'SIGTERM']);
      const proc = procs.get(pid);
      if (proc?.exitOnSignal) {
        proc.exited = true;
      } else if (proc && proc.afterSignal !== undefined) {
        proc.identity = proc.afterSignal;
      }
    },
    signalled(pid: number): string[] {
      return signals.filter(([target]) => target === pid).map(([, signal]) => signal);
    },
  };
  return world;
}

type World = ReturnType<typeof makeWorld>;
type Scenario = 'ours' | 'foreign' | 'unknown' | 'dead';

// One recorded process in a scenario: the world's view of the pid, and the
// start token its record carries.
function place(
  world: World,
  pid: number,
  scenario: Scenario,
  marker: string,
  recorded: string,
): string {
  switch (scenario) {
    case 'ours':
      world.set(pid, { identity: identityOf(recorded, marker) });
      return recorded;
    case 'foreign':
      world.set(pid, { identity: identityOf(withTicks(recorded, 999_999), marker) });
      return recorded;
    case 'unknown':
      // The identity read failed (a probe that timed out, an unreadable /proc).
      world.set(pid, { identity: null });
      return recorded;
    case 'dead':
      world.set(pid, { exited: true, identity: null });
      return recorded;
  }
}

// The stop's seams, with POSIX signals (a polite one, then the hard one) on
// every host.
function seams(world: World) {
  return {
    ops: processOps({
      terminate: world.terminate,
      processHasExited: world.hasExited,
      readProcessIdentity: world.read,
      platform: 'linux',
    }),
  };
}

// ---------------------------------------------------------------------------
// The kill primitive every stopper uses

test('stopJobProcesses signals a worker only when its verdict is ours', () => {
  const expected: Record<Scenario, { signalled: boolean; result: string }> = {
    ours: { signalled: true, result: 'stopped' },
    foreign: { signalled: false, result: 'foreign' },
    unknown: { signalled: false, result: 'unconfirmed' },
    dead: { signalled: false, result: 'exited' },
  };
  for (const [scenario, outcome] of Object.entries(expected) as Array<
    [Scenario, (typeof expected)[Scenario]]
  >) {
    const world = makeWorld();
    const pidStart = place(world, WORKER_PID, scenario, PROCESS_MARKERS.worker, recordedWorker());
    const result = stopJobProcesses(
      { pid: WORKER_PID, pidStart },
      { ...seams(world), graceMs: 10 },
    );
    assert.equal(
      world.signalled(WORKER_PID).length > 0,
      outcome.signalled,
      `${scenario}: signalled`,
    );
    assert.equal(result.worker, outcome.result, `${scenario}: stop result`);
  }
});

test('an unknown Claude child is never signalled, and one that turns unknown gets no SIGKILL', () => {
  {
    const world = makeWorld();
    const claudePidStart = place(
      world,
      CLAUDE_PID,
      'unknown',
      PROCESS_MARKERS.claude,
      recordedClaude(),
    );
    const result = stopJobProcesses(
      { claudePid: CLAUDE_PID, claudePidStart },
      { ...seams(world), graceMs: 10 },
    );
    assert.deepEqual(world.signals, [], 'no signal');
    assert.equal(result.claude, 'unconfirmed', 'the stop is still to come');
  }

  // Ours at first; after the polite signal its identity cannot be read.
  const world = makeWorld();
  world.set(CLAUDE_PID, {
    identity: identityOf(recordedClaude(), PROCESS_MARKERS.claude),
    exitOnSignal: false,
    afterSignal: null,
  });
  stopJobProcesses(
    { claudePid: CLAUDE_PID, claudePidStart: recordedClaude() },
    { ...seams(world), graceMs: 10 },
  );
  assert.deepEqual(world.signalled(CLAUDE_PID), ['SIGTERM'], 'the hard signal needs a fresh ours');

  // Still ours after the grace: the escalation does happen (not a vacuous pass).
  const stubborn = makeWorld();
  stubborn.set(CLAUDE_PID, {
    identity: identityOf(recordedClaude(), PROCESS_MARKERS.claude),
    exitOnSignal: false,
  });
  stopJobProcesses(
    { claudePid: CLAUDE_PID, claudePidStart: recordedClaude() },
    { ...seams(stubborn), graceMs: 10 },
  );
  assert.deepEqual(stubborn.signalled(CLAUDE_PID), ['SIGTERM', 'SIGKILL']);
});

test('an exact start-token match is signalled even after a process-title rewrite', () => {
  const world = makeWorld();
  world.set(WORKER_PID, { identity: identityOf(recordedWorker(), null) });
  stopJobProcesses({ pid: WORKER_PID, pidStart: recordedWorker() }, seams(world));
  assert.equal(world.signalled(WORKER_PID).length, 1);
});

test('a legacy record (no start recorded) keeps the marker rule, and a failed read is never signalled', () => {
  const marked = makeWorld();
  marked.set(WORKER_PID, { identity: identityOf(null, PROCESS_MARKERS.worker) });
  stopJobProcesses({ pid: WORKER_PID }, seams(marked));
  assert.equal(marked.signalled(WORKER_PID).length, 1, 'marker matches: ours');

  const unmarked = makeWorld();
  unmarked.set(WORKER_PID, { identity: identityOf(null, null) });
  const foreign = stopJobProcesses({ pid: WORKER_PID }, seams(unmarked));
  assert.deepEqual(unmarked.signals, [], 'marker contradicts: foreign');
  assert.equal(foreign.worker, 'foreign');

  // A probe that failed is unknown, never ours.
  const unreadable = makeWorld();
  unreadable.set(WORKER_PID, { identity: null });
  const unknown = stopJobProcesses({ pid: WORKER_PID }, seams(unreadable));
  assert.deepEqual(unreadable.signals, [], 'unknown: no signal');
  assert.notEqual(unknown.worker, 'exited');
  assert.notEqual(unknown.worker, 'foreign');
});

// ---------------------------------------------------------------------------
// cancel

function runningJob(id: string, fields: Record<string, unknown> = {}): JobRecord {
  return {
    id,
    status: 'running',
    title: 'Claude Task',
    runtime: 'claude',
    jobClass: 'task',
    sessionId: 'sess-identity',
    createdAt: '2026-09-26T08:00:00.000Z',
    updatedAt: '2026-09-26T08:01:00.000Z',
    ...fields,
  };
}

function cancelDeps(world: World): CancelDeps {
  return {
    interruptAppServerTurn: async () => ({
      attempted: false,
      interrupted: false,
      transport: null,
      detail: '',
    }),
    ops: processOps({
      terminate: world.terminate,
      processHasExited: world.hasExited,
      readProcessIdentity: world.read,
    }),
  } as unknown as CancelDeps;
}

function bothRecords(workspace: string, id: string): Array<JobRecord | undefined> {
  return [indexed(workspace, id), readJobFile(resolveJobFile(workspace, id)) as JobRecord];
}

test('cancel signals only an ours worker, and names an unknown one for the user to end', async (t) => {
  useTempCodexHome(t);
  for (const scenario of ['ours', 'foreign', 'unknown', 'dead'] as const) {
    const workspace = makeTempDir();
    const id = `task-cancel-${scenario}`;
    const world = makeWorld();
    const pidStart = place(world, WORKER_PID, scenario, PROCESS_MARKERS.worker, recordedWorker());
    seedJob(workspace, runningJob(id, { pid: WORKER_PID, pidStart }));

    const payload = JSON.parse(
      await captureStdout(() =>
        handleCancel(['--cwd', workspace, '--json', id], cancelDeps(world)),
      ),
    );

    assert.equal(
      world.signalled(WORKER_PID).length > 0,
      scenario === 'ours',
      `${scenario}: signalled`,
    );
    assert.equal(
      payload.killWarning?.includes(`worker pid ${WORKER_PID}`) ?? false,
      scenario === 'unknown',
      `${scenario}: warned`,
    );
    for (const record of bothRecords(workspace, id)) {
      assert.equal(record?.status, 'cancelled', `${scenario}: the cancel is recorded`);
      assert.equal(record?.pid, null, `${scenario}: no pid is kept`);
    }
    assert.equal(loadBrokerSession(workspace), null, 'a Claude cancel starts no broker');
  }
});

// ---------------------------------------------------------------------------
// doctor

function worldDoctorDeps(world: World) {
  return doctorDeps({
    ops: { processHasExited: world.hasExited, readProcessIdentity: world.read },
  });
}

test('doctor counts a job stalled only when its worker is dead or foreign', async (t) => {
  useTempCodexHome(t);
  const expectations: Record<Scenario, boolean> = {
    ours: false,
    unknown: false,
    foreign: true,
    dead: true,
  };
  for (const [scenario, stalled] of Object.entries(expectations) as Array<[Scenario, boolean]>) {
    const workspace = makeTempDir();
    const world = makeWorld();
    const id = `task-stall-${scenario}`;
    const pidStart = place(world, WORKER_PID, scenario, PROCESS_MARKERS.worker, recordedWorker());
    seedJob(workspace, runningJob(id, { pid: WORKER_PID, pidStart }));
    const found = findStalledJobs(workspace, worldDoctorDeps(world)).map((job) => job.id);
    assert.deepEqual(found, stalled ? [id] : [], `${scenario}`);
  }
});

test('doctor and status agree: a worker with no start token is stalled only once its pid is gone', async (t) => {
  useTempCodexHome(t);
  for (const [pid, stalled] of [
    [process.pid, false],
    [DEAD_PID, true],
  ] as const) {
    const workspace = makeTempDir();
    const world = makeWorld();
    // Another program on the live pid: only a command-line probe could tell,
    // and the shared cheap check runs none.
    world.set(process.pid, { identity: identityOf(null, null) });
    const job = runningJob('task-legacy', { pid });
    seedJob(workspace, job);
    const deps = doctorDeps({ ops: { processHasExited, readProcessIdentity: world.read } });
    assert.equal(findStalledJobs(workspace, deps).length, stalled ? 1 : 0, `doctor, pid ${pid}`);
    assert.equal(enrichJob(job).phase === 'stalled', stalled, `status, pid ${pid}`);
  }
});

// ---------------------------------------------------------------------------
// SessionEnd

test('SessionEnd signals only ours, and leaves unknown, foreign, and dead alone', async (t) => {
  useTempCodexHome(t);
  const sessionId = 'sess-identity';
  const options = (world: World) => seams(world);

  // Both processes unknown: nothing signalled, and the stop is not confirmed.
  {
    const workspace = makeTempDir();
    const world = makeWorld();
    const id = 'task-end-unknown';
    const pidStart = place(world, WORKER_PID, 'unknown', PROCESS_MARKERS.worker, recordedWorker());
    const claudePidStart = place(
      world,
      CLAUDE_PID,
      'unknown',
      PROCESS_MARKERS.claude,
      recordedClaude(),
    );
    seedJob(
      workspace,
      runningJob(id, {
        sessionId,
        pid: WORKER_PID,
        pidStart,
        claudePid: CLAUDE_PID,
        claudePidStart,
      }),
    );
    cleanupSessionJobs([workspace], sessionId, options(world));
    assert.deepEqual(world.signals, []);
    // Not confirmed stopped: the cancelled row stays.
    for (const record of bothRecords(workspace, id)) {
      assert.equal(record?.status, 'cancelled');
      assert.equal(record?.pid, null);
      assert.equal(record?.claudePid, null);
    }
  }
  // Foreign worker, dead child: nothing signalled, and the job is swept.
  {
    const workspace = makeTempDir();
    const world = makeWorld();
    const id = 'task-end-gone';
    const pidStart = place(world, WORKER_PID, 'foreign', PROCESS_MARKERS.worker, recordedWorker());
    const claudePidStart = place(
      world,
      CLAUDE_PID,
      'dead',
      PROCESS_MARKERS.claude,
      recordedClaude(),
    );
    seedJob(
      workspace,
      runningJob(id, {
        sessionId,
        pid: WORKER_PID,
        pidStart,
        claudePid: CLAUDE_PID,
        claudePidStart,
      }),
    );
    cleanupSessionJobs([workspace], sessionId, options(world));
    assert.deepEqual(world.signals, []);
    assert.equal(indexed(workspace, id), undefined, 'confirmed gone: the row leaves the index');
  }
  // Ours: signalled.
  {
    const workspace = makeTempDir();
    const world = makeWorld();
    const id = 'task-end-ours';
    const pidStart = place(world, WORKER_PID, 'ours', PROCESS_MARKERS.worker, recordedWorker());
    seedJob(workspace, runningJob(id, { sessionId, pid: WORKER_PID, pidStart }));
    cleanupSessionJobs([workspace], sessionId, options(world));
    assert.ok(world.signalled(WORKER_PID).length > 0);
  }
});

// ---------------------------------------------------------------------------
// Holders: a cleanup claim and a running job's status keep what they hold
// while their recorded process may still run.

// A holder's pid and the start token its record carries: a live stand-in's
// own (ours), another tick count on that same live pid (foreign: a reused
// pid), or a pid no process has (dead).
function holders(t: TestContext, marker: string) {
  const standIn = spawnStandIn(marker);
  t.after(() => stopStandIn(standIn));
  // Its start token, read right after the spawn returned, as a record's is.
  const { pid, start } = standIn;
  assert.match(start, /^linux:/, 'a live stand-in has a Linux start token');
  return {
    ours: { pid, start },
    foreign: { pid, start: withTicks(start, ticksOf(start) + 3) },
    dead: { pid: DEAD_PID, start: withTicks(SELF_ID, 1) },
  };
}

function writeRecord(recordPath: string, record: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(
    recordPath,
    `${JSON.stringify({ jobId: 'job-holder', createdAt: '2026-09-26T08:00:00.000Z', ...record })}\n`,
  );
}

test(
  'a cleanup claim and a running job hold only while their recorded process may run',
  onLinux,
  (t) => {
    useTempCodexHome(t);
    const workers = holders(t, PROCESS_MARKERS.worker);
    for (const scenario of ['ours', 'foreign', 'dead'] as const) {
      const holds = scenario === 'ours';
      const worker = workers[scenario];

      // A cleanup claim on a thread nobody holds, left by a cleaner that
      // still runs or whose pid another process has by now.
      if (scenario !== 'dead') {
        const claimed = `thr-claim-${scenario}`;
        const claimPath = `${threadReservationPath(claimed)}.cleanup`;
        writeRecord(claimPath, { pid: worker.pid, pidStart: worker.start, jobId: null });
        let reservation: ReturnType<typeof acquireThreadReservation> | null = null;
        try {
          reservation = acquireThreadReservation(claimed, { jobId: 'job-new' });
        } catch {
          reservation = null;
        }
        assert.equal(reservation === null, holds, `${scenario} claimant`);
        if (reservation) {
          releaseThreadReservation(reservation);
        } else {
          assert.ok(fs.existsSync(claimPath), `${scenario}: the claim stays`);
        }
      }

      // Job status: stalled once its worker is gone.
      const job: JobRecord = {
        id: `task-status-${scenario}`,
        status: 'running',
        jobClass: 'task',
        title: 'Codex Task',
        pid: worker.pid,
        pidStart: worker.start,
        createdAt: new Date().toISOString(),
      };
      assert.equal(enrichJob(job).phase === 'stalled', !holds, `${scenario} worker`);
    }
  },
);

// ---------------------------------------------------------------------------
// Recording the start tokens

test('reservations and cleanup claims record this process start token', onLinux, (t) => {
  useTempCodexHome(t);
  const reservation = acquireThreadReservation('thr-records', { jobId: 'job-records' });
  try {
    const record = JSON.parse(fs.readFileSync(reservation.path, 'utf8'));
    assert.equal(record.pid, process.pid);
    assert.equal(record.pidStart, SELF_ID);
    const claim = acquireCleanupClaim(reservation.path);
    assert.ok(claim);
    try {
      assert.equal(JSON.parse(claim.contents).pidStart, SELF_ID);
    } finally {
      releaseCleanupClaim(claim);
    }
  } finally {
    releaseThreadReservation(reservation);
  }
});

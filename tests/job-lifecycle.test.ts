import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { handleCancel } from '../plugins/stereo/src/cli/commands/cancel.ts';
import type { CancelDeps } from '../plugins/stereo/src/cli/commands/cancel.ts';
import { handleTaskWorker } from '../plugins/stereo/src/cli/commands/task.ts';
import type { TaskWorkerDeps } from '../plugins/stereo/src/cli/commands/task.ts';
import {
  settleJob,
  stopJobProcesses,
  stopJobsProcesses,
} from '../plugins/stereo/src/jobs/job-lifecycle.ts';
import {
  createJobProgressUpdater,
  runTrackedJob,
} from '../plugins/stereo/src/jobs/tracked-jobs.ts';
import { PROCESS_MARKERS } from '../plugins/stereo/src/platform/process.ts';
import type { ProcessIdentity } from '../plugins/stereo/src/platform/process.ts';
import {
  readJobFile,
  readStoredJobOrNull,
  resolveDurableStateDir,
  resolveJobFile,
} from '../plugins/stereo/src/workspace/state.ts';
import { captureStdout, indexed, makeTempDir, processOps, seedJob } from './helpers.ts';

// Nothing here starts a broker or a process: every pid is synthetic and every
// probe a fake, so the file runs on the Windows lane.

const DEAD_PID = 2147483600;

const noCancelProcesses: CancelDeps = {
  interruptAppServerTurn: async () => {
    throw new Error('a finished job is not interrupted');
  },
  ops: processOps({
    terminate: () => {
      throw new Error('a finished job is not signalled');
    },
    processHasExited: () => false,
  }),
};

// What each synthetic pid runs: a command line carrying the marker of the
// process it stands for, read with no start.
function runs(table: Record<number, string>): (pid: number) => ProcessIdentity | null {
  return (pid) =>
    table[pid] ? { commandLine: `node /plugin/${table[pid]} run`, start: null } : null;
}

// Cancel of a job that settled meanwhile.

test('cancel of a job whose record already settled writes nothing and reports alreadyFinished', async () => {
  const workspace = makeTempDir();
  const id = 'task-finished-meanwhile';
  const completed = {
    id,
    status: 'completed',
    phase: 'done',
    title: 'Codex Task',
    jobClass: 'task',
    pid: null,
    completedAt: '2026-09-25T08:05:00.000Z',
    result: { rawOutput: 'done' },
  };
  // The index row is stale: the run finished but its row still says running.
  seedJob(workspace, completed, { ...completed, status: 'running', phase: 'running', pid: 4242 });
  const before = fs.readFileSync(resolveJobFile(workspace, id), 'utf8');

  const payload = JSON.parse(
    await captureStdout(() => handleCancel(['--cwd', workspace, '--json', id], noCancelProcesses)),
  );
  assert.equal(payload.jobId, id);
  assert.equal(payload.status, 'completed');
  assert.equal(payload.alreadyFinished, true);
  assert.equal(
    payload.rendered,
    `# Stereo Cancel\n\nJob ${id} already finished (completed); nothing to cancel.\n`,
  );
  assert.equal(fs.readFileSync(resolveJobFile(workspace, id), 'utf8'), before, 'file untouched');
  // The stale row is brought in line with the settled file, never cancelled.
  assert.equal(indexed(workspace, id)?.status, 'completed');
  assert.equal(indexed(workspace, id)?.pid, null);

  // The synced row is no longer active, so a second cancel finds nothing to cancel.
  await assert.rejects(
    handleCancel(['--cwd', workspace, id], noCancelProcesses),
    new RegExp(`No active job found for "${id}"`),
  );
});

test('a cancel that settles the job reports alreadyFinished false', async () => {
  const workspace = makeTempDir();
  const id = 'task-cancel-now';
  seedJob(workspace, { id, status: 'running', title: 'Codex Task', pid: DEAD_PID });
  const payload = JSON.parse(
    await captureStdout(() =>
      handleCancel(['--cwd', workspace, '--json', id], {
        interruptAppServerTurn: async () => ({
          attempted: false,
          interrupted: false,
          transport: null,
          detail: '',
        }),
        ops: processOps({ terminate: () => {} }),
      }),
    ),
  );
  assert.equal(payload.status, 'cancelled');
  assert.equal(payload.alreadyFinished, false);
  assert.equal(readJobFile(resolveJobFile(workspace, id)).errorMessage, 'Cancelled by user.');
});

test('bare cancel resolves only a queued or running job, whatever a finished record carries', async () => {
  const workspace = makeTempDir();
  // A finished record an earlier build left with its pids.
  seedJob(workspace, {
    id: 'task-finished-left',
    status: 'cancelled',
    phase: 'cancelled',
    title: 'Claude Task',
    pid: 2147483021,
    claudePid: 2147483022,
    updatedAt: '2026-09-25T08:10:00.000Z',
  });
  seedJob(workspace, {
    id: 'task-running',
    status: 'running',
    title: 'Codex Task',
    pid: DEAD_PID,
    updatedAt: '2026-09-25T08:00:00.000Z',
  });
  const signalled: number[] = [];
  const deps: CancelDeps = {
    interruptAppServerTurn: async () => ({
      attempted: false,
      interrupted: false,
      transport: null,
      detail: '',
    }),
    ops: processOps({
      processHasExited: (pid) => pid === DEAD_PID,
      terminate: (pid) => {
        signalled.push(pid);
      },
    }),
  };

  const payload = JSON.parse(
    await captureStdout(() => handleCancel(['--cwd', workspace, '--json'], deps)),
  );
  assert.equal(payload.jobId, 'task-running', 'the one active job, not "multiple"');
  assert.equal(payload.alreadyFinished, false);
  // A finished job is not cancelable, and nothing of its record is signalled.
  await assert.rejects(
    handleCancel(['--cwd', workspace, 'task-finished-left'], deps),
    /No active job found for "task-finished-left"/,
  );
  assert.deepEqual(signalled, []);
});

// settleJob, the one terminal writer.

test('settleJob writes both records terminal and clears the worker and Claude pids', () => {
  const workspace = makeTempDir();
  const id = 'task-settle';
  seedJob(workspace, {
    id,
    status: 'running',
    title: 'Claude Task',
    pid: 4242,
    claudePid: 4343,
    threadId: 'sess-1',
    request: { prompt: 'x' },
  });

  const outcome = settleJob(workspace, id, {
    terminal: { status: 'failed', phase: 'failed', errorMessage: 'boom' },
    record: { result: { rawOutput: 'partial' } },
    index: { summary: 'short' },
  });
  assert.equal(outcome.settled, true);
  assert.equal(outcome.status, 'failed');

  const stored = readJobFile(resolveJobFile(workspace, id));
  assert.equal(stored.status, 'failed');
  assert.equal(stored.pid, null);
  assert.equal(stored.claudePid, null);
  assert.equal(stored.threadId, 'sess-1', 'the rest of the record survives');
  assert.deepEqual(stored.request, { prompt: 'x' });
  assert.deepEqual(stored.result, { rawOutput: 'partial' });
  assert.equal(typeof stored.completedAt, 'string');
  const row = indexed(workspace, id);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.pid, null);
  assert.equal(row?.claudePid, null);
  assert.equal(row?.summary, 'short');
  assert.equal(row?.completedAt, stored.completedAt);
  assert.equal('result' in (row ?? {}), false, 'the result stays in the job file');

  // Settled once: a second writer changes nothing.
  const again = settleJob(workspace, id, {
    terminal: { status: 'cancelled', phase: 'cancelled', errorMessage: 'late' },
  });
  assert.deepEqual(
    { settled: again.settled, status: again.status },
    { settled: false, status: 'failed' },
  );
  assert.equal(readJobFile(resolveJobFile(workspace, id)).errorMessage, 'boom');
  assert.equal(indexed(workspace, id)?.errorMessage, 'boom');
});

test('settleJob keeps an already terminal index row and brings the job file in line', () => {
  const workspace = makeTempDir();
  const id = 'task-row-terminal';
  const running = { id, status: 'running', pid: 4242, claudePid: 4343 };
  seedJob(workspace, running, {
    ...running,
    status: 'cancelled',
    phase: 'cancelled',
    errorMessage: 'Cancelled by user.',
    pid: null,
    claudePid: null,
  });
  const outcome = settleJob(workspace, id, { terminal: { status: 'failed', phase: 'failed' } });
  assert.equal(outcome.settled, false);
  assert.equal(outcome.status, 'cancelled');
  assert.equal(indexed(workspace, id)?.status, 'cancelled', 'the row keeps its outcome');
  const stored = readJobFile(resolveJobFile(workspace, id));
  assert.equal(stored.status, 'cancelled', 'the job file follows the terminal row');
  assert.equal(stored.phase, 'cancelled');
  assert.equal(stored.errorMessage, 'Cancelled by user.');
  assert.equal(stored.pid, null);
  assert.equal(stored.claudePid, null);
});

test('settleJob reports the processes it took off the record, start tokens included', () => {
  const workspace = makeTempDir();
  const id = 'task-settle-processes';
  seedJob(workspace, { id, status: 'running', pid: 4242, pidStart: 'wall:1000', claudePid: 4343 });
  const settled = settleJob(workspace, id, {
    terminal: { status: 'cancelled', phase: 'cancelled' },
  });
  assert.deepEqual(settled.processes, {
    pid: 4242,
    pidStart: 'wall:1000',
    claudePid: 4343,
    claudePidStart: null,
  });
  for (const record of [indexed(workspace, id), readJobFile(resolveJobFile(workspace, id))]) {
    assert.equal(record?.pid, null);
    assert.equal(record?.pidStart, undefined, 'no start token without its pid');
    assert.equal(record?.claudePid, null);
  }

  // A later settle takes nothing off: there is nothing left to stop.
  const again = settleJob(workspace, id, { terminal: { status: 'failed', phase: 'failed' } });
  assert.equal(again.settled, false);
  assert.equal(again.processes.pid, null);
  assert.equal(again.processes.claudePid, null);
});

test('a job file that cannot be written still yields the processes settled under the lock', (t) => {
  const workspace = makeTempDir();
  const id = 'task-settle-write-fails';
  // The worker recorded itself after the caller's snapshot (an index row with no pid).
  seedJob(
    workspace,
    { id, status: 'running', pid: 4242, pidStart: 'wall:1000', claudePid: 4343 },
    { id, status: 'running' },
  );
  const jobFile = resolveJobFile(workspace, id);
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === jobFile) {
      throw Object.assign(new Error('ENOSPC: injected failure'), { code: 'ENOSPC' });
    }
    return originalRename(from, to);
  }) as typeof fs.renameSync);

  const settled = settleJob(workspace, id, {
    terminal: { status: 'cancelled', phase: 'cancelled' },
  });
  t.mock.restoreAll();

  // Returned, not thrown: the caller stops these, then surfaces the error.
  assert.equal(settled.settled, true);
  assert.equal(settled.processes.pid, 4242);
  assert.equal(settled.processes.pidStart, 'wall:1000');
  assert.equal(settled.processes.claudePid, 4343);
  assert.match(String((settled.writeError as Error | undefined)?.message), /ENOSPC/);
  assert.equal(indexed(workspace, id)?.status, 'cancelled');
});

test('a stop of many jobs shares its waits: the time spent does not grow with the jobs', () => {
  const jobs = Array.from({ length: 6 }, (_, index) => ({
    pid: 2147483060 + index * 2,
    claudePid: 2147483061 + index * 2,
  }));
  const signals: Array<[number, string]> = [];
  const startedAt = Date.now();
  const stops = stopJobsProcesses(jobs, {
    ops: processOps({
      terminate: (pid, options) => {
        signals.push([pid, options?.signal ?? 'SIGTERM']);
      },
      // Every process ignores every signal.
      processHasExited: () => false,
      readProcessIdentity: () => ({
        commandLine: 'node codex-companion.ts claude -p --permission-prompts none',
        start: null,
      }),
      platform: 'linux',
    }),
    graceMs: 200,
    killWaitMs: 200,
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1200, `one grace and one kill wait for all twelve processes (${elapsed} ms)`);
  assert.equal(stops.length, 6);
  for (const stop of stops) {
    assert.deepEqual(stop, {
      worker: 'unconfirmed',
      workerError: 'still running after the hard signal',
      claude: 'unconfirmed',
      claudeError: 'still running after the hard signal',
    });
  }
  assert.equal(signals.filter(([, signal]) => signal === 'SIGTERM').length, 12);
  assert.equal(signals.filter(([, signal]) => signal === 'SIGKILL').length, 12);
  // Every polite signal goes out before any hard one.
  const firstKill = signals.findIndex(([, signal]) => signal === 'SIGKILL');
  assert.equal(firstKill, 12);
});

test('a job settled before its run starts is not run and keeps its record', async () => {
  const workspace = makeTempDir();
  const id = 'task-settled-at-start';
  const job = { id, status: 'queued', workspaceRoot: workspace };
  seedJob(workspace, { ...job, status: 'cancelled', phase: 'cancelled' }, job);
  let ran = false;
  const execution = await runTrackedJob(job, async () => {
    ran = true;
    return { exitStatus: 0, payload: {} };
  });
  assert.equal(ran, false, 'the runner never starts');
  assert.equal(execution.exitStatus, 1);
  assert.match(execution.errorMessage ?? '', /already cancelled before it started; nothing ran/);
  const stored = readJobFile(resolveJobFile(workspace, id));
  assert.equal(stored.status, 'cancelled', 'no running write over the settled job file');
  assert.equal(stored.pid, undefined);

  // Only the index row settled: the job file is not rewritten as running either.
  const second = { ...job, id: 'task-row-settled-at-start' };
  seedJob(workspace, second, { ...second, status: 'failed', phase: 'failed' });
  const skipped = await runTrackedJob(second, async () => {
    throw new Error('a settled job must not run');
  });
  assert.equal(skipped.exitStatus, 1);
  assert.equal(readJobFile(resolveJobFile(workspace, second.id)).status, 'queued');
  assert.equal(indexed(workspace, second.id)?.status, 'failed');
});

test('late progress on a settled job writes nothing, a Claude child included', () => {
  const workspace = makeTempDir();
  const id = 'task-file-settled';
  seedJob(workspace, { id, status: 'cancelled', phase: 'cancelled' }, { id, status: 'running' });
  const before = fs.readFileSync(resolveJobFile(workspace, id), 'utf8');
  createJobProgressUpdater(workspace, id)({ message: 'late', phase: 'editing', childPid: 4646 });
  createJobProgressUpdater(workspace, id)({ message: 'later', phase: 'done' });
  assert.equal(fs.readFileSync(resolveJobFile(workspace, id), 'utf8'), before);
  const row = indexed(workspace, id);
  assert.equal(row?.phase, undefined, 'no late phase on the row either');
  assert.equal(row?.claudePid, undefined);
});

test('settleJob with skipUnknown brings back no job that was swept away', () => {
  const workspace = makeTempDir();
  const outcome = settleJob(workspace, 'task-swept', {
    terminal: { status: 'cancelled', phase: 'cancelled' },
    skipUnknown: true,
  });
  assert.equal(outcome.settled, false);
  assert.equal(fs.existsSync(resolveJobFile(workspace, 'task-swept')), false);
  assert.equal(indexed(workspace, 'task-swept'), undefined);

  // Without it, an unreadable record still gets a minimal terminal one.
  fs.writeFileSync(resolveJobFile(workspace, 'task-torn'), '{', 'utf8');
  const torn = settleJob(workspace, 'task-torn', {
    terminal: { status: 'failed', phase: 'failed', errorMessage: 'bootstrap' },
    skipUnknown: true,
  });
  assert.equal(torn.settled, true);
  assert.equal(readJobFile(resolveJobFile(workspace, 'task-torn')).status, 'failed');
  assert.equal(indexed(workspace, 'task-torn')?.status, 'failed');
});

test('a successful run clears the Claude pid its progress left in the index', async () => {
  const workspace = makeTempDir();
  const id = 'task-claude-run';
  const job = { id, status: 'queued', workspaceRoot: workspace, runtime: 'claude' as const };
  seedJob(workspace, job);
  const progress = createJobProgressUpdater(workspace, id);

  await runTrackedJob(job, async () => {
    progress({ message: 'spawned', childPid: 4343, phase: 'running' });
    assert.equal(indexed(workspace, id)?.claudePid, 4343);
    return { exitStatus: 0, threadId: 'sess-run', payload: { rawOutput: 'ok' }, rendered: 'ok' };
  });
  const row = indexed(workspace, id);
  assert.equal(row?.status, 'completed');
  assert.equal(row?.claudePid, null);
  assert.equal(row?.pid, null);
  assert.equal(readJobFile(resolveJobFile(workspace, id)).claudePid, null);
});

test('a run that finishes after a cancel keeps the cancelled record, and late progress adds nothing', async () => {
  const workspace = makeTempDir();
  const id = 'task-cancelled-mid-run';
  const job = { id, status: 'queued', workspaceRoot: workspace };
  seedJob(workspace, job);
  const progress = createJobProgressUpdater(workspace, id);

  await runTrackedJob(job, async () => {
    settleJob(workspace, id, {
      terminal: { status: 'cancelled', phase: 'cancelled', errorMessage: 'Cancelled by user.' },
    });
    progress({ message: 'late', phase: 'investigating', childPid: 4444, childStart: 'wall:1234' });
    return { exitStatus: 0, threadId: 'thr-late', payload: { rawOutput: 'late' } };
  });
  const row = indexed(workspace, id);
  assert.equal(row?.status, 'cancelled');
  assert.equal(row?.phase, 'cancelled');
  assert.equal(row?.claudePid, null, "the late child is the worker's to stop");
  assert.equal(row?.claudePidStart, undefined);
  assert.equal(row?.pid, null);
  const stored = readJobFile(resolveJobFile(workspace, id));
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.phase, 'cancelled');
  assert.equal(stored.errorMessage, 'Cancelled by user.');
  assert.equal(stored.result, undefined, 'the late result does not replace the cancel');
  assert.equal(stored.claudePid, null);
});

// stopJobProcesses: escalation and confirmation. Which pids it signals at
// all (only ours) is identity-sites.test.ts's.

// Identities stood in by pid: what each synthetic pid runs and when it
// started. A pid missing from the table cannot be read.
function identities(
  table: Record<number, { marker: string; start: string }>,
): (pid: number) => ProcessIdentity | null {
  return (pid) => {
    const entry = table[pid];
    return entry ? { commandLine: `node /plugin/${entry.marker} run`, start: entry.start } : null;
  };
}

const RECORDED_START = `wall:${Date.parse('2026-09-25T08:00:00.000Z')}`;

test('stopJobProcesses counts a process stopped only once it is confirmed gone', () => {
  const signals: Array<[number, string]> = [];
  const terminate = (pid: number, options?: { signal?: NodeJS.Signals }): void => {
    signals.push([pid, options?.signal ?? 'SIGTERM']);
  };
  const readProcessIdentity = identities({
    301: { marker: 'codex-companion.ts', start: RECORDED_START },
    302: { marker: PROCESS_MARKERS.claude, start: RECORDED_START },
  });
  const recorded = {
    pid: 301,
    pidStart: RECORDED_START,
    claudePid: 302,
    claudePidStart: RECORDED_START,
  };

  // A delivered polite signal is not a stop: still running (and still ours)
  // after the grace, each gets the hard one, and survives it: kept.
  const stubborn = stopJobProcesses(recorded, {
    ops: processOps({
      terminate,
      processHasExited: () => false,
      readProcessIdentity,
      platform: 'linux',
    }),
    graceMs: 0,
    killWaitMs: 0,
  });
  assert.deepEqual(stubborn, {
    worker: 'unconfirmed',
    workerError: 'still running after the hard signal',
    claude: 'unconfirmed',
    claudeError: 'still running after the hard signal',
  });
  assert.deepEqual(signals, [
    [301, 'SIGTERM'],
    [302, 'SIGTERM'],
    [301, 'SIGKILL'],
    [302, 'SIGKILL'],
  ]);

  // The hard signal ends them: stopped.
  signals.length = 0;
  const hard = stopJobProcesses(recorded, {
    ops: processOps({
      terminate,
      processHasExited: (pid) =>
        signals.some(([target, signal]) => target === pid && signal === 'SIGKILL'),
      readProcessIdentity,
      platform: 'linux',
    }),
    graceMs: 0,
  });
  assert.deepEqual([hard.worker, hard.claude], ['stopped', 'stopped']);

  // Windows' tree kill is forceful already: no hard signal, and a survivor is kept.
  signals.length = 0;
  const windows = stopJobProcesses(recorded, {
    ops: processOps({
      terminate,
      processHasExited: () => false,
      readProcessIdentity,
      platform: 'win32',
    }),
    graceMs: 0,
  });
  assert.deepEqual(
    [windows.worker, windows.workerError],
    ['unconfirmed', 'still running after the tree kill'],
  );
  assert.deepEqual(
    signals.map(([, signal]) => signal),
    ['SIGTERM', 'SIGTERM'],
  );
});

test('a cancel that cannot confirm a process gone names each pid for the user to end', async () => {
  const workspace = makeTempDir();
  const id = 'task-kill-unconfirmed';
  const workerPid = 2147483032;
  const claudePid = 2147483033;
  seedJob(workspace, { id, status: 'running', title: 'Claude Task', pid: workerPid, claudePid });
  const statusAtSignal: string[] = [];
  const deps: CancelDeps = {
    interruptAppServerTurn: async () => ({
      attempted: false,
      interrupted: false,
      transport: null,
      detail: '',
    }),
    ops: processOps({
      terminate: () => {
        statusAtSignal.push(readJobFile(resolveJobFile(workspace, id)).status);
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
      processHasExited: () => false,
      // The worker is ours; the Claude child's identity cannot be read.
      readProcessIdentity: runs({ [workerPid]: 'codex-companion.ts' }),
    }),
  };
  const payload = JSON.parse(
    await captureStdout(() => handleCancel(['--cwd', workspace, '--json', id], deps)),
  );
  assert.deepEqual(statusAtSignal, ['cancelled'], 'settled before the signal');
  const warning = `Could not confirm worker pid ${workerPid} (the signal failed: operation not permitted) and Claude pid ${claudePid} (not signalled: its identity could not be verified) stopped; end them yourself if they are still running (for example \`kill ${workerPid} ${claudePid}\`, or Task Manager on Windows).`;
  assert.equal(payload.killWarning, warning);
  assert.ok(payload.rendered.includes(`- Warning: ${warning}\n`));
  // Nothing is kept for a later stop: the record settled without pids.
  for (const record of [indexed(workspace, id), readJobFile(resolveJobFile(workspace, id))]) {
    assert.equal(record?.status, 'cancelled');
    assert.equal(record?.pid, null);
    assert.equal(record?.claudePid, null);
  }
});

// The task worker and a job settled while queued.

test('a queued job settled before its worker starts is not run', async () => {
  const workspace = makeTempDir();
  const logFile = path.join(resolveDurableStateDir(workspace), 'jobs', 'task-settled-early.log');
  const never = async (): Promise<never> => {
    throw new Error('a settled job must not run');
  };
  const deps: TaskWorkerDeps = {
    runTrackedJob,
    executeTaskRun: never,
    executePlanReviewRun: never,
    executeReviewRun: never,
  };
  const queued = {
    id: 'task-settled-early',
    status: 'queued',
    workspaceRoot: workspace,
    logFile,
    request: { cwd: workspace, prompt: 'never run' },
  };
  seedJob(workspace, { ...queued, status: 'cancelled' }, queued);
  fs.writeFileSync(logFile, '', 'utf8');
  // The worker's running write refuses the settled job under the index lock.
  await handleTaskWorker(['--cwd', workspace, '--job-id', queued.id], deps);
  assert.match(
    fs.readFileSync(logFile, 'utf8'),
    /Job task-settled-early was already cancelled before it started; nothing ran\./,
  );
  assert.equal(readStoredJobOrNull(workspace, queued.id)?.status, 'cancelled');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { makeTempDir, seedState } from './helpers.ts';
import {
  createJobProgressUpdater,
  createJobRecord,
  normalizeProgressEvent,
  runTrackedJob,
} from '../plugins/stereo/src/jobs/tracked-jobs.ts';
import { settleJob } from '../plugins/stereo/src/jobs/job-lifecycle.ts';
import { currentProcessStartToken } from '../plugins/stereo/src/platform/process.ts';
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveStateFile,
  updateState,
  writeJobFile,
} from '../plugins/stereo/src/workspace/state.ts';
import type { TestContext } from 'node:test';

const IS_WINDOWS = process.platform === 'win32';

function makeWorkspace() {
  const workspace = makeTempDir();
  seedState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] });
  return workspace;
}

function baseJob(workspace: string, id: string) {
  return createJobRecord(
    {
      id,
      workspaceRoot: workspace,
      title: `Job ${id}`,
      jobClass: 'task',
      status: 'queued',
    },
    { env: {} },
  );
}

test('runTrackedJob persists completed state for a successful runner', async () => {
  const workspace = makeWorkspace();
  const execution = await runTrackedJob(baseJob(workspace, 'job-ok'), async () => ({
    exitStatus: 0,
    threadId: 'thread-1',
    turnId: 'turn-1',
    payload: { done: true },
    rendered: '# Done\n',
    summary: 'All good.',
    tokenUsage: {
      job: {
        totalTokens: 350,
        inputTokens: 280,
        cachedInputTokens: 120,
        cacheWriteInputTokens: 15,
        outputTokens: 70,
        reasoningOutputTokens: 15,
      },
      thread: {
        totalTokens: 700,
        inputTokens: 560,
        cachedInputTokens: 240,
        cacheWriteInputTokens: 30,
        outputTokens: 140,
        reasoningOutputTokens: 30,
      },
      modelContextWindow: 258000,
    },
  }));

  assert.equal(execution.exitStatus, 0);
  const stored = readJobFile(resolveJobFile(workspace, 'job-ok'));
  assert.equal(stored.status, 'completed');
  assert.equal(stored.phase, 'done');
  assert.equal(stored.pid, null);
  assert.equal(stored.threadId, 'thread-1');
  assert.deepEqual(stored.result, { done: true });
  assert.equal(stored.tokenUsage?.job.totalTokens, 350);
  assert.equal(stored.tokenUsage?.thread.totalTokens, 700);

  const indexed = listJobs(workspace).find((job) => job.id === 'job-ok');
  assert.ok(indexed);
  assert.equal(indexed.status, 'completed');
  assert.equal(indexed.summary, 'All good.');
  assert.equal(indexed.pid, null);
  assert.deepEqual(indexed.tokenUsage, stored.tokenUsage);
});

test('runTrackedJob persists failed state for a nonzero exit status', async () => {
  const workspace = makeWorkspace();
  await runTrackedJob(baseJob(workspace, 'job-exit2'), async () => ({
    exitStatus: 2,
    threadId: null,
    turnId: null,
    payload: { error: 'boom' },
    rendered: 'failed',
    summary: 'Codex exited 2.',
  }));

  const stored = readJobFile(resolveJobFile(workspace, 'job-exit2'));
  assert.equal(stored.status, 'failed');
  assert.equal(stored.phase, 'failed');
  assert.equal(stored.pid, null);
});

test('runTrackedJob records a thrown runner error and rethrows it', async () => {
  const workspace = makeWorkspace();
  await assert.rejects(
    runTrackedJob(baseJob(workspace, 'job-throws'), async () => {
      throw new Error('runner exploded');
    }),
    /runner exploded/,
  );

  const stored = readJobFile(resolveJobFile(workspace, 'job-throws'));
  assert.equal(stored.status, 'failed');
  assert.equal(stored.errorMessage, 'runner exploded');
  assert.equal(stored.pid, null);

  const indexed = listJobs(workspace).find((job) => job.id === 'job-throws');
  assert.ok(indexed);
  assert.equal(indexed.status, 'failed');
  assert.equal(indexed.errorMessage, 'runner exploded');
});

test('a corrupt per-job file does not mask the runner failure or strand the job', async () => {
  const workspace = makeWorkspace();
  const jobFile = resolveJobFile(workspace, 'job-corrupt-on-failure');

  await assert.rejects(
    runTrackedJob(baseJob(workspace, 'job-corrupt-on-failure'), async () => {
      fs.writeFileSync(jobFile, '{', 'utf8');
      throw new Error('original runner failure');
    }),
    /original runner failure/,
  );

  const stored = readJobFile(jobFile);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.phase, 'failed');
  assert.equal(stored.pid, null);
  assert.equal(stored.errorMessage, 'original runner failure');
  assert.equal(
    listJobs(workspace).find((job) => job.id === 'job-corrupt-on-failure')?.status,
    'failed',
  );
});

test(
  'a terminal-persistence failure degrades the record instead of the outcome',
  { skip: IS_WINDOWS || process.getuid?.() === 0 },
  async () => {
    const workspace = makeWorkspace();
    const job = baseJob(workspace, 'job-degraded');

    // Atomic replacement creates and renames a temporary file beside the
    // destination, so remove directory write permission to make the terminal
    // writeJobFile fail and exercise the fallback.
    const jobFile = resolveJobFile(workspace, 'job-degraded');
    const jobsDir = path.dirname(jobFile);
    const jobsDirMode = fs.statSync(jobsDir).mode & 0o777;

    const execution = await runTrackedJob(job, async () => {
      fs.chmodSync(jobsDir, 0o500);
      return {
        exitStatus: 0,
        threadId: null,
        turnId: null,
        payload: { done: true },
        rendered: '# Done\n',
        summary: 'Succeeded despite bookkeeping trouble.',
      };
    }).finally(() => {
      fs.chmodSync(jobsDir, jobsDirMode);
    });

    // The successful outcome survives the bookkeeping failure...
    assert.equal(execution.exitStatus, 0);
    // ...the per-job file still shows the pre-terminal state (the terminal
    // write really failed)...
    assert.equal(readJobFile(jobFile).status, 'running');
    // ...and the index reached terminal state via the minimal fallback
    // upsert, so the job can never linger as running/stalled.
    const indexed = listJobs(workspace).find((entry) => entry.id === 'job-degraded');
    assert.ok(indexed);
    assert.equal(indexed.status, 'completed');
    assert.equal(indexed.pid, null);
  },
);

test('normalizeProgressEvent handles strings and structured events', () => {
  assert.deepEqual(normalizeProgressEvent('plain message'), {
    message: 'plain message',
    phase: null,
    threadId: null,
    turnId: null,
    childPid: null,
    childStart: null,
    stderrMessage: 'plain message',
    logTitle: null,
    logBody: null,
  });

  assert.deepEqual(
    normalizeProgressEvent({
      message: '  starting turn  ',
      phase: ' investigating ',
      threadId: 'thread-9',
      turnId: '',
      childPid: null,
      stderrMessage: null,
      logTitle: 'Reasoning summary',
      logBody: 'details\n',
    }),
    {
      message: 'starting turn',
      phase: 'investigating',
      threadId: 'thread-9',
      turnId: null,
      childPid: null,
      childStart: null,
      stderrMessage: null,
      logTitle: 'Reasoning summary',
      logBody: 'details',
    },
  );

  assert.equal(normalizeProgressEvent(null).message, '');
  assert.equal(normalizeProgressEvent(undefined).stderrMessage, '');
});

// Makes the next `times` state-index reads throw a transient I/O error (one
// read's retries take five).
function refuseStateReads(
  t: TestContext,
  workspace: string,
  times = Number.POSITIVE_INFINITY,
): { reads: () => number } {
  const stateFile = resolveStateFile(workspace);
  const original = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', ((file: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(file) === stateFile) {
      reads += 1;
      if (reads <= times) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${stateFile}'`), {
          code: 'EBUSY',
        });
      }
    }
    return original(file, options as Parameters<typeof fs.readFileSync>[1]);
  }) as typeof fs.readFileSync);
  return { reads: () => reads };
}

test('a progress write the index refuses is logged, never thrown into the run', (t) => {
  const workspace = makeWorkspace();
  const job = { ...baseJob(workspace, 'job-progress'), status: 'running' };
  writeJobFile(workspace, job.id, job);
  const logFile = path.join(makeTempDir(), 'job-progress.log');
  const progress = createJobProgressUpdater(workspace, job.id, logFile);

  // The runner's child pid and start land on the record.
  progress({ message: 'spawned', childPid: 4343, childStart: 'wall:1700000000000' });
  const row = listJobs(workspace).find((entry) => entry.id === job.id);
  assert.equal(row?.claudePid, 4343);
  assert.equal(row?.claudePidStart, 'wall:1700000000000');

  // An antivirus scan holding the index: the event is lost, the run is not.
  refuseStateReads(t, workspace);
  assert.doesNotThrow(() => progress({ message: 'editing', phase: 'editing' }));
  t.mock.restoreAll();
  assert.match(fs.readFileSync(logFile, 'utf8'), /Could not record progress on job job-progress: /);
});

test('a progress write that fails is retried by the next event, the one-time Claude pid included', (t) => {
  const workspace = makeWorkspace();
  const job = { ...baseJob(workspace, 'job-progress-retry'), status: 'running' };
  writeJobFile(workspace, job.id, job);
  const progress = createJobProgressUpdater(workspace, job.id);

  // The spawn's one event cannot land (an antivirus scan holding the index).
  refuseStateReads(t, workspace);
  progress({ message: 'spawned', phase: 'starting', childPid: 4343, childStart: 'wall:1700' });
  t.mock.restoreAll();
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).claudePid, undefined);

  // The next event carries neither the pid nor a new phase, yet writes both.
  progress({ message: 'still starting', phase: 'starting' });
  const row = listJobs(workspace).find((entry) => entry.id === job.id);
  assert.equal(row?.claudePid, 4343);
  assert.equal(row?.claudePidStart, 'wall:1700');
  assert.equal(row?.phase, 'starting');
  const stored = readJobFile(resolveJobFile(workspace, job.id));
  assert.equal(stored.claudePid, 4343);
  assert.equal(stored.claudePidStart, 'wall:1700');
});

test('a run whose job was swept away meanwhile does not bring it back; a lost row alone is rebuilt', async () => {
  const workspace = makeWorkspace();
  const swept = baseJob(workspace, 'job-swept');
  const execution = await runTrackedJob(swept, async () => {
    // A session end settles the job cancelled and removes its row, which
    // deletes its file, while this worker still runs.
    settleJob(workspace, swept.id, { terminal: { status: 'cancelled', phase: 'cancelled' } });
    updateState(workspace, (state) => {
      state.jobs = state.jobs.filter((entry) => entry.id !== swept.id);
    });
    assert.equal(fs.existsSync(resolveJobFile(workspace, swept.id)), false);
    return { exitStatus: 0, payload: { rawOutput: 'late' } };
  });
  assert.equal(execution.exitStatus, 0, 'the run keeps its own outcome');
  assert.equal(
    listJobs(workspace).find((entry) => entry.id === swept.id),
    undefined,
  );
  assert.equal(fs.existsSync(resolveJobFile(workspace, swept.id)), false);

  // The index alone lost the row (a corrupt state file moved aside): rebuilt.
  const lost = baseJob(workspace, 'job-lost-index');
  await runTrackedJob(lost, async () => {
    fs.writeFileSync(
      resolveStateFile(workspace),
      `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [] })}\n`,
      'utf8',
    );
    return { exitStatus: 0, payload: { rawOutput: 'done' } };
  });
  assert.equal(listJobs(workspace).find((entry) => entry.id === lost.id)?.status, 'completed');
  assert.equal(readJobFile(resolveJobFile(workspace, lost.id)).status, 'completed');
});

test('progress on a job whose index row was lost rebuilds the row from the job file', () => {
  const workspace = makeWorkspace();
  const job = {
    ...baseJob(workspace, 'job-lost-row'),
    status: 'running',
    kind: 'task',
    request: { prompt: 'secret' },
  };
  // The job file alone: the index never got (or lost) the row.
  writeJobFile(workspace, job.id, job);
  const progress = createJobProgressUpdater(workspace, job.id);

  progress({ message: 'editing', phase: 'editing' });
  const row = listJobs(workspace).find((entry) => entry.id === job.id);
  assert.equal(row?.status, 'running');
  assert.equal(row?.kind, 'task');
  assert.equal(row?.title, 'Job job-lost-row');
  assert.equal(row?.phase, 'editing');
  assert.equal(row?.request, undefined, 'the index carries metadata only');
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).phase, 'editing');
});

test('a terminal write that fails is logged and changes neither the run nor a settled record', async (t) => {
  const workspace = makeWorkspace();
  const job = baseJob(workspace, 'job-cancelled-mid-write');
  const logFile = path.join(makeTempDir(), 'job.log');
  fs.writeFileSync(logFile, '', 'utf8');
  const execution = await runTrackedJob(
    job,
    async () => {
      // The worker records itself with its own start token.
      const row = listJobs(workspace).find((entry) => entry.id === job.id);
      assert.equal(row?.pid, process.pid);
      assert.equal(row?.pidStart, currentProcessStartToken());
      settleJob(workspace, job.id, {
        terminal: { status: 'cancelled', phase: 'cancelled', errorMessage: 'Cancelled by user.' },
      });
      // The completion's settle then fails outright.
      refuseStateReads(t, workspace);
      return { exitStatus: 0, payload: { rawOutput: 'late' } };
    },
    { logFile },
  );
  t.mock.restoreAll();
  assert.equal(execution.exitStatus, 0, 'the run keeps its own outcome');
  assert.match(
    fs.readFileSync(logFile, 'utf8'),
    /Failed to persist terminal state for job job-cancelled-mid-write: /,
  );
  const row = listJobs(workspace).find((entry) => entry.id === job.id);
  assert.equal(row?.status, 'cancelled', 'the cancel stands');
});

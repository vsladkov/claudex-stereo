import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import test from 'node:test';

import { makeTempDir } from './helpers.ts';
import {
  createJobRecord,
  normalizeProgressEvent,
  runTrackedJob,
} from '../plugins/stereo/src/jobs/tracked-jobs.ts';
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  saveState,
} from '../plugins/stereo/src/workspace/state.ts';

const IS_WINDOWS = process.platform === 'win32';

function makeWorkspace() {
  const workspace = makeTempDir();
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] });
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
  }));

  assert.equal(execution.exitStatus, 0);
  const stored = readJobFile(resolveJobFile(workspace, 'job-ok'));
  assert.equal(stored.status, 'completed');
  assert.equal(stored.phase, 'done');
  assert.equal(stored.pid, null);
  assert.equal(stored.threadId, 'thread-1');
  assert.deepEqual(stored.result, { done: true });

  const indexed = listJobs(workspace).find((job) => job.id === 'job-ok');
  assert.ok(indexed);
  assert.equal(indexed.status, 'completed');
  assert.equal(indexed.summary, 'All good.');
  assert.equal(indexed.pid, null);
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

test(
  'a terminal-persistence failure degrades the record instead of the outcome',
  { skip: IS_WINDOWS || process.getuid?.() === 0 },
  async () => {
    const workspace = makeWorkspace();
    const job = baseJob(workspace, 'job-degraded');

    // Make the per-job FILE itself unwritable mid-run: overwriting an
    // existing file needs write permission on the file (a read-only jobs
    // dir would not block it), so this genuinely fails the terminal
    // writeJobFile and exercises the fallback.
    const jobFile = resolveJobFile(workspace, 'job-degraded');

    const execution = await runTrackedJob(job, async () => {
      fs.chmodSync(jobFile, 0o400);
      return {
        exitStatus: 0,
        threadId: null,
        turnId: null,
        payload: { done: true },
        rendered: '# Done\n',
        summary: 'Succeeded despite bookkeeping trouble.',
      };
    }).finally(() => {
      fs.chmodSync(jobFile, 0o600);
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
      stderrMessage: null,
      logTitle: 'Reasoning summary',
      logBody: 'details\n',
    }),
    {
      message: 'starting turn',
      phase: 'investigating',
      threadId: 'thread-9',
      turnId: null,
      stderrMessage: null,
      logTitle: 'Reasoning summary',
      logBody: 'details',
    },
  );

  assert.equal(normalizeProgressEvent(null).message, '');
  assert.equal(normalizeProgressEvent(undefined).stderrMessage, '');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { makeTempDir, run, seedState, useTempCodexHome } from './helpers.ts';
import { SCRIPT } from './runtime-helpers.ts';
import { loadBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import {
  buildBriefJobStatus,
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  buildUsageSnapshot,
  enrichJob,
  filterJobsForCurrentSession,
  formatJobModel,
  getJobTypeLabel,
  jobKindLabel,
  readJobProgressPreview,
  renderBriefJobStatus,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst,
  waitForJobSnapshot,
} from '../plugins/stereo/src/jobs/job-control.ts';
import {
  STOP_GATE_ORIGIN,
  listJobs,
  resolveJobFile,
  updateState,
  writeJobFile,
} from '../plugins/stereo/src/workspace/state.ts';
import { resolveThreadReservationDir } from '../plugins/stereo/src/workspace/thread-lock-io.ts';
import { settleJob } from '../plugins/stereo/src/jobs/job-lifecycle.ts';
import type { JobRecord } from '../plugins/stereo/src/workspace/state.ts';
import {
  assertSameRoleResume,
  buildTaskRunMetadata,
  findLatestResumableTaskJob,
  resumeOwnerRole,
} from '../plugins/stereo/src/workflows/task.ts';
import type { ResumeOwner } from '../plugins/stereo/src/workflows/task.ts';

const DEAD_PID = 2147483647;
const IS_WINDOWS = process.platform === 'win32';

function seedJobs(workspace: string, jobs: JobRecord[]): void {
  seedState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs,
  });
}

function jobAt(id: string, minute: number, patch: Partial<JobRecord> = {}): JobRecord {
  const stamp = `2026-03-18T15:${String(minute).padStart(2, '0')}:00.000Z`;
  return {
    id,
    status: 'completed',
    title: `Job ${id}`,
    sessionId: 'sess-current',
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  };
}

test('sortJobsNewestFirst orders by updatedAt descending', () => {
  const sorted = sortJobsNewestFirst([jobAt('old', 1), jobAt('new', 30), jobAt('mid', 15)]);
  assert.deepEqual(
    sorted.map((job) => job.id),
    ['new', 'mid', 'old'],
  );
});

test('filterJobsForCurrentSession prefers an explicit session id', () => {
  const jobs = [jobAt('a', 1, { sessionId: 'sess-a' }), jobAt('b', 2, { sessionId: 'sess-b' })];
  assert.deepEqual(
    filterJobsForCurrentSession(jobs, { sessionId: 'sess-b' }).map((job) => job.id),
    ['b'],
  );
  assert.equal(filterJobsForCurrentSession(jobs, {}).length >= 1, true);
});

test('buildUsageSnapshot groups job usage, backfills files, and never sums thread usage', (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  const usage = (input: number, cached: number, output: number, reasoning: number) => ({
    job: {
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
      reasoningOutputTokens: reasoning,
      totalTokens: input + output,
      cacheWriteInputTokens: 0,
    },
    thread: {
      inputTokens: 900_000,
      cachedInputTokens: 800_000,
      outputTokens: 100_000,
      reasoningOutputTokens: 50_000,
      totalTokens: 1_000_000,
      cacheWriteInputTokens: 0,
    },
    modelContextWindow: 258_000,
  });
  const indexed = [
    jobAt('review-sol', 3, {
      kind: 'review',
      jobClass: 'review',
      model: 'gpt-5.6-sol',
      tokenUsage: usage(100, 40, 25, 5),
    }),
    jobAt('task-missing-usage', 2, {
      kind: 'task',
      jobClass: 'task',
      model: null,
    }),
    jobAt('task-backfilled', 1, {
      kind: 'task',
      jobClass: 'task',
      model: null,
    }),
    jobAt('other-session', 4, {
      sessionId: 'sess-other',
      kind: 'review',
      jobClass: 'review',
      model: 'gpt-5.6-terra',
      tokenUsage: usage(500, 100, 50, 10),
    }),
  ];
  seedJobs(workspace, indexed);
  writeJobFile(workspace, 'task-backfilled', {
    ...indexed[2],
    request: { model: 'kimi-k3' },
    tokenUsage: usage(60, 20, 15, 3),
  });

  const scoped = buildUsageSnapshot(workspace, { sessionId: 'sess-current' });
  assert.equal(scoped.scope, 'session');
  assert.equal(scoped.sessionId, 'sess-current');
  assert.deepEqual(scoped.window, {
    retainedJobs: 4,
    countedJobs: 3,
    maxRetainedJobs: 50,
  });
  assert.deepEqual(scoped.totals, {
    jobs: 3,
    jobsWithUsage: 2,
    inputTokens: 160,
    cachedInputTokens: 60,
    outputTokens: 40,
    reasoningOutputTokens: 8,
    totalTokens: 200,
  });
  assert.deepEqual(scoped.byKind, [
    {
      key: 'review',
      jobs: 1,
      jobsWithUsage: 1,
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 25,
      reasoningOutputTokens: 5,
      totalTokens: 125,
    },
    {
      key: 'rescue',
      jobs: 2,
      jobsWithUsage: 1,
      inputTokens: 60,
      cachedInputTokens: 20,
      outputTokens: 15,
      reasoningOutputTokens: 3,
      totalTokens: 75,
    },
  ]);
  assert.deepEqual(
    scoped.byModel.map((group) => [group.key, group.jobs, group.totalTokens]),
    [
      ['gpt-5.6-sol', 1, 125],
      ['kimi-k3@moonshot', 1, 75],
      ['-', 1, 0],
    ],
  );

  const all = buildUsageSnapshot(workspace, { sessionId: 'sess-current', all: true });
  assert.equal(all.scope, 'workspace');
  assert.equal(all.window.countedJobs, 4);
  assert.equal(all.totals.totalTokens, 750);
  assert.equal(all.totals.jobsWithUsage, 3);
});

test('buildUsageSnapshot returns an empty workspace window', (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  const snapshot = buildUsageSnapshot(workspace, { env: {} });

  assert.equal(snapshot.scope, 'workspace');
  assert.equal(snapshot.sessionId, null);
  assert.deepEqual(snapshot.window, {
    retainedJobs: 0,
    countedJobs: 0,
    maxRetainedJobs: 50,
  });
  assert.deepEqual(snapshot.totals, {
    jobs: 0,
    jobsWithUsage: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  });
  assert.deepEqual(snapshot.byKind, []);
  assert.deepEqual(snapshot.byModel, []);
});

test('job-control entry points honor an explicit workspace root', (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  const unrelatedCwd = makeTempDir();
  seedJobs(workspace, [
    jobAt('task-finished', 5),
    jobAt('task-running', 10, { status: 'running', pid: process.pid }),
  ]);

  const usage = buildUsageSnapshot(unrelatedCwd, { workspaceRoot: workspace, env: {} });
  assert.equal(usage.workspaceRoot, workspace);
  assert.equal(usage.window.countedJobs, 2);

  const status = buildStatusSnapshot(unrelatedCwd, { workspaceRoot: workspace, env: {} });
  assert.equal(status.workspaceRoot, workspace);
  assert.equal(status.running[0]?.id, 'task-running');

  const single = buildSingleJobSnapshot(unrelatedCwd, 'task-finished', {
    workspaceRoot: workspace,
  });
  assert.equal(single.workspaceRoot, workspace);
  assert.equal(single.job.id, 'task-finished');

  assert.equal(
    resolveResultJob(unrelatedCwd, 'task-finished', { workspaceRoot: workspace }).job.id,
    'task-finished',
  );
  assert.equal(
    resolveCancelableJob(unrelatedCwd, 'task-running', { workspaceRoot: workspace }).job.id,
    'task-running',
  );
});

test('resolveResultJob reports a referenced running job as still running', (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  seedJobs(workspace, [
    jobAt('task-running', 10, { status: 'running', pid: process.pid }),
    jobAt('task-finished', 5),
  ]);

  const resolved = resolveResultJob(workspace, 'task-finished');
  assert.equal(resolved.job.id, 'task-finished');

  assert.throws(() => resolveResultJob(workspace, 'task-running'), /still running/);
  assert.throws(() => resolveResultJob(workspace, 'task-nonexistent'), /No finished job found/);
});

test('resolveResultJob repairs a stale running index from a terminal per-job record', (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  const running = jobAt('task-repaired', 10, {
    status: 'running',
    phase: 'running',
    pid: process.pid,
  });
  seedJobs(workspace, [running]);
  writeJobFile(workspace, running.id, {
    ...running,
    status: 'completed',
    phase: 'done',
    pid: null,
    completedAt: '2026-03-18T15:11:00.000Z',
  });

  const resolved = resolveResultJob(workspace, running.id);

  assert.equal(resolved.job.status, 'completed');
  assert.equal(resolved.job.phase, 'done');
  assert.equal(resolved.job.pid, null);
  const indexed = listJobs(workspace).find((job) => job.id === running.id);
  assert.equal(indexed?.status, 'completed');
  assert.equal(indexed?.phase, 'done');
});

test('the result repair never overwrites a row a cancel settled meanwhile', (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  const running = jobAt('task-cancel-race', 10, { status: 'running', phase: 'running', pid: 4242 });
  seedJobs(workspace, [running]);
  const jobFile = resolveJobFile(workspace, running.id);
  writeJobFile(workspace, running.id, {
    ...running,
    status: 'completed',
    phase: 'done',
    pid: null,
  });

  // A cancel settles the row right after the repair read the finished job file.
  const originalRead = fs.readFileSync;
  let cancelled = false;
  t.mock.method(fs, 'readFileSync', ((file: fs.PathOrFileDescriptor, options?: unknown) => {
    const text = originalRead(file, options as Parameters<typeof fs.readFileSync>[1]);
    if (!cancelled && String(file) === jobFile) {
      cancelled = true;
      updateState(workspace, (state) => {
        const row = state.jobs.find((job) => job.id === running.id);
        Object.assign(row ?? {}, { status: 'cancelled', phase: 'cancelled', pid: null });
      });
    }
    return text;
  }) as typeof fs.readFileSync);

  resolveResultJob(workspace, running.id);
  t.mock.restoreAll();
  assert.equal(cancelled, true);
  const indexed = listJobs(workspace).find((job) => job.id === running.id);
  assert.equal(indexed?.status, 'cancelled', 'the cancel stands');
});

test('resolveResultJob rejects ambiguous prefixes', (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  seedJobs(workspace, [jobAt('task-abc', 1), jobAt('task-abd', 2)]);

  assert.throws(() => resolveResultJob(workspace, 'task-ab'), /ambiguous/);
  assert.equal(resolveResultJob(workspace, 'task-abc').job.id, 'task-abc');
});

test('resolveCancelableJob reports missing and inactive references distinctly', (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  seedJobs(workspace, [
    jobAt('task-finished', 5),
    jobAt('task-running', 10, { status: 'running', pid: process.pid, sessionId: 'sess-current' }),
  ]);

  assert.equal(resolveCancelableJob(workspace, 'task-running').job.id, 'task-running');
  assert.throws(
    () => resolveCancelableJob(workspace, 'task-finished'),
    /No active job found for "task-finished"/,
  );

  seedJobs(workspace, [jobAt('task-finished', 5)]);
  assert.throws(
    () => resolveCancelableJob(workspace, '', { env: {} }),
    /No active companion jobs to cancel/,
  );
});

test('buildStatusSnapshot keeps recent finished jobs when many jobs are active', (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  const active = [1, 2, 3].map((n) =>
    jobAt(`running-${n}`, 40 + n, { status: 'running', pid: process.pid }),
  );
  const finished = [...Array(10).keys()].map((n) => jobAt(`finished-${n}`, 30 - n));
  seedJobs(workspace, [...active, ...finished]);

  const snapshot = buildStatusSnapshot(workspace, {
    env: { CODEX_COMPANION_SESSION_ID: 'sess-current' },
  });
  assert.equal(snapshot.running.length, 3);
  assert.equal(snapshot.latestFinished!.id, 'finished-0');
  // Active jobs must not consume the recent budget: 8 finished jobs beyond the
  // latest one are still listed.
  assert.equal(snapshot.recent.length, 8);
  assert.deepEqual(
    snapshot.recent.map((job) => job.id),
    [...Array(8).keys()].map((n) => `finished-${n + 1}`),
  );
});

test('buildSingleJobSnapshot reports unknown references with its own message', (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  seedJobs(workspace, [jobAt('task-known', 1)]);

  assert.equal(buildSingleJobSnapshot(workspace, 'task-known').job.id, 'task-known');
  assert.throws(
    () => buildSingleJobSnapshot(workspace, 'task-unknown'),
    /No job found for "task-unknown"/,
  );
});

test('status enrichment recovers a provider-qualified model from a legacy request', (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  seedJobs(workspace, [jobAt('task-legacy', 1)]);
  writeJobFile(workspace, 'task-legacy', {
    id: 'task-legacy',
    status: 'completed',
    request: {
      model: 'kimi-k3',
    },
  });

  const snapshot = buildSingleJobSnapshot(workspace, 'task-legacy');
  assert.equal(snapshot.job.model, 'kimi-k3');
  assert.equal(snapshot.job.modelDisplay, 'kimi-k3@moonshot');
  assert.equal(formatJobModel('gpt-5.6-sol'), 'gpt-5.6-sol');
});

test('status enrichment treats truncated legacy job JSON as an unknown model', (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  seedJobs(workspace, [jobAt('task-truncated', 1)]);
  fs.writeFileSync(resolveJobFile(workspace, 'task-truncated'), '{"request":', 'utf8');

  const snapshot = buildSingleJobSnapshot(workspace, 'task-truncated');
  assert.equal(snapshot.job.model, null);
  assert.equal(snapshot.job.modelDisplay, '-');
});

test('enrichJob marks running jobs with dead pids as stalled', { skip: IS_WINDOWS }, () => {
  const stalled = enrichJob(jobAt('task-stalled', 1, { status: 'running', pid: DEAD_PID }));
  assert.equal(stalled.phase, 'stalled');

  const alive = enrichJob(jobAt('task-alive', 2, { status: 'running', pid: process.pid }));
  assert.notEqual(alive.phase, 'stalled');

  const noPid = enrichJob(jobAt('task-nopid', 3, { status: 'running' }));
  assert.notEqual(noPid.phase, 'stalled');

  const finished = enrichJob(jobAt('task-done', 4, { status: 'completed', pid: DEAD_PID }));
  assert.notEqual(finished.phase, 'stalled');
});

test(
  'status --wait stops at a stalled job and scans for stranded reservations once',
  { skip: IS_WINDOWS },
  async (t) => {
    const codexHome = useTempCodexHome(t);
    const workspace = makeTempDir();
    seedJobs(workspace, [jobAt('task-stalled-wait', 1, { status: 'running', pid: DEAD_PID })]);
    // A record the scan cannot validate, for it to list.
    const lockDir = resolveThreadReservationDir();
    assert.ok(lockDir.startsWith(codexHome));
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, `${'a'.repeat(32)}.lock.cleanup`), '{}\n', 'utf8');
    const originalReaddir = fs.readdirSync;
    let scans = 0;
    t.mock.method(fs, 'readdirSync', ((dir: fs.PathLike, options?: unknown) => {
      if (String(dir) === lockDir) {
        scans += 1;
      }
      return originalReaddir(dir, options as Parameters<typeof fs.readdirSync>[1]);
    }) as typeof fs.readdirSync);

    const startedAt = Date.now();
    const snapshot = await waitForJobSnapshot(workspace, 'task-stalled-wait', {
      timeoutMs: 60_000,
      pollIntervalMs: 100,
    });
    assert.ok(Date.now() - startedAt < 10_000, 'a stalled job ends the wait at once');
    assert.equal(snapshot.job.phase, 'stalled');
    assert.equal(snapshot.waitTimedOut, false);
    assert.deepEqual(
      snapshot.strandedReservations.map((entry) => entry.kind),
      ['unreadable'],
    );
    assert.equal(scans, 1, 'one scan, after the loop');

    // The one-line --brief answer shows none, so none is scanned.
    scans = 0;
    const brief = await waitForJobSnapshot(workspace, 'task-stalled-wait', {
      timeoutMs: 60_000,
      pollIntervalMs: 100,
      strandedReservations: false,
    });
    assert.deepEqual(brief.strandedReservations, []);
    assert.equal(scans, 0);
  },
);

test('a job that settles between the index read and the worker check is reported settled, not stalled', async (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  const running = jobAt('task-settling', 1, { status: 'running', pid: DEAD_PID });
  seedJobs(workspace, [running]);
  writeJobFile(workspace, running.id, running);
  // The worker settles its job and exits just as the poll checks its pid.
  const originalKill = process.kill;
  t.mock.method(process, 'kill', ((pid: number, signal?: string | number) => {
    if (pid !== DEAD_PID) {
      return originalKill.call(process, pid, signal);
    }
    settleJob(workspace, running.id, { terminal: { status: 'completed', phase: 'done' } });
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  }) as typeof process.kill);

  const snapshot = await waitForJobSnapshot(workspace, running.id, {
    timeoutMs: 60_000,
    pollIntervalMs: 100,
    strandedReservations: false,
  });
  t.mock.restoreAll();
  assert.equal(snapshot.job.status, 'completed');
  assert.equal(snapshot.job.phase, 'done');
  assert.equal(snapshot.waitTimedOut, false);
});

test('status --wait with a 0 timeout answers at once', async (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  seedJobs(workspace, [jobAt('task-live-wait', 1, { status: 'running', pid: process.pid })]);
  const startedAt = Date.now();
  const snapshot = await waitForJobSnapshot(workspace, 'task-live-wait', {
    timeoutMs: '0',
    pollIntervalMs: '0',
    strandedReservations: false,
  });
  assert.ok(Date.now() - startedAt < 5000, 'no default window was waited out');
  assert.equal(snapshot.timeoutMs, 0);
  assert.equal(snapshot.waitTimedOut, true);
  assert.equal(snapshot.job.status, 'running');
});

test('readJobProgressPreview tails large logs without losing recent lines', () => {
  const dir = makeTempDir();
  const logFile = path.join(dir, 'job.log');
  const filler = `[2026-03-18T15:00:00.000Z] filler line ${'x'.repeat(80)}\n`;
  const lines = [];
  while (lines.length * filler.length < 96 * 1024) {
    lines.push(filler);
  }
  lines.push('[2026-03-18T15:59:00.000Z] penultimate marker\n');
  lines.push('[2026-03-18T16:00:00.000Z] final marker\n');
  fs.writeFileSync(logFile, lines.join(''), 'utf8');

  const preview = readJobProgressPreview(logFile, 2);
  assert.deepEqual(preview, ['penultimate marker', 'final marker']);
});

test('readJobProgressPreview drops a partial multi-byte character at the tail cut', () => {
  const dir = makeTempDir();
  const logFile = path.join(dir, 'job.log');
  const markers =
    '[2026-03-18T15:59:00.000Z] penultimate marker\n[2026-03-18T16:00:00.000Z] final marker\n';
  // One huge line of 2-byte characters so the 64KB window boundary lands
  // inside it; force the cut to an odd byte offset so it splits a character.
  let content = `[2026-03-18T15:00:00.000Z] head\n${'é'.repeat(60000)}\n`;
  const tailBytes = 64 * 1024;
  if ((Buffer.byteLength(content + markers, 'utf8') - tailBytes) % 2 === 0) {
    content = `x${content}`;
  }
  fs.writeFileSync(logFile, content + markers, 'utf8');
  assert.equal(Buffer.byteLength(content + markers, 'utf8') > tailBytes, true);

  const preview = readJobProgressPreview(logFile, 4);
  assert.deepEqual(preview, ['penultimate marker', 'final marker']);
  assert.equal(
    preview.some((line) => line.includes('�')),
    false,
  );
});

test('the brief status is status, phase, and whole elapsed seconds', () => {
  const now = Date.parse('2026-03-18T15:10:00.000Z');
  const running = enrichJob(
    jobAt('run', 0, {
      status: 'running',
      phase: 'verifying',
      startedAt: '2026-03-18T15:06:56.000Z',
      pid: process.pid,
    }),
  );
  const brief = buildBriefJobStatus(running, now);
  assert.deepEqual(brief, {
    jobId: 'run',
    status: 'running',
    phase: 'verifying',
    elapsedSeconds: 184,
  });
  assert.equal(renderBriefJobStatus(brief), 'running verifying 184s\n');

  // A finished job counts to its completion, not to now.
  const done = enrichJob(
    jobAt('done', 0, {
      phase: 'done',
      startedAt: '2026-03-18T15:00:00.000Z',
      completedAt: '2026-03-18T15:06:42.000Z',
    }),
  );
  assert.equal(renderBriefJobStatus(buildBriefJobStatus(done, now)), 'completed done 402s\n');

  const undated = enrichJob({ id: 'undated', status: 'queued' });
  assert.equal(buildBriefJobStatus(undated, now).elapsedSeconds, 0);
});

test('status --brief combines with --wait and --timeout-ms and prints one line', (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  const startedAtMs = Date.now() - 184_000;
  const startedAt = new Date(startedAtMs).toISOString();
  seedJobs(workspace, [
    jobAt('task-live', 0, { status: 'running', phase: 'verifying', startedAt, pid: process.pid }),
    jobAt('task-done', 1, {
      phase: 'done',
      startedAt: '2026-03-18T15:00:00.000Z',
      completedAt: '2026-03-18T15:06:42.000Z',
    }),
  ]);
  // The status command starts no broker: a plain CLI spawn.
  const status = (args: string[]) =>
    run(process.execPath, [SCRIPT, 'status', ...args, '--cwd', workspace]);
  // A running job's whole seconds lie between the elapsed time just before
  // and just after the spawn: no fixed bound a slow Windows node start breaks.
  const elapsedAround = <T>(work: () => T): { value: T; low: number; high: number } => {
    const low = Math.round((Date.now() - startedAtMs) / 1000);
    const value = work();
    return { value, low, high: Math.round((Date.now() - startedAtMs) / 1000) };
  };
  const assertElapsed = (seconds: number, bounds: { low: number; high: number }) =>
    assert.ok(
      seconds >= bounds.low && seconds <= bounds.high,
      `${seconds}s outside [${bounds.low}, ${bounds.high}]`,
    );

  // The window ends while the job still runs: the line says so.
  const waited = elapsedAround(() =>
    status(['task-live', '--wait', '--timeout-ms', '300', '--brief']),
  );
  assert.equal(waited.value.status, 0, waited.value.stderr);
  const line = /^running verifying (\d+)s\n$/.exec(waited.value.stdout);
  assert.ok(line, waited.value.stdout);
  assertElapsed(Number(line[1]), waited);

  const json = elapsedAround(() =>
    status(['task-live', '--wait', '--timeout-ms', '300', '--brief', '--json']),
  );
  assert.equal(json.value.status, 0, json.value.stderr);
  const payload = JSON.parse(json.value.stdout);
  assert.deepEqual(Object.keys(payload), ['jobId', 'status', 'phase', 'elapsedSeconds']);
  assert.equal(payload.jobId, 'task-live');
  assert.equal(payload.status, 'running');
  assert.equal(payload.phase, 'verifying');
  assertElapsed(payload.elapsedSeconds, json);

  // A finished job answers at once, well inside a long window.
  const startedAt2 = Date.now();
  const done = status(['task-done', '--wait', '--timeout-ms', '90000', '--brief']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stdout, 'completed done 402s\n');
  assert.ok(Date.now() - startedAt2 < 30_000, 'no wait for a finished job');
  assert.deepEqual(JSON.parse(status(['task-done', '--brief', '--json']).stdout), {
    jobId: 'task-done',
    status: 'completed',
    phase: 'done',
    elapsedSeconds: 402,
  });

  const missing = status(['--brief']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /`status --brief` requires a job id\./);
  // What keeps this file on the Windows lane: status never starts a broker.
  assert.equal(loadBrokerSession(workspace), null);
});

test('result --report --json carries the effort, touched files, and dropped notifications', (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  const withEffort = jobAt('task-effort', 0);
  const withoutEffort = jobAt('task-no-effort', 1);
  seedJobs(workspace, [withEffort, withoutEffort]);
  writeJobFile(workspace, withEffort.id, {
    ...withEffort,
    result: {
      rawOutput: 'Done.',
      effort: 'xhigh',
      touchedFiles: ['src/a.ts', 'README.md'],
      droppedNotifications: 3,
    },
  });
  writeJobFile(workspace, withoutEffort.id, { ...withoutEffort, result: { rawOutput: 'Done.' } });

  const report = (id: string) =>
    JSON.parse(
      run(process.execPath, [SCRIPT, 'result', id, '--report', '--json', '--cwd', workspace])
        .stdout,
    );
  const full = report('task-effort');
  assert.equal(full.effort, 'xhigh');
  // The run's own facts travel beside the report when it recorded them.
  assert.deepEqual(full.touchedFiles, ['src/a.ts', 'README.md']);
  assert.equal(full.droppedNotifications, 3);
  const bare = report('task-no-effort');
  assert.equal(bare.effort, null);
  assert.equal(Object.hasOwn(bare, 'touchedFiles'), false);
  assert.equal(Object.hasOwn(bare, 'droppedNotifications'), false);
  assert.equal(loadBrokerSession(workspace), null, 'result never starts a broker');
});

test('the stop-gate origin names the task, not its prompt text', () => {
  assert.deepEqual(buildTaskRunMetadata({ prompt: 'anything', origin: STOP_GATE_ORIGIN }), {
    title: 'Codex Stop Gate Review',
    summary: 'Stop-gate review of previous Claude turn',
  });
  const prompt = '<task>\nRun a stop-gate review of the previous Claude turn.\n</task>';
  assert.equal(buildTaskRunMetadata({ prompt }).title, 'Codex Task');
});

test('stop-gate jobs are labelled stop-gate and skipped by the resume lookup', () => {
  assert.equal(jobKindLabel('task', 'task', null, STOP_GATE_ORIGIN), 'stop-gate');
  assert.equal(jobKindLabel('task', 'task', null), 'rescue');
  assert.equal(jobKindLabel('task', 'task', 'implementer', STOP_GATE_ORIGIN), 'implementer');
  const gate: JobRecord = {
    id: 'task-gate',
    status: 'completed',
    kind: 'task',
    jobClass: 'task',
    origin: STOP_GATE_ORIGIN,
    threadId: 'thr_gate',
    updatedAt: '2026-09-25T10:05:00.000Z',
  };
  const rescue: JobRecord = {
    id: 'task-rescue',
    status: 'completed',
    kind: 'task',
    jobClass: 'task',
    threadId: 'thr_rescue',
    updatedAt: '2026-09-25T10:00:00.000Z',
  };
  assert.equal(getJobTypeLabel(gate), 'stop-gate');
  assert.equal(findLatestResumableTaskJob([gate, rescue])?.id, 'task-rescue');
  assert.equal(findLatestResumableTaskJob([gate]), null);
});

test('a role resumes only a thread its own role ran, on either runtime', () => {
  const owner = (patch: Partial<JobRecord>, runtime: 'claude' | 'codex' = 'codex'): ResumeOwner => {
    const job = jobAt('owner-job', 1, patch);
    return { job, runtime, role: typeof job.role === 'string' ? job.role : null };
  };
  // A record from before roles were recorded takes the role its kind implies.
  assert.equal(
    resumeOwnerRole(owner({ kind: 'plan-review', jobClass: 'review' })),
    'plan-reviewer',
  );
  assert.equal(resumeOwnerRole(owner({ kind: 'adversarial-review' })), 'adversarial-reviewer');
  assert.equal(resumeOwnerRole(owner({ kind: 'review', jobClass: 'review' })), 'reviewer');
  assert.equal(
    resumeOwnerRole(owner({ kind: 'task', jobClass: 'task', role: 'implementer' })),
    'implementer',
  );
  assert.equal(resumeOwnerRole(owner({ kind: 'task', jobClass: 'task' })), null);
  assert.equal(resumeOwnerRole(null), null);

  assert.throws(
    () =>
      assertSameRoleResume(
        owner({ kind: 'plan-review', jobClass: 'review' }),
        'thr_1',
        'implementer',
      ),
    {
      message:
        'Thread thr_1 belongs to plan-reviewer job owner-job; a role resumes only its own thread or session, so run the implementer without --thread.',
    },
  );
  assert.throws(
    () =>
      assertSameRoleResume(
        owner({ kind: 'task', jobClass: 'task', role: 'implementer' }, 'claude'),
        'sess-1',
        'implementation-reviewer',
      ),
    /^Error: Session sess-1 belongs to implementer job owner-job;/,
  );
  // The same role continues its own thread (an implementer's fix turn).
  assert.doesNotThrow(() =>
    assertSameRoleResume(
      owner({ kind: 'task', jobClass: 'task', role: 'implementer' }),
      'thr_2',
      'implementer',
    ),
  );
  // A run without a role never takes over a role's thread.
  assert.throws(() => assertSameRoleResume(owner({ kind: 'plan-review' }), 'thr_3', null), {
    message:
      'Thread thr_3 belongs to plan-reviewer job owner-job; resume it with --role plan-reviewer.',
  });
  // Nothing to judge: an unknown id, or a role-less task.
  assert.doesNotThrow(() => assertSameRoleResume(null, 'thr_4', 'implementer'));
  assert.doesNotThrow(() =>
    assertSameRoleResume(owner({ kind: 'task', jobClass: 'task' }), 'thr_5', 'implementer'),
  );
});

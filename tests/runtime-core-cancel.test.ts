import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { initGitRepo, makeTempDir, processOps, run, waitFor } from './helpers.ts';
import { PROCESS_MARKERS } from '../plugins/stereo/src/platform/process.ts';
import {
  SCRIPT,
  SESSION_HOOK,
  readCompanionState,
  readFakeState,
  registerBrokerReaping,
  spawnStandIn,
  stopStandIn,
} from './runtime-helpers.ts';
import {
  resolveJobFile,
  resolveDurableStateDir,
  upsertJob,
  writeJobFile,
} from '../plugins/stereo/src/workspace/state.ts';
import { handleCancel, type CancelDeps } from '../plugins/stereo/src/cli/commands/cancel.ts';
import { handleTaskWorker, type TaskWorkerDeps } from '../plugins/stereo/src/cli/commands/task.ts';

registerBrokerReaping();

test('cancel stops an active background job and marks it cancelled', async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  // A stand-in worker: cancel kills a recorded pid only while its command
  // line still names the companion, so the sleeper carries that marker.
  const sleeper = spawnStandIn(PROCESS_MARKERS.worker, { cwd: workspace });
  t.after(() => stopStandIn(sleeper));

  const logFile = path.join(jobsDir, 'task-live.log');
  const jobFile = path.join(jobsDir, 'task-live.json');
  fs.writeFileSync(logFile, '[2026-03-18T15:30:00.000Z] Starting Codex Task.\n', 'utf8');
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: 'task-live',
        status: 'running',
        title: 'Codex Task',
        logFile,
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'task-live',
            status: 'running',
            title: 'Codex Task',
            jobClass: 'task',
            summary: 'Investigate flaky test',
            pid: sleeper.pid,
            logFile,
            createdAt: '2026-03-18T15:30:00.000Z',
            startedAt: '2026-03-18T15:30:01.000Z',
            updatedAt: '2026-03-18T15:30:02.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const cancelResult = run('node', [SCRIPT, 'cancel', 'task-live', '--json'], {
    cwd: workspace,
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, 'cancelled');
  // The JSON payload carries the report text the plain run prints.
  assert.match(cancelPayload.rendered, /^# Stereo Cancel\n\nCancelled task-live\.\n/);
  assert.match(
    cancelPayload.rendered,
    /\n- Title: Codex Task\n- Summary: Investigate flaky test\n/,
  );

  await waitFor(() => {
    try {
      process.kill(sleeper.pid!, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException | null)?.code === 'ESRCH';
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  const cancelled = state.jobs.find((job: Record<string, any>) => job.id === 'task-live');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  assert.equal(stored.status, 'cancelled');
  assert.match(fs.readFileSync(logFile, 'utf8'), /Cancelled by user/);
});

test('cancel degrades to index data when the stored job file is corrupt', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobs = ['task-corrupt-json', 'task-corrupt-text'].map((id, index) => {
    const logFile = path.join(jobsDir, `${id}.log`);
    fs.writeFileSync(logFile, '', 'utf8');
    fs.writeFileSync(resolveJobFile(workspace, id), '{', 'utf8');
    return {
      id,
      status: 'running',
      title: 'Codex Task',
      jobClass: 'task',
      summary: `Corrupt stored job ${index + 1}`,
      pid: null,
      logFile,
      createdAt: `2026-03-18T15:3${index}:00.000Z`,
      updatedAt: `2026-03-18T15:3${index}:01.000Z`,
    };
  });
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const jsonCancel = run(process.execPath, [SCRIPT, 'cancel', 'task-corrupt-json', '--json'], {
    cwd: workspace,
  });
  assert.equal(jsonCancel.status, 0, jsonCancel.stderr);
  const jsonPayload = JSON.parse(jsonCancel.stdout);
  assert.equal(jsonPayload.status, 'cancelled');
  assert.match(jsonPayload.rendered, /^# Stereo Cancel\n\nCancelled task-corrupt-json\.\n/);
  assert.match(jsonPayload.rendered, /Warnings:\n- Stored job file is unreadable:/);
  assert.match(
    jsonPayload.storedJobWarning,
    new RegExp(
      `^Stored job file is unreadable: ${resolveJobFile(workspace, 'task-corrupt-json').replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      )} \\(.+\\)\\. Cancelling with index data only\\.$`,
    ),
  );

  const textCancel = run(process.execPath, [SCRIPT, 'cancel', 'task-corrupt-text'], {
    cwd: workspace,
  });
  assert.equal(textCancel.status, 0, textCancel.stderr);
  assert.match(textCancel.stdout, /Warnings:\n- Stored job file is unreadable:/);
  assert.match(textCancel.stdout, /Cancelling with index data only\./);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  assert.deepEqual(
    state.jobs.map((job: Record<string, unknown>) => job.status),
    ['cancelled', 'cancelled'],
  );
  for (const job of jobs) {
    const log = fs.readFileSync(job.logFile, 'utf8');
    assert.match(log, /Stored job file is unreadable:/);
    assert.match(log, /Cancelled by user/);
  }
});

test('handleCancel dependency injection preserves interrupt-then-kill order', async () => {
  const workspace = makeTempDir();
  const jobId = 'task-di-cancel';
  const logFile = path.join(resolveDurableStateDir(workspace), 'jobs', `${jobId}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, '', 'utf8');
  const job = {
    id: jobId,
    status: 'running',
    title: 'Codex Task',
    jobClass: 'task',
    pid: 4242,
    threadId: 'thr-index',
    turnId: 'turn-index',
    logFile,
    createdAt: '2026-03-18T15:30:00.000Z',
    updatedAt: '2026-03-18T15:30:01.000Z',
  };
  writeJobFile(workspace, jobId, {
    ...job,
    threadId: 'thr-stored',
    turnId: 'turn-stored',
    request: { threadId: 'thr-request' },
  });
  upsertJob(workspace, job);

  const calls: string[] = [];
  const deps: CancelDeps = {
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: 'sess-di' },
    interruptAppServerTurn: async (cwd, target) => {
      calls.push('interrupt');
      assert.equal(cwd, workspace);
      assert.deepEqual(target, { threadId: 'thr-stored', turnId: 'turn-stored' });
      return {
        attempted: true,
        interrupted: true,
        transport: 'fake',
        detail: 'interrupted',
      };
    },
    ops: processOps({
      terminate: (pid) => {
        calls.push('kill');
        assert.equal(pid, 4242);
      },
      // The worker goes with the polite signal: the stop is confirmed.
      processHasExited: () => calls.includes('kill'),
      readProcessIdentity: () => ({ commandLine: 'node codex-companion.ts', start: null }),
    }),
  };

  const originalLog = console.log;
  console.log = () => {};
  try {
    await handleCancel(['--cwd', workspace, '--json', jobId], deps);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(calls, ['interrupt', 'kill']);
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), 'utf8'));
  assert.equal(stored.status, 'cancelled');
});

test('cancel from another directory of the workspace interrupts on the root the job was found in', async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const subdir = path.join(workspace, 'packages', 'app');
  fs.mkdirSync(subdir, { recursive: true });
  const jobId = 'task-cancel-subdir';
  const job = {
    id: jobId,
    status: 'running',
    title: 'Codex Task',
    jobClass: 'task',
    pid: 2147483647,
    threadId: 'thr-subdir',
    turnId: 'turn-subdir',
    createdAt: '2026-03-18T15:30:00.000Z',
    updatedAt: '2026-03-18T15:30:01.000Z',
  };
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);
  const interruptedOn: string[] = [];
  const deps: CancelDeps = {
    interruptAppServerTurn: async (cwd) => {
      interruptedOn.push(cwd);
      return { attempted: true, interrupted: true, transport: 'fake', detail: 'interrupted' };
    },
    ops: processOps({ terminate: () => {} }),
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    await handleCancel(['--cwd', subdir, '--json', jobId], deps);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(interruptedOn, [workspace]);
});

test('handleTaskWorker dependency injection dispatches task, plan-review, and review requests', async () => {
  const workspace = makeTempDir();
  const worktree = makeTempDir();
  const seedWorker = (id: string, request: Record<string, unknown>) => {
    const job = {
      id,
      status: 'queued',
      title: 'Queued worker',
      jobClass: 'task',
      workspaceRoot: workspace,
      request,
      createdAt: '2026-03-18T15:30:00.000Z',
      updatedAt: '2026-03-18T15:30:01.000Z',
    };
    writeJobFile(workspace, id, job);
    upsertJob(workspace, job);
  };
  seedWorker('task-worker-di', {
    cwd: worktree,
    prompt: 'run the task branch',
  });
  seedWorker('plan-worker-di', {
    kind: 'plan-review',
    cwd: workspace,
    plan: 'Review this plan.',
    round: 1,
  });
  seedWorker('review-worker-di', {
    kind: 'review',
    cwd: workspace,
    reviewName: 'Adversarial Review',
    focusText: 'Review the edge cases.',
  });

  const calls: string[] = [];
  const deps: TaskWorkerDeps = {
    runTrackedJob: async (_job, runner) => {
      calls.push('tracked');
      return runner();
    },
    executeTaskRun: async (request) => {
      calls.push('task');
      assert.equal(request.cwd, worktree);
      assert.equal(request.workspaceRoot, workspace);
      assert.equal(request.prompt, 'run the task branch');
      assert.equal(typeof request.onProgress, 'function');
      return {
        exitStatus: 0,
        threadId: 'thr-task',
        turnId: null,
        payload: {},
        rendered: 'task\n',
        summary: 'task',
        jobTitle: 'Codex Task',
        jobClass: 'task',
      };
    },
    executePlanReviewRun: async (request) => {
      calls.push('plan');
      assert.equal(request.plan, 'Review this plan.');
      assert.equal(typeof request.onProgress, 'function');
      return {
        exitStatus: 0,
        threadId: 'thr-plan',
        turnId: null,
        payload: {},
        rendered: 'plan\n',
        summary: 'plan',
        jobTitle: 'Codex Plan Review',
        jobClass: 'review',
      };
    },
    executeReviewRun: async (request) => {
      calls.push('review');
      assert.equal(request.reviewName, 'Adversarial Review');
      assert.equal(typeof request.onProgress, 'function');
      return {
        exitStatus: 0,
        threadId: 'thr-review',
        turnId: null,
        payload: {},
        rendered: 'review\n',
        summary: 'review',
        jobTitle: 'Codex Adversarial Review',
        jobClass: 'review',
      };
    },
  };

  await handleTaskWorker(
    ['--cwd', worktree, '--workspace', workspace, '--job-id', 'task-worker-di'],
    deps,
  );
  await handleTaskWorker(['--cwd', workspace, '--job-id', 'plan-worker-di'], deps);
  await handleTaskWorker(['--cwd', workspace, '--job-id', 'review-worker-di'], deps);

  assert.deepEqual(calls, ['tracked', 'task', 'tracked', 'plan', 'tracked', 'review']);
});

test('handleTaskWorker records a bootstrap failure when --workspace is invalid', async () => {
  const workspace = makeTempDir();
  const jobId = 'task-worker-invalid-workspace';
  const job = {
    id: jobId,
    status: 'queued',
    title: 'Queued worker',
    jobClass: 'task',
    workspaceRoot: workspace,
    request: { cwd: workspace, prompt: 'run the task branch' },
  };
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);
  const missingWorkspace = path.join(workspace, 'missing-workspace');

  await assert.rejects(
    handleTaskWorker(['--cwd', workspace, '--workspace', missingWorkspace, '--job-id', jobId]),
    (error: unknown) =>
      error instanceof Error &&
      error.message === `--workspace ${missingWorkspace} is not an existing directory.`,
  );

  const failed = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), 'utf8'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.phase, 'failed');
  assert.equal(
    failed.errorMessage,
    `--workspace ${missingWorkspace} is not an existing directory.`,
  );
});

test('handleTaskWorker rejects an unsafe job id before bootstrap failure persistence', async () => {
  const workspace = makeTempDir();

  await assert.rejects(
    handleTaskWorker(['--cwd', workspace, '--job-id', '../escape']),
    /Unsupported job id "\.\.\/escape"/,
  );

  assert.equal(fs.existsSync(path.join(resolveDurableStateDir(workspace), 'escape.json')), false);
});

test('cancel without a job id ignores active jobs from other Claude sessions', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, 'task-other.log');
  fs.writeFileSync(logFile, '', 'utf8');
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'task-other',
            status: 'running',
            title: 'Codex Task',
            jobClass: 'task',
            sessionId: 'sess-other',
            summary: 'Other session run',
            updatedAt: '2026-03-24T20:05:00.000Z',
            logFile,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: 'sess-current',
  };
  const status = run('node', [SCRIPT, 'status', '--json'], {
    cwd: workspace,
    env,
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run('node', [SCRIPT, 'cancel', '--json'], {
    cwd: workspace,
    env,
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active companion jobs to cancel for this session\./);
  assert.match(
    JSON.parse(cancel.stdout).error,
    /No active companion jobs to cancel for this session\./,
  );

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  assert.equal(state.jobs[0].status, 'running');
});

test('cancel with a job id can still target an active job from another Claude session', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, 'task-other.log');
  fs.writeFileSync(logFile, '', 'utf8');
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'task-other',
            status: 'running',
            title: 'Codex Task',
            jobClass: 'task',
            sessionId: 'sess-other',
            summary: 'Other session run',
            updatedAt: '2026-03-24T20:05:00.000Z',
            logFile,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: 'sess-current',
  };
  const cancel = run('node', [SCRIPT, 'cancel', 'task-other', '--json'], {
    cwd: workspace,
    env,
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, 'task-other');

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  assert.equal(state.jobs[0].status, 'cancelled');
});

test('cancel sends turn interrupt to the shared app-server before killing a brokered task', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'interruptible-slow-task');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run(
    'node',
    [SCRIPT, 'task', '--background', '--json', 'investigate the flaky worker timeout'],
    {
      cwd: repo,
      env,
    },
  );

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const runningJob = await waitFor(
    () => {
      const job = readCompanionState(repo, env)?.jobs.find(
        (candidate: Record<string, any>) => candidate.id === jobId,
      );
      if (job?.status === 'running' && job.threadId && job.turnId) {
        return job;
      }
      return null;
    },
    { timeoutMs: 15000 },
  );

  const cancelResult = run('node', [SCRIPT, 'cancel', jobId, '--json'], {
    cwd: repo,
    env,
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, 'cancelled');
  assert.equal(cancelPayload.turnInterruptAttempted, true);
  assert.equal(cancelPayload.turnInterrupted, true);

  const lastInterrupt = await waitFor(() => readFakeState(binDir).lastInterrupt ?? null);
  assert.deepEqual(lastInterrupt, {
    threadId: runningJob.threadId,
    turnId: runningJob.turnId,
  });

  const cleanup = run('node', [SESSION_HOOK, 'SessionEndSweep'], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: 'SessionEnd',
      cwd: repo,
    }),
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

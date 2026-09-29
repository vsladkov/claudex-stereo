import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import {
  initGitRepo,
  makeTempDir,
  processIsAlive,
  processOps,
  run,
  seedState,
  waitFor,
  writeExecutable,
} from './helpers.ts';
import {
  BROKER_SCRIPT,
  SCRIPT,
  SESSION_HOOK,
  brokerEndpointConnectable,
  initializeBasicRepo,
  readCompanionState,
  readFakeState,
  readJobLog,
  readJobLogIfReadable,
  registerBrokerReaping,
  registerSessionCleanup,
  requireCompanionState,
  runNodeWithTimeout,
  waitForFakeState,
  withCodexHome,
} from './runtime-helpers.ts';
import { terminateProcessTree } from '../plugins/stereo/src/platform/process.ts';
import { CodexAppServerClient } from '../plugins/stereo/src/transport/app-server-client.ts';
import { renderStoredJobResult } from '../plugins/stereo/src/render/render.ts';
import type { StoredJobLike } from '../plugins/stereo/src/render/render.ts';
import { TURN_INACTIVITY_TIMEOUT_ENV } from '../plugins/stereo/src/runtime/turn-capture.ts';
import { APP_SERVER_REQUEST_TIMEOUT_ENV } from '../plugins/stereo/src/protocol/broker-rpc.ts';
import {
  ensureBrokerSession,
  loadBrokerSession,
  sendBrokerShutdown,
  spawnBrokerProcess,
  waitForBrokerEndpoint,
} from '../plugins/stereo/src/broker/lifecycle.ts';
import {
  buildSingleJobSnapshot,
  DEFAULT_MAX_PROGRESS_LINES,
} from '../plugins/stereo/src/jobs/job-control.ts';
import { handleCancel } from '../plugins/stereo/src/cli/commands/cancel.ts';
import type { CancelDeps } from '../plugins/stereo/src/cli/commands/cancel.ts';
import {
  readJobFile,
  resolveDurableStateDir,
  resolveJobFile,
  resolveStateDir,
  writeJobFile,
} from '../plugins/stereo/src/workspace/state.ts';
import type { JobRecord } from '../plugins/stereo/src/workspace/state.ts';
import { buildTaskCapturePayload } from '../plugins/stereo/src/workflows/task.ts';

registerBrokerReaping();

test('task --background enqueues a detached worker and exposes per-job status', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-task');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const launched = run(
    'node',
    [SCRIPT, 'task', '--background', '--json', 'investigate the failing test'],
    {
      cwd: repo,
      env: buildEnv(binDir),
    },
  );

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, 'queued');
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    'node',
    [SCRIPT, 'status', launchPayload.jobId, '--wait', '--timeout-ms', '15000', '--json'],
    {
      cwd: repo,
      env: buildEnv(binDir),
    },
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, 'completed');

  const resultPayload = await waitFor(() => {
    const result = run('node', [SCRIPT, 'result', launchPayload.jobId, '--json'], {
      cwd: repo,
      env: buildEnv(binDir),
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, 'completed');
  // The printed payload is slimmed (no rendered/request echoes); the answer
  // itself travels once as result.rawOutput.
  assert.equal(Object.hasOwn(resultPayload.storedJob, 'rendered'), false);
  assert.match(resultPayload.storedJob.result.rawOutput, /Handled the requested task/);
});

test('task --workspace keeps isolated thread state on the main workspace broker', async (t) => {
  const repo = initializeBasicRepo();
  const worktreeParent = makeTempDir('isolated-task-worktree-');
  const worktree = path.join(worktreeParent, 'checkout');
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const added = run('git', ['-C', repo, 'worktree', 'add', '--detach', worktree, 'HEAD']);
  assert.equal(added.status, 0, added.stderr);

  const result = run(
    process.execPath,
    [SCRIPT, 'task', '--write', '--cwd', worktree, '--workspace', repo, 'implement it'],
    { cwd: repo, env },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readCompanionState(repo, env)?.jobs.length, 1);
  assert.equal(fs.existsSync(resolveDurableStateDir(worktree, env.CODEX_HOME)), false);
  assert.equal(fs.existsSync(path.join(resolveStateDir(worktree), 'broker.json')), false);
  assert.equal(fs.existsSync(path.join(resolveStateDir(repo), 'broker.json')), true);
  assert.equal((await waitForFakeState(binDir, 'threads')).threads[0].cwd, worktree);
});

test('cancel --workspace retargets the turn interrupt to the recorded workspace', async () => {
  const workspace = makeTempDir();
  const unrelatedCwd = makeTempDir();
  const job = {
    id: 'task-cross-workspace-cancel',
    status: 'running',
    title: 'Cross-workspace task',
    threadId: 'thread-cross-workspace',
    turnId: 'turn-cross-workspace',
    pid: null,
  };
  seedState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [job],
  });
  writeJobFile(workspace, job.id, job);

  let interruptCwd: string | null = null;
  const deps: CancelDeps = {
    interruptAppServerTurn: async (cwd, target) => {
      interruptCwd = cwd;
      assert.deepEqual(target, { threadId: job.threadId, turnId: job.turnId });
      return { attempted: true, interrupted: true, transport: 'broker', detail: '' };
    },
    ops: processOps({
      terminate: () => {
        throw new Error('A missing worker pid must not be terminated.');
      },
      processHasExited: () => true,
    }),
    env: {},
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    await handleCancel(['--cwd', unrelatedCwd, '--workspace', workspace, '--json', job.id], deps);
  } finally {
    console.log = originalLog;
  }

  assert.equal(interruptCwd, workspace);
});

test('status and result resolve isolated jobs from an unrelated cwd with --workspace', async (t) => {
  const repo = initializeBasicRepo();
  const unrelatedCwd = makeTempDir('unrelated-job-control-cwd-');
  const worktree = path.join(makeTempDir('isolated-job-control-worktree-'), 'checkout');
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-task');
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const added = run('git', ['-C', repo, 'worktree', 'add', '--detach', worktree, 'HEAD']);
  assert.equal(added.status, 0, added.stderr);

  const launched = run(
    process.execPath,
    [
      SCRIPT,
      'task',
      '--background',
      '--json',
      '--write',
      '--cwd',
      worktree,
      '--workspace',
      repo,
      'implement it',
    ],
    { cwd: unrelatedCwd, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId as string;

  const status = run(
    process.execPath,
    [SCRIPT, 'status', jobId, '--workspace', repo, '--wait', '--timeout-ms', '15000', '--json'],
    { cwd: unrelatedCwd, env },
  );
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.workspaceRoot, repo);
  assert.equal(statusPayload.job.id, jobId);
  assert.equal(statusPayload.job.status, 'completed');

  const result = await waitFor(() => {
    const outcome = run(
      process.execPath,
      [SCRIPT, 'result', jobId, '--workspace', repo, '--json'],
      { cwd: unrelatedCwd, env },
    );
    return outcome.status === 0 ? outcome : null;
  });
  assert.equal(JSON.parse(result.stdout).job.id, jobId);
});

test('status reports a missing explicit workspace through the JSON error contract', () => {
  const cwd = makeTempDir();
  const missing = path.join(cwd, 'missing-workspace');
  const result = run(process.execPath, [SCRIPT, 'status', '--workspace', missing, '--json'], {
    cwd,
  });

  assert.notEqual(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    error: `--workspace ${missing} is not an existing directory.`,
  });
});

test('task job payloads retain bounded command and file-change metadata', () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'captured-write-data');
  const env = buildEnv(binDir);

  const runResult = run(process.execPath, [SCRIPT, 'task', '--write', 'capture metadata'], {
    cwd: repo,
    env,
  });
  assert.equal(runResult.status, 0, runResult.stderr);

  const indexedJob = requireCompanionState(repo, env).jobs[0]! as JobRecord;
  const storedJob = withCodexHome(env.CODEX_HOME, () =>
    readJobFile(resolveJobFile(repo, indexedJob.id)),
  ) as JobRecord & StoredJobLike;
  const payload = storedJob.result as Record<string, any>;
  assert.equal(payload.commandExecutions.length, 2);
  assert.deepEqual(payload.commandExecutions[0], {
    command: 'npm run check:ok',
    cwd: repo,
    status: 'completed',
    exitCode: 0,
    durationMs: 12,
  });
  assert.equal(Object.hasOwn(payload.commandExecutions[0], 'output'), false);
  assert.equal(payload.commandExecutions[1].exitCode, 7);
  assert.equal(payload.commandExecutions[1].output.length, 2000);
  assert.match(payload.commandExecutions[1].output, /failed-output-tail$/);
  assert.doesNotMatch(payload.commandExecutions[1].output, /discarded-prefix/);
  assert.deepEqual(payload.fileChanges, [
    { path: 'src/added.ts', kind: { type: 'add' }, status: 'completed' },
    {
      path: 'src/updated.ts',
      kind: { type: 'update', move_path: null },
      status: 'completed',
    },
  ]);
  assert.equal(
    payload.fileChanges.some((change: Record<string, unknown>) => 'diff' in change),
    false,
  );

  const legacyStoredJob = structuredClone(storedJob);
  const legacyPayload = legacyStoredJob.result as Record<string, unknown>;
  delete legacyPayload.commandExecutions;
  delete legacyPayload.commandExecutionsOmitted;
  delete legacyPayload.fileChanges;
  delete legacyPayload.fileChangesOmitted;
  assert.equal(
    renderStoredJobResult(indexedJob, storedJob),
    renderStoredJobResult(indexedJob, legacyStoredJob),
  );
});

test('task capture metadata stays within its command and file-change caps', () => {
  const commandExecutions = Array.from({ length: 300 }, (_, index) => ({
    type: 'commandExecution' as const,
    id: `command-${index}`,
    // pluginId/scriptPath are required by the 0.146.0 codegen types and are
    // harmless extra properties under 0.145.0 (no excess-property check on a
    // variable-passed object) — keep both so either pinned CLI typechecks.
    pluginId: null,
    scriptPath: null,
    command: `command ${index}`,
    cwd: '/repo',
    processId: null,
    source: 'agent' as const,
    status: 'completed' as const,
    commandActions: [],
    aggregatedOutput: '',
    exitCode: 0,
    durationMs: index,
  }));
  const fileChanges = [
    {
      type: 'fileChange' as const,
      id: 'file-changes',
      status: 'completed' as const,
      changes: Array.from({ length: 900 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        kind: { type: 'update' as const, move_path: null },
        diff: `diff ${index}`,
      })),
    },
  ];

  const payload = buildTaskCapturePayload({ commandExecutions, fileChanges });
  assert.equal(payload.commandExecutions?.length, 100);
  assert.equal(payload.commandExecutionsOmitted, 200);
  assert.equal(payload.fileChanges?.length, 500);
  assert.equal(payload.fileChangesOmitted, 400);
});

test('task results report dropped malformed notifications without failing the run', () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'malformed-notification');
  const env = buildEnv(binDir);

  const launched = run(
    process.execPath,
    [SCRIPT, 'task', '--background', '--json', 'survive a malformed notification'],
    { cwd: repo, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  const waited = run(
    process.execPath,
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '15000', '--json'],
    { cwd: repo, env },
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, 'completed');

  const result = run(process.execPath, [SCRIPT, 'result', jobId, '--json'], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.storedJob.status, 'completed');
  assert.equal(payload.storedJob.result.droppedNotifications, 1);
});

test('task --output-schema reaches a background app-server turn', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  const env = buildEnv(binDir);
  const schemaPath = path.join(
    path.dirname(SCRIPT),
    '..',
    'schemas',
    'implementation-review-output.schema.json',
  );

  const launched = run(
    process.execPath,
    [
      SCRIPT,
      'task',
      '--background',
      '--json',
      '--output-schema',
      schemaPath,
      'review the implementation',
    ],
    { cwd: repo, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  const status = run(
    process.execPath,
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '15000', '--json'],
    { cwd: repo, env },
  );
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.status, 'completed');

  const result = run(process.execPath, [SCRIPT, 'result', jobId, '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).job.status, 'completed');

  const expectedSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.deepEqual(
    (await waitForFakeState(binDir, 'lastTurnStart')).lastTurnStart.outputSchema,
    expectedSchema,
  );
});

test('slow write tasks expose diff and plan progress while running and retain it in the log', async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-turn');
  const env = buildEnv(binDir);

  const launched = run(
    process.execPath,
    [SCRIPT, 'task', '--background', '--write', '--json', 'exercise live progress'],
    { cwd: repo, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  await waitFor(
    () => {
      const job = readCompanionState(repo, env)?.jobs.find((candidate) => candidate.id === jobId);
      if (job?.status !== 'running') {
        return null;
      }
      const log = readJobLogIfReadable(repo, jobId, env);
      return log.includes('Diff: 2 files (+2/-1)') &&
        log.includes('Step 3/3: verify progress reporting')
        ? true
        : null;
    },
    { timeoutMs: 10000 },
  );

  const runningSnapshot = withCodexHome(env.CODEX_HOME, () => buildSingleJobSnapshot(repo, jobId));
  assert.equal(runningSnapshot.job.status, 'running');
  assert.ok(runningSnapshot.job.progressPreview.length <= DEFAULT_MAX_PROGRESS_LINES);
  assert.ok(runningSnapshot.job.progressPreview.includes('Diff: 2 files (+2/-1)'));
  assert.ok(runningSnapshot.job.progressPreview.includes('Step 3/3: verify progress reporting'));

  const waited = run(
    process.execPath,
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '15000', '--json'],
    { cwd: repo, env },
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, 'completed');

  const completedSnapshot = withCodexHome(env.CODEX_HOME, () =>
    buildSingleJobSnapshot(repo, jobId),
  );
  assert.deepEqual(completedSnapshot.job.progressPreview, []);

  const log = readJobLog(repo, jobId, env);
  assert.equal(log.match(/Diff: 2 files \(\+2\/-1\)/g)?.length, 1);
  assert.equal(log.match(/Step 2\/3: summarize live file changes/g)?.length, 1);
  assert.equal(log.match(/Step 3\/3: verify progress reporting/g)?.length, 1);
  assert.doesNotMatch(log, /Diff: 1 files \(\+1\/-0\)/);
});

test('commands lazily start and reuse one shared app-server after first use', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');

  const env = buildEnv(binDir);

  const review = run('node', [SCRIPT, 'review'], {
    cwd: repo,
    env,
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const adversarial = run('node', [SCRIPT, 'adversarial-review'], {
    cwd: repo,
    env,
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = await waitForFakeState(binDir, 'appServerStarts');
  assert.equal(fakeState.appServerStarts, 2);

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

test('task --write --thread escalates the resumed thread to workspace-write', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  // A read-only rescue thread (no role), which a role-less write may continue.
  const first = run('node', [SCRIPT, 'task', '--json', 'Initial plan draft'], {
    cwd: repo,
    env: buildEnv(binDir),
  });
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout).threadId;
  assert.ok(threadId);

  const impl = run(
    'node',
    [SCRIPT, 'task', '--write', '--thread', threadId, 'implement the approved plan'],
    {
      cwd: repo,
      env: buildEnv(binDir),
    },
  );

  assert.equal(impl.status, 0, impl.stderr);
  assert.equal(
    impl.stdout,
    'Handled the requested task.\nTask prompt accepted.\n\nNote: this write-capable run recorded no edit-tool file changes; shell commands may still have changed files.\n',
  );
  const fakeState = await waitForFakeState(binDir, 'lastResume');
  assert.equal(fakeState.lastResume.threadId, threadId);
  assert.equal(fakeState.lastResume.sandbox, 'workspace-write');
  assert.equal(fakeState.lastTurnStart.threadId, threadId);
  assert.equal(fakeState.lastTurnStart.prompt, 'implement the approved plan');
});

test('task routes a registered provider model when resuming an explicit thread', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const first = run('node', [SCRIPT, 'task', '--json', 'Initial plan draft'], {
    cwd: repo,
    env: buildEnv(binDir),
  });
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout).threadId;
  assert.ok(threadId);

  const resumed = run(
    'node',
    [SCRIPT, 'task', '--thread', threadId, '--model', 'deepseek', 'continue through DeepSeek'],
    {
      cwd: repo,
      env: buildEnv(binDir),
    },
  );

  assert.equal(resumed.status, 0, resumed.stderr);
  const fakeState = await waitForFakeState(binDir, 'lastResume');
  assert.equal(fakeState.lastResume.threadId, threadId);
  assert.equal(fakeState.lastResume.model, 'deepseek-v4-pro');
  assert.equal(fakeState.lastResume.modelProvider, 'deepseek');
});

test('task rejects --thread combined with resume or fresh flags', () => {
  const repo = makeTempDir();

  const resume = run('node', [SCRIPT, 'task', '--thread', 'thr_9', '--resume-last', 'follow up'], {
    cwd: repo,
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /Choose either --thread <id> or --resume\/--resume-last\/--fresh\./);

  const fresh = run('node', [SCRIPT, 'task', '--thread', 'thr_9', '--fresh', 'follow up'], {
    cwd: repo,
  });
  assert.equal(fresh.status, 1);
  assert.match(fresh.stderr, /Choose either --thread <id> or --resume\/--resume-last\/--fresh\./);
});

test('task --write --thread retries privately when the shared runtime ignores escalation', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'stale-write-escalation');
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, 'task', '--json', 'Initial implementation plan'], {
    cwd: repo,
    env,
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;
  const staleBroker = loadBrokerSession(repo);
  assert.ok(staleBroker);

  const implementation = run(
    process.execPath,
    [SCRIPT, 'task', '--write', '--thread', threadId, 'implement the approved plan'],
    { cwd: repo, env },
  );
  assert.equal(implementation.status, 0, implementation.stderr);
  assert.match(implementation.stdout, /Handled the requested task/);

  const state = requireCompanionState(repo, env);
  const taskJob = state.jobs.find((job) => job.jobClass === 'task');
  assert.ok(taskJob);
  const log = readJobLog(repo, taskJob.id, env);
  assert.match(log, /resumed the thread read-only; retrying the write run on a private runtime/i);
  assert.match(log, /Drained the stale shared Codex runtime/);
  assert.equal(fs.existsSync(path.join(binDir, 'fake-codex-state.json')), true);
  const fakeStateAfterRetry = await waitForFakeState(binDir, 'appServerStarts');
  assert.equal(fakeStateAfterRetry.appServerStarts, 3);
  assert.equal(fakeStateAfterRetry.lastResume?.sandbox, 'workspace-write');
  assert.equal(await brokerEndpointConnectable(staleBroker.endpoint), false);
  assert.deepEqual(loadBrokerSession(repo), staleBroker);

  const followUp = run(process.execPath, [SCRIPT, 'task', 'verify the implementation'], {
    cwd: repo,
    env,
  });
  assert.equal(followUp.status, 0, followUp.stderr);
  assert.equal((await waitForFakeState(binDir, 'appServerStarts')).appServerStarts, 4);
  assert.notEqual(loadBrokerSession(repo)?.endpoint, staleBroker.endpoint);
});

test('task --write --thread fails clearly when write escalation is refused', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'resume-never-escalates');
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, 'task', '--json', 'Initial implementation plan'], {
    cwd: repo,
    env,
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;

  const result = run(
    process.execPath,
    [SCRIPT, 'task', '--write', '--thread', threadId, 'implement the approved plan'],
    { cwd: repo, env },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /resumed thread .* read-only despite the workspace-write request/i);
  assert.equal((await waitForFakeState(binDir, 'appServerStarts')).appServerStarts, 3);
});

test('a direct fallback write does not disturb a busy shared runtime', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-turn');
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, 'task', '--json', 'Target thread plan'], {
    cwd: repo,
    env,
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;
  const broker = loadBrokerSession(repo);
  assert.ok(broker);

  const launched = run(
    process.execPath,
    [SCRIPT, 'task', '--background', '--json', 'keep the shared runtime busy'],
    { cwd: repo, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  await waitFor(
    () => {
      const state = readFakeState(binDir);
      return Array.isArray(state.turnStarts) && state.turnStarts.length >= 2;
    },
    { timeoutMs: 10000 },
  );

  const write = run(
    process.execPath,
    [SCRIPT, 'task', '--write', '--thread', threadId, 'implement while another turn runs'],
    { cwd: repo, env },
  );
  assert.equal(write.status, 0, write.stderr);

  const waited = run(
    process.execPath,
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '15000', '--json'],
    { cwd: repo, env },
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, 'completed');
  assert.equal(fs.existsSync(path.join(binDir, 'fake-codex-state.json')), true);
  assert.equal((await waitForFakeState(binDir, 'appServerStarts')).appServerStarts, 3);
  assert.equal(await brokerEndpointConnectable(broker.endpoint), true);
  assert.equal(loadBrokerSession(repo)?.endpoint, broker.endpoint);
});

test('a resume waits for the broker to finish an abandoned turn instead of running elsewhere', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  // The fake acknowledges the interrupt and lets the turn run out (3 s).
  installFakeCodex(binDir, 'slow-turn-ignores-interrupt');
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const launched = run(
    process.execPath,
    [SCRIPT, 'task', '--background', '--json', 'a turn to abandon'],
    { cwd: repo, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const running = await waitFor(
    () => {
      const job = readCompanionState(repo, env)?.jobs.find((candidate) => candidate.id === jobId);
      return job?.turnId && typeof job.threadId === 'string' && typeof job.pid === 'number'
        ? job
        : null;
    },
    { timeoutMs: 10000 },
  );
  // The worker dies without a word: the broker is left with its turn.
  process.kill(running.pid as number, 'SIGKILL');
  await waitFor(() => !processIsAlive(running.pid as number), { timeoutMs: 10000 });
  const startsBefore = readFakeState(binDir).appServerStarts;

  const resumed = run(
    process.execPath,
    [SCRIPT, 'task', '--thread', running.threadId as string, 'continue the thread'],
    { cwd: repo, env },
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.doesNotMatch(resumed.stderr, /retrying on a private app-server/);
  assert.equal(readFakeState(binDir).appServerStarts, startsBefore, 'no second app-server ran');
});

test('a broker-routed turn fails promptly when the child app-server dies mid-turn', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'die-mid-turn');
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const broker = await ensureBrokerSession(repo, {
    env,
    scriptPath: BROKER_SCRIPT,
    timeoutMs: 4000,
  });
  assert.ok(broker);
  assert.ok(loadBrokerSession(repo));

  const result = await runNodeWithTimeout([SCRIPT, 'task', 'exercise the dying runtime'], {
    cwd: repo,
    env,
    timeoutMs: 5000,
  });
  assert.equal(result.timedOut, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /app-server connection closed before the turn completed/i);
});

test('a resume followed by app-server death fails instead of hanging', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'die-after-resume');
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, 'task', '--json', 'Create a resumable thread'], {
    cwd: repo,
    env,
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;

  const result = await runNodeWithTimeout(
    [SCRIPT, 'task', '--thread', threadId, 'continue after resume'],
    {
      cwd: repo,
      env,
      timeoutMs: 5000,
    },
  );
  assert.equal(result.timedOut, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /app-server connection closed before the turn completed/i);
});

test('a silent app-server turn hits the inactivity deadline and terminalizes the job', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'wedged-turn');
  const env = {
    ...buildEnv(binDir),
    [TURN_INACTIVITY_TIMEOUT_ENV]: '25',
  };
  registerSessionCleanup(t, repo, env);

  const result = await runNodeWithTimeout([SCRIPT, 'task', '--json', 'exercise silent turn'], {
    cwd: repo,
    env,
    timeoutMs: 5000,
  });

  assert.equal(result.timedOut, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sent no turn activity for 25ms/);
  assert.match(JSON.parse(result.stdout).error, /sent no turn activity for 25ms/);
  const job = requireCompanionState(repo, env).jobs.find((entry) => entry.jobClass === 'task');
  assert.ok(job);
  assert.equal(job.status, 'failed');
  assert.equal(job.pid, null);
  assert.match(job.errorMessage, /sent no turn activity for 25ms/);
  const lockDir = path.join(env.CODEX_HOME, 'companion-thread-locks');
  assert.deepEqual(
    fs.existsSync(lockDir) ? fs.readdirSync(lockDir).filter((file) => file.endsWith('.lock')) : [],
    [],
  );
});

test('an unanswered app-server request hits its deadline and terminalizes the job', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'withheld-start-response');
  const env = {
    ...buildEnv(binDir),
    [APP_SERVER_REQUEST_TIMEOUT_ENV]: '250',
  };
  registerSessionCleanup(t, repo, env);

  const result = await runNodeWithTimeout(
    [SCRIPT, 'task', '--json', 'exercise withheld start response'],
    { cwd: repo, env, timeoutMs: 5000 },
  );

  assert.equal(result.timedOut, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /turn\/start timed out after 250ms/);
  assert.match(JSON.parse(result.stdout).error, /turn\/start timed out after 250ms/);
  const job = requireCompanionState(repo, env).jobs.find((entry) => entry.jobClass === 'task');
  assert.ok(job);
  assert.equal(job.status, 'failed');
  assert.equal(job.pid, null);
  assert.match(job.errorMessage, /turn\/start timed out after 250ms/);
  const lockDir = path.join(env.CODEX_HOME, 'companion-thread-locks');
  assert.deepEqual(
    fs.existsSync(lockDir) ? fs.readdirSync(lockDir).filter((file) => file.endsWith('.lock')) : [],
    [],
  );
});

test('background write task results retain the no-file-changes note', (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const launched = run(
    process.execPath,
    [SCRIPT, 'task', '--background', '--write', '--json', 'implement the small fix'],
    { cwd: repo, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const waited = run(
    process.execPath,
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '15000', '--json'],
    { cwd: repo, env },
  );
  assert.equal(waited.status, 0, waited.stderr);

  const result = run(process.execPath, [SCRIPT, 'result', jobId], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Note: this write-capable run recorded no edit-tool file changes;/);
});

test('an endpoint-pinned runtime is never drained after a private write retry', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'stale-write-escalation');
  const env = buildEnv(binDir);
  const sessionDir = makeTempDir('pinned-broker-');
  const endpoint =
    process.platform === 'win32'
      ? `pipe:\\\\.\\pipe\\codex-pinned-${process.pid}-${Date.now()}`
      : `unix:${path.join(sessionDir, 'broker.sock')}`;
  const pidFile = path.join(sessionDir, 'broker.pid');
  const logFile = path.join(sessionDir, 'broker.log');
  const broker = spawnBrokerProcess({
    scriptPath: BROKER_SCRIPT,
    cwd: repo,
    endpoint,
    pidFile,
    logFile,
    env,
  });
  assert.equal(await waitForBrokerEndpoint(endpoint, 4000), true);
  t.after(async () => {
    await sendBrokerShutdown(endpoint).catch(() => {});
    if (broker.pid && processIsAlive(broker.pid)) {
      await waitFor(() => !processIsAlive(broker.pid!), { timeoutMs: 2000 }).catch(() => {});
      if (processIsAlive(broker.pid)) {
        terminateProcessTree(broker.pid);
      }
    }
  });

  const pinnedEnv = {
    ...env,
    CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint,
  };
  const plan = run(process.execPath, [SCRIPT, 'task', '--json', 'Pinned runtime plan'], {
    cwd: repo,
    env: pinnedEnv,
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;
  assert.equal(loadBrokerSession(repo), null);

  const write = run(
    process.execPath,
    [SCRIPT, 'task', '--write', '--thread', threadId, 'implement from the pinned thread'],
    { cwd: repo, env: pinnedEnv },
  );
  assert.equal(write.status, 0, write.stderr);
  assert.equal((await waitForFakeState(binDir, 'appServerStarts')).appServerStarts, 2);
  assert.equal(await brokerEndpointConnectable(endpoint), true);
  assert.equal(process.kill(broker.pid!, 0), true);

  const taskJob = requireCompanionState(repo, pinnedEnv).jobs.find(
    (job) => job.jobClass === 'task',
  );
  assert.match(readJobLog(repo, taskJob!.id, pinnedEnv), /not plugin-owned/i);
});

test(
  'closing a direct app-server client kills a child that ignores stdin EOF and SIGTERM',
  { skip: process.platform === 'win32' },
  async (t) => {
    const binDir = makeTempDir();
    const pidFile = path.join(binDir, 'codex.pid');
    // Answers initialize, then ignores everything that asks it to stop.
    writeExecutable(
      path.join(binDir, 'codex'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
process.stdin.on('end', () => {});
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined) {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`,
    );
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` };
    const client = await CodexAppServerClient.connect(makeTempDir(), { disableBroker: true, env });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    t.after(() => {
      if (processIsAlive(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    });
    assert.equal(processIsAlive(pid), true);

    const started = Date.now();
    await client.close();
    await waitFor(() => !processIsAlive(pid), { timeoutMs: 5000 });
    assert.ok(Date.now() - started < 5000, 'the hard signal followed the ignored polite one');
  },
);

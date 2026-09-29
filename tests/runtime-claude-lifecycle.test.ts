import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { spawn } from 'node:child_process';

import { createCompanionJob } from '../plugins/stereo/src/workflows/companion-jobs.ts';
import { runClaudeTurn } from '../plugins/stereo/src/runtime/claude-runner.ts';
import {
  acquireThreadReservation,
  releaseThreadReservation,
} from '../plugins/stereo/src/runtime/index.ts';
import { TURN_INACTIVITY_TIMEOUT_ENV } from '../plugins/stereo/src/runtime/turn-capture.ts';
import { nowIso, resolveJobFile, upsertJob } from '../plugins/stereo/src/workspace/state.ts';
import { threadReservationPath } from '../plugins/stereo/src/workspace/thread-lock-io.ts';
import {
  buildClaudeEnv,
  claudeFixture,
  fakeClaudeBin,
  installFakeClaude,
  readFakeClaudeState,
  removeFakeClaudeRunDirs,
} from './fake-claude-fixture.ts';
import type { FakeClaudeBin } from './fake-claude-fixture.ts';
import { installFakeCodex } from './fake-codex-fixture.ts';
import { makeTempDir, processIsAlive, waitFor } from './helpers.ts';
import {
  companion,
  initializeBasicRepo,
  readCompanionState,
  readJobLog,
  readJobLogIfReadable,
  readJsonIfReadable,
  registerBrokerReaping,
  requireCompanionState,
  SCRIPT,
} from './runtime-helpers.ts';

// The Claude runtime's job lifecycle end to end, through the companion CLI
// and the fake `claude`: resumes, reservations, cancel, signals, failures,
// timers, and orphaned children. Which launches are refused (same-role
// resumes, runtime mismatches) is pinned with dry runs in
// runtime-tasks-models.test.ts and at the unit level in job-control.test.ts;
// the transport's own kills in claude-transport.test.ts.

registerBrokerReaping();

function findJob(
  repo: string,
  env: NodeJS.ProcessEnv,
  jobId: string,
): Record<string, any> | undefined {
  return readCompanionState(repo, env)?.jobs.find((job) => job.id === jobId);
}

// The prologue shared by every "hold a session" test: queue a background job
// on an interruptible fake (a planner task unless told otherwise), wait until
// it is running, and make sure a failed assertion never strands it.
async function holdSession(
  t: TestContext,
  repo: string,
  options: { args?: string[]; holding?: FakeClaudeBin } = {},
): Promise<{ jobId: string; holding: FakeClaudeBin; job: Record<string, any> }> {
  const holding = options.holding ?? fakeClaudeBin('interruptible');
  const queued = companion(
    [
      ...(options.args ?? ['task', '--model', 'claude:opus', '--role', 'planner', 'hold']),
      '--background',
      '--json',
    ],
    repo,
    holding.env,
  );
  assert.equal(queued.status, 0, queued.stderr);
  const jobId = JSON.parse(queued.stdout).jobId as string;
  t.after(() => {
    companion(['cancel', jobId, '--json'], repo, holding.env);
  });
  const job = await waitFor(
    () => {
      const current = findJob(repo, holding.env, jobId);
      return current?.status === 'running' ? current : null;
    },
    { timeoutMs: 15000 },
  );
  return { jobId, holding, job };
}

// Waits until a held job's fake has written its first events: a reader that
// vanishes while the child is still writing them crashes the child with
// EPIPE, which would prove nothing about who stops it.
function waitForHeldOutput(repo: string, jobId: string, env: NodeJS.ProcessEnv) {
  return waitFor(
    () =>
      /Assistant message captured: Working until told to stop/.test(
        readJobLogIfReadable(repo, jobId, env),
      ),
    { timeoutMs: 15000 },
  );
}

// A resume of `session` as a planner, on the given fake.
function resumePlanner(repo: string, session: string, env: NodeJS.ProcessEnv, prompt: string) {
  return companion(
    ['task', '--json', '--thread', session, '--model', 'claude:opus', '--role', 'planner', prompt],
    repo,
    env,
  );
}

test('--thread resumes a Claude session with the --model and --role given, and only as its role', () => {
  const { repo, binDir, env } = claudeFixture();
  const first = companion(
    ['task', '--json', '--model', 'claude:opus-5.5', '--role', 'planner', 'first'],
    repo,
    env,
  );
  assert.equal(first.status, 0, first.stderr);
  const session = JSON.parse(first.stdout).threadId as string;
  const firstJob = requireCompanionState(repo, env).jobs.find((job) => job.threadId === session);
  assert.equal(firstJob?.runtime, 'claude');
  assert.equal(firstJob?.role, 'planner');

  const resumed = resumePlanner(repo, session, env, 'again');
  assert.equal(resumed.status, 0, resumed.stderr);
  const run = readFakeClaudeState(binDir).lastRun!;
  assert.equal(run.resume, session);
  assert.equal(run.model, 'claude-opus-5-5');
  assert.equal(run.agent, 'stereo-planner');
  const resumedJob = requireCompanionState(repo, env).jobs[0];
  assert.equal(resumedJob?.runtime, 'claude');
  assert.equal(resumedJob?.role, 'planner');
  assert.equal(resumedJob?.model, 'claude-opus-5-5');

  // Roles never share a session: plan-review refuses a planner's session
  // before anything launches.
  const planFile = path.join(repo, 'plan.md');
  fs.writeFileSync(planFile, '# Plan\n\nDo the thing.\n');
  const reviewed = companion(
    [
      'plan-review',
      '--json',
      '--thread',
      session,
      '--model',
      'claude:opus',
      '--plan-file',
      planFile,
    ],
    repo,
    env,
  );
  assert.equal(reviewed.status, 1);
  assert.match(
    JSON.parse(reviewed.stdout).error,
    /^Session \S+ belongs to planner job \S+; a role resumes only its own thread or session, so run the plan-reviewer without --thread\.$/,
  );
  assert.equal(readFakeClaudeState(binDir).runs.length, 2, 'the refusal never launched');

  // The same role continues its own session: the implementer's fix turn.
  const built = companion(
    ['task', '--json', '--write', '--model', 'claude:opus', '--role', 'implementer', 'build it'],
    repo,
    env,
  );
  assert.equal(built.status, 0, built.stderr);
  const buildSession = JSON.parse(built.stdout).threadId as string;
  const fixed = companion(
    [
      'task',
      '--json',
      '--write',
      '--thread',
      buildSession,
      '--model',
      'claude:opus',
      '--role',
      'implementer',
      'fix it',
    ],
    repo,
    env,
  );
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(readFakeClaudeState(binDir).lastRun?.agent, 'stereo-implementer');
  assert.equal(readFakeClaudeState(binDir).lastRun?.resume, buildSession);
});

test('a held Claude session refuses a second run, and cancel skips the Codex interrupt and frees it', async (t) => {
  const { repo, binDir, env } = claudeFixture();
  const { jobId: holdingId, holding } = await holdSession(t, repo, {
    args: ['task', '--model', 'claude:opus', '--role', 'planner', 'hold the session'],
  });

  // A fresh session is reserved as soon as the CLI names it. The lock is
  // rewritten while the run settles in, so it is read like any live file.
  const session = await waitFor(() => readFakeClaudeState(holding.binDir).runs[0]?.sessionId, {
    timeoutMs: 15000,
  });
  const lockPath = threadReservationPath(session);
  await waitFor(
    () =>
      readJsonIfReadable<{ jobId?: string }>(lockPath)?.jobId === holdingId &&
      findJob(repo, env, holdingId)?.threadId === session,
    { timeoutMs: 15000 },
  );

  // Two runs never drive one session at once: the second resume is refused
  // while the first holds the session reservation, like a Codex thread.
  const refused = resumePlanner(repo, session, env, 'me too');
  assert.equal(refused.status, 1);
  assert.match(
    JSON.parse(refused.stdout).error,
    new RegExp(
      `^Thread or session ${session} is already being used by another companion run \\(job ${holdingId}\\)\\. Wait for it or cancel it first\\.$`,
    ),
  );
  assert.deepEqual(readFakeClaudeState(binDir).runs, [], 'the refused run never reached the CLI');
  assert.equal(findJob(repo, env, holdingId)?.status, 'running', 'the holder is untouched');

  const cancelled = companion(['cancel', holdingId, '--json'], repo, holding.env);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.status, 'cancelled');
  // No app-server turn exists for a Claude job: nothing to interrupt.
  assert.equal(payload.turnInterruptAttempted, false);
  assert.equal(payload.turnInterrupted, false);
  assert.equal(fs.existsSync(lockPath), false, 'the reservation is gone once cancel returns');
  const log = readJobLog(repo, holdingId, env);
  assert.doesNotMatch(log, /Requested Codex turn interrupt/);
  assert.doesNotMatch(log, /Codex turn interrupt failed/);
  assert.match(log, /Cancelled by user\./);
  await waitFor(() => findJob(repo, env, holdingId)?.status === 'cancelled', {
    timeoutMs: 10000,
  });
  // The worker rewrites the job file on its way out; read it like a live file.
  await waitFor(
    () =>
      readJsonIfReadable<{ status?: string }>(resolveJobFile(repo, holdingId))?.status ===
      'cancelled',
    { timeoutMs: 10000 },
  );
  await waitFor(() => readFakeClaudeState(holding.binDir).terminated?.signal === 'SIGTERM', {
    timeoutMs: 10000,
  });

  const resumed = resumePlanner(repo, session, env, 'resume after cancel');
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(readFakeClaudeState(binDir).lastRun?.resume, session);
});

test('a Claude plan-review session resumes as a task with the plan-reviewer role', () => {
  const { repo, binDir, env } = claudeFixture();
  const reviewJob = createCompanionJob({
    prefix: 'plan',
    kind: 'plan-review',
    title: 'Claude Plan Review',
    workspaceRoot: repo,
    jobClass: 'review',
    summary: 'reviewed plan',
    model: 'claude-sonnet-5',
    runtime: 'claude',
  });
  const session = 'claude-plan-review-session';
  upsertJob(repo, { ...reviewJob, status: 'completed', threadId: session, completedAt: nowIso() });

  const resumed = companion(
    [
      'task',
      '--json',
      '--thread',
      session,
      '--model',
      'claude:sonnet-5',
      '--role',
      'plan-reviewer',
      'review it again',
    ],
    repo,
    env,
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  const last = readFakeClaudeState(binDir).lastRun!;
  assert.equal(last.resume, session);
  assert.equal(last.model, 'claude-sonnet-5');
  assert.equal(last.effort, 'xhigh', 'the sonnet version default applies');
  assert.equal(last.agent, 'stereo-plan-reviewer');
  assert.equal(last.permissionMode, 'dontAsk');
  const job = requireCompanionState(repo, env).jobs.find((entry) => entry.jobClass === 'task');
  assert.equal(job?.runtime, 'claude');
  assert.equal(job?.role, 'plan-reviewer');
  assert.equal(job?.model, 'claude-sonnet-5');
});

test('a mid-session auth failure is reported as a failed run, not a success', () => {
  const { repo, env } = claudeFixture('auth-expired-result');
  const result = companion(
    ['task', '--json', '--model', 'claude:opus', '--role', 'planner', 'go'],
    repo,
    env,
  );
  assert.equal(result.status, 1);
  assert.match(
    String(requireCompanionState(repo, env).jobs[0]?.summary),
    /^Claude run failed: Not logged in/,
  );
});

// A foreground companion's signal handler never leaves its child behind: the
// polite signal, a synchronous grace, then the hard one, so even a child that
// ignores SIGTERM is gone when the companion is.
test('a signal to a foreground companion stops its live claude child and releases its session', async (t) => {
  const { repo, binDir, env } = claudeFixture('stubborn');
  const child = spawn(
    process.execPath,
    [SCRIPT, 'task', '--json', '--model', 'claude:opus', '--role', 'planner', 'wait for a signal'],
    { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // A timed-out wait must not strand the companion and its waiting fake.
  t.after(() => child.kill('SIGKILL'));
  const session = await waitFor(() => readFakeClaudeState(binDir).runs[0]?.sessionId, {
    timeoutMs: 15000,
  });
  const claudePid = readFakeClaudeState(binDir).runs[0]!.pid;
  t.after(() => {
    if (processIsAlive(claudePid)) {
      process.kill(claudePid, 'SIGKILL');
    }
  });
  const lockPath = threadReservationPath(session);
  const jobId = await waitFor(
    () => {
      const job = readCompanionState(repo, env)?.jobs[0];
      return fs.existsSync(lockPath) && job?.status === 'running' ? (job.id as string) : null;
    },
    { timeoutMs: 15000 },
  );
  await waitForHeldOutput(repo, jobId, env);

  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, {
    timeoutMs: 15000,
  });
  // Gone with the companion (a zombie may take init a moment to reap).
  await waitFor(() => !processIsAlive(claudePid), { timeoutMs: 2000 });
  const cancelled = await waitFor(
    () => {
      const job = findJob(repo, env, jobId);
      return job?.status === 'cancelled' ? job : null;
    },
    { timeoutMs: 15000 },
  );
  assert.equal(cancelled.errorMessage, 'Terminated by SIGTERM.');
  assert.equal(cancelled.threadId, session);
  assert.equal(readFakeClaudeState(binDir).terminated, undefined, 'only SIGKILL ended it');
  // The signal path releases the session once the child is gone, so a
  // successor resumes it.
  assert.equal(fs.existsSync(lockPath), false);
  const successor = fakeClaudeBin();
  const resumed = resumePlanner(repo, session, successor.env, 'resume after the signal');
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(readFakeClaudeState(successor.binDir).lastRun?.resume, session);
  assert.equal(readFakeClaudeState(successor.binDir).lastRun?.agent, 'stereo-planner');
});

test('background Claude jobs go through status and result like Codex jobs', () => {
  const { repo, env } = claudeFixture();

  const queued = companion(
    [
      'task',
      '--background',
      '--json',
      '--model',
      'claude:opus',
      '--role',
      'planner',
      'background plan',
    ],
    repo,
    env,
  );
  assert.equal(queued.status, 0, queued.stderr);
  const { jobId } = JSON.parse(queued.stdout);
  const waited = companion(
    ['status', jobId, '--wait', '--timeout-ms', '15000', '--json'],
    repo,
    env,
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, 'completed');

  const result = companion(['result', jobId, '--json'], repo, env);
  assert.equal(result.status, 0, result.stderr);
  const stored = JSON.parse(result.stdout);
  assert.equal(stored.job.runtime, 'claude');
  const rendered = companion(['result', jobId], repo, env);
  assert.match(rendered.stdout, /Claude session ID: /);
  assert.match(rendered.stdout, /Resume in Claude: claude --resume /);
  assert.doesNotMatch(rendered.stdout, /codex resume/);
});

test('a failed Claude run stores the CLI error on the job record', () => {
  const { repo, env } = claudeFixture('error-result');
  const failed = companion(
    ['task', '--json', '--model', 'claude:opus', '--role', 'planner', 'plan'],
    repo,
    env,
  );
  assert.equal(failed.status, 1);
  const payload = JSON.parse(failed.stdout);
  assert.equal(
    payload.error,
    'Claude run ended with error_during_execution: The model claude-opus-9 does not exist',
  );
  const job = requireCompanionState(repo, env).jobs[0];
  assert.equal(job?.status, 'failed');
  assert.match(String(job?.summary), /does not exist/);
  assert.equal(job?.errorMessage, payload.error);
  // With no output to show, the failure itself is the rendered result.
  const rendered = companion(['result', String(job?.id)], repo, env);
  assert.match(
    rendered.stdout,
    /^Claude run ended with error_during_execution: The model claude-opus-9 does not exist\n/,
  );
});

test('a claude that dies mid-run is a failed run with no result', () => {
  const { repo, env } = claudeFixture('die-mid-run');
  const died = companion(
    ['task', '--json', '--model', 'claude:opus', '--role', 'planner', 'plan'],
    repo,
    env,
  );
  assert.equal(died.status, 1);
  const payload = JSON.parse(died.stdout);
  assert.match(payload.error, /^Claude exited with code 137 before reporting a result/);
  const job = requireCompanionState(repo, env).jobs[0];
  assert.equal(job?.status, 'failed');
  assert.match(String(job?.summary), /before reporting a result/);
  assert.equal(job?.errorMessage, payload.error);
});

test('STEREO_TURN_INACTIVITY_TIMEOUT_MS fails a silent run, keeps its open Bash call as interrupted, and frees the session', () => {
  const { repo, binDir, env } = claudeFixture('slow-after-bash');
  const timedOut = companion(
    ['task', '--json', '--model', 'claude:opus', '--role', 'planner', 'plan'],
    repo,
    { ...env, [TURN_INACTIVITY_TIMEOUT_ENV]: '3000' },
  );
  assert.equal(timedOut.status, 1);
  const payload = JSON.parse(timedOut.stdout);
  assert.match(payload.error, /^Claude produced no output for 3000 ms and was stopped/);
  const session = readFakeClaudeState(binDir).runs[0]!.sessionId;
  assert.equal(payload.threadId, session);
  const job = requireCompanionState(repo, env).jobs[0]!;
  assert.equal(job.status, 'failed');
  assert.match(String(job.summary), /produced no output for 3000 ms/);
  assert.equal(job.threadId, session);

  // The stored record keeps the call, marked as never having reported.
  const stored = JSON.parse(companion(['result', String(job.id), '--json'], repo, env).stdout);
  const executions = stored.storedJob.result.commandExecutions as Array<Record<string, unknown>>;
  assert.equal(executions.length, 1);
  assert.equal(executions[0]!.command, 'npm test');
  assert.equal(executions[0]!.status, 'interrupted');
  assert.equal(executions[0]!.exitCode, null);
  assert.equal(typeof executions[0]!.durationMs, 'number');
  assert.equal('output' in executions[0]!, false);

  // The runner releases the reservation on its way out, so the session is
  // free for a successor at once.
  assert.equal(fs.existsSync(threadReservationPath(session)), false);
  const successor = fakeClaudeBin();
  const resumed = resumePlanner(repo, session, successor.env, 'resume after the timeout');
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(readFakeClaudeState(successor.binDir).lastRun?.resume, session);
});

test('an orphaned Claude child blocks a resume, shows its job stalled, and dies with the cancel', async (t) => {
  const repo = initializeBasicRepo();
  // Both fakes on one PATH entry: the doctor's embedded setup report probes
  // Codex as well, and neither probe may reach a real CLI. The child ignores
  // SIGTERM: whoever settles the job once its worker is gone must escalate.
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  installFakeClaude(binDir, 'stubborn');
  t.after(() => removeFakeClaudeRunDirs(binDir));
  const env = buildClaudeEnv(binDir);
  const { jobId } = await holdSession(t, repo, { holding: { binDir, env } });

  // The spawn progress event patches the child pid onto the index record,
  // the stored job file, and the session lock (what a later acquirer checks).
  const running = await waitFor(
    () => {
      const job = findJob(repo, env, jobId);
      return job?.status === 'running' &&
        typeof job.claudePid === 'number' &&
        typeof job.threadId === 'string'
        ? job
        : null;
    },
    { timeoutMs: 15000 },
  );
  const workerPid = running.pid as number;
  const claudePid = running.claudePid as number;
  const session = running.threadId as string;
  const lockPath = threadReservationPath(session);
  assert.notEqual(claudePid, workerPid);
  t.after(() => {
    if (processIsAlive(claudePid)) {
      process.kill(claudePid, 'SIGKILL');
    }
  });
  await waitFor(
    () =>
      readJsonIfReadable<{ childPid?: number }>(lockPath)?.childPid === claudePid &&
      readJsonIfReadable<{ claudePid?: number }>(resolveJobFile(repo, jobId))?.claudePid ===
        claudePid,
    { timeoutMs: 10000 },
  );
  await waitForHeldOutput(repo, jobId, env);

  // The worker dies without any cleanup: the record stays running, and the
  // headless child, which leads its own process group, keeps running with
  // the session still reserved by a pid that no longer exists.
  process.kill(workerPid, 'SIGKILL');
  await waitFor(() => !processIsAlive(workerPid), { timeoutMs: 10000 });
  assert.equal(processIsAlive(claudePid), true, 'the child survives the worker');
  process.kill(claudePid, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(processIsAlive(claudePid), true, 'the child ignores SIGTERM');

  // The dead owner's lock is not taken over while its child drives the
  // session: the resume names the child's pid to end, and signals nothing.
  const successor = fakeClaudeBin();
  const refused = resumePlanner(repo, session, successor.env, 'resume over the orphan');
  assert.equal(refused.status, 1);
  assert.equal(
    JSON.parse(refused.stdout).error,
    `A previous companion run (job ${jobId}, pid ${workerPid}) is gone, and the Claude process it started (pid ${claudePid}) may still be running on thread or session ${session}. Check that pid ${claudePid} is that Claude process, end it if so (for example \`kill ${claudePid}\`, or Task Manager on Windows), then retry.`,
  );
  assert.deepEqual(readFakeClaudeState(successor.binDir).runs, [], 'the resume never launched');
  assert.equal(fs.existsSync(lockPath), true, 'the lock is left in place');
  assert.equal(processIsAlive(claudePid), true, 'the refusal signals nothing');

  const doctor = companion(['doctor', '--json'], repo, env);
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.deepEqual(
    report.stalledJobs.map((job: { id: string }) => job.id),
    [jobId],
  );
  assert.ok(report.nextSteps.some((step: string) => step.includes(`/stereo:cancel ${jobId}`)));

  // Cancel reaches the child through its recorded pid, escalating to SIGKILL.
  const cancelled = companion(['cancel', jobId, '--json'], repo, env);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.status, 'cancelled');
  assert.equal('killWarning' in payload, false);
  await waitFor(() => !processIsAlive(claudePid), { timeoutMs: 5000 });
  assert.equal(readFakeClaudeState(binDir).terminated, undefined, 'only SIGKILL ended it');
  const log = readJobLog(repo, jobId, env);
  assert.match(
    log,
    new RegExp(`Skipped process termination: worker pid ${workerPid} is no longer running`),
  );
  assert.match(log, new RegExp(`Terminated the Claude process ${claudePid}\\.`));
  const settled = findJob(repo, env, jobId);
  assert.equal(settled?.status, 'cancelled');
  assert.equal(settled?.pid, null);
  assert.equal(settled?.claudePid, null);

  // The dead run's lock stays until the next run of the session takes it over.
  assert.equal(fs.existsSync(lockPath), true);
  const resumed = resumePlanner(repo, session, successor.env, 'resume once the orphan is gone');
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(readFakeClaudeState(successor.binDir).lastRun?.resume, session);
  assert.equal(readFakeClaudeState(successor.binDir).lastRun?.agent, 'stereo-planner');
  assert.equal(fs.existsSync(lockPath), false, 'the successor released the lock it took over');
});

test('a resume whose agents file cannot be prepared releases the session reservation', async () => {
  const { repo, binDir, env } = claudeFixture();
  const sessionId = 'sess-prep-fail';
  const lockPath = threadReservationPath(sessionId);

  // No roles directory under the plugin root: the role definition read
  // fails after the resume has already reserved the session.
  await assert.rejects(
    runClaudeTurn(repo, {
      binary: env.CLAUDE_CODE_EXECPATH,
      model: 'claude-opus-5-5',
      effort: 'high',
      role: 'planner',
      prompt: 'go',
      resumeSessionId: sessionId,
      pluginRoot: makeTempDir(),
      env,
    }),
    (error: NodeJS.ErrnoException) =>
      error.code === 'ENOENT' && /roles[\\/]planner\.md/.test(error.message),
  );
  assert.equal(fs.existsSync(lockPath), false, 'the reservation is released');
  assert.deepEqual(readFakeClaudeState(binDir).runs, [], 'the run never launched');
  // Proof the lock is free rather than held by this live process: a
  // successor reserves the session at once.
  releaseThreadReservation(acquireThreadReservation(sessionId, { jobId: 'successor' }));
});

test('cancel of a background Claude review skips the Codex interrupt and releases its session', async (t) => {
  const repo = initializeBasicRepo();
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');
  const { jobId, holding } = await holdSession(t, repo, {
    args: ['review', '--model', 'claude:opus', 'hold the review'],
  });
  assert.equal(findJob(repo, holding.env, jobId)?.jobClass, 'review');
  const session = await waitFor(() => readFakeClaudeState(holding.binDir).runs[0]?.sessionId, {
    timeoutMs: 15000,
  });
  const lockPath = threadReservationPath(session);
  await waitFor(
    () => fs.existsSync(lockPath) && findJob(repo, holding.env, jobId)?.threadId === session,
    { timeoutMs: 15000 },
  );

  const cancelled = companion(['cancel', jobId, '--json'], repo, holding.env);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.status, 'cancelled');
  assert.equal(payload.turnInterruptAttempted, false);
  assert.equal(payload.turnInterrupted, false);
  const log = readJobLog(repo, jobId, holding.env);
  assert.doesNotMatch(log, /Requested Codex turn interrupt/);
  assert.doesNotMatch(log, /Codex turn interrupt failed/);
  assert.match(log, /Cancelled by user\./);
  await waitFor(() => findJob(repo, holding.env, jobId)?.status === 'cancelled', {
    timeoutMs: 10000,
  });
  assert.equal(fs.existsSync(lockPath), false, 'the session is free again');
  await waitFor(() => readFakeClaudeState(holding.binDir).terminated?.signal === 'SIGTERM', {
    timeoutMs: 10000,
  });
});

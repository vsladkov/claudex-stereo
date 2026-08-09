import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { initGitRepo, makeTempDir, run } from './helpers.ts';
import {
  SCRIPT,
  SESSION_HOOK,
  STOP_HOOK,
  findThreadReservation,
  initializeBasicRepo,
  processIsAlive,
  readCompanionState,
  readFakeState,
  readJobLog,
  registerBrokerReaping,
  registerSessionCleanup,
  requireCompanionState,
  waitFor,
  withCodexHome,
} from './runtime-helpers.ts';
import { terminateProcessTree } from '../plugins/stereo/src/platform/process.ts';
import { loadBrokerSession, saveBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import {
  acquireThreadReservation,
  releaseThreadReservation,
} from '../plugins/stereo/src/runtime/index.ts';
import { resolveDurableStateDir } from '../plugins/stereo/src/workspace/state.ts';

registerBrokerReaping();

const SESSION_HOOK_GUARD = path.join(path.dirname(SESSION_HOOK), 'session-lifecycle-hook.cjs');
const STOP_HOOK_GUARD = path.join(path.dirname(STOP_HOOK), 'stop-review-gate-hook.cjs');

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

test('CommonJS hook guards delegate to the TypeScript entries on supported Node', () => {
  const workspace = makeTempDir();
  const sessionStart = run(process.execPath, [SESSION_HOOK_GUARD, 'SessionStart'], {
    cwd: workspace,
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: workspace }),
  });
  assert.equal(sessionStart.status, 0, sessionStart.stderr);
  assert.equal(sessionStart.stdout, '');
  assert.equal(sessionStart.stderr, '');

  const stop = run(process.execPath, [STOP_HOOK_GUARD], {
    cwd: workspace,
    input: JSON.stringify({ cwd: workspace }),
  });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stdout, '');
  assert.equal(stop.stderr, '');
});

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
    const dead = acquireThreadReservation('status-dead-thread', {
      jobId: 'status-dead-job',
      pid: 2147483647,
    });
    const deadCleanup = acquireThreadReservation('status-dead-cleanup-thread', {
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
    const liveOwner = acquireThreadReservation('status-live-owner-thread', {
      jobId: 'status-live-owner-job',
      pid: process.pid,
    });
    fs.writeFileSync(
      liveOwner.cleanupPath,
      `${JSON.stringify({
        pid: 2147483647,
        jobId: 'status-orphaned-claim-job',
        createdAt: '2026-07-20T12:00:00.000Z',
      })}\n`,
      'utf8',
    );
    return { dead, deadCleanup, liveOwner };
  });

  t.after(() => {
    for (const target of [
      reservations.dead.path,
      reservations.dead.cleanupPath,
      reservations.deadCleanup.path,
      reservations.deadCleanup.cleanupPath,
      reservations.liveOwner.cleanupPath,
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
  assert.equal(setupPayload.strandedReservations.length, 3);
  const cleanupEntry = setupPayload.strandedReservations.find(
    (entry: Record<string, any>) => entry.kind === 'stranded-cleanup',
  );
  const claimEntry = setupPayload.strandedReservations.find(
    (entry: Record<string, any>) => entry.kind === 'orphaned-claim',
  );
  assert.ok(cleanupEntry);
  assert.ok(claimEntry);

  const cleanupStep = setupPayload.nextSteps.find((step: string) =>
    step.includes(`\`${reservations.deadCleanup.path}\``),
  );
  assert.ok(cleanupStep);
  assert.ok(cleanupStep.includes(`\`${reservations.deadCleanup.cleanupPath}\``));
  const claimStep = setupPayload.nextSteps.find((step: string) =>
    step.includes(`\`${reservations.liveOwner.cleanupPath}\``),
  );
  assert.ok(claimStep);
  assert.equal(claimStep.includes(`\`${reservations.liveOwner.path}\``), false);

  const renderedSetup = run(process.execPath, [SCRIPT, 'setup'], { cwd: repo, env });
  assert.equal(renderedSetup.status, 0, renderedSetup.stderr);
  assert.match(renderedSetup.stdout, /- thread reservations: 3 stranded \(see next steps\)/);

  const aggregateStatus = run(process.execPath, [SCRIPT, 'status'], { cwd: repo, env });
  assert.equal(aggregateStatus.status, 0, aggregateStatus.stderr);
  assert.match(aggregateStatus.stdout, /Warnings:/);
  assert.ok(aggregateStatus.stdout.includes(`\`${reservations.dead.path}\``));
  assert.ok(aggregateStatus.stdout.includes(`\`${reservations.deadCleanup.cleanupPath}\``));
  assert.ok(aggregateStatus.stdout.includes(`\`${reservations.liveOwner.cleanupPath}\``));
  assert.equal(aggregateStatus.stdout.includes(`\`${reservations.liveOwner.path}\``), false);

  const referencedStatus = run(process.execPath, [SCRIPT, 'status', jobId], { cwd: repo, env });
  assert.equal(referencedStatus.status, 0, referencedStatus.stderr);
  assert.match(referencedStatus.stdout, /# Codex Job Status[\s\S]*Warnings:/);
  assert.ok(referencedStatus.stdout.includes(`\`${reservations.liveOwner.cleanupPath}\``));

  const referencedJson = run(process.execPath, [SCRIPT, 'status', jobId, '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(referencedJson.status, 0, referencedJson.stderr);
  assert.equal(JSON.parse(referencedJson.stdout).strandedReservations.length, 3);

  const waitedJson = run(
    process.execPath,
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '25', '--json'],
    { cwd: repo, env },
  );
  assert.equal(waitedJson.status, 0, waitedJson.stderr);
  const waitedPayload = JSON.parse(waitedJson.stdout);
  assert.equal(waitedPayload.waitTimedOut, true);
  assert.equal(waitedPayload.strandedReservations.length, 3);

  for (const target of [
    reservations.dead.path,
    reservations.deadCleanup.path,
    reservations.deadCleanup.cleanupPath,
    reservations.liveOwner.cleanupPath,
  ]) {
    fs.unlinkSync(target);
  }

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

test('session start hook exports the Claude session id, transcript path, and plugin data dir', () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), 'claude-env.sh');
  fs.writeFileSync(envFile, '', 'utf8');
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, 'session.jsonl');

  const result = run('node', [SESSION_HOOK, 'SessionStart'], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir,
    },
    input: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'sess-current',
      transcript_path: transcriptPath,
      cwd: repo,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(
    fs.readFileSync(envFile, 'utf8'),
    `export CODEX_COMPANION_SESSION_ID='sess-current'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`,
  );
});

test('session start announces active and newly finished durable jobs once', () => {
  const repo = makeTempDir();
  const codexHome = makeTempDir();
  const env = { ...process.env, CODEX_HOME: codexHome };
  const stateDir = resolveDurableStateDir(repo, codexHome);
  const stateFile = path.join(stateDir, 'state.json');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false,
          roleDefaults: {},
          lastJobAnnouncementAt: '2026-08-01T10:00:00.000Z',
        },
        jobs: [
          {
            id: 'task-running',
            status: 'running',
            jobClass: 'task',
            createdAt: '2026-08-01T10:30:00.000Z',
            updatedAt: '2026-08-01T10:40:00.000Z',
          },
          {
            id: 'plan-finished',
            status: 'completed',
            kind: 'plan-review',
            createdAt: '2026-08-01T10:15:00.000Z',
            completedAt: '2026-08-01T10:45:00.000Z',
            updatedAt: '2026-08-01T10:45:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const first = run(process.execPath, [SESSION_HOOK, 'SessionStart'], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: repo }),
  });
  assert.equal(first.status, 0, first.stderr);
  const hookOutput = JSON.parse(first.stdout);
  assert.equal(hookOutput.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(hookOutput.hookSpecificOutput.additionalContext, /task-running/);
  assert.match(hookOutput.hookSpecificOutput.additionalContext, /plan-finished/);
  assert.equal(
    JSON.parse(fs.readFileSync(stateFile, 'utf8')).config.lastJobAnnouncementAt,
    '2026-08-01T10:45:00.000Z',
  );

  const second = run(process.execPath, [SESSION_HOOK, 'SessionStart'], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: repo }),
  });
  assert.equal(second.status, 0, second.stderr);
  const secondContext = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
  assert.match(secondContext, /task-running/);
  assert.doesNotMatch(secondContext, /plan-finished/);
});

test('session start initializes a watermark silently for jobless durable state', () => {
  const repo = makeTempDir();
  const codexHome = makeTempDir();
  const env = { ...process.env, CODEX_HOME: codexHome };
  const stateDir = resolveDurableStateDir(repo, codexHome);
  const stateFile = path.join(stateDir, 'state.json');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [] }, null, 2)}\n`,
    'utf8',
  );

  const result = run(process.execPath, [SESSION_HOOK, 'SessionStart'], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: repo }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const watermark = JSON.parse(fs.readFileSync(stateFile, 'utf8')).config.lastJobAnnouncementAt;
  assert.equal(Number.isFinite(Date.parse(watermark)), true);
});

test('session start suppresses corrupt durable state failures', () => {
  const repo = makeTempDir();
  const codexHome = makeTempDir();
  const env = { ...process.env, CODEX_HOME: codexHome };
  const stateDir = resolveDurableStateDir(repo, codexHome);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), '{', 'utf8');

  const result = run(process.execPath, [SESSION_HOOK, 'SessionStart'], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: repo }),
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('malformed session hook stdin degrades to empty input', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-turn');
  const sessionId = 'sess-malformed-input';
  const env: NodeJS.ProcessEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: sessionId,
  };
  registerSessionCleanup(t, repo, env);

  const envFile = path.join(makeTempDir(), 'claude-env.sh');
  fs.writeFileSync(envFile, '', 'utf8');
  const started = run(process.execPath, [SESSION_HOOK, 'SessionStart'], {
    cwd: repo,
    env: {
      ...env,
      CLAUDE_ENV_FILE: envFile,
    },
    input: 'not-json{{{',
  });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(
    fs.readFileSync(envFile, 'utf8'),
    `export CLAUDE_PLUGIN_DATA='${env.CLAUDE_PLUGIN_DATA}'\n`,
  );

  const launched = run(
    process.execPath,
    [SCRIPT, 'task', '--background', '--json', 'malformed session cleanup'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  await waitFor(
    () => {
      const job = readCompanionState(repo, env)?.jobs.find((candidate) => candidate.id === jobId);
      return job?.turnId ? job : null;
    },
    { timeoutMs: 10000 },
  );

  assert.ok(loadBrokerSession(repo), 'expected the running job to own a workspace broker');
  const ended = run(process.execPath, [SESSION_HOOK, 'SessionEnd'], {
    cwd: repo,
    env,
    input: 'not-json{{{',
  });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(
    requireCompanionState(repo, env).jobs.some((job) => job.id === jobId),
    false,
  );
  assert.equal(loadBrokerSession(repo), null);
});

test("session end removes only the ending session's active jobs and preserves finished results", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const stateDir = resolveDurableStateDir(repo);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, 'completed.log');
  const runningLog = path.join(jobsDir, 'running.log');
  const otherSessionLog = path.join(jobsDir, 'other.log');
  const completedJobFile = path.join(jobsDir, 'review-completed.json');
  const runningJobFile = path.join(jobsDir, 'review-running.json');
  const otherJobFile = path.join(jobsDir, 'review-other.json');
  fs.writeFileSync(completedLog, 'completed\n', 'utf8');
  fs.writeFileSync(runningLog, 'running\n', 'utf8');
  fs.writeFileSync(otherSessionLog, 'other\n', 'utf8');
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: 'review-completed' }, null, 2), 'utf8');
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: 'review-other' }, null, 2), 'utf8');

  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: repo,
    detached: true,
    stdio: 'ignore',
  });
  sleeper.unref();
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: 'review-running' }, null, 2), 'utf8');

  t.after(() => {
    try {
      process.kill(-sleeper.pid!, 'SIGTERM');
    } catch {
      try {
        process.kill(sleeper.pid!, 'SIGTERM');
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'review-completed',
            status: 'completed',
            title: 'Codex Review',
            sessionId: 'sess-current',
            logFile: completedLog,
            createdAt: '2026-03-18T15:30:00.000Z',
            updatedAt: '2026-03-18T15:31:00.000Z',
          },
          {
            id: 'review-running',
            status: 'running',
            title: 'Codex Review',
            sessionId: 'sess-current',
            pid: sleeper.pid,
            logFile: runningLog,
            createdAt: '2026-03-18T15:32:00.000Z',
            updatedAt: '2026-03-18T15:33:00.000Z',
          },
          {
            id: 'review-other',
            status: 'completed',
            title: 'Codex Review',
            sessionId: 'sess-other',
            logFile: otherSessionLog,
            createdAt: '2026-03-18T15:34:00.000Z',
            updatedAt: '2026-03-18T15:35:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run('node', [SESSION_HOOK, 'SessionEnd'], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: 'sess-current',
    },
    input: JSON.stringify({
      hook_event_name: 'SessionEnd',
      session_id: 'sess-current',
      cwd: repo,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);
  // The ending session's finished job keeps its record and log so
  // /stereo:result still works after the session closes.
  assert.equal(fs.existsSync(completedLog), true);
  assert.equal(fs.existsSync(completedJobFile), true);
  assert.deepEqual(
    fs.readdirSync(path.dirname(otherJobFile)).sort(),
    [
      path.basename(completedJobFile),
      path.basename(completedLog),
      path.basename(otherJobFile),
      path.basename(otherSessionLog),
    ].sort(),
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
  assert.deepEqual(state.jobs.map((job: Record<string, any>) => job.id).sort(), [
    'review-completed',
    'review-other',
  ]);
  assert.equal(
    state.jobs.every((job: Record<string, any>) => job.id !== 'review-running'),
    true,
  );
});

test('stop hook runs a stop-time review task and blocks on findings when the review gate is enabled', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, 'fake-codex-state.json');
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const setup = run('node', [SCRIPT, 'setup', '--enable-review-gate', '--json'], {
    cwd: repo,
    env: buildEnv(binDir),
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run('node', [SCRIPT, 'task', '--write', 'fix the issue'], {
    cwd: repo,
    env: buildEnv(binDir),
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run('node', [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: 'sess-stop-review',
      last_assistant_message: 'I completed the refactor and updated the retry logic.',
    }),
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, 'block');
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, 'utf8'));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(
    fakeState.lastTurnStart.prompt,
    /Run a stop-gate review of the previous Claude turn/i,
  );
  assert.match(
    fakeState.lastTurnStart.prompt,
    /I completed the refactor and updated the retry logic\./,
  );

  const status = run('node', [SCRIPT, 'status'], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: 'sess-stop-review',
    },
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex Stop Gate Review/);
});

test('stop hook logs running tasks to stderr without blocking when the review gate is disabled', () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const stateDir = resolveDurableStateDir(repo);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, 'task-running.log');
  fs.writeFileSync(runningLog, 'running\n', 'utf8');

  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false,
        },
        jobs: [
          {
            id: 'task-live',
            status: 'running',
            title: 'Codex Task',
            jobClass: 'task',
            sessionId: 'sess-current',
            logFile: runningLog,
            createdAt: '2026-03-18T15:32:00.000Z',
            updatedAt: '2026-03-18T15:33:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const blocked = run('node', [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: 'sess-current',
    },
    input: JSON.stringify({ cwd: repo }),
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), '');
  assert.match(blocked.stderr, /Codex task task-live is still running/i);
  assert.match(blocked.stderr, /\/stereo:status/i);
  assert.match(blocked.stderr, /\/stereo:cancel task-live/i);
});

test('stop hook allows the stop when the review gate is enabled and the stop-time review task is clean', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'adversarial-clean');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const setup = run('node', [SCRIPT, 'setup', '--enable-review-gate', '--json'], {
    cwd: repo,
    env: buildEnv(binDir),
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run('node', [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: 'sess-stop-clean' }),
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), '');
});

test('stop hook does not block when Codex is unavailable even if the review gate is enabled', () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, 'setup', '--enable-review-gate', '--json'], {
    cwd: repo,
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: '',
    },
    input: JSON.stringify({ cwd: repo }),
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), '');
  assert.match(allowed.stderr, /Codex is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/stereo:setup/i);
});

test('stop hook runs the actual task when auth status looks stale', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'refreshable-auth');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const setup = run('node', [SCRIPT, 'setup', '--enable-review-gate', '--json'], {
    cwd: repo,
    env: buildEnv(binDir),
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run('node', [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo }),
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, 'block');
  assert.match(payload.reason, /Missing empty-state guard/i);
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

  const live = withCodexHome(env.CODEX_HOME, () =>
    acquireThreadReservation(threadId, {
      jobId: 'holding-job',
      pid: process.pid,
    }),
  );
  const blocked = run(process.execPath, [SCRIPT, 'task', '--thread', threadId, 'competing run'], {
    cwd: repo,
    env,
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /already being used by another Codex run \(job holding-job\)/);
  releaseThreadReservation(live);

  const dead = withCodexHome(env.CODEX_HOME, () =>
    acquireThreadReservation(threadId, {
      jobId: 'crashed-job',
      pid: 2147483647,
    }),
  );
  const stale = run(process.execPath, [SCRIPT, 'task', '--thread', threadId, 'retry after crash'], {
    cwd: repo,
    env,
  });
  assert.notEqual(stale.status, 0);
  assert.match(
    stale.stderr,
    /previous Codex run \(job crashed-job, pid 2147483647\) appears to have crashed/i,
  );
  assert.match(stale.stderr, new RegExp(dead.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.existsSync(dead.path), true);
  releaseThreadReservation(dead);

  const normal = run(process.execPath, [SCRIPT, 'task', '--thread', threadId, 'normal resume'], {
    cwd: repo,
    env,
  });
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(fs.existsSync(dead.path), false);

  const launched = run(
    process.execPath,
    [SCRIPT, 'task', '--background', '--json', '--thread', threadId, 'slow reserved resume'],
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
  const turnStarts: Array<Record<string, any>> = readFakeState(binDir).turnStarts ?? [];
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
  'SIGTERM terminalizes a background job and releases its reservation after orphan completion',
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
      [SCRIPT, 'task', '--background', '--json', '--thread', threadId, 'signal this slow task'],
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
    // Signal-time cleanup still retains in-flight locks; the broker releases
    // this one only after the abandoned turn's interrupt completion arrives.
    await waitFor(() => !fs.existsSync(running.reservation.path), { timeoutMs: 10000 });

    const successor = run(
      process.execPath,
      [SCRIPT, 'task', '--thread', threadId, 'resume after the signalled worker'],
      { cwd: repo, env },
    );
    assert.equal(successor.status, 0, successor.stderr);
    assert.doesNotMatch(successor.stderr, /appears to have crashed while reserving thread/i);
  },
);

test(
  'foreground SIGINT releases its reservation after orphan completion',
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
      [SCRIPT, 'task', '--json', '--thread', threadId, 'interrupt this foreground task'],
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
    // As above, completion—not the signal handler—is the release proof.
    await waitFor(() => !fs.existsSync(running.reservation.path), { timeoutMs: 10000 });

    const successor = run(
      process.execPath,
      [SCRIPT, 'task', '--thread', threadId, 'resume after the foreground signal'],
      { cwd: repo, env },
    );
    assert.equal(successor.status, 0, successor.stderr);
    assert.doesNotMatch(successor.stderr, /appears to have crashed while reserving thread/i);
  },
);

test('/stereo:cancel releases task and plan-review thread reservations', async (t) => {
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
    [SCRIPT, 'task', '--background', '--json', '--thread', threadId, 'slow cancellable task'],
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
  assert.match(JSON.parse(taskCancel.stdout).reservationCleanup, /released|none-found/);
  assert.equal(findThreadReservation(env.CODEX_HOME, threadId), null);
  assert.match(readJobLog(repo, taskJobId, env), /Thread reservation cleanup:/);

  const resumed = run(
    process.execPath,
    [SCRIPT, 'task', '--thread', threadId, 'resume immediately'],
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
  assert.match(JSON.parse(planCancel.stdout).reservationCleanup, /released|none-found/);
  assert.equal(findThreadReservation(env.CODEX_HOME, threadId), null);
  assert.match(readJobLog(repo, planJobId, env), /Thread reservation cleanup:/);
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
    [SCRIPT, 'task', '--background', '--json', '--thread', threadId, 'own the reservation briefly'],
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
  assert.equal(JSON.parse(cancelled.stdout).reservationCleanup, 'mismatch-skipped');
  assert.equal(fs.existsSync(reservation.path), true);
  assert.match(readJobLog(repo, jobId, env), /mismatch-skipped/);
  releaseThreadReservation({
    path: reservation.path,
    token: foreignRecord.token,
  });
});

test('SessionEnd releases reservations for the session jobs it kills', async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-turn');
  const sessionId = 'session-reservation-cleanup';
  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: sessionId,
  };

  const plan = run(process.execPath, [SCRIPT, 'plan-review', '--json', 'Session cleanup target'], {
    cwd: repo,
    env,
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;
  const launched = run(
    process.execPath,
    [SCRIPT, 'task', '--background', '--json', '--thread', threadId, 'session-owned work'],
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

  const ended = run(process.execPath, [SESSION_HOOK, 'SessionEnd'], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      cwd: repo,
    }),
  });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(findThreadReservation(env.CODEX_HOME, threadId), null);
  assert.equal(
    requireCompanionState(repo, env).jobs.some((job) => job.id === jobId),
    false,
  );
});

test('the same thread is exclusive across workspaces and plugin state roots', () => {
  const workspaceA = initializeBasicRepo();
  const workspaceB = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const codexHome = path.join(binDir, 'shared-codex-home');
  const reservation = withCodexHome(codexHome, () =>
    acquireThreadReservation('cross-workspace-thread', {
      jobId: 'workspace-a-job',
      pid: process.pid,
    }),
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
  assert.match(result.stderr, /already being used by another Codex run \(job workspace-a-job\)/);
  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastResume, undefined);
  assert.equal(fakeState.lastThreadStart, undefined);
  assert.deepEqual(fakeState.turnStarts ?? [], []);
  assert.equal(path.dirname(reservation.path), path.join(codexHome, 'companion-thread-locks'));
  releaseThreadReservation(reservation);

  assert.notEqual(workspaceA, workspaceB);
});

test('SessionEnd tears down an idle workspace broker with no kill fallback', async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const first = run(process.execPath, [SCRIPT, 'task', 'warm the broker up'], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const session = loadBrokerSession(repo);
  assert.ok(session, 'expected the task run to auto-start a workspace broker');
  assert.equal(processIsAlive(session.pid), true);

  const cleanup = run(process.execPath, [SESSION_HOOK, 'SessionEnd'], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-idle', cwd: repo }),
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);

  await waitFor(() => !processIsAlive(session.pid), { timeoutMs: 4000 });
  assert.equal(loadBrokerSession(repo), null);
  assert.equal(fs.existsSync(session.sessionDir ?? ''), false);
});

test('SessionEnd leaves a busy shared broker (and its session state) running', async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-turn');
  const env = buildEnv(binDir);

  const launch = run(
    process.execPath,
    [SCRIPT, 'task', '--background', '--json', 'slow shared turn'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;
  await waitFor(
    () => {
      const job = readCompanionState(repo, env)?.jobs.find((candidate) => candidate.id === jobId);
      return job?.turnId ? job : null;
    },
    { timeoutMs: 10000 },
  );

  const session = loadBrokerSession(repo);
  assert.ok(session, 'expected the background task to auto-start a workspace broker');

  // A different session ends while the turn is in flight: the shared broker
  // (and the state the surviving session needs to find it) must survive.
  const cleanup = run(process.execPath, [SESSION_HOOK, 'SessionEnd'], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-other', cwd: repo }),
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);

  assert.equal(
    processIsAlive(session.pid),
    true,
    "busy broker must not be killed by another session's end",
  );
  assert.ok(loadBrokerSession(repo), 'busy broker session state must survive');

  const finished = run(
    process.execPath,
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '15000', '--json'],
    { cwd: repo, env },
  );
  assert.equal(finished.status, 0, finished.stderr);
});

test("SessionEnd reaps the broker after killing this session's own running job", async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-turn');
  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: 'sess-own' };

  const launch = run(
    process.execPath,
    [SCRIPT, 'task', '--background', '--json', 'own slow turn'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;
  await waitFor(
    () => {
      const job = readCompanionState(repo, env)?.jobs.find((candidate) => candidate.id === jobId);
      return job?.turnId ? job : null;
    },
    { timeoutMs: 10000 },
  );

  const session = loadBrokerSession(repo);
  assert.ok(session, 'expected the background task to auto-start a workspace broker');

  // The ending session owns the running job: the hook must kill the job
  // first, then reap the now-idle broker (bounded busy retry covers the
  // orphaned turn winding down after the worker dies).
  const cleanup = run(process.execPath, [SESSION_HOOK, 'SessionEnd'], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-own', cwd: repo }),
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);

  await waitFor(() => !processIsAlive(session.pid), { timeoutMs: 4000 });
  assert.equal(loadBrokerSession(repo), null, 'broker session state must be cleared');
  const job = requireCompanionState(repo, env).jobs.find((candidate) => candidate.id === jobId);
  assert.equal(job, undefined, 'the killed job must leave the index');
});

test('SessionEnd hard-kills only a wedged broker that is provably still alive', async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
    detached: true,
  });
  sleeper.unref();
  assert.ok(sleeper.pid);

  const sessionDir = makeTempDir('wedged-broker-');
  const pidFile = path.join(sessionDir, 'broker.pid');
  fs.writeFileSync(pidFile, String(sleeper.pid), 'utf8');
  saveBrokerSession(repo, {
    endpoint: `unix:${path.join(sessionDir, 'gone.sock')}`,
    pid: sleeper.pid,
    pidFile,
    logFile: path.join(sessionDir, 'broker.log'),
    sessionDir,
  });

  try {
    const cleanup = run(process.execPath, [SESSION_HOOK, 'SessionEnd'], {
      cwd: repo,
      env,
      input: JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 'sess-wedged',
        cwd: repo,
      }),
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);

    // Unreachable endpoint + live pid = wedged: the kill fallback applies.
    await waitFor(() => !processIsAlive(sleeper.pid), { timeoutMs: 4000 });
    assert.equal(loadBrokerSession(repo), null);
  } finally {
    if (processIsAlive(sleeper.pid)) {
      terminateProcessTree(sleeper.pid!);
    }
  }
});

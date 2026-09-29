import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { initGitRepo, makeTempDir, run, waitFor } from './helpers.ts';
import {
  SCRIPT,
  SESSION_HOOK,
  STOP_HOOK,
  initializeBasicRepo,
  readCompanionState,
  registerBrokerReaping,
  registerSessionCleanup,
  requireCompanionState,
  spawnStandIn,
  stopStandIn,
  waitForFakeState,
} from './runtime-helpers.ts';
import { PROCESS_MARKERS } from '../plugins/stereo/src/platform/process.ts';
import { loadBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import { resolveDurableStateDir } from '../plugins/stereo/src/workspace/state.ts';

registerBrokerReaping();

const SESSION_HOOK_GUARD = path.join(path.dirname(SESSION_HOOK), 'session-lifecycle-hook.cjs');
const STOP_HOOK_GUARD = path.join(path.dirname(STOP_HOOK), 'stop-review-gate-hook.cjs');

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
  const ended = run(process.execPath, [SESSION_HOOK, 'SessionEndSweep'], {
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

  // A stand-in worker: SessionEnd kills a recorded pid only while its command
  // line still names the companion, so the sleeper carries that marker.
  const sleeper = spawnStandIn(PROCESS_MARKERS.worker, { cwd: repo });
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: 'review-running' }, null, 2), 'utf8');
  t.after(() => stopStandIn(sleeper));

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

  const result = run('node', [SESSION_HOOK, 'SessionEndSweep'], {
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

test('stop hook runs a stop-time review task and blocks on findings when the review gate is enabled', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
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

  const fakeState = await waitForFakeState(binDir, 'lastTurnStart');
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
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  // The gate is enabled while Codex is set up; it is gone by the Stop hook.
  const env = buildEnv(binDir);
  const setup = run(process.execPath, [SCRIPT, 'setup', '--enable-review-gate', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).reviewGateEnabled, true);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...env,
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

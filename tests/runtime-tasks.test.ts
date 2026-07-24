import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { initGitRepo, makeTempDir, run } from './helpers.ts';
import {
  BROKER_SCRIPT,
  SCRIPT,
  SESSION_HOOK,
  brokerEndpointConnectable,
  initializeBasicRepo,
  processIsAlive,
  readCompanionState,
  readFakeState,
  readJobLog,
  registerBrokerReaping,
  registerSessionCleanup,
  runNodeWithTimeout,
  waitFor,
} from './runtime-helpers.ts';
import { terminateProcessTree } from '../plugins/stereo/src/platform/process.ts';
import {
  ensureBrokerSession,
  loadBrokerSession,
  sendBrokerShutdown,
  spawnBrokerProcess,
  waitForBrokerEndpoint,
} from '../plugins/stereo/src/broker/lifecycle.ts';
import { resolveStateDir } from '../plugins/stereo/src/workspace/state.ts';

registerBrokerReaping();

test('a task-worker bootstrap failure marks the job failed instead of leaving it queued', () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, 'jobs'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'task-ghost',
            status: 'queued',
            title: 'Codex Task',
            jobClass: 'task',
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

  // No per-job file exists, so the worker's bootstrap read fails.
  const result = run(
    'node',
    [SCRIPT, 'task-worker', '--cwd', workspace, '--job-id', 'task-ghost'],
    {
      cwd: workspace,
    },
  );

  assert.notEqual(result.status, 0);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  const ghost = state.jobs.find((job: Record<string, any>) => job.id === 'task-ghost');
  assert.equal(ghost.status, 'failed');
  assert.match(ghost.errorMessage, /No stored job found/);
});

test('task completes when the turn/start response omits the turn object', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'turn-start-no-turn');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  // Regression: a start response without turn.id used to buffer every
  // notification forever and hang the capture.
  const result = run('node', [SCRIPT, 'task', 'finish without a turn id'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test('task runs when the active provider does not require OpenAI login', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'provider-no-auth');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const result = run('node', [SCRIPT, 'task', 'check auth preflight'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test('task runs without auth preflight so Codex can refresh an expired session', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'refreshable-auth');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const result = run('node', [SCRIPT, 'task', 'check refreshable auth'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test('transfer delegates the current Claude session directly to native import', () => {
  const home = makeTempDir();
  const repo = path.join(home, 'repo');
  const binDir = makeTempDir();
  const sessionId = 'sess-native-transfer';
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, '.claude', 'projects', '-repo');
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: 'custom-title', customTitle: 'Native transfer' },
      { type: 'user', cwd: repo, message: { role: 'user', content: 'Initial request' } },
      { type: 'assistant', cwd: repo, message: { role: 'assistant', content: 'Initial answer' } },
      { type: 'user', cwd: repo, message: { role: 'user', content: '/stereo:transfer' } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
    'utf8',
  );
  const result = run('node', [SCRIPT, 'transfer', '--json'], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.equal(payload.threadId, 'thr_1');
  assert.equal(payload.resumeCommand, 'codex resume thr_1');
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.sessionId, sessionId);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, 'fake-codex-state.json'), 'utf8'));
  assert.equal(fakeState.threads.length, 1);
  assert.equal(fakeState.threads[0].ephemeral, false);
  assert.equal(fakeState.threads[0].name, 'Native transfer');
  assert.equal(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message: Record<string, any>) => message.text),
    ['Initial request', 'Initial answer', '/stereo:transfer'],
  );
});

test('transfer reports an actionable upgrade error when native import is unsupported', () => {
  const home = makeTempDir();
  const repo = path.join(home, 'repo');
  const binDir = makeTempDir();
  const projectDir = path.join(home, '.claude', 'projects', '-repo');
  const sourcePath = path.join(projectDir, 'session.jsonl');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, 'external-import-unsupported');
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: 'user', cwd: repo, message: { role: 'user', content: 'Continue this work.' } })}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'transfer', '--source', sourcePath, '--json'], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support Claude session transfer/);
  assert.match(result.stderr, /@openai\/codex@latest/);
  assert.match(JSON.parse(result.stdout).error, /does not support Claude session transfer/);
});

test('transfer fails visibly when native import completes without a ledger record', () => {
  const home = makeTempDir();
  const repo = path.join(home, 'repo');
  const binDir = makeTempDir();
  const projectDir = path.join(home, '.claude', 'projects', '-repo');
  const sourcePath = path.join(projectDir, 'session.jsonl');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, 'external-import-fails');
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: 'user', cwd: repo, message: { role: 'user', content: 'Do not lose this request.' } })}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'transfer', '--source', sourcePath], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not record an imported thread/);
});

test('transfer rejects sources outside the Claude projects directory', () => {
  const home = makeTempDir();
  const repo = path.join(home, 'repo');
  const binDir = makeTempDir();
  const sourcePath = path.join(home, 'session.jsonl');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: 'user', cwd: repo, message: { role: 'user', content: 'Outside source.' } })}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'transfer', '--source', sourcePath], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
});

test('task reports the actual Codex auth error when the run is rejected', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'auth-run-fails');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const result = run('node', [SCRIPT, 'task', 'check failed auth'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication expired; run codex login/);
});

test('task --resume-last resumes the latest persisted task thread', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const firstRun = run('node', [SCRIPT, 'task', 'initial task'], {
    cwd: repo,
    env: buildEnv(binDir),
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run('node', [SCRIPT, 'task', '--resume-last', 'follow up'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Resumed the prior run.\nFollow-up prompt accepted.\n');
});

test('task-resume-candidate returns the latest rescue thread from the current session', () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'task-current',
            status: 'completed',
            title: 'Codex Task',
            jobClass: 'task',
            sessionId: 'sess-current',
            threadId: 'thr_current',
            summary: 'Investigate the flaky test',
            updatedAt: '2026-03-24T20:00:00.000Z',
          },
          {
            id: 'task-other-session',
            status: 'completed',
            title: 'Codex Task',
            jobClass: 'task',
            sessionId: 'sess-other',
            threadId: 'thr_other',
            summary: 'Old rescue run',
            updatedAt: '2026-03-24T20:05:00.000Z',
          },
          {
            id: 'review-current',
            status: 'completed',
            title: 'Codex Review',
            jobClass: 'review',
            sessionId: 'sess-current',
            threadId: 'thr_review',
            summary: 'Review main...HEAD',
            updatedAt: '2026-03-24T20:10:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'task-resume-candidate', '--json'], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: 'sess-current',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, 'sess-current');
  assert.equal(payload.candidate.id, 'task-current');
  assert.equal(payload.candidate.threadId, 'thr_current');
});

test('task --resume-last does not resume a task from another Claude session', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, 'fake-codex-state.json');
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: 'sess-other',
  };
  const currentEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: 'sess-current',
  };

  const firstRun = run('node', [SCRIPT, 'task', 'initial task'], {
    cwd: repo,
    env: otherEnv,
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run('node', [SCRIPT, 'task-resume-candidate', '--json'], {
    cwd: repo,
    env: currentEnv,
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run('node', [SCRIPT, 'task', '--resume-last', 'follow up'], {
    cwd: repo,
    env: currentEnv,
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);

  const fakeState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(fakeState.lastTurnStart.threadId, 'thr_1');
  assert.equal(fakeState.lastTurnStart.prompt, 'initial task');
});

test('task --resume-last ignores running tasks from other Claude sessions', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, 'jobs'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'task-other-running',
            status: 'running',
            title: 'Codex Task',
            jobClass: 'task',
            sessionId: 'sess-other',
            threadId: 'thr_other',
            summary: 'Other session active task',
            updatedAt: '2026-03-24T20:05:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: 'sess-current',
  };
  const status = run('node', [SCRIPT, 'status', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run('node', [SCRIPT, 'task', '--resume-last', 'follow up'], {
    cwd: repo,
    env,
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
});

test('write task output focuses on the Codex result without generic follow-up hints', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const result = run('node', [SCRIPT, 'task', '--write', 'fix the failing test'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    'Handled the requested task.\nTask prompt accepted.\n\nNote: this write-capable run reported no file changes.\n',
  );
});

test('task --resume acts like --resume-last without leaking the flag into the prompt', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, 'fake-codex-state.json');
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const firstRun = run('node', [SCRIPT, 'task', 'initial task'], {
    cwd: repo,
    env: buildEnv(binDir),
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run('node', [SCRIPT, 'task', '--resume', 'follow up'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(fakeState.lastTurnStart.threadId, 'thr_1');
  assert.equal(fakeState.lastTurnStart.prompt, 'follow up');
});

test('task --fresh is treated as routing control and does not leak into the prompt', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, 'fake-codex-state.json');
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const result = run('node', [SCRIPT, 'task', '--fresh', 'diagnose the flaky test'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(fakeState.lastTurnStart.prompt, 'diagnose the flaky test');
});

test('task forwards model selection and reasoning effort to app-server turn/start', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, 'fake-codex-state.json');
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const result = run(
    'node',
    [SCRIPT, 'task', '--model', 'spark', '--effort', 'low', 'diagnose the failing test'],
    {
      cwd: repo,
      env: buildEnv(binDir),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(fakeState.lastTurnStart.model, 'gpt-5.3-codex-spark');
  assert.equal(fakeState.lastTurnStart.effort, 'low');

  const maxResult = run(
    'node',
    [SCRIPT, 'task', '--model', 'spark', '--effort', 'max', 'investigate the parser regression'],
    {
      cwd: repo,
      env: buildEnv(binDir),
    },
  );

  assert.equal(maxResult.status, 0, maxResult.stderr);
  const maxState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(maxState.lastTurnStart.model, 'gpt-5.3-codex-spark');
  assert.equal(maxState.lastTurnStart.effort, 'max');
});

test('task logs reasoning summaries and assistant messages to the job log', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'with-reasoning');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const result = run('node', [SCRIPT, 'task', 'investigate the failing test'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  const log = fs.readFileSync(state.jobs[0].logFile, 'utf8');
  assert.match(log, /Reasoning summary/);
  assert.match(
    log,
    /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/,
  );
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test('task logs subagent reasoning and messages with a subagent prefix', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'with-subagent');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const result = run('node', [SCRIPT, 'task', 'challenge the current design'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  const log = fs.readFileSync(state.jobs[0].logFile, 'utf8');
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger reasoning:/);
  assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  assert.match(log, /Subagent design-challenger:/);
  assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./,
  );
});

test('task waits for the main thread to complete before returning the final result', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'with-subagent');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const result = run('node', [SCRIPT, 'task', 'challenge the current design'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Handled the requested task.\nTask prompt accepted.\n');
});

test('task ignores later subagent messages when choosing the final returned output', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'with-late-subagent-message');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const result = run('node', [SCRIPT, 'task', 'challenge the current design'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Handled the requested task.\nTask prompt accepted.\n');
});

test('task can finish after subagent work even if the parent turn/completed event is missing', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'with-subagent-no-main-turn-completed');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const result = run('node', [SCRIPT, 'task', 'challenge the current design'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Handled the requested task.\nTask prompt accepted.\n');
});

test('task using the shared broker still completes when Codex spawns subagents', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'with-subagent');
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

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run('node', [SCRIPT, 'task', 'challenge the current design'], {
    cwd: repo,
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Handled the requested task.\nTask prompt accepted.\n');
});

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
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

test('commands lazily start and reuse one shared app-server after first use', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, 'fake-codex-state.json');

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

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, 'utf8'));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run('node', [SESSION_HOOK, 'SessionEnd'], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: 'SessionEnd',
      cwd: repo,
    }),
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test('task --write --thread escalates the resumed thread to workspace-write', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, 'fake-codex-state.json');
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const first = run('node', [SCRIPT, 'plan-review', '--json', 'Initial plan draft'], {
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
    'Handled the requested task.\nTask prompt accepted.\n\nNote: this write-capable run reported no file changes.\n',
  );
  const fakeState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(fakeState.lastResume.threadId, threadId);
  assert.equal(fakeState.lastResume.sandbox, 'workspace-write');
  assert.equal(fakeState.lastTurnStart.threadId, threadId);
  assert.equal(fakeState.lastTurnStart.prompt, 'implement the approved plan');
});

test('task routes a registered provider model when resuming an explicit thread', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, 'fake-codex-state.json');
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const first = run('node', [SCRIPT, 'plan-review', '--json', 'Initial plan draft'], {
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
  const fakeState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
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

  const plan = run(
    process.execPath,
    [SCRIPT, 'plan-review', '--json', 'Initial implementation plan'],
    {
      cwd: repo,
      env,
    },
  );
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

  const state = readCompanionState(repo);
  const taskJob = state.jobs.find((job) => job.jobClass === 'task');
  assert.ok(taskJob);
  const log = readJobLog(repo, taskJob.id);
  assert.match(log, /resumed the thread read-only; retrying the write run on a private runtime/i);
  assert.match(log, /Drained the stale shared Codex runtime/);
  assert.equal(fs.existsSync(path.join(binDir, 'fake-codex-state.json')), true);
  const fakeStateAfterRetry = readFakeState(binDir);
  assert.equal(fakeStateAfterRetry.appServerStarts, 2);
  assert.equal(fakeStateAfterRetry.lastResume?.sandbox, 'workspace-write');
  assert.equal(await brokerEndpointConnectable(staleBroker.endpoint), false);
  assert.deepEqual(loadBrokerSession(repo), staleBroker);

  const followUp = run(process.execPath, [SCRIPT, 'task', 'verify the implementation'], {
    cwd: repo,
    env,
  });
  assert.equal(followUp.status, 0, followUp.stderr);
  assert.equal(readFakeState(binDir).appServerStarts, 3);
  assert.notEqual(loadBrokerSession(repo)?.endpoint, staleBroker.endpoint);
});

test('task --write --thread fails clearly when write escalation is refused', (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'resume-never-escalates');
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(
    process.execPath,
    [SCRIPT, 'plan-review', '--json', 'Initial implementation plan'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;

  const result = run(
    process.execPath,
    [SCRIPT, 'task', '--write', '--thread', threadId, 'implement the approved plan'],
    { cwd: repo, env },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /resumed thread .* read-only despite the workspace-write request/i);
  assert.equal(readFakeState(binDir).appServerStarts, 2);
});

test('a direct fallback write does not disturb a busy shared runtime', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-turn');
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, 'plan-review', '--json', 'Target thread plan'], {
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
  assert.equal(readFakeState(binDir).appServerStarts, 2);
  assert.equal(await brokerEndpointConnectable(broker.endpoint), true);
  assert.equal(loadBrokerSession(repo)?.endpoint, broker.endpoint);
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

  const plan = run(
    process.execPath,
    [SCRIPT, 'plan-review', '--json', 'Create a resumable thread'],
    {
      cwd: repo,
      env,
    },
  );
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
  assert.match(result.stdout, /Note: this write-capable run reported no file changes\./);
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
  const plan = run(process.execPath, [SCRIPT, 'plan-review', '--json', 'Pinned runtime plan'], {
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
  assert.equal(readFakeState(binDir).appServerStarts, 2);
  assert.equal(await brokerEndpointConnectable(endpoint), true);
  assert.equal(process.kill(broker.pid!, 0), true);

  const taskJob = readCompanionState(repo).jobs.find((job) => job.jobClass === 'task');
  assert.match(readJobLog(repo, taskJob!.id), /not plugin-owned/i);
});

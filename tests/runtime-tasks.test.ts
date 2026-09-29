import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClaudeEnv, installFakeClaude, readFakeClaudeState } from './fake-claude-fixture.ts';
import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import {
  accountCatalogModels,
  catalogFixture,
  initGitRepo,
  makeTempDir,
  run,
  seedState,
} from './helpers.ts';
import {
  ROOT,
  SCRIPT,
  companion,
  initializeBasicRepo,
  readCompanionState,
  readFakeState,
  registerBrokerReaping,
  requireCompanionState,
  runCliInProcess,
  waitForFakeState,
  withCodexHome,
} from './runtime-helpers.ts';
import { loadBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import { defaultModelEffort } from '../plugins/stereo/src/models/registry.ts';
import {
  STOP_GATE_ORIGIN,
  nowIso,
  resolveDurableStateDir,
  upsertJob,
} from '../plugins/stereo/src/workspace/state.ts';
import type { JobRecord } from '../plugins/stereo/src/workspace/state.ts';
import {
  CODEX_NOT_AUTHENTICATED_ERROR,
  createCompanionJob,
} from '../plugins/stereo/src/workflows/companion-jobs.ts';

registerBrokerReaping();

test('a task-worker bootstrap failure marks the job failed instead of leaving it queued', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
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

test('a stale CLI login status with a healthy app-server account passes the launch preflight', () => {
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

test('task, background review, and plan review reject logged-out launches without job records', () => {
  const cases = [
    ['task', '--json', 'blocked task'],
    ['review', '--background', '--json', '--scope', 'working-tree'],
    ['plan-review', '--json', 'Blocked plan review'],
  ];

  for (const argv of cases) {
    const repo = initializeBasicRepo();
    const binDir = makeTempDir();
    installFakeCodex(binDir, 'logged-out');
    fs.appendFileSync(path.join(repo, 'README.md'), 'dirty\n', 'utf8');
    const env = buildEnv(binDir);

    const result = run(process.execPath, [SCRIPT, ...argv], { cwd: repo, env });

    assert.notEqual(result.status, 0, `${argv[0]} unexpectedly launched`);
    assert.match(
      result.stderr,
      new RegExp(CODEX_NOT_AUTHENTICATED_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.deepEqual(JSON.parse(result.stdout), { error: CODEX_NOT_AUTHENTICATED_ERROR });
    const state = readCompanionState(repo, env);
    assert.equal(state === null || state.jobs.length === 0, true, `${argv[0]} wrote a job record`);
  }
});

test('foreground review and plan review availability failures leave no job record', () => {
  for (const argv of [
    ['review', '--scope', 'working-tree'],
    ['plan-review', 'Unavailable plan review'],
  ]) {
    const repo = initializeBasicRepo();
    fs.appendFileSync(path.join(repo, 'README.md'), 'dirty\n', 'utf8');
    const codexHome = makeTempDir();
    const env = { ...process.env, PATH: '', CODEX_HOME: codexHome };

    const result = run(process.execPath, [SCRIPT, ...argv], { cwd: repo, env });

    assert.notEqual(result.status, 0);
    const state = readCompanionState(repo, env);
    assert.equal(state === null || state.jobs.length === 0, true, `${argv[0]} wrote a job record`);
  }
});

test('task --prompt-file delivers delimiter-bearing content intact', async () => {
  const repo = makeTempDir();
  const payloadDir = makeTempDir();
  const binDir = makeTempDir();
  const payloadPath = path.join(payloadDir, 'task.txt');
  const payload = [
    '<task>',
    'Verify file-based task delivery.',
    'CODEX_PAIR_PLAN',
    'TRAILING_PROMPT_FILE_SENTINEL',
    '</task>',
  ].join('\n');
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(payloadPath, payload, 'utf8');

  const result = run('node', [SCRIPT, 'task', '--prompt-file', payloadPath], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = await waitForFakeState(binDir, 'lastTurnStart');
  assert.equal(fakeState.lastTurnStart.prompt, payload);
  assert.match(fakeState.lastTurnStart.prompt, /TRAILING_PROMPT_FILE_SENTINEL/);
});

test('transfer delegates the current Claude session directly to native import', async () => {
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

  const fakeState = await waitForFakeState(binDir, 'threads');
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

test('task jobs persist per-job token usage separately from cumulative thread usage', () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const first = run('node', [SCRIPT, 'task', 'initial token accounting'], {
    cwd: repo,
    env,
  });
  assert.equal(first.status, 0, first.stderr);

  const second = run('node', [SCRIPT, 'task', '--resume-last', 'second token accounting'], {
    cwd: repo,
    env,
  });
  assert.equal(second.status, 0, second.stderr);

  const jobs = requireCompanionState(repo, env).jobs.filter((job) => job.jobClass === 'task');
  assert.equal(jobs.length, 2);
  const newest = jobs[0]!;
  const oldest = jobs[1]!;
  assert.deepEqual(oldest.tokenUsage.job, {
    totalTokens: 350,
    inputTokens: 280,
    cachedInputTokens: 120,
    cacheWriteInputTokens: 15,
    outputTokens: 70,
    reasoningOutputTokens: 15,
  });
  assert.deepEqual(oldest.tokenUsage.thread, oldest.tokenUsage.job);
  assert.deepEqual(newest.tokenUsage.job, oldest.tokenUsage.job);
  assert.deepEqual(newest.tokenUsage.thread, {
    totalTokens: 700,
    inputTokens: 560,
    cachedInputTokens: 240,
    cacheWriteInputTokens: 30,
    outputTokens: 140,
    reasoningOutputTokens: 30,
  });

  const stateDir = resolveDurableStateDir(repo, env.CODEX_HOME);
  const stored = JSON.parse(
    fs.readFileSync(path.join(stateDir, 'jobs', `${newest.id}.json`), 'utf8'),
  );
  assert.deepEqual(stored.tokenUsage, newest.tokenUsage);

  const status = run('node', [SCRIPT, 'status', newest.id], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Tokens: job 280 in \(43% cached\) \/ 70 out/);
  assert.match(status.stdout, /thread 560 in \/ 140 out/);

  const result = run('node', [SCRIPT, 'result', newest.id], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\nTokens: job 280 in \(43% cached\).*thread 560 in/);
});

test('task token usage includes registered subagent turns in the job aggregate', () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'with-subagent');
  const env = buildEnv(binDir);

  const result = run('node', [SCRIPT, 'task', 'challenge token accounting'], {
    cwd: repo,
    env,
  });
  assert.equal(result.status, 0, result.stderr);

  const job = requireCompanionState(repo, env).jobs.find(
    (candidate) => candidate.jobClass === 'task',
  );
  assert.ok(job);
  assert.deepEqual(job.tokenUsage.job, {
    totalTokens: 1050,
    inputTokens: 840,
    cachedInputTokens: 360,
    cacheWriteInputTokens: 45,
    outputTokens: 210,
    reasoningOutputTokens: 45,
  });
  assert.equal(job.tokenUsage.thread.totalTokens, 350);
  assert.equal(job.tokenUsage.modelContextWindow, 258000);
});

test('task-resume-candidate returns the latest rescue thread from the current session', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
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

test('task --resume-last does not resume a task from another Claude session', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
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

  const fakeState = await waitForFakeState(binDir, 'lastTurnStart');
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
  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: 'sess-current',
  };

  const stateDir = resolveDurableStateDir(repo, env.CODEX_HOME);
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
    'Handled the requested task.\nTask prompt accepted.\n\nNote: this write-capable run recorded no edit-tool file changes; shell commands may still have changed files.\n',
  );
});

test('task --resume acts like --resume-last without leaking the flag into the prompt', async () => {
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

  const result = run('node', [SCRIPT, 'task', '--resume', 'follow up'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = await waitForFakeState(binDir, 'lastTurnStart');
  assert.equal(fakeState.lastTurnStart.threadId, 'thr_1');
  assert.equal(fakeState.lastTurnStart.prompt, 'follow up');
});

test('task --fresh is treated as routing control and does not leak into the prompt', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
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
  const fakeState = await waitForFakeState(binDir, 'lastTurnStart');
  assert.equal(fakeState.lastTurnStart.prompt, 'diagnose the flaky test');
});

test('task --output-schema rejects unreadable or invalid schemas before starting a turn', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  const env = buildEnv(binDir);

  const missingSchemaPath = path.join(repo, 'missing-output-schema.json');
  const missing = run(
    process.execPath,
    [SCRIPT, 'task', '--json', '--output-schema', missingSchemaPath, 'review the implementation'],
    { cwd: repo, env },
  );

  assert.equal(missing.status, 1);
  const missingPayload = JSON.parse(missing.stdout);
  assert.deepEqual(Object.keys(missingPayload), ['error']);
  assert.match(missingPayload.error, /ENOENT/);
  assert.equal(readFakeState(binDir).lastTurnStart, undefined);
  assert.equal(readCompanionState(repo, env), null);

  const invalidSchemaPath = path.join(repo, 'invalid-output-schema.json');
  fs.writeFileSync(invalidSchemaPath, '{ not valid JSON\n', 'utf8');
  const invalid = run(
    process.execPath,
    [SCRIPT, 'task', '--json', '--output-schema', invalidSchemaPath, 'review the implementation'],
    { cwd: repo, env },
  );

  assert.equal(invalid.status, 1);
  const invalidPayload = JSON.parse(invalid.stdout);
  assert.deepEqual(Object.keys(invalidPayload), ['error']);
  assert.match(invalidPayload.error, /JSON|position/i);
  assert.equal(readFakeState(binDir).lastTurnStart, undefined);
  assert.equal(readCompanionState(repo, env), null);
});

test('task logs reasoning summaries and assistant messages to the job log', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'with-reasoning');
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const env = buildEnv(binDir);
  const result = run('node', [SCRIPT, 'task', 'investigate the failing test'], {
    cwd: repo,
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveDurableStateDir(repo, env.CODEX_HOME);
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

  const env = buildEnv(binDir);
  const result = run('node', [SCRIPT, 'task', 'challenge the current design'], {
    cwd: repo,
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveDurableStateDir(repo, env.CODEX_HOME);
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

test('a Codex --resume-last skips newer Claude jobs and --role gives a Codex task the default effort', async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  const first = run('node', [SCRIPT, 'task', '--json', '--model', 'sol', 'first codex task'], {
    cwd: repo,
    env,
  });
  assert.equal(first.status, 0, first.stderr);
  const codexThread = JSON.parse(first.stdout).threadId as string;
  // A newer Claude job in the same workspace must not become the Codex resume target.
  const claudeJob = createCompanionJob({
    prefix: 'task',
    kind: 'task',
    title: 'Claude Task',
    workspaceRoot: repo,
    jobClass: 'task',
    summary: 'claude',
    model: 'opus',
    runtime: 'claude',
  });
  // Seed under the CODEX_HOME the CLI runs with, or the job is invisible to it.
  withCodexHome(env.CODEX_HOME, () =>
    upsertJob(repo, {
      ...claudeJob,
      status: 'completed',
      threadId: 'claude-session-uuid',
      completedAt: nowIso(),
    }),
  );
  const resumed = run(
    'node',
    [SCRIPT, 'task', '--json', '--model', 'sol', '--resume-last', 'again'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal((await waitForFakeState(binDir, 'lastResume')).lastResume.threadId, codexThread);
  const candidate = JSON.parse(
    run('node', [SCRIPT, 'task-resume-candidate', '--json'], { cwd: repo, env }).stdout,
  );
  assert.equal(candidate.candidate?.threadId, codexThread);

  const roled = run(
    'node',
    [SCRIPT, 'task', '--json', '--model', 'sol', '--role', 'planner', 'pair role'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(roled.status, 0, roled.stderr);
  assert.equal(
    (await waitForFakeState(binDir, 'lastTurnStart')).lastTurnStart.effort,
    defaultModelEffort('gpt-6-sol', { catalog: catalogFixture(accountCatalogModels()) }),
    'a role run takes the default effort',
  );
  const plain = run('node', [SCRIPT, 'task', '--json', '--model', 'sol', 'plain'], {
    cwd: repo,
    env,
  });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(
    (await waitForFakeState(binDir, 'lastTurnStart')).lastTurnStart.effort ?? null,
    null,
    'a plain task injects none',
  );
});

test('a bare --thread that no job record knows stays a Codex thread', async () => {
  const repo = initializeBasicRepo();
  const codexBin = makeTempDir();
  installFakeCodex(codexBin);
  const claudeBin = makeTempDir();
  installFakeClaude(claudeBin);
  const codexEnv = buildEnv(codexBin);
  const env = buildClaudeEnv(claudeBin, codexEnv);

  const first = run('node', [SCRIPT, 'task', '--json', '--model', 'sol', 'seed a thread'], {
    cwd: repo,
    env,
  });
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout).threadId as string;
  // Drop the record: the thread still exists in Codex, but no job names it.
  withCodexHome(codexEnv.CODEX_HOME, () => seedState(repo, { jobs: [] }));
  assert.equal(requireCompanionState(repo, env).jobs.length, 0);

  const resumed = run('node', [SCRIPT, 'task', '--json', '--thread', threadId, 'carry on'], {
    cwd: repo,
    env,
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).threadId, threadId);
  // The resumed turn starts after the resume, so a state holding it holds both.
  const fakeState = await waitForFakeState(codexBin, 'lastTurnStart');
  assert.equal(fakeState.lastResume?.threadId, threadId);
  assert.equal(fakeState.lastTurnStart?.threadId, threadId);
  assert.deepEqual(readFakeClaudeState(claudeBin).runs, [], 'the Claude CLI is never consulted');
  const job = requireCompanionState(repo, env).jobs[0];
  assert.equal(job?.runtime, 'codex');
  assert.equal(job?.threadId, threadId);
  assert.equal(job?.status, 'completed');
});

test('a Codex task whose turn fails after reporting is a failed job that shows the failure first', () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'failed-turn');
  const env = buildEnv(binDir);

  const result = run(process.execPath, [SCRIPT, 'task', '--json', 'do the thing'], {
    cwd: repo,
    env,
  });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 1);
  assert.equal(payload.rawOutput, 'Handled the requested task.\nTask prompt accepted.');
  assert.equal(payload.error, 'Codex hit the context window limit before finishing.');

  const job = requireCompanionState(repo, env).jobs[0]!;
  assert.equal(job.status, 'failed');
  assert.equal(job.errorMessage, payload.error);
  // Failure first: the summary is the failure, not the report's first line.
  assert.equal(job.summary, 'Codex hit the context window limit before finishing.');

  const rendered = run(process.execPath, [SCRIPT, 'result', job.id], { cwd: repo, env });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(
    rendered.stdout,
    /Handled the requested task\.\nTask prompt accepted\.\n\nRun failed: Codex hit the context window limit before finishing\.\n/,
  );
});

test('a Codex --resume-last skips a newer pair-role job and resumes the last rescue thread', async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  const first = run('node', [SCRIPT, 'task', '--json', 'first rescue'], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const rescueThread = JSON.parse(first.stdout).threadId as string;

  // A newer planner run in the same workspace belongs to a pair command and
  // is never what "continue the last Codex work" means.
  const roled = createCompanionJob({
    prefix: 'task',
    kind: 'task',
    title: 'Codex Task',
    workspaceRoot: repo,
    jobClass: 'task',
    summary: 'planner run',
    model: 'gpt-6-sol',
    role: 'planner',
  });
  withCodexHome(env.CODEX_HOME, () =>
    upsertJob(repo, {
      ...roled,
      status: 'completed',
      threadId: 'thr_planner_role',
      completedAt: nowIso(),
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  const newest = requireCompanionState(repo, env).jobs[0];
  assert.equal(newest?.id, roled.id, 'the role-bearing job is the newest record');
  assert.equal(newest?.kindLabel, 'planner');

  const candidate = JSON.parse(
    run('node', [SCRIPT, 'task-resume-candidate', '--json'], { cwd: repo, env }).stdout,
  );
  assert.equal(candidate.available, true);
  assert.equal(candidate.candidate.threadId, rescueThread);
  assert.notEqual(candidate.candidate.id, roled.id);

  const resumed = run('node', [SCRIPT, 'task', '--json', '--resume-last', 'again'], {
    cwd: repo,
    env,
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).threadId, rescueThread);
  assert.equal((await waitForFakeState(binDir, 'lastResume')).lastResume.threadId, rescueThread);
});

// Seed a workspace job index directly, for the in-process resume lookups.
function writeStateJobs(workspace: string, jobs: JobRecord[]): void {
  const stateDir = resolveDurableStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, 'jobs'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs }, null, 2)}\n`,
    'utf8',
  );
}

test('task-resume-candidate reads the job index of --workspace, not of the cwd', async () => {
  const workspace = makeTempDir();
  const foreignCwd = makeTempDir();
  writeStateJobs(workspace, [
    {
      id: 'task-isolated',
      status: 'completed',
      title: 'Codex Task',
      jobClass: 'task',
      sessionId: 'sess-resume-workspace',
      threadId: 'thr_isolated',
      updatedAt: '2026-09-25T10:00:00.000Z',
    },
  ]);
  const env = { CODEX_COMPANION_SESSION_ID: 'sess-resume-workspace' };

  const viaWorkspace = await runCliInProcess(
    ['task-resume-candidate', '--cwd', foreignCwd, '--workspace', workspace, '--json'],
    env,
  );
  assert.equal(viaWorkspace.status, 0, viaWorkspace.stderr);
  const payload = JSON.parse(viaWorkspace.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.candidate.id, 'task-isolated');
  assert.equal(payload.candidate.threadId, 'thr_isolated');

  const viaCwd = await runCliInProcess(
    ['task-resume-candidate', '--cwd', foreignCwd, '--json'],
    env,
  );
  assert.equal(viaCwd.status, 0, viaCwd.stderr);
  assert.equal(JSON.parse(viaCwd.stdout).available, false);

  const missing = path.join(foreignCwd, 'missing');
  const invalid = await runCliInProcess(
    ['task-resume-candidate', '--workspace', missing, '--json'],
    env,
  );
  assert.equal(invalid.status, 1);
  assert.deepEqual(JSON.parse(invalid.stdout), {
    error: `--workspace ${missing} is not an existing directory.`,
  });
});

test('task-resume-candidate skips a newer stop-gate job for the older rescue', async () => {
  const workspace = makeTempDir();
  writeStateJobs(workspace, [
    {
      id: 'task-gate',
      status: 'completed',
      title: 'Codex Stop Gate Review',
      kind: 'task',
      kindLabel: 'stop-gate',
      jobClass: 'task',
      origin: STOP_GATE_ORIGIN,
      sessionId: 'sess-stop-gate',
      threadId: 'thr_gate',
      updatedAt: '2026-09-25T10:05:00.000Z',
    },
    {
      id: 'task-rescue',
      status: 'completed',
      title: 'Codex Task',
      kind: 'task',
      jobClass: 'task',
      sessionId: 'sess-stop-gate',
      threadId: 'thr_rescue',
      updatedAt: '2026-09-25T10:00:00.000Z',
    },
  ]);

  const result = await runCliInProcess(
    ['task-resume-candidate', '--workspace', workspace, '--json'],
    { CODEX_COMPANION_SESSION_ID: 'sess-stop-gate' },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.candidate.id, 'task-rescue');
  assert.equal(payload.candidate.threadId, 'thr_rescue');
});

// ---------------------------------------------------------------------------
// The task payload on Codex: a schema's parsed result and the effort, and no
// edit order (a Claude runner capture; see claude-runner.test.ts)

const SCHEMAS = path.join(ROOT, 'plugins', 'stereo', 'schemas');
const REVIEW_SCHEMA = path.join(SCHEMAS, 'review-output.schema.json');
const IMPLEMENTATION_REVIEW_SCHEMA = path.join(SCHEMAS, 'implementation-review-output.schema.json');

function codexFixture(): { repo: string; env: NodeJS.ProcessEnv } {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  return { repo, env: buildEnv(binDir) };
}

test('a Codex task with an output schema reports the parsed result and the effort', () => {
  const { repo, env } = codexFixture();
  const result = companion(
    ['task', '--json', '--effort', 'low', '--output-schema', REVIEW_SCHEMA, 'review it'],
    repo,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result?.verdict, 'approve');
  assert.equal(payload.parseError, null);
  assert.equal(payload.effort, 'low');
  assert.equal('lastEditOrder' in payload, false, 'the edit order is a Claude capture');
});

test('a Codex task whose answer does not parse reports the parse error', () => {
  const { repo, env } = codexFixture();
  const result = companion(
    ['task', '--json', '--output-schema', IMPLEMENTATION_REVIEW_SCHEMA, 'check it'],
    repo,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, null);
  assert.equal(typeof payload.parseError, 'string');
  assert.ok(payload.parseError.length > 0);
  assert.equal(payload.rawOutput, 'Handled the requested task.\nTask prompt accepted.');
});

test('a Codex task without a schema carries the effort but no parsed result', () => {
  const { repo, env } = codexFixture();
  const result = companion(['task', '--json', 'do the thing'], repo, env);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal('effort' in payload, true);
  assert.equal('result' in payload, false);
  assert.equal('parseError' in payload, false);
});

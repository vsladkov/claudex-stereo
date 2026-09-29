import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { initGitRepo, makeTempDir, run, waitFor } from './helpers.ts';
import {
  SCRIPT,
  initializeBasicRepo,
  readCompanionState,
  registerBrokerReaping,
  registerSessionCleanup,
} from './runtime-helpers.ts';
import { resolveDurableStateDir, upsertJob } from '../plugins/stereo/src/workspace/state.ts';

registerBrokerReaping();

test('status --usage aggregates retained job usage and rejects job ids or --wait', () => {
  const repo = makeTempDir();
  const stateHome = makeTempDir('usage-state-home-');
  initGitRepo(repo);
  const env = {
    ...process.env,
    CODEX_HOME: stateHome,
    CODEX_COMPANION_SESSION_ID: 'sess-usage',
  };
  const stateDir = resolveDurableStateDir(repo, stateHome);
  fs.mkdirSync(path.join(stateDir, 'jobs'), { recursive: true });
  const usage = {
    job: {
      inputTokens: 80,
      cachedInputTokens: 20,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      totalTokens: 100,
      cacheWriteInputTokens: 0,
    },
    thread: {
      inputTokens: 8000,
      cachedInputTokens: 2000,
      outputTokens: 2000,
      reasoningOutputTokens: 500,
      totalTokens: 10000,
      cacheWriteInputTokens: 0,
    },
    modelContextWindow: 258000,
  };
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'review-usage',
            status: 'completed',
            kind: 'review',
            jobClass: 'review',
            sessionId: 'sess-usage',
            model: 'gpt-5.6-sol',
            tokenUsage: usage,
          },
          {
            id: 'task-no-usage',
            status: 'completed',
            kind: 'task',
            jobClass: 'task',
            sessionId: 'sess-usage',
            model: null,
          },
          {
            id: 'other-session',
            status: 'completed',
            kind: 'review',
            jobClass: 'review',
            sessionId: 'sess-other',
            model: 'gpt-5.6-terra',
            tokenUsage: usage,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'status', '--usage', '--json'], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.scope, 'session');
  assert.deepEqual(snapshot.window, {
    retainedJobs: 3,
    countedJobs: 2,
    maxRetainedJobs: 50,
  });
  assert.equal(snapshot.totals.jobs, 2);
  assert.equal(snapshot.totals.jobsWithUsage, 1);
  assert.equal(snapshot.totals.totalTokens, 100);
  assert.equal(
    snapshot.byKind.find((group: { key: string }) => group.key === 'review').totalTokens,
    100,
  );
  assert.equal(snapshot.byModel.find((group: { key: string }) => group.key === '-').jobs, 1);

  for (const [args, expected] of [
    [['status', '--usage', 'review-usage', '--json'], '`status --usage` does not take a job id.'],
    [['status', '--usage', '--wait', '--json'], '`status --usage` cannot be combined with --wait.'],
  ] as const) {
    const invalid = run('node', [SCRIPT, ...args], { cwd: repo, env });
    assert.notEqual(invalid.status, 0);
    assert.equal(JSON.parse(invalid.stdout).error, expected);
    assert.equal(invalid.stderr.trim(), expected);
  }
});

test('status shows a provider-qualified model for an active background task', async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'interruptible-slow-task');
  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: 'sess-model-background',
  };
  registerSessionCleanup(t, repo, env);

  const launched = run(
    'node',
    [SCRIPT, 'task', '--background', '--model', 'kimi', '--json', 'inspect model routing'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId as string;

  await waitFor(
    () => {
      return readCompanionState(repo, env)?.jobs.find(
        (job: Record<string, unknown>) => job.id === jobId && job.status === 'running',
      );
    },
    { timeoutMs: 10000 },
  );

  const jsonStatus = run('node', [SCRIPT, 'status', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(jsonStatus.status, 0, jsonStatus.stderr);
  const snapshot = JSON.parse(jsonStatus.stdout);
  const job = snapshot.running.find((entry: Record<string, unknown>) => entry.id === jobId);
  assert.equal(job.model, 'kimi-k3');
  assert.equal(job.modelDisplay, 'kimi-k3@moonshot');

  const renderedStatus = run('node', [SCRIPT, 'status'], {
    cwd: repo,
    env,
  });
  assert.equal(renderedStatus.status, 0, renderedStatus.stderr);
  assert.match(
    renderedStatus.stdout,
    new RegExp(`\\| ${jobId} \\| rescue \\| kimi-k3@moonshot \\| running \\|`),
  );

  const cancelled = run('node', [SCRIPT, 'cancel', jobId, '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(cancelled.status, 0, cancelled.stderr);
});

test('foreground task status and result retain the provider-qualified model', () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const task = run('node', [SCRIPT, 'task', '--model', 'kimi', 'inspect model routing'], {
    cwd: repo,
    env,
  });
  assert.equal(task.status, 0, task.stderr);

  const jsonStatus = run('node', [SCRIPT, 'status', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(jsonStatus.status, 0, jsonStatus.stderr);
  const snapshot = JSON.parse(jsonStatus.stdout);
  assert.equal(snapshot.latestFinished.model, 'kimi-k3');
  assert.equal(snapshot.latestFinished.modelDisplay, 'kimi-k3@moonshot');

  const renderedStatus = run('node', [SCRIPT, 'status'], {
    cwd: repo,
    env,
  });
  assert.equal(renderedStatus.status, 0, renderedStatus.stderr);
  assert.match(renderedStatus.stdout, /Model: kimi-k3@moonshot/);

  const result = run('node', [SCRIPT, 'result'], {
    cwd: repo,
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Model: kimi-k3@moonshot/);
});

test('status shows phases, hints, and the latest finished job', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, 'review-live.log');
  const progressMessages = [
    'Starting Codex Review.',
    'Thread ready (thr_1).',
    'Turn started (turn_1).',
    'Searching: status implementation',
    'Running command: npm test',
    'Reviewer started: current changes',
  ];
  fs.writeFileSync(
    logFile,
    progressMessages
      .map((message, index) => `[2026-03-18T15:30:0${index}.000Z] ${message}`)
      .join('\n'),
    'utf8',
  );

  const finishedLogFile = path.join(jobsDir, 'review-done.log');
  fs.writeFileSync(finishedLogFile, '[2026-03-18T15:11:10.000Z] Review output\n', 'utf8');
  const finishedJobFile = path.join(jobsDir, 'review-done.json');
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: 'review-done',
        status: 'completed',
        title: 'Codex Review',
        rendered: '# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n',
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
            id: 'review-live',
            kind: 'review',
            kindLabel: 'review',
            status: 'running',
            title: 'Codex Review',
            jobClass: 'review',
            phase: 'reviewing',
            threadId: 'thr_1',
            summary: 'Review working tree diff',
            logFile,
            createdAt: '2026-03-18T15:30:00.000Z',
            startedAt: '2026-03-18T15:30:01.000Z',
            updatedAt: '2026-03-18T15:30:03.000Z',
          },
          {
            id: 'review-done',
            status: 'completed',
            title: 'Codex Review',
            jobClass: 'review',
            threadId: 'thr_done',
            summary: 'Review main...HEAD',
            logFile: finishedLogFile,
            createdAt: '2026-03-18T15:10:00.000Z',
            startedAt: '2026-03-18T15:10:05.000Z',
            completedAt: '2026-03-18T15:11:10.000Z',
            updatedAt: '2026-03-18T15:11:10.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'status'], {
    cwd: workspace,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(
    result.stdout,
    /\| Job \| Kind \| Model \| Status \| Phase \| Elapsed \| Session ID \| Summary \| Actions \|/,
  );
  assert.match(
    result.stdout,
    /\| review-live \| review \| - \| running \| reviewing \| .* \| thr_1 \| Review working tree diff \|/,
  );
  assert.match(result.stdout, /`\/stereo:status review-live`<br>`\/stereo:cancel review-live`/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Session runtime: direct startup/);
  // Non-verbose output is the documented compact shape: the table carries the
  // running job; Live details and Progress blocks are verbose-only.
  assert.doesNotMatch(result.stdout, /Live details:/);
  assert.doesNotMatch(result.stdout, /Progress:/);
  for (const message of progressMessages) {
    assert.equal(result.stdout.includes(message), false);
  }
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /Codex session ID: thr_done/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_done/);
  assert.doesNotMatch(result.stdout, / {2}(?:Created|Started|Completed):/);
  assert.equal(result.stdout.includes(finishedLogFile), false);

  const verboseResult = run('node', [SCRIPT, 'status', '--verbose'], {
    cwd: workspace,
  });

  assert.equal(verboseResult.status, 0, verboseResult.stderr);
  assert.match(verboseResult.stdout, /Live details:/);
  assert.match(verboseResult.stdout, /Progress:/);
  assert.match(verboseResult.stdout, /Phase: reviewing/);
  assert.match(verboseResult.stdout, /Codex session ID: thr_1/);
  assert.match(verboseResult.stdout, /Resume in Codex: codex resume thr_1/);
  for (const message of progressMessages) {
    assert.equal(verboseResult.stdout.includes(message), true);
  }
  assert.match(verboseResult.stdout, / {2}Created: 2026-03-18T15:30:00\.000Z/);
  assert.match(verboseResult.stdout, / {2}Completed: 2026-03-18T15:11:10\.000Z/);
  assert.equal(verboseResult.stdout.includes(finishedLogFile), true);

  const verboseJsonResult = run('node', [SCRIPT, 'status', '--verbose', '--json'], {
    cwd: workspace,
  });

  assert.equal(verboseJsonResult.status, 0, verboseJsonResult.stderr);
  const verbosePayload = JSON.parse(verboseJsonResult.stdout);
  assert.equal(verbosePayload.running[0].progressPreview.length, 6);

  const singleRunningResult = run('node', [SCRIPT, 'status', 'review-live', '--verbose'], {
    cwd: workspace,
  });

  assert.equal(singleRunningResult.status, 0, singleRunningResult.stderr);
  for (const message of progressMessages) {
    assert.equal(singleRunningResult.stdout.includes(message), true);
  }
  assert.match(singleRunningResult.stdout, / {2}Created: 2026-03-18T15:30:00\.000Z/);
  assert.match(singleRunningResult.stdout, / {2}Started: 2026-03-18T15:30:01\.000Z/);

  const waitResult = run(
    'node',
    [SCRIPT, 'status', 'review-live', '--verbose', '--wait', '--timeout-ms', '25', '--json'],
    { cwd: workspace },
  );

  assert.equal(waitResult.status, 0, waitResult.stderr);
  const waitPayload = JSON.parse(waitResult.stdout);
  assert.equal(waitPayload.waitTimedOut, true);
  assert.equal(waitPayload.job.progressPreview.length, 6);

  const singleCompletedResult = run('node', [SCRIPT, 'status', 'review-done', '--verbose'], {
    cwd: workspace,
  });

  assert.equal(singleCompletedResult.status, 0, singleCompletedResult.stderr);
  assert.match(singleCompletedResult.stdout, / {2}Completed: 2026-03-18T15:11:10\.000Z/);

  const aliasResult = run('node', [SCRIPT, 'status', '-v'], {
    cwd: workspace,
  });

  assert.equal(aliasResult.status, 0, aliasResult.stderr);
  assert.match(aliasResult.stdout, / {2}Created: 2026-03-18T15:30:00\.000Z/);
});

test('status preserves adversarial review kind labels', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, 'review-adv.log');
  fs.writeFileSync(
    logFile,
    '[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n',
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
            id: 'review-adv-live',
            kind: 'adversarial-review',
            status: 'running',
            title: 'Codex Adversarial Review',
            jobClass: 'review',
            phase: 'reviewing',
            threadId: 'thr_adv_live',
            summary: 'Adversarial review current changes',
            logFile,
            createdAt: '2026-03-18T15:30:00.000Z',
            updatedAt: '2026-03-18T15:30:00.000Z',
          },
          {
            id: 'review-adv',
            kind: 'adversarial-review',
            status: 'completed',
            title: 'Codex Adversarial Review',
            jobClass: 'review',
            threadId: 'thr_adv_done',
            summary: 'Adversarial review working tree diff',
            createdAt: '2026-03-18T15:10:00.000Z',
            startedAt: '2026-03-18T15:10:05.000Z',
            completedAt: '2026-03-18T15:11:10.000Z',
            updatedAt: '2026-03-18T15:11:10.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'status'], {
    cwd: workspace,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /\| review-adv-live \| adversarial-review \| - \| running \| reviewing \|/,
  );
  assert.match(
    result.stdout,
    /- review-adv \| completed \| adversarial-review \| Codex Adversarial Review/,
  );
  // The running job's session id lives in the table cell (details are
  // verbose-only); the finished job keeps its detail line.
  assert.match(result.stdout, /\| thr_adv_live \|/);
  assert.match(result.stdout, /Codex session ID: thr_adv_done/);
});

test('status --wait times out cleanly when a job is still active', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, 'task-live.log');
  fs.writeFileSync(logFile, '[2026-03-18T15:30:00.000Z] Starting Codex Task.\n', 'utf8');
  fs.writeFileSync(
    path.join(jobsDir, 'task-live.json'),
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

  const result = run(
    'node',
    [SCRIPT, 'status', 'task-live', '--wait', '--timeout-ms', '25', '--json'],
    {
      cwd: workspace,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, 'task-live');
  assert.equal(payload.job.status, 'running');
  assert.equal(payload.waitTimedOut, true);
});

test('result falls back to index data when the stored job file is unreadable', () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const task = run('node', [SCRIPT, 'task', 'inspect the stored result fallback'], {
    cwd: repo,
    env,
  });
  assert.equal(task.status, 0, task.stderr);

  const stateDir = resolveDurableStateDir(repo, env.CODEX_HOME);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  const job = state.jobs.find(
    (candidate: Record<string, unknown>) => candidate.jobClass === 'task',
  );
  assert.ok(job);
  const jobId = job.id as string;
  const jobFile = path.join(stateDir, 'jobs', `${jobId}.json`);

  const control = run('node', [SCRIPT, 'result', jobId, '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(control.status, 0, control.stderr);
  const controlPayload = JSON.parse(control.stdout);
  assert.equal(controlPayload.storedJob.id, jobId);
  assert.equal(Object.hasOwn(controlPayload, 'storedJobWarning'), false);

  fs.writeFileSync(jobFile, '{not-json', 'utf8');

  const jsonResult = run('node', [SCRIPT, 'result', jobId, '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const payload = JSON.parse(jsonResult.stdout);
  assert.equal(payload.storedJob, null);
  assert.equal(payload.storedJobWarning.includes(jobFile), true);
  assert.match(payload.storedJobWarning, /^Stored result file is unreadable:/);
  assert.match(payload.storedJobWarning, /Showing index data only\.$/);

  const reportResult = run('node', [SCRIPT, 'result', jobId, '--report', '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(reportResult.status, 0, reportResult.stderr);
  const reportPayload = JSON.parse(reportResult.stdout);
  assert.equal(reportPayload.report, null);
  assert.equal(reportPayload.storedJobWarning, payload.storedJobWarning);
  assert.equal(Object.hasOwn(reportPayload, 'storedJob'), false);

  const renderedResult = run('node', [SCRIPT, 'result', jobId], {
    cwd: repo,
    env,
  });
  assert.equal(renderedResult.status, 0, renderedResult.stderr);
  assert.match(renderedResult.stdout, /^# Codex Task/);
  assert.equal(renderedResult.stdout.includes(`Job: ${jobId}`), true);
  assert.match(renderedResult.stdout, /Status: completed/);
  assert.match(renderedResult.stdout, /No captured result payload was stored for this job\./);
  assert.match(renderedResult.stdout, /\nWarnings:\n- Stored result file is unreadable:/);
  assert.equal(renderedResult.stdout.includes(jobFile), true);
  assert.match(renderedResult.stdout, /Showing index data only\./);
});

test('result returns the stored output for the latest finished job by default', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, 'review-finished.json'),
    JSON.stringify(
      {
        id: 'review-finished',
        status: 'completed',
        title: 'Codex Review',
        rendered: '# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n',
        result: {
          codex: {
            stdout: 'Reviewed uncommitted changes.\nNo material issues found.',
          },
        },
        threadId: 'thr_review_finished',
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
            id: 'review-finished',
            status: 'completed',
            title: 'Codex Review',
            jobClass: 'review',
            threadId: 'thr_review_finished',
            summary: 'Review working tree diff',
            createdAt: '2026-03-18T15:00:00.000Z',
            updatedAt: '2026-03-18T15:01:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'result'], {
    cwd: workspace,
  });

  assert.equal(result.status, 0, result.stderr);
  // The stored rendering (with its heading) is preferred over raw stdout for
  // review-class jobs.
  assert.equal(
    result.stdout,
    '# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n\nModel: -\nCodex session ID: thr_review_finished\nResume in Codex: codex resume thr_review_finished\n',
  );
});

test('result --report returns report-only text and a compact JSON envelope', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  const report = 'Implemented the requested change.\nAll focused checks pass.\n\n';
  const usage = {
    job: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
    thread: { inputTokens: 4200, outputTokens: 800, totalTokens: 5000 },
  };
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, 'task-report.json'),
    `${JSON.stringify(
      {
        id: 'task-report',
        status: 'completed',
        title: 'Codex Task',
        jobClass: 'task',
        threadId: 'thr_report',
        tokenUsage: usage,
        result: { rawOutput: report },
      },
      null,
      2,
    )}\n`,
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
            id: 'task-report',
            status: 'completed',
            title: 'Codex Task',
            jobClass: 'task',
            threadId: 'thr_report',
            createdAt: '2026-08-01T12:00:00.000Z',
            updatedAt: '2026-08-01T12:01:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const textResult = run('node', [SCRIPT, 'result', 'task-report', '--report'], {
    cwd: workspace,
  });
  assert.equal(textResult.status, 0, textResult.stderr);
  assert.equal(textResult.stdout, 'Implemented the requested change.\nAll focused checks pass.\n');
  assert.doesNotMatch(textResult.stdout, /Model:|Codex session ID:|Resume in Codex:/);

  const jsonResult = run('node', [SCRIPT, 'result', 'task-report', '--report', '--json'], {
    cwd: workspace,
  });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const payload = JSON.parse(jsonResult.stdout);
  assert.deepEqual(payload, {
    jobId: 'task-report',
    status: 'completed',
    report,
    threadId: 'thr_report',
    tokenUsage: usage,
    effort: null,
  });
  assert.equal(Object.hasOwn(payload, 'storedJob'), false);
});

test('result --report explains when a finished job has no stored report', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, 'task-no-report.json'),
    `${JSON.stringify(
      {
        id: 'task-no-report',
        status: 'completed',
        title: 'Codex Task',
        jobClass: 'task',
        result: {},
      },
      null,
      2,
    )}\n`,
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
            id: 'task-no-report',
            status: 'completed',
            title: 'Codex Task',
            jobClass: 'task',
            createdAt: '2026-08-01T12:00:00.000Z',
            updatedAt: '2026-08-01T12:01:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const jsonResult = run('node', [SCRIPT, 'result', 'task-no-report', '--report', '--json'], {
    cwd: workspace,
  });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  assert.deepEqual(JSON.parse(jsonResult.stdout), {
    jobId: 'task-no-report',
    status: 'completed',
    report: null,
    threadId: null,
    tokenUsage: null,
    effort: null,
  });

  const textResult = run('node', [SCRIPT, 'result', 'task-no-report', '--report'], {
    cwd: workspace,
  });
  assert.equal(textResult.status, 0, textResult.stderr);
  assert.equal(textResult.stdout, 'No stored report for task-no-report (status: completed).\n');
});

test('result without a job id prefers the latest finished job from the current Claude session', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, 'review-current.json'),
    JSON.stringify(
      {
        id: 'review-current',
        status: 'completed',
        title: 'Codex Review',
        threadId: 'thr_current',
        result: {
          codex: {
            stdout: 'Current session output.',
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  fs.writeFileSync(
    path.join(jobsDir, 'review-other.json'),
    JSON.stringify(
      {
        id: 'review-other',
        status: 'completed',
        title: 'Codex Review',
        threadId: 'thr_other',
        result: {
          codex: {
            stdout: 'Old session output.',
          },
        },
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
            id: 'review-current',
            status: 'completed',
            title: 'Codex Review',
            jobClass: 'review',
            sessionId: 'sess-current',
            threadId: 'thr_current',
            summary: 'Current session review',
            createdAt: '2026-03-18T15:10:00.000Z',
            updatedAt: '2026-03-18T15:11:00.000Z',
          },
          {
            id: 'review-other',
            status: 'completed',
            title: 'Codex Review',
            jobClass: 'review',
            sessionId: 'sess-other',
            threadId: 'thr_other',
            summary: 'Old session review',
            createdAt: '2026-03-18T15:20:00.000Z',
            updatedAt: '2026-03-18T15:21:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = run('node', [SCRIPT, 'result'], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: 'sess-current',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    'Current session output.\n\nModel: -\nCodex session ID: thr_current\nResume in Codex: codex resume thr_current\n',
  );
});

test('result for a finished write-capable task returns the raw Codex final response', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const taskRun = run('node', [SCRIPT, 'task', '--write', 'fix the flaky integration test'], {
    cwd: repo,
    env: buildEnv(binDir),
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run('node', [SCRIPT, 'result'], {
    cwd: repo,
    env: buildEnv(binDir),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(result.stdout, /Note: this write-capable run recorded no edit-tool file changes;/);
  assert.match(result.stdout, /Codex session ID: thr_[a-z0-9]+/i);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_[a-z0-9]+/i);
});

test("status --all lists every session's jobs while the default view stays session-scoped", () => {
  const workspace = makeTempDir();
  const env = { ...process.env, CODEX_COMPANION_SESSION_ID: 'sess-current' };
  const breakdown = {
    inputTokens: 80,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 100,
  };
  const usage = { job: breakdown, thread: breakdown, modelContextWindow: null };
  upsertJob(workspace, {
    id: 'task-mine',
    status: 'completed',
    title: 'Codex Task',
    kind: 'task',
    jobClass: 'task',
    sessionId: 'sess-current',
    model: 'gpt-6-sol',
    completedAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T10:00:00.000Z',
    tokenUsage: usage,
  });
  upsertJob(workspace, {
    id: 'task-theirs',
    status: 'completed',
    title: 'Codex Task',
    kind: 'task',
    jobClass: 'task',
    sessionId: 'sess-other',
    model: 'gpt-6-sol',
    completedAt: '2026-09-25T10:05:00.000Z',
    updatedAt: '2026-09-25T10:05:00.000Z',
    tokenUsage: usage,
  });
  upsertJob(workspace, {
    id: 'task-theirs-queued',
    status: 'queued',
    title: 'Codex Task',
    kind: 'task',
    jobClass: 'task',
    sessionId: 'sess-other',
    pid: null,
    createdAt: '2026-09-25T10:06:00.000Z',
    updatedAt: '2026-09-25T10:06:00.000Z',
  });
  const listed = (payload: Record<string, any>): string[] =>
    [...payload.running, payload.latestFinished, ...payload.recent]
      .filter(Boolean)
      .map((job: { id: string }) => job.id)
      .sort();

  const scoped = run('node', [SCRIPT, 'status', '--json'], { cwd: workspace, env });
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.deepEqual(listed(JSON.parse(scoped.stdout)), ['task-mine']);

  // A resumed session can see what an earlier one left running.
  const all = run('node', [SCRIPT, 'status', '--json', '--all'], { cwd: workspace, env });
  assert.equal(all.status, 0, all.stderr);
  const allPayload = JSON.parse(all.stdout);
  assert.deepEqual(listed(allPayload), ['task-mine', 'task-theirs', 'task-theirs-queued']);
  assert.deepEqual(
    allPayload.running.map((job: { id: string }) => job.id),
    ['task-theirs-queued'],
  );
  const rendered = run('node', [SCRIPT, 'status', '--all'], { cwd: workspace, env });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.deepEqual(
    [...new Set(rendered.stdout.match(/task-(?:mine|theirs-queued|theirs)/g) ?? [])].sort(),
    ['task-mine', 'task-theirs', 'task-theirs-queued'],
  );

  // --usage keeps its own scoping: session by default, the workspace with --all.
  const usageScoped = run('node', [SCRIPT, 'status', '--usage', '--json'], { cwd: workspace, env });
  assert.equal(usageScoped.status, 0, usageScoped.stderr);
  const scopedSnapshot = JSON.parse(usageScoped.stdout);
  assert.equal(scopedSnapshot.scope, 'session');
  assert.equal(scopedSnapshot.sessionId, 'sess-current');
  assert.deepEqual(scopedSnapshot.window, { retainedJobs: 3, countedJobs: 1, maxRetainedJobs: 50 });
  assert.equal(scopedSnapshot.totals.totalTokens, 100);
  const usageAll = run('node', [SCRIPT, 'status', '--usage', '--all', '--json'], {
    cwd: workspace,
    env,
  });
  assert.equal(usageAll.status, 0, usageAll.stderr);
  const allSnapshot = JSON.parse(usageAll.stdout);
  assert.equal(allSnapshot.scope, 'workspace');
  assert.equal(allSnapshot.sessionId, 'sess-current');
  assert.deepEqual(allSnapshot.window, { retainedJobs: 3, countedJobs: 3, maxRetainedJobs: 50 });
  assert.equal(allSnapshot.totals.jobs, 3);
  assert.equal(allSnapshot.totals.jobsWithUsage, 2);
  assert.equal(allSnapshot.totals.totalTokens, 200);
});

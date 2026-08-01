import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatTokenUsage,
  renderConfigReport,
  renderImplementState,
  renderJobStatusReport,
  renderPlanReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderStoredPlanState,
  renderTaskResult,
  renderUsageReport,
} from '../plugins/stereo/src/render/render.ts';

const tokenUsage = {
  job: {
    totalTokens: 58000,
    inputTokens: 46000,
    cachedInputTokens: 37260,
    cacheWriteInputTokens: 0,
    outputTokens: 12000,
    reasoningOutputTokens: 0,
  },
  thread: {
    totalTokens: 1333000,
    inputTokens: 1200000,
    cachedInputTokens: 900000,
    cacheWriteInputTokens: 0,
    outputTokens: 133000,
    reasoningOutputTokens: 12000,
  },
  modelContextWindow: 258000,
};

const runningStatusJob = {
  id: 'task-running',
  status: 'running',
  kindLabel: 'rescue',
  title: 'Codex Task',
  phase: 'editing',
  threadId: 'thr_running',
  elapsed: '42s',
  summary: 'Implement status diagnostics',
  logFile: '/tmp/task-running.log',
  createdAt: '2026-07-20T08:00:00.000Z',
  startedAt: '2026-07-20T08:00:01.000Z',
  progressPreview: ['Inspecting status renderer', 'Applying file changes'],
  model: 'kimi-k3',
  modelDisplay: 'kimi-k3@moonshot',
};

const completedStatusJob = {
  id: 'review-complete',
  status: 'completed',
  kindLabel: 'review',
  title: 'Codex Review',
  phase: 'done',
  threadId: 'thr_complete',
  duration: '1m 5s',
  summary: 'Review working tree diff',
  logFile: '/tmp/review-complete.log',
  createdAt: '2026-07-20T07:30:00.000Z',
  startedAt: '2026-07-20T07:30:05.000Z',
  completedAt: '2026-07-20T07:31:10.000Z',
  progressPreview: [],
  model: 'gpt-5.6-sol',
  modelDisplay: 'gpt-5.6-sol',
};

const recentStatusJob = {
  id: 'task-recent',
  status: 'completed',
  kindLabel: 'rescue',
  title: 'Codex Task',
  phase: 'done',
  threadId: 'thr_recent',
  duration: '12s',
  summary: 'Update documentation',
  logFile: '/tmp/task-recent.log',
  createdAt: '2026-07-20T07:00:00.000Z',
  startedAt: '2026-07-20T07:00:01.000Z',
  completedAt: '2026-07-20T07:00:13.000Z',
  progressPreview: [],
};

const statusReport = {
  running: [runningStatusJob],
  latestFinished: completedStatusJob,
  recent: [recentStatusJob],
  sessionRuntime: { label: 'direct startup' },
  config: { stopReviewGate: false },
  needsReview: false,
};

test('renderStatusReport preserves its non-verbose output byte-for-byte', () => {
  // Non-verbose output is the documented compact shape: the table plus brief
  // finished-job details, with no Live details or Progress blocks.
  assert.equal(
    renderStatusReport(statusReport),
    '# Codex Status\n\nSession runtime: direct startup\nReview gate: disabled\n\nActive jobs:\n| Job | Kind | Model | Status | Phase | Elapsed | Codex Session ID | Summary | Actions |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| task-running | rescue | kimi-k3@moonshot | running | editing | 42s | thr_running | Implement status diagnostics | `/stereo:status task-running`<br>`/stereo:cancel task-running` |\n\nLatest finished:\n- review-complete | completed | review | Codex Review\n  Model: gpt-5.6-sol\n  Summary: Review working tree diff\n  Phase: done\n  Duration: 1m 5s\n  Codex session ID: thr_complete\n  Resume in Codex: codex resume thr_complete\n\nRecent jobs:\n- task-recent | completed | rescue | Codex Task\n  Model: -\n  Summary: Update documentation\n  Phase: done\n  Duration: 12s\n  Codex session ID: thr_recent\n  Resume in Codex: codex resume thr_recent\n',
  );
});

test('renderJobStatusReport preserves its non-verbose output byte-for-byte', () => {
  assert.equal(
    renderJobStatusReport(completedStatusJob),
    '# Codex Job Status\n\n- review-complete | completed | review | Codex Review\n  Model: gpt-5.6-sol\n  Summary: Review working tree diff\n  Phase: done\n  Duration: 1m 5s\n  Codex session ID: thr_complete\n  Resume in Codex: codex resume thr_complete\n  Log: /tmp/review-complete.log\n  Result: /stereo:result review-complete\n',
  );
});

test('renderStatusReport includes live details, progress, and timestamps in verbose output', () => {
  const output = renderStatusReport(statusReport, { verbose: true });

  assert.match(output, /Live details:/);
  assert.match(output, / {2}Progress:/);
  assert.match(output, / {4}Inspecting status renderer/);
  assert.match(output, / {2}Created: 2026-07-20T07:30:00\.000Z/);
  assert.match(output, / {2}Completed: 2026-07-20T07:31:10\.000Z/);
  assert.match(output, / {2}Log: \/tmp\/review-complete\.log/);
});

test('renderJobStatusReport includes timestamps in verbose output', () => {
  const output = renderJobStatusReport(completedStatusJob, { verbose: true });

  assert.match(output, / {2}Created: 2026-07-20T07:30:00\.000Z/);
  assert.match(output, / {2}Started: 2026-07-20T07:30:05\.000Z/);
  assert.match(output, / {2}Completed: 2026-07-20T07:31:10\.000Z/);
});

test('token usage formatting labels job and cumulative thread figures separately', () => {
  assert.equal(
    formatTokenUsage(tokenUsage),
    'Tokens: job 46K in (81% cached) / 12K out · thread 1.2M in / 133K out (12K reasoning) · context 258K',
  );
  assert.equal(formatTokenUsage(null), null);
  assert.equal(formatTokenUsage({ job: {}, thread: {} }), null);
});

test('job status and stored results render token usage without changing legacy records', () => {
  const job = { ...completedStatusJob, tokenUsage };
  assert.match(
    renderJobStatusReport(job),
    / {2}Tokens: job 46K in \(81% cached\).*thread 1\.2M in.*context 258K/,
  );

  const result = renderStoredJobResult(job, {
    jobClass: 'review',
    threadId: 'thr_complete',
    rendered: 'Reviewed the change.\n',
    tokenUsage,
  });
  assert.match(
    result,
    /Model: gpt-5\.6-sol\nTokens: job 46K in \(81% cached\).*context 258K\nCodex session ID:/,
  );
});

test('renderSetupReport prints the active and configured provider key status', () => {
  const output = renderSetupReport({
    ready: true,
    node: { detail: 'v24' },
    npm: { detail: '11' },
    codex: { detail: 'codex-cli' },
    writeSandbox: { available: true, detail: 'workspace-write sandbox launches' },
    auth: { detail: 'ChatGPT login active' },
    providers: {
      active: 'openai',
      configured: [{ id: 'moonshot', envKey: 'MOONSHOT_API_KEY', keySet: true }],
      aliases: [
        {
          alias: 'kimi',
          model: 'kimi-k3',
          providerId: 'moonshot',
          configured: true,
          envKey: 'MOONSHOT_API_KEY',
          keySet: true,
        },
      ],
    },
    sessionRuntime: { label: 'direct startup' },
    strandedReservations: [],
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: [],
  });

  assert.match(output, /- Model provider: openai \(default\)/);
  assert.match(output, /- Custom provider moonshot \(codex:kimi → kimi-k3\): MOONSHOT_API_KEY set/);
});

test('renderSetupReport renders sparse rate-limit windows and warnings defensively', () => {
  const output = renderSetupReport({
    ready: true,
    node: { detail: 'v24' },
    npm: { detail: '11' },
    codex: { detail: 'codex-cli' },
    auth: { detail: 'ChatGPT login active' },
    providers: {
      active: 'openai',
      configured: [],
      aliases: [],
    },
    sessionRuntime: { label: 'direct startup' },
    rateLimits: {
      limitId: 'codex',
      limitName: 'Codex',
      planType: 'plus',
      primary: {
        usedPercent: 37,
        windowDurationMins: 300,
        resetsAt: 1785000000,
      },
      spendControlReached: true,
      rateLimitReachedType: 'rate_limit_reached',
    },
    actionsTaken: [],
    nextSteps: [],
  });

  assert.match(output, /\nRate limits:\n/);
  assert.match(output, /- Plan: plus/);
  assert.match(output, /- Codex primary: 37% used \(5h window, resets /);
  assert.match(output, /- Warning: Codex spend control has been reached\./);
  assert.match(output, /- Warning: Codex limit reached \(rate_limit_reached\)\./);
});

test('renderReviewResult degrades gracefully when JSON is missing required review fields', () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: 'approve',
        summary: 'Looks fine.',
      },
      rawOutput: JSON.stringify({
        verdict: 'approve',
        summary: 'Looks fine.',
      }),
      parseError: null,
    },
    {
      reviewLabel: 'Adversarial Review',
      targetLabel: 'working tree diff',
    },
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test('renderReviewResult keeps the target visible when structured JSON parsing fails', () => {
  const output = renderReviewResult(
    { parsed: null, rawOutput: 'not json at all', parseError: 'Unexpected token' },
    { reviewLabel: 'Review', targetLabel: 'branch diff against main' },
  );

  assert.match(output, /Target: branch diff against main/);
  assert.match(output, /did not return valid structured JSON/);
  assert.match(output, /Parse error: Unexpected token/);
});

test('renderStoredJobResult prefers rendered output for structured review jobs', () => {
  const output = renderStoredJobResult(
    {
      id: 'review-123',
      status: 'completed',
      title: 'Codex Adversarial Review',
      jobClass: 'review',
      threadId: 'thr_123',
      model: 'kimi-k3',
    },
    {
      threadId: 'thr_123',
      rendered:
        '# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n',
      result: {
        result: {
          verdict: 'needs-attention',
          summary: 'One issue.',
          findings: [],
          next_steps: [],
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}',
      },
    },
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Model: kimi-k3@moonshot/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});

test('renderStoredJobResult appends warnings before the footer without changing clean output', () => {
  const warning =
    'Stored result file is unreadable: /tmp/task-warning.json (Unexpected end of JSON input). Showing index data only.';
  const job = {
    id: 'task-warning',
    status: 'completed',
    title: 'Codex Task',
    jobClass: 'task',
    threadId: 'thr_warning',
    model: 'gpt-5.6-sol',
  };
  const storedJob = {
    jobClass: 'task',
    threadId: 'thr_warning',
    rendered: 'Stored task output.\n',
  };

  assert.equal(
    renderStoredJobResult(job, storedJob, warning),
    'Stored task output.\n\nWarnings:\n- Stored result file is unreadable: /tmp/task-warning.json (Unexpected end of JSON input). Showing index data only.\n\nModel: gpt-5.6-sol\nCodex session ID: thr_warning\nResume in Codex: codex resume thr_warning\n',
  );
  assert.equal(
    renderStoredJobResult(job, storedJob),
    'Stored task output.\n\nModel: gpt-5.6-sol\nCodex session ID: thr_warning\nResume in Codex: codex resume thr_warning\n',
  );

  assert.equal(
    renderStoredJobResult(
      {
        id: 'task-warning-fallback',
        status: 'completed',
        title: 'Codex Task',
        summary: 'Index-only summary',
        jobClass: 'task',
        threadId: 'thr_fallback',
        model: 'kimi-k3',
      },
      null,
      warning,
    ),
    '# Codex Task\n\nJob: task-warning-fallback\nStatus: completed\nSummary: Index-only summary\n\nNo captured result payload was stored for this job.\n\nWarnings:\n- Stored result file is unreadable: /tmp/task-warning.json (Unexpected end of JSON input). Showing index data only.\n\nModel: kimi-k3@moonshot\nCodex session ID: thr_fallback\nResume in Codex: codex resume thr_fallback\n',
  );
});

test('renderTaskResult warns only when a write run with output reports no touched files', () => {
  assert.equal(
    renderTaskResult({ rawOutput: 'Implemented the change.' }, { write: true, touchedFiles: [] }),
    'Implemented the change.\n\nNote: this write-capable run reported no file changes.\n',
  );
  assert.equal(
    renderTaskResult(
      { rawOutput: 'Implemented the change.' },
      { write: true, touchedFiles: ['src/app.js'] },
    ),
    'Implemented the change.\n',
  );
  assert.equal(
    renderTaskResult({ rawOutput: 'Inspected the change.' }, { write: false, touchedFiles: [] }),
    'Inspected the change.\n',
  );
  assert.equal(
    renderTaskResult(
      { rawOutput: '', failureMessage: 'No response.' },
      { write: true, touchedFiles: [] },
    ),
    'No response.\n',
  );
});

test('renderStoredJobResult prefers rendered task output over raw output', () => {
  const output = renderStoredJobResult(
    {
      id: 'task-123',
      status: 'completed',
      title: 'Codex Task',
      jobClass: 'task',
      threadId: 'thr_task',
      model: 'gpt-5.6-sol',
    },
    {
      jobClass: 'task',
      threadId: 'thr_task',
      rendered: 'Task output.\n\nNote: this write-capable run reported no file changes.\n',
      result: {
        rawOutput: 'Task output.',
      },
    },
  );

  assert.match(output, /^Task output\./);
  assert.match(output, /Note: this write-capable run reported no file changes\./);
  assert.match(output, /Model: gpt-5.6-sol/);
  assert.match(output, /Codex session ID: thr_task/);
});

test('renderStoredJobResult uses the non-throwing legacy request model fallback', () => {
  const output = renderStoredJobResult(
    {
      id: 'task-legacy',
      status: 'completed',
      title: 'Codex Task',
      jobClass: 'task',
      threadId: null,
    },
    {
      jobClass: 'task',
      threadId: null,
      rendered: 'Legacy task output.\n',
      request: {
        model: 'kimi-k3',
      },
    },
  );

  assert.equal(output, 'Legacy task output.\n\nModel: kimi-k3@moonshot\n');
});

test('renderStoredJobResult tolerates a malformed legacy request while resolving the model', () => {
  const output = renderStoredJobResult(
    {
      id: 'task-malformed',
      status: 'completed',
      title: 'Codex Task',
      jobClass: 'task',
      threadId: null,
    },
    {
      jobClass: 'task',
      threadId: null,
      rendered: 'Legacy task output.\n',
      request: 'truncated legacy payload',
    },
  );

  assert.equal(output, 'Legacy task output.\n\nModel: -\n');
});

test('renderStoredPlanState renders metadata, lists, and the stored plan verbatim', () => {
  const plan = '# Plan\n\n```ts\nconst enabled = true;\n```\n';

  assert.equal(
    renderStoredPlanState({
      verdict: 'approve',
      round: 3,
      updatedAt: '2026-07-25T17:00:00.000Z',
      model: 'gpt-5.6-sol',
      effort: 'max',
      threadId: 'thr_plan',
      openQuestions: ['Keep the compatibility alias?'],
      residualRisks: ['Legacy records still lack schema validation.'],
      plan,
    }),
    'Stored plan (verdict: approve, round 3, updated 2026-07-25T17:00:00.000Z)\nModel: gpt-5.6-sol@max · Thread: thr_plan\nOpen questions:\n- Keep the compatibility alias?\nResidual risks:\n- Legacy records still lack schema validation.\n\n---\n\n# Plan\n\n```ts\nconst enabled = true;\n```\n',
  );
});

test('renderStoredPlanState renders implementedAt after runtime metadata', () => {
  assert.equal(
    renderStoredPlanState({
      verdict: 'approve',
      round: 2,
      model: 'gpt-5.6-sol',
      threadId: 'thr_plan',
      implementedAt: '2026-08-01T12:00:00.000Z',
      plan: '# Implemented plan\n',
    }),
    'Stored plan (verdict: approve, round 2)\nModel: gpt-5.6-sol · Thread: thr_plan\nImplemented: 2026-08-01T12:00:00.000Z\nOpen questions: none\nResidual risks: none\n\n---\n\n# Implemented plan\n',
  );
});

test('renderConfigReport renders mixed defaults, actions, and warnings byte-exactly', () => {
  assert.equal(
    renderConfigReport({
      roleDefaults: [
        {
          role: 'planner',
          flag: 'planner',
          model: 'codex:terra',
          effort: 'high',
          route: 'codex',
          resolvedModel: 'gpt-5.6-terra',
          invalidReason: null,
        },
        {
          role: 'planReviewer',
          flag: 'plan-reviewer',
          model: 'claude:opus',
          effort: null,
          route: 'claude',
          resolvedModel: null,
          invalidReason: null,
        },
        {
          role: 'implementer',
          flag: 'implementer',
          model: 'claude:fabel',
          effort: null,
          route: null,
          resolvedModel: null,
          invalidReason: 'Unsupported model.',
        },
        {
          role: 'implementationReviewer',
          flag: 'implementation-reviewer',
          model: null,
          effort: null,
          route: null,
          resolvedModel: null,
          invalidReason: null,
        },
      ],
      actionsTaken: ['Set planner to codex:terra for /work/repo.'],
      warnings: ['implementer stored model "claude:fabel" is invalid.'],
    }),
    '# Stereo Config\n\nRole defaults:\n- planner: codex:terra (effort high)\n- plan-reviewer: claude:opus\n- implementer: claude:fabel [invalid]\n- implementation-reviewer: not set\n\nActions taken:\n- Set planner to codex:terra for /work/repo.\n\nWarnings:\n- implementer stored model "claude:fabel" is invalid.\n\nUse `/stereo:config --clear roles` to clear all workspace role defaults.\n',
  );
});

test('renderStoredPlanState reports empty question and risk lists', () => {
  assert.equal(
    renderStoredPlanState({
      verdict: 'approve',
      round: 1,
      openQuestions: [],
      residualRisks: [],
      plan: '# Compact plan\n',
    }),
    'Stored plan (verdict: approve, round 1)\nOpen questions: none\nResidual risks: none\n\n---\n\n# Compact plan\n',
  );
});

test('renderStoredPlanState degrades gracefully when plan text and metadata are absent', () => {
  assert.equal(
    renderStoredPlanState({
      openQuestions: 'not an array',
      residualRisks: [null, ''],
    }),
    'Stored plan (verdict: unknown)\nOpen questions: none\nResidual risks: none\n\n---\n\n(plan text missing)\n',
  );
});

test('renderStoredPlanState preserves the unavailable message byte-for-byte', () => {
  assert.equal(
    renderStoredPlanState(null),
    'No stored plan for this repository. Run /stereo:plan first.\n',
  );
});

test('renderImplementState shows the durable phase metadata and recorded job id', () => {
  const output = renderImplementState({
    baselineCommit: '8b995ad',
    baselineDirtyPaths: ['README.md', 'src/local.ts'],
    implementer: {
      selection: 'codex:sol',
      model: 'gpt-5.6-sol',
      effort: 'max',
    },
    implementationThreadId: 'thr_implementation',
    jobId: 'task-background-7',
    round: 2,
    latestVerdict: 'needs-fixes',
    status: 'in-progress',
    updatedAt: '2026-08-01T10:00:00.000Z',
    plan: {
      fingerprint: '0123456789abcdef0123456789abcdef',
      updatedAt: '2026-08-01T09:00:00.000Z',
    },
  });

  assert.match(output, /^# Stereo Implementation State/m);
  assert.match(output, /Baseline commit: 8b995ad/);
  assert.match(output, /Baseline-dirty paths: 2/);
  assert.match(output, /Implementer selection: codex:sol/);
  assert.match(output, /Implementation thread ID: thr_implementation/);
  assert.match(output, /Background job ID: task-background-7/);
  assert.match(output, /Completed review rounds: 2/);
  assert.match(output, /Recorded plan fingerprint: 0123456789abcdef0123456789abcdef/);
});

test('renderImplementState preserves the unavailable message', () => {
  assert.equal(
    renderImplementState(null),
    'No implementation state for this repository. Run /stereo:implement first.\n',
  );
});

test('renderUsageReport renders a scoped window, exact tables, and escaped keys', () => {
  const output = renderUsageReport({
    workspaceRoot: '/tmp/repo',
    scope: 'session',
    sessionId: 'sess-1',
    window: { retainedJobs: 4, countedJobs: 3, maxRetainedJobs: 50 },
    totals: {
      jobs: 3,
      jobsWithUsage: 2,
      inputTokens: 1160,
      cachedInputTokens: 600,
      outputTokens: 240,
      reasoningOutputTokens: 80,
      totalTokens: 1400,
    },
    byKind: [
      {
        key: 'review|native',
        jobs: 1,
        jobsWithUsage: 1,
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 200,
        reasoningOutputTokens: 70,
        totalTokens: 1200,
      },
      {
        key: 'rescue',
        jobs: 2,
        jobsWithUsage: 1,
        inputTokens: 160,
        cachedInputTokens: 100,
        outputTokens: 40,
        reasoningOutputTokens: 10,
        totalTokens: 200,
      },
    ],
    byModel: [
      {
        key: 'gpt-5.6-sol',
        jobs: 2,
        jobsWithUsage: 2,
        inputTokens: 1160,
        cachedInputTokens: 600,
        outputTokens: 240,
        reasoningOutputTokens: 80,
        totalTokens: 1400,
      },
      {
        key: '-',
        jobs: 1,
        jobsWithUsage: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
    ],
  });

  assert.match(output, /^# Codex Usage/m);
  assert.match(output, /3 counted of 4 retained jobs .*cap 50.*scope: current session sess-1/);
  assert.match(output, /not Codex account usage, and not all-time history/);
  assert.match(output, /Total: 1\.4K tokens/);
  assert.match(
    output,
    /\| Kind \| Jobs \| With usage \| Input \| Cached input \| Output \| Reasoning \| Total \|/,
  );
  assert.match(output, /\| review\\\|native \| 1 \| 1 \| 1000 \| 500 \| 200 \| 70 \| 1200 \|/);
  assert.match(output, /\| Model \| Jobs \| With usage/);
});

test('renderUsageReport renders the empty retained-index case', () => {
  const output = renderUsageReport({
    workspaceRoot: '/tmp/repo',
    scope: 'workspace',
    sessionId: null,
    window: { retainedJobs: 0, countedJobs: 0, maxRetainedJobs: 50 },
    totals: {
      jobs: 0,
      jobsWithUsage: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
    byKind: [],
    byModel: [],
  });

  assert.match(output, /0 counted of 0 retained jobs .*cap 50.*scope: workspace/);
  assert.match(output, /No recorded token usage in the retained job index\./);
  assert.doesNotMatch(output, /By kind:/);
});

test('renderPlanReviewResult orders findings by severity and lists revision guidance', () => {
  const output = renderPlanReviewResult(
    {
      parsed: {
        verdict: 'needs-revision',
        summary: 'Two gaps found.',
        findings: [
          {
            severity: 'medium',
            title: 'Test gap',
            body: 'No tests planned.',
            section: 'Testing and verification',
            confidence: 0.7,
            recommendation: 'Add tests.',
          },
          {
            severity: 'critical',
            title: 'Missing file',
            body: 'src/missing.js does not exist.',
            section: 'Files to change',
            confidence: 0.95,
            recommendation: 'Fix the path.',
          },
        ],
        revision_instructions: ['Correct the file list.', 'Add a testing section.'],
        open_questions: ['Keep the legacy flag?'],
      },
      rawOutput: '{}',
      parseError: null,
    },
    { round: 2 },
  );

  assert.match(output, /^# Codex Plan Review \(round 2\)/);
  assert.match(output, /Verdict: needs-revision/);
  assert.match(output, /\[critical, confidence 0\.95\] Missing file \(Files to change\)/);
  assert.ok(output.indexOf('Missing file') < output.indexOf('Test gap'));
  assert.match(output, /Revision instructions:/);
  assert.match(output, /1\. Correct the file list\./);
  assert.match(output, /2\. Add a testing section\./);
  assert.match(output, /Open questions:/);
  assert.match(output, /Keep the legacy flag\?/);
});

test('renderPlanReviewResult reports approve plans without findings', () => {
  const output = renderPlanReviewResult(
    {
      parsed: {
        verdict: 'approve',
        summary: 'Workable plan.',
        findings: [],
        revision_instructions: [],
        open_questions: [],
      },
      rawOutput: '{}',
      parseError: null,
    },
    { round: 1 },
  );

  assert.match(output, /^# Codex Plan Review\n/);
  assert.match(output, /Verdict: approve/);
  assert.match(output, /No material findings\./);
  assert.doesNotMatch(output, /Revision instructions:/);
  // Older stored results predate residual_risks; absence must render cleanly.
  assert.doesNotMatch(output, /Residual risks/);
});

test('renderPlanReviewResult lists residual risks as a non-blocking section', () => {
  const output = renderPlanReviewResult(
    {
      parsed: {
        verdict: 'approve',
        summary: 'Workable plan with documented residuals.',
        findings: [],
        revision_instructions: [],
        open_questions: [],
        residual_risks: [
          'Pre-existing retry helper swallows errors; follow-up plan suggested.',
          'Legacy records lack schema validation.',
        ],
      },
      rawOutput: '{}',
      parseError: null,
    },
    { round: 3 },
  );

  assert.match(output, /Verdict: approve/);
  assert.match(output, /Residual risks \(non-blocking\):/);
  assert.match(output, /- Pre-existing retry helper swallows errors; follow-up plan suggested\./);
  assert.match(output, /- Legacy records lack schema validation\./);
});

test('renderPlanReviewResult degrades gracefully on unexpected shapes and parse errors', () => {
  const badShape = renderPlanReviewResult(
    {
      parsed: { verdict: 'approve', summary: 'Missing arrays.' },
      rawOutput: '{"verdict":"approve","summary":"Missing arrays."}',
      parseError: null,
    },
    { round: 1 },
  );
  assert.match(badShape, /unexpected plan-review shape/);
  assert.match(badShape, /Missing array `findings`\./);
  assert.match(badShape, /Raw final message:/);

  const parseFailure = renderPlanReviewResult(
    { parsed: null, rawOutput: 'not json', parseError: 'Unexpected token' },
    { round: 3 },
  );
  assert.match(parseFailure, /^# Codex Plan Review \(round 3\)/);
  assert.match(parseFailure, /did not return valid structured JSON/);
  assert.match(parseFailure, /Raw final message:/);
});

test('renderJobStatusReport reports a timed-out wait in text mode', () => {
  const output = renderJobStatusReport(runningStatusJob, { waitTimedOut: true, timeoutMs: 240000 });
  assert.match(output, /Wait timed out after 240000 ms; the job is still running\./);

  const noWait = renderJobStatusReport(runningStatusJob, {});
  assert.doesNotMatch(noWait, /Wait timed out/);
});

test('renderStoredJobResult prefers the stored rendering for native review jobs', () => {
  // Native review payloads carry neither result nor parseError keys, which
  // used to drop them to the raw stdout fallback.
  const output = renderStoredJobResult(
    {
      id: 'review-native',
      status: 'completed',
      title: 'Codex Review',
      jobClass: 'review',
      threadId: 'thr_native',
    },
    {
      jobClass: 'review',
      threadId: 'thr_native',
      rendered: '# Codex Review\n\nTarget: working tree diff\n\nNo material issues found.\n',
      result: {
        review: 'Review',
        target: { mode: 'working-tree', label: 'working tree diff' },
        codex: { status: 0, stdout: 'No material issues found.', stderr: '' },
      },
    },
  );

  assert.match(output, /^# Codex Review/);
  assert.match(output, /Target: working tree diff/);
  assert.match(output, /Codex session ID: thr_native/);
});

test('review findings render confidence when present and omit it for legacy records', () => {
  const withConfidence = renderReviewResult(
    {
      parsed: {
        verdict: 'needs-attention',
        summary: 'One issue.',
        findings: [
          {
            severity: 'high',
            title: 'Unchecked input',
            body: 'Value used without validation.',
            file: 'src/app.js',
            line_start: 3,
            line_end: 3,
            confidence: 0.87,
            recommendation: 'Validate first.',
          },
        ],
        next_steps: [],
      },
      rawOutput: '{}',
      parseError: null,
    },
    { reviewLabel: 'Adversarial Review', targetLabel: 'working tree diff' },
  );
  assert.match(withConfidence, /\[high, confidence 0\.87\] Unchecked input \(src\/app\.js:3\)/);

  const legacy = renderReviewResult(
    {
      parsed: {
        verdict: 'needs-attention',
        summary: 'One issue.',
        findings: [
          {
            severity: 'high',
            title: 'Unchecked input',
            body: 'Value used without validation.',
            file: 'src/app.js',
            recommendation: 'Validate first.',
          },
        ],
        next_steps: [],
      },
      rawOutput: '{}',
      parseError: null,
    },
    { reviewLabel: 'Adversarial Review', targetLabel: 'working tree diff' },
  );
  assert.match(legacy, /\[high\] Unchecked input \(src\/app\.js\)/);
});

test('raw-output fences grow past embedded backtick runs', () => {
  const hostile = 'prose with a block:\n```diff\n- a\n+ b\n```\n# not a heading';
  const rendered = renderReviewResult(
    { parsed: null, parseError: 'Unexpected token p', rawOutput: hostile },
    { reviewLabel: 'Review', targetLabel: 'working tree' },
  );
  // The outer fence must be longer than any run inside the payload so the
  // embedded ``` cannot close it and leak live markdown.
  const fences = rendered.match(/^`{3,}/gm) ?? [];
  assert.ok(
    fences.some((fence) => fence.length >= 4),
    `expected a grown fence, got: ${fences.join(', ')}`,
  );
  const opener = rendered.match(/(`{4,})text/);
  assert.ok(opener, 'outer fence must be 4+ backticks when payload contains ```');
  assert.ok(rendered.includes(hostile), 'payload must be embedded verbatim');
});

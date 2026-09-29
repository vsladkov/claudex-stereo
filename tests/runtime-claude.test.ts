import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  CLAUDE_NOT_AUTHENTICATED_ERROR,
  createCompanionJob,
} from '../plugins/stereo/src/workflows/companion-jobs.ts';
import { claudeModelId, parseClaudeSelection } from '../plugins/stereo/src/models/claude-models.ts';
import {
  findModelVersion,
  latestModelVersion,
  MODEL_VERSIONS,
} from '../plugins/stereo/src/models/model-table.ts';
import type { ModelVersionRow } from '../plugins/stereo/src/models/model-table.ts';
import {
  defaultModelEffort,
  parseCodexSelection,
  resolveCodexSelection,
} from '../plugins/stereo/src/models/registry.ts';
import { ROLE_DEFINITIONS } from '../plugins/stereo/src/models/role-defaults.ts';
import type { RoleDefinition } from '../plugins/stereo/src/models/role-defaults.ts';
import { IMPLEMENTER_DEFAULT_GRANTS } from '../plugins/stereo/src/runtime/claude-runner.ts';
import { readSessionWorkspaces } from '../plugins/stereo/src/workspace/session-registry.ts';
import { loadPairPlanState, nowIso, upsertJob } from '../plugins/stereo/src/workspace/state.ts';
import {
  buildClaudeEnv,
  claudeFixture,
  fakeClaudeBin,
  installFakeClaude,
  readFakeClaudeState,
} from './fake-claude-fixture.ts';
import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { accountCatalogModels, catalogFixture, makeTempDir, run, waitFor } from './helpers.ts';
import {
  companion,
  errorOf,
  initializeBasicRepo,
  readCompanionState,
  readFakeState,
  registerBrokerReaping,
  requireCompanionState,
  runCliInProcess,
} from './runtime-helpers.ts';

registerBrokerReaping();

// Defaults come from the version table and the role definitions: a new row
// or a moved built-in changes what these tests expect, not the tests.
interface Launched {
  model: string;
  effort: string | null;
}

function rowLaunch(row: ModelVersionRow): Launched {
  return { model: claudeModelId(row.family, row.version), effort: row.effort };
}

// What `claude:<family>` launches: the family's newest row.
const newest = (family: string): Launched =>
  rowLaunch(latestModelVersion('claude', family) as ModelVersionRow);
// The default effort of a pinned version.
const versionEffort = (family: string, version: string): string | null =>
  (findModelVersion('claude', family, version) as ModelVersionRow).effort;
const builtInSelection = (flag: RoleDefinition['flag']): string =>
  (ROLE_DEFINITIONS.find((role) => role.flag === flag) as RoleDefinition).builtInSelection;

// A role's Claude built-in as a launch runs it.
function claudeBuiltIn(flag: RoleDefinition['flag']): Launched & { row: ModelVersionRow } {
  const { modelArg } = parseClaudeSelection(builtInSelection(flag));
  const row = MODEL_VERSIONS.find(
    (candidate) =>
      candidate.runtime === 'claude' &&
      claudeModelId(candidate.family, candidate.version) === modelArg,
  ) as ModelVersionRow;
  return { ...rowLaunch(row), row };
}

// A role's Codex built-in as a launch runs it against the fake's catalog.
function codexBuiltIn(flag: RoleDefinition['flag']): Launched {
  const catalog = catalogFixture(accountCatalogModels());
  const model = resolveCodexSelection(parseCodexSelection(builtInSelection(flag))!, catalog);
  return { model, effort: defaultModelEffort(model, { catalog }) };
}

test('a Claude planner task pins the version, the effort, and the role definition on the child', () => {
  const { repo, binDir, env } = claudeFixture();

  const result = companion(
    ['task', '--json', '--model', 'claude:opus-5.5', '--role', 'planner', 'Draft the plan'],
    repo,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.rawOutput, 'Handled the requested task.\nTask prompt accepted.');
  assert.deepEqual(payload.claude, { costUsd: 0.01, permissionDenials: [] });

  const state = readFakeClaudeState(binDir);
  const last = state.lastRun!;
  const effort = versionEffort('opus', '5.5');
  assert.equal(last.model, 'claude-opus-5-5');
  assert.equal(last.effort, effort, 'the Opus 5.5 table effort');
  assert.equal(last.envEffort, effort, 'CLAUDE_CODE_EFFORT_LEVEL pins the level in the child');
  assert.equal(last.envClaudeEffort, null, 'the parent session effort marker is scrubbed');
  assert.equal(last.envCompanionSession, null);
  assert.equal(last.envMessagingSocket, null);
  assert.equal(last.agent, 'stereo-planner');
  assert.equal(last.permissionMode, 'dontAsk');
  assert.equal(last.prompt, 'Draft the plan');
  assert.equal(last.cwd, repo);
  assert.equal(payload.threadId, last.sessionId);
  const definition = last.agentsDefinition!['stereo-planner']!;
  // The role body travels as the prompt; its wording is the agent file's business.
  assert.ok(String(definition.prompt).trim().length > 0);
  assert.doesNotMatch(String(definition.prompt), /^---/m, 'frontmatter is stripped');
  assert.equal(definition.model, 'claude-opus-5-5');
  assert.equal(definition.effort, effort);
  assert.deepEqual(last.allowedTools, []);
  assert.deepEqual(last.flags['setting-sources'], 'project');
  assert.deepEqual(JSON.parse(String(last.flags.settings)), { disableAllHooks: true });
  assert.equal(last.flags['permission-prompts'], 'none');
  assert.equal(last.flags['strict-mcp-config'], true);

  const job = requireCompanionState(repo, env).jobs.find((entry) => entry.jobClass === 'task');
  assert.equal(job?.runtime, 'claude');
  assert.equal(job?.model, 'claude-opus-5-5');
  assert.equal(job?.title, 'Claude Task');
  assert.equal(job?.status, 'completed');
  assert.equal(job?.threadId, last.sessionId);
  // Thinking blocks become the reasoning summary; reasoning tokens count for the job.
  assert.deepEqual(payload.reasoningSummary, [
    'Considering the request carefully before answering.',
  ]);
  const stored = JSON.parse(companion(['result', String(job?.id), '--json'], repo, env).stdout);
  assert.equal(stored.storedJob.tokenUsage.job.reasoningOutputTokens, 3);
  // A completed job's report is the raw output, nothing appended.
  const report = companion(['result', String(job?.id), '--report'], repo, env);
  assert.equal(report.status, 0, report.stderr);
  assert.equal(report.stdout, `${payload.rawOutput}\n`);
});

test('an alias request launches the newest known version and shows the cost', () => {
  const { repo, binDir, env } = claudeFixture();
  const result = companion(
    ['task', '--json', '--model', 'claude:opus', '--role', 'planner', 'go'],
    repo,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  // The child never sees the bare alias: the launch names the concrete id
  // and pins that version's effort.
  const opus = newest('opus');
  const last = readFakeClaudeState(binDir).lastRun!;
  assert.equal(last.model, opus.model);
  assert.equal(last.effort, opus.effort);
  assert.equal(last.envEffort, opus.effort);
  const job = requireCompanionState(repo, env).jobs[0]!;
  assert.equal(job.model, opus.model);
  const rendered = companion(['result', String(job.id)], repo, env).stdout;
  assert.match(rendered, new RegExp(`^Model: ${opus.model}$`, 'm'));
  assert.match(rendered, /^Cost: \$0\.0100$/m);
});

test('a Claude plan review stores the verdict and a later round resumes the session', () => {
  const { repo, binDir, env } = claudeFixture();

  const first = companion(
    ['plan-review', '--json', '--model', 'claude:sonnet-5', 'Initial plan draft'],
    repo,
    env,
  );
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout);
  assert.equal(firstPayload.result.verdict, 'needs-revision');
  assert.equal(firstPayload.parseError, null);
  assert.equal(firstPayload.model, 'claude-sonnet-5');
  assert.equal(firstPayload.effort, versionEffort('sonnet', '5'));
  const firstRun = readFakeClaudeState(binDir).lastRun!;
  assert.equal(firstRun.agent, 'stereo-plan-reviewer');
  assert.ok(
    firstRun.jsonSchema?.properties && 'verdict' in (firstRun.jsonSchema.properties as object),
  );
  // Claude Code validates against draft-07 and rejects a 2020-12 declaration.
  assert.equal('$schema' in (firstRun.jsonSchema ?? {}), false);
  assert.equal('$id' in (firstRun.jsonSchema ?? {}), false);
  assert.ok(
    (firstRun.agentsDefinition!['stereo-plan-reviewer']!.tools as string[]).includes(
      'StructuredOutput',
    ),
  );
  assert.equal(firstRun.resume, null);
  const stored = loadPairPlanState(repo) as { reviewedBy?: string };
  assert.equal(stored.reviewedBy, 'claude:claude-sonnet-5');

  const second = companion(
    [
      'plan-review',
      '--json',
      '--model',
      'claude:sonnet-5',
      '--thread',
      firstPayload.threadId,
      '--round',
      '2',
      'Revised plan draft',
    ],
    repo,
    env,
  );
  assert.equal(second.status, 0, second.stderr);
  const secondPayload = JSON.parse(second.stdout);
  assert.equal(secondPayload.result.verdict, 'approve');
  assert.equal(readFakeClaudeState(binDir).lastRun?.resume, firstPayload.threadId);
  assert.equal(secondPayload.threadId, firstPayload.threadId);
  const jobs = requireCompanionState(repo, env).jobs;
  assert.equal(jobs.filter((job) => job.title?.startsWith('Claude Plan Review')).length, 2);

  // Without --model a later round runs the plan reviewer's default (the
  // Codex built-in here), which cannot resume a Claude session.
  const third = companion(
    ['plan-review', '--json', '--thread', firstPayload.threadId, '--round', '3', 'Third draft'],
    repo,
    env,
  );
  assert.equal(third.status, 1);
  assert.match(
    errorOf(third),
    new RegExp(
      `^Thread ${firstPayload.threadId} belongs to a Claude job \\(\\S+\\); resume it with a Claude --model\\.$`,
    ),
  );
  assert.equal(requireCompanionState(repo, env).jobs.length, 2, 'the refusal left no record');
});

test('Claude reviews run the reviewer roles with the review schema and accept an effort', () => {
  const { repo, binDir, env } = claudeFixture();
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');

  const review = companion(
    ['review', '--json', '--model', 'claude:opus', '--effort', 'high', 'focus on the readme'],
    repo,
    env,
  );
  assert.equal(review.status, 0, review.stderr);
  const reviewPayload = JSON.parse(review.stdout);
  assert.equal(reviewPayload.result.verdict, 'approve');
  const reviewRun = readFakeClaudeState(binDir).lastRun!;
  assert.equal(reviewRun.agent, 'stereo-reviewer');
  assert.equal(reviewRun.envEffort, 'high');
  assert.match(reviewRun.prompt, /focus on the readme/);

  const adversarial = companion(
    ['adversarial-review', '--json', '--model', 'claude:fable'],
    repo,
    env,
  );
  assert.equal(adversarial.status, 0, adversarial.stderr);
  assert.equal(readFakeClaudeState(binDir).lastRun?.agent, 'stereo-adversarial-reviewer');
  assert.equal(readFakeClaudeState(binDir).lastRun?.envEffort, newest('fable').effort);
  const jobs = requireCompanionState(repo, env).jobs;
  assert.deepEqual(jobs.map((job) => job.title).sort(), [
    'Claude Adversarial Review',
    'Claude Review',
  ]);
});

test('a stored Claude reviewer default runs model-less plan reviews and reviews on Claude', () => {
  const { repo, binDir, env } = claudeFixture();
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');
  const config = companion(
    [
      'config',
      '--plan-reviewer',
      'claude:sonnet',
      '--plan-reviewer-effort',
      'high',
      '--implementation-reviewer',
      'claude:fable',
      '--json',
    ],
    repo,
    env,
  );
  assert.equal(config.status, 0, config.stderr);

  // No --model: the plan reviewer's workspace default, at its stored effort.
  const plan = companion(['plan-review', '--json', 'Initial plan draft'], repo, env);
  assert.equal(plan.status, 0, plan.stderr);
  const planPayload = JSON.parse(plan.stdout);
  assert.equal(planPayload.model, newest('sonnet').model);
  assert.equal(planPayload.effort, 'high');
  const planRun = readFakeClaudeState(binDir).lastRun!;
  assert.equal(planRun.agent, 'stereo-plan-reviewer');
  assert.equal(planRun.model, newest('sonnet').model);
  assert.equal(planRun.envEffort, 'high');

  // Both review commands run the implementation reviewer's default at its version default.
  for (const [command, agent] of [
    ['review', 'stereo-reviewer'],
    ['adversarial-review', 'stereo-adversarial-reviewer'],
  ] as const) {
    const result = companion([command, '--json'], repo, env);
    assert.equal(result.status, 0, result.stderr);
    const last = readFakeClaudeState(binDir).lastRun!;
    assert.equal(last.agent, agent);
    assert.equal(last.model, newest('fable').model, command);
    assert.equal(last.envEffort, newest('fable').effort, command);
  }
  const jobs = requireCompanionState(repo, env).jobs;
  assert.ok(jobs.every((job) => job.runtime === 'claude'));
  assert.equal(jobs.length, 3);
});

test('Claude reviews and plan reviews dispatch through the background worker', () => {
  const { repo, binDir, env } = claudeFixture();
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');

  const cases = [
    {
      args: ['review', '--model', 'claude:opus', 'focus on the readme'],
      title: 'Claude Review',
      agent: 'stereo-reviewer',
      verdict: 'approve',
    },
    {
      args: ['adversarial-review', '--model', 'claude:fable'],
      title: 'Claude Adversarial Review',
      agent: 'stereo-adversarial-reviewer',
      verdict: 'approve',
    },
    {
      args: ['plan-review', '--model', 'claude:sonnet-5', '--round', '1', 'Initial plan draft'],
      title: 'Claude Plan Review',
      agent: 'stereo-plan-reviewer',
      verdict: 'needs-revision',
    },
  ];
  for (const { args, title, agent, verdict } of cases) {
    const queued = companion([...args, '--background', '--json'], repo, env);
    assert.equal(queued.status, 0, queued.stderr);
    const { jobId } = JSON.parse(queued.stdout);
    const waited = companion(
      ['status', jobId, '--wait', '--timeout-ms', '20000', '--poll-interval-ms', '200', '--json'],
      repo,
      env,
    );
    assert.equal(waited.status, 0, waited.stderr);
    assert.equal(JSON.parse(waited.stdout).job.status, 'completed', title);

    const stored = JSON.parse(companion(['result', jobId, '--json'], repo, env).stdout);
    assert.equal(stored.job.runtime, 'claude', title);
    assert.match(String(stored.job.title), new RegExp(`^${title}`));
    assert.equal(stored.storedJob.result.result.verdict, verdict, title);
    assert.equal(stored.storedJob.result.parseError, null, title);
    assert.equal(typeof stored.storedJob.result.threadId, 'string', title);
    assert.equal(readFakeClaudeState(binDir).lastRun?.agent, agent, title);
  }
  assert.deepEqual(
    requireCompanionState(repo, env).jobs.map((job) => job.jobClass),
    ['review', 'review', 'review'],
  );
});

test('a Claude implementer runs in acceptEdits with the runner grants plus --allow rules', () => {
  const { repo, binDir, env } = claudeFixture();

  const result = companion(
    [
      'task',
      '--json',
      '--write',
      '--model',
      'claude:opus',
      '--role',
      'implementer',
      '--allow',
      'Bash(pytest *)',
      'implement the plan',
    ],
    repo,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.touchedFiles, [path.join(repo, 'implemented.txt')]);
  // The foreground --json answer slims command captures; the stored record keeps them.
  assert.equal(payload.commandExecutions, undefined);
  assert.ok(fs.existsSync(path.join(repo, 'implemented.txt')));
  const last = readFakeClaudeState(binDir).lastRun!;
  assert.equal(last.permissionMode, 'acceptEdits');
  assert.deepEqual(last.allowedTools, [...IMPLEMENTER_DEFAULT_GRANTS, 'Bash(pytest *)']);
  // Every built-in grant is a `Bash(<runner>:*)` prefix rule, and the fake
  // received them all through the variadic --allowedTools flag, kept last.
  for (const grant of IMPLEMENTER_DEFAULT_GRANTS) {
    assert.match(grant, /^Bash\([a-z0-9]+:\*\)$/);
  }
  const grantsFlag = last.args.indexOf('--allowedTools');
  assert.ok(grantsFlag > -1, 'the grants reach the CLI as --allowedTools');
  assert.deepEqual(last.args.slice(grantsFlag + 1), [
    ...IMPLEMENTER_DEFAULT_GRANTS,
    'Bash(pytest *)',
  ]);
  // Grants only: the run carries no deny rules.
  assert.equal(last.args.includes('--disallowedTools'), false);
  assert.equal(last.agent, 'stereo-implementer');
  const job = requireCompanionState(repo, env).jobs[0];
  assert.equal(job?.write, true);
  assert.equal(job?.status, 'completed');
  const stored = JSON.parse(companion(['result', String(job?.id), '--json'], repo, env).stdout);
  const executions = stored.storedJob.result.commandExecutions as Array<Record<string, unknown>>;
  assert.equal(executions[0]!.command, 'npm test');
  assert.equal(executions[0]!.status, 'completed');
  assert.equal('output' in executions[0]!, false, 'a successful command keeps no output');
  assert.equal(executions[1]!.command, 'npm run lint');
  assert.equal(executions[1]!.exitCode, 1);
  assert.equal(executions[1]!.output, 'lint failed: unexpected token');
});

test('a denied write fails the implementer job and names the path', () => {
  const { repo, env } = claudeFixture('denied-write');

  const result = companion(
    ['task', '--json', '--write', '--model', 'claude:opus', '--role', 'implementer', 'implement'],
    repo,
    env,
  );
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 1);
  // The fake writes beside the repository, wherever the temp directory is.
  const outside = path.join(path.dirname(repo), 'outside.txt');
  // Denials are stored as tool plus target, never with the attempted body.
  assert.deepEqual(payload.claude.permissionDenials, [{ tool: 'Write', target: outside }]);
  assert.deepEqual(
    payload.touchedFiles,
    [path.join(repo, 'implemented.txt')],
    'denied targets are not touched',
  );
  const job = requireCompanionState(repo, env).jobs[0];
  assert.equal(job?.status, 'failed');
  // The failure is what a human sees: on the record and in the rendered result.
  assert.ok(String(job?.summary).includes(`Claude was denied 1 write (${outside})`), job?.summary);
  assert.match(String(job?.errorMessage), /denied 1 write/);
  assert.equal(payload.error, job?.errorMessage);
  const rendered = companion(['result', String(job?.id)], repo, env);
  assert.match(rendered.stdout, /Run failed: Claude was denied 1 write/);
  assert.ok(rendered.stdout.includes(`Denied: ${outside}\n`), rendered.stdout);
  assert.equal(job?.kindLabel, 'implementer');
  // The report-only view of a failed job is the rendered body: the model's
  // report first, then the failure and the denied path closing it.
  const report = companion(['result', String(job?.id), '--report'], repo, env);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /^Files touched:\n- implemented\.txt\n/);
  const reportLines = report.stdout.trimEnd().split('\n');
  assert.match(reportLines.at(-2)!, /^Run failed: Claude was denied 1 write/);
  assert.equal(reportLines.at(-1), `Denied: ${outside}`);
});

test('a reviewer role may carry --allow grants and a denied Bash call is reported, not fatal', () => {
  const { repo, binDir, env } = claudeFixture('bash-denied');
  const result = companion(
    [
      'task',
      '--json',
      '--model',
      'claude:opus',
      '--role',
      'implementation-reviewer',
      '--allow',
      'Bash(npm test)',
      'review',
    ],
    repo,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.claude.permissionDenials, [{ tool: 'Bash', target: 'npm test' }]);
  assert.deepEqual(readFakeClaudeState(binDir).lastRun?.allowedTools, ['Bash(npm test)']);
  assert.equal(readFakeClaudeState(binDir).lastRun?.permissionMode, 'dontAsk');
});

test('Claude selections are validated before any launch or job record', async () => {
  const { repo, binDir, env } = claudeFixture();

  // Refused while the arguments are read, before any probe: in process.
  for (const [args, pattern] of [
    [
      ['task', '--model', 'gpt-5.5', '--allow', 'Bash(x)', 'x'],
      /--allow grants permission rules to a Claude role/,
    ],
    [
      ['task', '--model', 'claude:opus', '--role', 'implementer', 'x'],
      /--role implementer needs --write/,
    ],
    [
      ['task', '--model', 'claude:opus', '--role', 'architect', 'x'],
      /Unsupported --role "architect"/,
    ],
    [
      ['task', '--model', 'claude:session', '--role', 'planner', 'x'],
      /runs inline in the Claude session/,
    ],
    [['task', '--model', 'claude:inherit', '--role', 'planner', 'x'], /claude:inherit was removed/],
    [
      ['task', '--model', 'claude:opus', '--role', 'planner', '--effort', 'ultra', 'x'],
      /for a Claude-routed role/,
    ],
    [
      ['task', '--model', 'claude:fabel', '--role', 'planner', 'x'],
      /Unsupported model "claude:fabel"\. Use claude:<family>/,
    ],
    [
      ['task', '--model', 'claude:opus@bedrock', '--role', 'planner', 'x'],
      /Unsupported model "claude:opus@bedrock"\. Use claude:<family>/,
    ],
    [
      ['plan-review', '--model', 'claude:opus', '--effort', 'none', 'plan'],
      /for a Claude-routed role/,
    ],
  ] as const) {
    const [command, ...rest] = args;
    const result = await runCliInProcess([command, '--cwd', repo, '--json', ...rest], env);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(JSON.parse(result.stdout).error, pattern, args.join(' '));
  }
  assert.deepEqual(readFakeClaudeState(binDir).runs, []);
  assert.equal(readCompanionState(repo, env), null);

  const old = companion(
    ['task', '--json', '--model', 'claude:opus', '--role', 'planner', 'x'],
    repo,
    fakeClaudeBin('old-version').env,
  );
  assert.equal(old.status, 1);
  assert.match(JSON.parse(old.stdout).error, /Claude Code 2\.1\.281 or newer/);

  const loggedOut = companion(
    ['task', '--json', '--model', 'claude:opus', '--role', 'planner', 'x'],
    repo,
    fakeClaudeBin('logged-out').env,
  );
  assert.equal(loggedOut.status, 1);
  assert.equal(JSON.parse(loggedOut.stdout).error, CLAUDE_NOT_AUTHENTICATED_ERROR);

  const missing = companion(
    ['task', '--json', '--model', 'claude:opus', '--role', 'planner', 'x'],
    repo,
    {
      ...process.env,
      PATH: '',
    },
  );
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stdout).error, /Claude roles need the Claude Code CLI/);
  assert.equal(readCompanionState(repo, env), null);
});

test('status and usage label a Claude planner job by its role and a role-less task as rescue', () => {
  const { repo, env } = claudeFixture();
  const planned = companion(
    ['task', '--json', '--model', 'claude:opus', '--role', 'planner', 'plan it'],
    repo,
    env,
  );
  assert.equal(planned.status, 0, planned.stderr);
  const plannerJob = requireCompanionState(repo, env).jobs[0]!;
  assert.equal(plannerJob.kindLabel, 'planner');
  const plannerTokens = plannerJob.tokenUsage.job.totalTokens as number;
  assert.ok(plannerTokens > 0, 'the Claude run reported token usage');

  // A task without a pair role is a rescue, on either runtime.
  const rescue = createCompanionJob({
    prefix: 'task',
    kind: 'task',
    title: 'Codex Task',
    workspaceRoot: repo,
    jobClass: 'task',
    summary: 'role-less rescue',
    model: 'gpt-6-astra',
  });
  const breakdown = {
    totalTokens: 300,
    inputTokens: 200,
    cachedInputTokens: 50,
    cacheWriteInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 20,
  };
  upsertJob(repo, {
    ...rescue,
    status: 'completed',
    completedAt: nowIso(),
    tokenUsage: { job: breakdown, thread: breakdown, modelContextWindow: null },
  });

  const status = JSON.parse(companion(['status', '--json'], repo, env).stdout);
  const labels = new Map<string, string>(
    [status.latestFinished, ...status.recent].map((job) => [job.id, job.kindLabel]),
  );
  assert.equal(labels.get(plannerJob.id), 'planner');
  assert.equal(labels.get(rescue.id), 'rescue');
  const single = JSON.parse(companion(['status', plannerJob.id, '--json'], repo, env).stdout);
  assert.equal(single.job.kindLabel, 'planner');
  assert.equal(single.job.runtime, 'claude');

  const usage = JSON.parse(companion(['status', '--usage', '--json'], repo, env).stdout);
  const byKind = new Map<string, Record<string, number>>(
    usage.byKind.map((group: Record<string, unknown>) => [group.key, group]),
  );
  assert.deepEqual([...byKind.keys()].sort(), ['planner', 'rescue']);
  assert.equal(byKind.get('planner')?.jobs, 1);
  assert.equal(byKind.get('planner')?.totalTokens, plannerTokens);
  assert.equal(byKind.get('rescue')?.jobs, 1);
  assert.equal(byKind.get('rescue')?.totalTokens, 300);
  const rendered = companion(['status', '--usage'], repo, env);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /\| planner \| 1 \| 1 \|/);
  assert.match(rendered.stdout, /\| rescue \| 1 \| 1 \|/);
});

test('a dated served id is normalised everywhere the run records it', () => {
  const { repo, binDir } = claudeFixture();
  const env = { ...buildClaudeEnv(binDir), FAKE_CLAUDE_SERVED_MODEL: 'claude-haiku-4-5-20251001' };

  const reviewed = companion(
    ['plan-review', '--json', '--model', 'claude:haiku', 'Initial plan draft'],
    repo,
    env,
  );
  assert.equal(reviewed.status, 0, reviewed.stderr);
  const payload = JSON.parse(reviewed.stdout);
  // The payload, the plan's reviewer label, and the job record all carry
  // the id the launch pinned.
  assert.equal(payload.model, 'claude-haiku-4-5');
  const stored = loadPairPlanState(repo) as { reviewedBy?: string };
  assert.equal(stored.reviewedBy, 'claude:claude-haiku-4-5');
  const job = requireCompanionState(repo, env).jobs[0]!;
  assert.equal(job.model, 'claude-haiku-4-5');
});

test('a later plan-review round on a bare --thread keeps the stored Claude default effort', () => {
  const { repo, binDir, env } = claudeFixture();
  const config = companion(
    ['config', '--plan-reviewer', 'claude:opus', '--plan-reviewer-effort', 'medium', '--json'],
    repo,
    env,
  );
  assert.equal(config.status, 0, config.stderr);

  const first = companion(['plan-review', '--json', 'Initial plan draft'], repo, env);
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout).threadId as string;
  assert.equal(readFakeClaudeState(binDir).lastRun?.effort, 'medium');

  const second = companion(
    ['plan-review', '--json', '--thread', threadId, '--round', '2', 'Revised plan draft'],
    repo,
    env,
  );
  assert.equal(second.status, 0, second.stderr);
  const last = readFakeClaudeState(binDir).lastRun!;
  assert.deepEqual(
    [last.resume, last.model, last.effort],
    [threadId, newest('opus').model, 'medium'],
  );
});

test('--sandbox turns on the Claude Code Bash sandbox in the child and is Claude-only', () => {
  const { repo, binDir, env } = claudeFixture();
  const sandboxed = companion(
    [
      'task',
      '--json',
      '--sandbox',
      '--write',
      '--model',
      'claude:opus',
      '--role',
      'implementer',
      'implement it',
    ],
    repo,
    env,
  );
  assert.equal(sandboxed.status, 0, sandboxed.stderr);
  assert.deepEqual(JSON.parse(String(readFakeClaudeState(binDir).lastRun?.flags.settings)), {
    disableAllHooks: true,
    sandbox: { enabled: true },
  });

  // Opt-in only: without the flag the settings carry no sandbox key at all.
  const plain = companion(
    ['task', '--json', '--write', '--model', 'claude:opus', '--role', 'implementer', 'again'],
    repo,
    env,
  );
  assert.equal(plain.status, 0, plain.stderr);
  const settings = JSON.parse(String(readFakeClaudeState(binDir).lastRun?.flags.settings));
  assert.equal('sandbox' in settings, false);
  assert.deepEqual(settings, { disableAllHooks: true });

  // The workspace default turns it on for every implementer launch, and
  // --no-sandbox turns it off for one run.
  const stored = companion(['config', '--claude-sandbox', 'on', '--json'], repo, env);
  assert.equal(stored.status, 0, stored.stderr);
  const implement = (extra: string[]) =>
    companion(
      ['task', '--json', '--write', '--model', 'claude:opus', '--role', 'implementer', ...extra],
      repo,
      env,
    );
  const defaulted = implement(['by default']);
  assert.equal(defaulted.status, 0, defaulted.stderr);
  assert.deepEqual(JSON.parse(String(readFakeClaudeState(binDir).lastRun?.flags.settings)), {
    disableAllHooks: true,
    sandbox: { enabled: true },
  });
  const optedOut = implement(['--no-sandbox', 'not this time']);
  assert.equal(optedOut.status, 0, optedOut.stderr);
  assert.deepEqual(JSON.parse(String(readFakeClaudeState(binDir).lastRun?.flags.settings)), {
    disableAllHooks: true,
  });
});

// What a Claude role launch runs, from an in-process dry run: the id and the
// effort the launch hands the child (the planner test above proves the child
// gets both, as the flag and as the environment pin).
async function launchOf(
  repo: string,
  selection: string,
  role: string,
  extra: string[] = [],
): Promise<Launched> {
  const args = ['task', '--dry-run', '--json', '--cwd', repo, '--model', selection, '--role', role];
  if (role === 'implementer') {
    args.push('--write');
  }
  const result = await runCliInProcess([...args, ...extra, 'work']);
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  const { model, effort } = JSON.parse(result.stdout) as Launched;
  return { model, effort };
}

// `config` for one workspace, in process.
async function configure(repo: string, args: string[]): Promise<void> {
  const result = await runCliInProcess(['config', '--cwd', repo, '--json', ...args]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('a launch runs its version default effort, a stored default only where it applies, and an explicit --effort over both', async () => {
  const repo = initializeBasicRepo();
  // No stored default: every launch runs at its version's default, whatever the role.
  assert.deepEqual(await launchOf(repo, 'claude:opus', 'implementer'), newest('opus'));
  assert.deepEqual(await launchOf(repo, 'claude:sonnet-5', 'planner'), {
    model: 'claude-sonnet-5',
    effort: versionEffort('sonnet', '5'),
  });

  // A stored pair applies to its own model on its own role; an effort stored
  // alone rides the role's built-in model and no other.
  await configure(repo, [
    '--implementer',
    'claude:opus-4.8',
    '--implementer-effort',
    'high',
    '--planner-effort',
    'medium',
  ]);
  const opus48 = { model: 'claude-opus-4-8', effort: versionEffort('opus', '4.8') };
  assert.deepEqual(await launchOf(repo, 'claude:opus-4.8', 'implementer'), {
    ...opus48,
    effort: 'high',
  });
  assert.deepEqual(await launchOf(repo, 'claude:opus', 'implementer'), newest('opus'));
  assert.deepEqual(await launchOf(repo, 'claude:opus-4.8', 'planner'), opus48);
  const planner = claudeBuiltIn('planner');
  assert.deepEqual(await launchOf(repo, builtInSelection('planner'), 'planner'), {
    model: planner.model,
    effort: 'medium',
  });

  // An explicit effort wins over both.
  assert.deepEqual(await launchOf(repo, 'claude:opus-4.8', 'implementer', ['--effort', 'low']), {
    ...opus48,
    effort: 'low',
  });
  assert.deepEqual(
    await launchOf(repo, builtInSelection('planner'), 'planner', ['--effort', 'max']),
    {
      model: planner.model,
      effort: 'max',
    },
  );
});

test('an explicit effort on a haiku selection is refused before any job record', async () => {
  const { repo, binDir, env } = claudeFixture();
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');
  const haiku = newest('haiku').model;

  for (const [args, modelArg, effort] of [
    [
      ['task', '--model', 'claude:haiku', '--role', 'planner', '--effort', 'high', 'x'],
      haiku,
      'high',
    ],
    [['plan-review', '--model', 'claude:haiku', '--effort', 'high', 'plan'], haiku, 'high'],
    [['review', '--model', 'claude:haiku', '--effort', 'high'], haiku, 'high'],
    [
      ['adversarial-review', '--model', 'claude:haiku-4.5', '--effort', 'low'],
      'claude-haiku-4-5',
      'low',
    ],
  ] as const) {
    const [command, ...rest] = args;
    const result = await runCliInProcess([command, '--cwd', repo, '--json', ...rest], env);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(
      errorOf(result),
      `claude:haiku takes no effort (the model rejects the parameter); drop --effort ${effort} for ${modelArg}.`,
      args.join(' '),
    );
  }
  assert.equal(readCompanionState(repo, env), null, 'no refusal left a record');
  assert.deepEqual(readFakeClaudeState(binDir).runs, [], 'no refusal reached the CLI');

  // Without an effort the same selection runs, and the child gets none.
  const ran = companion(
    ['task', '--json', '--model', 'claude:haiku', '--role', 'planner', 'x'],
    repo,
    env,
  );
  assert.equal(ran.status, 0, ran.stderr);
  const last = readFakeClaudeState(binDir).lastRun!;
  assert.equal(last.model, haiku);
  assert.equal(last.effort, null);
  assert.equal(last.envEffort, null);
  assert.equal(requireCompanionState(repo, env).jobs[0]?.status, 'completed');
});

test('the parent session identity never reaches the child environment', () => {
  const { repo, binDir, env } = claudeFixture();
  const result = companion(
    ['task', '--json', '--model', 'claude:opus', '--role', 'planner', 'go'],
    repo,
    {
      ...env,
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ATTENDED: 'true',
      CLAUDE_PID: '12345',
      CODEX_COMPANION_SESSION_ID: 'sess-parent',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const last = readFakeClaudeState(binDir).lastRun!;
  assert.equal(last.envSessionId, null);
  assert.equal(last.envChildSession, null);
  assert.equal(last.envSessionAttended, null);
  assert.equal(last.envClaudePid, null);
  assert.equal(last.envCompanionSession, null);
  // The job itself still belongs to the launching session.
  assert.equal(requireCompanionState(repo, env).jobs[0]?.sessionId, 'sess-parent');
});

test('a Claude plan review that returns no structured JSON keeps its session for the next round', () => {
  const { repo, binDir, env } = claudeFixture('invalid-structured');
  const first = companion(
    ['plan-review', '--json', '--model', 'claude:sonnet-5', 'Initial plan draft'],
    repo,
    env,
  );
  assert.equal(first.status, 0, first.stderr);
  const payload = JSON.parse(first.stdout);
  assert.equal(payload.result, null);
  assert.equal(typeof payload.parseError, 'string');
  assert.ok(payload.parseError.length > 0);
  assert.equal(payload.rawOutput, 'not json at all');
  assert.equal(typeof payload.threadId, 'string');
  assert.equal(loadPairPlanState(repo), null, 'an unparsable round stores no verdict');
  const job = requireCompanionState(repo, env).jobs[0]!;
  assert.equal(job.status, 'completed');
  assert.equal(job.threadId, payload.threadId);
  assert.equal(job.summary, payload.parseError);
  const rendered = companion(['result', String(job.id)], repo, env);
  assert.match(rendered.stdout, /^# Claude Plan Review\n/);
  assert.match(
    rendered.stdout,
    /\nThe reviewer did not return valid structured JSON\.\n\n- Parse error: /,
  );
  assert.match(rendered.stdout, /not json at all/);

  // The session survives the bad round: the next one resumes it.
  const second = companion(
    [
      'plan-review',
      '--json',
      '--thread',
      payload.threadId,
      '--model',
      'claude:sonnet-5',
      '--round',
      '2',
      'Revised plan draft',
    ],
    repo,
    env,
  );
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).threadId, payload.threadId);
  const resumed = readFakeClaudeState(binDir).lastRun!;
  assert.equal(resumed.resume, payload.threadId);
  assert.equal(resumed.model, 'claude-sonnet-5');
  assert.equal(readFakeClaudeState(binDir).runs.length, 2);
});

test('a Claude task launched from a worktree with --workspace records under the repository', () => {
  const { repo, binDir, env: baseEnv } = claudeFixture();
  const worktree = path.join(makeTempDir(), 'wt');
  const added = run('git', ['worktree', 'add', '-b', 'stereo-wt', worktree], { cwd: repo });
  assert.equal(added.status, 0, added.stderr);
  const launchDir = makeTempDir();
  const env = { ...baseEnv, CODEX_COMPANION_SESSION_ID: 'sess-worktree' };

  const result = companion(
    [
      'task',
      '--json',
      '--model',
      'claude:opus',
      '--role',
      'planner',
      '--cwd',
      worktree,
      '--workspace',
      repo,
      'plan in the worktree',
    ],
    launchDir,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  const last = readFakeClaudeState(binDir).lastRun!;
  assert.equal(fs.realpathSync.native(last.cwd), worktree, 'the role runs in the worktree');

  // The record lives under the repository, nowhere else, and the session
  // registry names the repository so SessionEnd can find it from elsewhere.
  const job = requireCompanionState(repo, env).jobs[0]!;
  assert.equal(job.status, 'completed');
  assert.equal(job.sessionId, 'sess-worktree');
  assert.equal(job.threadId, last.sessionId);
  assert.equal(readCompanionState(worktree, env), null);
  assert.equal(readCompanionState(launchDir, env), null);
  assert.deepEqual(readSessionWorkspaces('sess-worktree'), [repo]);
  const status = JSON.parse(
    companion(['status', '--json', '--workspace', repo], launchDir, env).stdout,
  );
  assert.equal(status.latestFinished?.id, job.id);
  assert.equal(status.workspaceRoot, repo);
  const local = JSON.parse(companion(['status', '--json'], worktree, env).stdout);
  assert.equal(local.latestFinished, null, 'the worktree itself holds no record');
});

test('a Claude session resumes only from the directory it ran in', () => {
  const { repo, binDir, env } = claudeFixture();
  const worktree = path.join(makeTempDir(), 'wt');
  const added = run('git', ['worktree', 'add', '-b', 'stereo-wt-resume', worktree], { cwd: repo });
  assert.equal(added.status, 0, added.stderr);
  const inWorktree = ['--cwd', worktree, '--workspace', repo];
  const first = companion(
    ['task', '--json', '--model', 'claude:opus', '--role', 'planner', ...inWorktree, 'plan it'],
    repo,
    env,
  );
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout).threadId as string;
  assert.equal(requireCompanionState(repo, env).jobs[0]?.cwd, worktree);

  // Claude Code keeps the session under the worktree: resuming it from the
  // repository is refused before any job record or Claude run.
  const resume = ['--thread', threadId, '--model', 'claude:opus', '--role', 'planner'];
  const elsewhere = companion(['task', '--json', ...resume, 'refine it'], repo, env);
  assert.equal(elsewhere.status, 1);
  assert.equal(
    errorOf(elsewhere),
    `Session ${threadId} ran in ${worktree}; resume it from there (pass --cwd '${worktree}').`,
  );
  assert.equal(requireCompanionState(repo, env).jobs.length, 1);
  assert.equal(readFakeClaudeState(binDir).runs.length, 1);

  const resumed = companion(['task', '--json', ...resume, ...inWorktree, 'refine it'], repo, env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(readFakeClaudeState(binDir).lastRun?.resume, threadId);
});

test('a Claude plan-review session resumes only from the directory it ran in', () => {
  const { repo, binDir, env } = claudeFixture();
  const worktree = path.join(makeTempDir(), 'wt');
  const added = run('git', ['worktree', 'add', '-b', 'stereo-wt-plan', worktree], { cwd: repo });
  assert.equal(added.status, 0, added.stderr);
  const inWorktree = ['--cwd', worktree, '--workspace', repo];
  const first = companion(
    ['plan-review', '--json', '--model', 'claude:sonnet-5', ...inWorktree, 'Initial plan'],
    repo,
    env,
  );
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout).threadId as string;
  assert.equal(requireCompanionState(repo, env).jobs[0]?.cwd, worktree);

  const resume = ['--thread', threadId, '--model', 'claude:sonnet-5', '--round', '2'];
  const elsewhere = companion(['plan-review', '--json', ...resume, 'Revised plan'], repo, env);
  assert.equal(elsewhere.status, 1);
  assert.equal(
    errorOf(elsewhere),
    `Session ${threadId} ran in ${worktree}; resume it from there (pass --cwd '${worktree}').`,
  );
  assert.equal(requireCompanionState(repo, env).jobs.length, 1);
  assert.equal(readFakeClaudeState(binDir).runs.length, 1);

  const resumed = companion(
    ['plan-review', '--json', ...resume, ...inWorktree, 'Revised plan'],
    repo,
    env,
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(readFakeClaudeState(binDir).lastRun?.resume, threadId);
});

test('task --role without --model runs the role default on its own runtime', async () => {
  const repo = initializeBasicRepo();
  const codexBin = makeTempDir();
  installFakeCodex(codexBin);
  const claudeBin = makeTempDir();
  installFakeClaude(claudeBin);
  const env = buildClaudeEnv(claudeBin, buildEnv(codexBin));

  // The planner's built-in is Claude-routed: the fake claude runs it.
  const planner = companion(['task', '--json', '--role', 'planner', 'draft the plan'], repo, env);
  assert.equal(planner.status, 0, planner.stderr);
  const claudeRun = readFakeClaudeState(claudeBin).lastRun!;
  const plannerDefault = claudeBuiltIn('planner');
  assert.deepEqual(
    [claudeRun.model, claudeRun.effort],
    [plannerDefault.model, plannerDefault.effort],
  );

  // The reviewer roles run the implementation reviewer's built-in on Codex...
  const reviewer = companion(['task', '--json', '--role', 'reviewer', 'review it'], repo, env);
  assert.equal(reviewer.status, 0, reviewer.stderr);
  const reviewerDefault = codexBuiltIn('implementation-reviewer');
  const builtInTurn = await waitFor(() => {
    const turn = readFakeState(codexBin).lastTurnStart;
    return turn?.model === reviewerDefault.model ? turn : null;
  });
  assert.equal(builtInTurn.effort, reviewerDefault.effort);

  // ...and its stored default at its stored effort.
  const config = companion(
    [
      'config',
      '--implementation-reviewer',
      'codex:sol',
      '--implementation-reviewer-effort',
      'high',
      '--json',
    ],
    repo,
    env,
  );
  assert.equal(config.status, 0, config.stderr);
  const adversarial = companion(
    ['task', '--json', '--role', 'adversarial-reviewer', 'challenge it'],
    repo,
    env,
  );
  assert.equal(adversarial.status, 0, adversarial.stderr);
  const solTurn = await waitFor(() => {
    const turn = readFakeState(codexBin).lastTurnStart;
    return turn?.model === 'gpt-6-sol' ? turn : null;
  });
  assert.equal(solTurn.effort, 'high');
  assert.equal(readFakeClaudeState(claudeBin).runs.length, 1, 'only the planner reached Claude');
});

// The rule grammar itself is pinned in allow-rules.test.ts.

test('a refused --allow rule fails before any job record or Claude run', async () => {
  const repo = initializeBasicRepo();
  const claudeBin = makeTempDir();
  installFakeClaude(claudeBin);
  const env = buildClaudeEnv(claudeBin);
  const result = await runCliInProcess(
    [
      'task',
      '--cwd',
      repo,
      '--json',
      '--model',
      'claude:opus',
      '--role',
      'planner',
      '--allow',
      'Bash(node:*)',
      'x',
    ],
    env,
  );
  assert.equal(result.status, 1);
  assert.equal(
    errorOf(result),
    'Unsupported --allow rule "Bash(node:*)": a wildcard would let the read-only planner run commands beyond the one named; name the exact command instead.',
  );
  assert.equal(readCompanionState(repo, env), null);
  assert.deepEqual(readFakeClaudeState(claudeBin).runs, []);
});

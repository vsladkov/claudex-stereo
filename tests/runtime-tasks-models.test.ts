import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import {
  builtinCatalog,
  resolveCompanionCatalogFile,
  writeCodexCatalogCache,
} from '../plugins/stereo/src/models/catalog.ts';
import type { CodexCatalog } from '../plugins/stereo/src/models/catalog.ts';
import {
  claudeModelId,
  defaultClaudeEffort,
  parseClaudeSelection,
} from '../plugins/stereo/src/models/claude-models.ts';
import { latestModelVersion } from '../plugins/stereo/src/models/model-table.ts';
import type { ModelVersionRow } from '../plugins/stereo/src/models/model-table.ts';
import {
  defaultModelEffort,
  parseCodexSelection,
  resolveCodexSelection,
} from '../plugins/stereo/src/models/registry.ts';
import { ROLE_DEFINITIONS } from '../plugins/stereo/src/models/role-defaults.ts';
import type { RoleDefinition } from '../plugins/stereo/src/models/role-defaults.ts';
import { buildClaudeEnv, installFakeClaude, readFakeClaudeState } from './fake-claude-fixture.ts';
import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import {
  accountCatalogModels,
  ASTRA_TIERS,
  catalogFixture,
  initGitRepo,
  makeTempDir,
  run,
  seedState,
  waitFor,
  writeExecutable,
} from './helpers.ts';
import {
  SCRIPT,
  companion,
  errorOf,
  findThreadReservation,
  initializeBasicRepo,
  readCompanionState,
  readFakeState,
  readJsonIfReadable,
  registerBrokerReaping,
  requireCompanionState,
  resolveCompanionStateDir,
  runCliInProcess,
  waitForFakeState,
  waitForTurnStart,
  withCodexHome,
} from './runtime-helpers.ts';
import { updateState } from '../plugins/stereo/src/workspace/state.ts';
import type { JobRecord } from '../plugins/stereo/src/workspace/state.ts';

registerBrokerReaping();

// The role defaults and version defaults come from the role definitions, the
// version table, and the fake's catalog, so a new row or a moved built-in
// changes what these tests expect, not the tests.
const ACCOUNT_CATALOG = catalogFixture(accountCatalogModels());
const builtInSelection = (flag: RoleDefinition['flag']): string =>
  (ROLE_DEFINITIONS.find((role) => role.flag === flag) as RoleDefinition).builtInSelection;

// A role's Claude built-in as a launch runs it: its id and its version's effort.
function claudeBuiltIn(flag: RoleDefinition['flag']): { model: string; effort: string | null } {
  const { modelArg } = parseClaudeSelection(builtInSelection(flag));
  return { model: modelArg, effort: defaultClaudeEffort(modelArg) };
}

interface DryRunLaunch {
  runtime: 'claude' | 'codex';
  model: string | null;
  effort: string | null;
  role: string | null;
  sandbox: boolean;
}

// What `task --dry-run --json` prints for a launch: the launch, the selection
// it pins (the id with its runtime prefix), and the launchArgs a
// --launch-args-file replay takes.
function taskDryRun(launch: DryRunLaunch, allowRules: string[] = []): Record<string, unknown> {
  const selection = launch.model ? `${launch.runtime}:${launch.model}` : null;
  return {
    ok: true,
    ...launch,
    selection,
    launchArgs: {
      selection,
      effort: launch.effort,
      role: launch.role,
      allowRules,
      sandbox: launch.sandbox,
    },
  };
}

// A role's Codex built-in resolved against a catalog, at its version default.
function codexBuiltIn(
  flag: RoleDefinition['flag'],
  catalog: CodexCatalog = ACCOUNT_CATALOG,
): { model: string; effort: string | null } {
  const model = resolveCodexSelection(parseCodexSelection(builtInSelection(flag))!, catalog);
  return { model, effort: defaultModelEffort(model, { catalog }) };
}

const codexEffort = (model: string): string | null =>
  defaultModelEffort(model, { catalog: ACCOUNT_CATALOG });

// `task --dry-run` in process: it starts no runtime and records nothing, so
// only its answer is under test.
const taskDryRunOf =
  (repo: string, env: NodeJS.ProcessEnv) =>
  (args: string[], json = true) =>
    runCliInProcess(
      ['task', '--cwd', repo, ...(json ? ['--json'] : []), '--dry-run', ...args],
      env,
    );

test('task rejects a Claude route before starting a turn or creating a job record', () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  const env = buildEnv(binDir);

  const result = run(
    process.execPath,
    [SCRIPT, 'task', '--json', '--model', 'claude:opus', 'do not start this task'],
    { cwd: repo, env },
  );

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(payload), ['error']);
  assert.equal(
    payload.error,
    'A Claude selection needs --role. Use one of: planner, implementer, plan-reviewer, implementation-reviewer, reviewer, adversarial-reviewer.',
  );
  assert.equal(readFakeState(binDir).lastTurnStart, undefined);
  assert.equal(readFakeState(binDir).appServerStarts ?? 0, 0, 'no runtime was probed');
  assert.equal(readCompanionState(repo, env), null);
});

test('task forwards model selection and reasoning effort to app-server turn/start', async () => {
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
    [SCRIPT, 'task', '--model', 'luna', '--effort', 'low', 'diagnose the failing test'],
    {
      cwd: repo,
      env: buildEnv(binDir),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  // The broker-owned fake app-server keeps rewriting its state file after
  // the run returns; read it like any live file.
  const fakeState = await waitFor(() => readJsonIfReadable<Record<string, any>>(statePath));
  assert.equal(fakeState.lastThreadStart.model, 'gpt-6-luna');
  assert.equal(fakeState.lastThreadStart.modelProvider, 'openai');
  assert.equal(fakeState.lastTurnStart.model, 'gpt-6-luna');
  assert.equal(fakeState.lastTurnStart.effort, 'low');

  const maxResult = run(
    'node',
    [SCRIPT, 'task', '--model', 'luna', '--effort', 'max', 'investigate the parser regression'],
    {
      cwd: repo,
      env: buildEnv(binDir),
    },
  );

  assert.equal(maxResult.status, 0, maxResult.stderr);
  const maxState = await waitFor(() => readJsonIfReadable<Record<string, any>>(statePath));
  assert.equal(maxState.lastTurnStart.model, 'gpt-6-luna');
  assert.equal(maxState.lastTurnStart.effort, 'max');
});

test('an explicit Codex effort the catalog does not list for the model is refused before any job record', () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  // The fake catalog lists gpt-6-luna up to max; ultra is a sol/astra tier.
  for (const args of [
    ['task', '--model', 'luna', '--effort', 'ultra', 'diagnose the failing test'],
    ['plan-review', '--model', 'codex:luna-6', '--effort', 'ultra', 'Review the plan'],
    ['review', '--model', 'gpt-6-luna', '--effort', 'ultra'],
  ]) {
    const result = run('node', [SCRIPT, ...args, '--json'], { cwd: repo, env });
    assert.equal(result.status, 1, args.join(' '));
    assert.deepEqual(
      JSON.parse(result.stdout),
      {
        error:
          'Effort ultra is not a tier codex:luna (gpt-6-luna) lists; the catalog lists low, medium, high, xhigh, max.',
      },
      args.join(' '),
    );
  }
  assert.deepEqual(readCompanionState(repo, env)?.jobs ?? [], [], 'no refusal left a record');
  assert.equal(readFakeState(binDir).lastTurnStart, undefined, 'no refusal reached a turn');
});

test('qualified task models route bare ids to explicit providers and remain canonical in job output', async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  const env = buildEnv(binDir);

  const task = run(
    process.execPath,
    [SCRIPT, 'task', '--model', 'unregistered-x@myprov', 'exercise provider routing'],
    { cwd: repo, env },
  );
  assert.equal(task.status, 0, task.stderr);

  const fakeState = await waitForFakeState(binDir, 'lastTurnStart');
  assert.equal(fakeState.lastThreadStart.model, 'unregistered-x');
  assert.equal(fakeState.lastThreadStart.modelProvider, 'myprov');
  assert.equal(fakeState.lastTurnStart.model, 'unregistered-x');

  const taskJob = requireCompanionState(repo, env).jobs.find(
    (job) => job.model === 'unregistered-x@myprov',
  );
  assert.ok(taskJob);

  const status = run(process.execPath, [SCRIPT, 'status', taskJob.id, '--json'], {
    cwd: repo,
    env,
  });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.job.model, 'unregistered-x@myprov');
  assert.equal(statusPayload.job.modelDisplay, 'unregistered-x@myprov');

  const result = run(process.execPath, [SCRIPT, 'result', taskJob.id], {
    cwd: repo,
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\nModel: unregistered-x@myprov\n/);

  const override = run(
    process.execPath,
    [SCRIPT, 'task', '--model', 'kimi@custom', 'override the registry provider'],
    { cwd: repo, env },
  );
  assert.equal(override.status, 0, override.stderr);
  const overrideState = await waitForFakeState(binDir, 'lastTurnStart');
  assert.equal(overrideState.lastThreadStart.model, 'kimi-k3');
  assert.equal(overrideState.lastThreadStart.modelProvider, 'custom');
  assert.equal(overrideState.lastTurnStart.model, 'kimi-k3');
});

test('family selections resolve against the refreshed catalog, version pins hold, and unknown ones fail fast', async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const pinned = run(
    'node',
    [SCRIPT, 'task', '--model', 'sol-5.6', '--json', 'pin the previous sol'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(
    (await waitForFakeState(binDir, 'lastThreadStart')).lastThreadStart.model,
    'gpt-5.6-sol',
  );

  // The launch-ready check fetched model/list and cached it under CODEX_HOME.
  const cacheFile = path.join(env.CODEX_HOME, 'companion-state', 'codex-models.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
    fetchedAt: string;
    models: Array<{ id: string }>;
  };
  assert.ok(cache.models.some((model) => model.id === 'gpt-6-sol'));

  const latest = run('node', [SCRIPT, 'task', '--model', 'sol', '--json', 'use the latest sol'], {
    cwd: repo,
    env,
  });
  assert.equal(latest.status, 0, latest.stderr);
  assert.equal(
    (await waitForFakeState(binDir, 'lastThreadStart')).lastThreadStart.model,
    'gpt-6-sol',
  );
  // A fetch younger than the TTL is reused: launches do not rewrite the cache.
  const cacheAfterLaunches = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
    fetchedAt: string;
  };
  assert.equal(cacheAfterLaunches.fetchedAt, cache.fetchedAt);
  // Setup always refreshes, so its fetch time moves forward.
  const setup = run('node', [SCRIPT, 'setup', '--json'], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const cacheAfterSetup = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { fetchedAt: string };
  assert.ok(cacheAfterSetup.fetchedAt > cache.fetchedAt, 'setup re-fetched the catalog');

  const retired = run(
    'node',
    [SCRIPT, 'task', '--model', 'mini', '--json', 'use the retired alias'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(retired.status, 1);
  assert.match(
    errorOf(retired),
    /^Cannot resolve "mini": the Codex model catalog lists no mini family/,
  );
  const unknownVersion = run(
    'node',
    [SCRIPT, 'task', '--model', 'sol-4', '--json', 'pin a version that does not exist'],
    { cwd: repo, env },
  );
  assert.equal(unknownVersion.status, 1);
  assert.match(unknownVersion.stdout, /lists sol versions 6 \(gpt-6-sol\), 5\.6 \(gpt-5\.6-sol\)/);
  // Rejected selections never create job records.
  assert.equal(requireCompanionState(repo, env).jobs.length, 2);
});

test('a runtime without model/list keeps the built-in floor and names the failed fetch', async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'model-list-fails');
  const env = buildEnv(binDir);

  const setup = run('node', [SCRIPT, 'setup', '--json'], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const report = JSON.parse(setup.stdout) as { rendered: string; nextSteps: string[] };
  assert.match(report.rendered, /- Codex catalog: built-in snapshot /);
  assert.match(report.rendered, /\n- codex:astra → gpt-6-astra \(effort xhigh\)\n/);
  assert.doesNotMatch(report.rendered, /codex:sol/);
  assert.ok(
    report.nextSteps.includes(
      'Codex model/list failed (Unsupported method: model/list); showing the built-in snapshot.',
    ),
    report.nextSteps.join('\n'),
  );
  assert.equal(
    fs.existsSync(path.join(env.CODEX_HOME, 'companion-state', 'codex-models.json')),
    false,
    'a failed model/list must not write a catalog cache',
  );

  // The floor resolves only the built-in default family; any other family
  // word is refused naming the failed fetch rather than sent to Codex as a
  // raw id, while a full model id still passes through.
  const astra = run('node', [SCRIPT, 'task', '--model', 'astra', '--json', 'use the default'], {
    cwd: repo,
    env,
  });
  assert.equal(astra.status, 0, astra.stderr);
  assert.equal(
    (await waitForFakeState(binDir, 'lastThreadStart')).lastThreadStart.model,
    'gpt-6-astra',
  );
  const family = run('node', [SCRIPT, 'task', '--model', 'sol-5.6', '--json', 'pass through'], {
    cwd: repo,
    env,
  });
  assert.equal(family.status, 1);
  assert.deepEqual(JSON.parse(family.stdout), {
    error:
      'Cannot resolve "sol-5.6": fetching the Codex model catalog failed (Unsupported method: model/list), and the built-in snapshot lists no sol family, only codex:astra. Use a listed codex:<family>[-<version>], or <id>@<provider> for another provider\'s model.',
  });
  assert.equal(requireCompanionState(repo, env).jobs.length, 1, 'the refusal left no record');
  const raw = run('node', [SCRIPT, 'task', '--model', 'gpt-5.6-sol', '--json', 'pass through'], {
    cwd: repo,
    env,
  });
  assert.equal(raw.status, 0, raw.stderr);
  assert.equal(
    (await waitForFakeState(binDir, 'lastThreadStart')).lastThreadStart.model,
    'gpt-5.6-sol',
  );
});

test('selections resolve against the live model/list, not a built-in table', async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  // An account whose catalog moved sol and astra on to 7 and no longer lists astra 6.
  fs.writeFileSync(
    path.join(binDir, 'fake-codex-state.json'),
    JSON.stringify({
      nextThreadId: 1,
      nextTurnId: 1,
      appServerStarts: 0,
      threads: [],
      capabilities: null,
      lastInterrupt: null,
      catalog: [
        { id: 'gpt-7-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        { id: 'gpt-6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'gpt-7-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      ],
    }),
  );
  const env = buildEnv(binDir);

  const latest = run('node', [SCRIPT, 'task', '--model', 'sol', '--json', 'use the newest sol'], {
    cwd: repo,
    env,
  });
  assert.equal(latest.status, 0, latest.stderr);
  assert.equal(
    (await waitForFakeState(binDir, 'lastThreadStart')).lastThreadStart.model,
    'gpt-7-sol',
  );

  const unknown = run(
    'node',
    [SCRIPT, 'task', '--model', 'sol-5.6', '--json', 'pin a version this account lacks'],
    { cwd: repo, env },
  );
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /lists sol versions 7 \(gpt-7-sol\), 6 \(gpt-6-sol\)/);

  // The reviewer roles' built-in default pins an astra version this account
  // lacks: it fails before a job record exists, naming the default, even
  // though a newer astra is listed.
  const refusal = (label: string, flag: RoleDefinition['flag']): string => {
    const selection = builtInSelection(flag);
    return `The ${label}'s built-in default ${selection} cannot run: Cannot resolve "${selection}": the Codex model catalog lists astra versions 7 (gpt-7-astra). Use a listed codex:<family>[-<version>], or <id>@<provider> for another provider's model. Pass --model, or store another default with /stereo:config.`;
  };
  const noDefault = run('node', [SCRIPT, 'plan-review', '--json', 'Review the plan'], {
    cwd: repo,
    env,
  });
  assert.equal(noDefault.status, 1);
  assert.deepEqual(JSON.parse(noDefault.stdout), {
    error: refusal('plan reviewer', 'plan-reviewer'),
  });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');
  const noReviewDefault = run('node', [SCRIPT, 'review', '--json'], { cwd: repo, env });
  assert.equal(noReviewDefault.status, 1);
  assert.deepEqual(JSON.parse(noReviewDefault.stdout), {
    error: refusal('implementation reviewer', 'implementation-reviewer'),
  });
  assert.equal(requireCompanionState(repo, env).jobs.length, 1, 'no refusal left a record');
});

test('a model-less plan-review runs the stored plan reviewer default at its stored effort', async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  const config = run(
    'node',
    [SCRIPT, 'config', '--plan-reviewer', 'codex:sol', '--plan-reviewer-effort', 'high', '--json'],
    { cwd: repo, env },
  );
  assert.equal(config.status, 0, config.stderr);

  const stored = run('node', [SCRIPT, 'plan-review', '--json', 'Review the plan'], {
    cwd: repo,
    env,
  });
  assert.equal(stored.status, 0, stored.stderr);
  assert.equal(JSON.parse(stored.stdout).model, 'gpt-6-sol');
  assert.equal(JSON.parse(stored.stdout).effort, 'high');
  assert.equal((await waitForTurnStart(binDir, { model: 'gpt-6-sol' })).effort, 'high');

  // Naming the stored model takes its stored effort too...
  const named = run(
    'node',
    [SCRIPT, 'plan-review', '--json', '--model', 'codex:sol', 'Review the plan again'],
    { cwd: repo, env },
  );
  assert.equal(named.status, 0, named.stderr);
  assert.equal(JSON.parse(named.stdout).effort, 'high');
  // ...while another model runs at its version default.
  const other = run(
    'node',
    [SCRIPT, 'plan-review', '--json', '--model', 'codex:astra-6', 'Review the plan once more'],
    { cwd: repo, env },
  );
  assert.equal(other.status, 0, other.stderr);
  assert.equal(JSON.parse(other.stdout).model, 'gpt-6-astra');
  assert.equal(JSON.parse(other.stdout).effort, codexEffort('gpt-6-astra'));
  assert.equal(
    (await waitForTurnStart(binDir, { model: 'gpt-6-astra' })).effort,
    codexEffort('gpt-6-astra'),
  );

  // With the default cleared the built-in runs at its version default.
  const cleared = run('node', [SCRIPT, 'config', '--clear', 'roles', '--json'], { cwd: repo, env });
  assert.equal(cleared.status, 0, cleared.stderr);
  const builtIn = run('node', [SCRIPT, 'plan-review', '--json', 'Review the plan anew'], {
    cwd: repo,
    env,
  });
  assert.equal(builtIn.status, 0, builtIn.stderr);
  const expected = codexBuiltIn('plan-reviewer');
  assert.equal(JSON.parse(builtIn.stdout).model, expected.model);
  assert.equal(JSON.parse(builtIn.stdout).effort, expected.effort);
});

test('a model-less review runs the stored implementation reviewer default; --native passes none', async () => {
  const repo = initializeBasicRepo();
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  const config = run(
    'node',
    [
      SCRIPT,
      'config',
      '--implementation-reviewer',
      'codex:sol',
      '--implementation-reviewer-effort',
      'high',
      '--json',
    ],
    { cwd: repo, env },
  );
  assert.equal(config.status, 0, config.stderr);

  for (const command of ['review', 'adversarial-review']) {
    const result = run('node', [SCRIPT, command, '--json'], { cwd: repo, env });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    const turn = await waitForTurnStart(binDir, { threadId: JSON.parse(result.stdout).threadId });
    assert.equal(turn.model, 'gpt-6-sol', command);
    assert.equal(turn.effort, 'high', command);
  }

  // The native reviewer runs on Codex's own configured model.
  const native = run('node', [SCRIPT, 'review', '--native', '--json'], { cwd: repo, env });
  assert.equal(native.status, 0, native.stderr);
  const started = await waitFor(() => {
    const state = readFakeState(binDir);
    return state.lastReviewStart && state.lastThreadStart ? state.lastThreadStart : null;
  });
  assert.equal(started.model, null);
});

test('a model-less review and adversarial-review with no stored default run the built-in at its version default', async () => {
  const repo = initializeBasicRepo();
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  const expected = codexBuiltIn('implementation-reviewer');

  for (const command of ['review', 'adversarial-review']) {
    const result = run('node', [SCRIPT, command, '--json'], { cwd: repo, env });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    const turn = await waitForTurnStart(binDir, { threadId: JSON.parse(result.stdout).threadId });
    assert.equal(turn.model, expected.model, command);
    assert.equal(turn.effort, expected.effort, command);
  }
  const jobs = requireCompanionState(repo, env).jobs;
  assert.equal(jobs.length, 2);
  assert.ok(
    jobs.every((job) => job.status === 'completed'),
    jobs.map((job) => `${job.kind}: ${job.status}`).join(', '),
  );
});

test('malformed selections are rejected before the runtime is probed', () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  for (const [args, pattern] of [
    [['review', '--model', 'm@a@b', '--json'], /Use <model> or <model>@<provider>/],
    [
      ['plan-review', '--effort', 'hyper', 'Review the plan'],
      /Unsupported reasoning effort "hyper"/,
    ],
  ] as const) {
    const result = run('node', [SCRIPT, ...args], { cwd: repo, env });
    assert.equal(result.status, 1, args.join(' '));
    assert.match(`${result.stdout}${result.stderr}`, pattern, args.join(' '));
  }
  // No app-server was ever started for these: the fake counts its boots.
  assert.equal(readFakeState(binDir).appServerStarts ?? 0, 0);
});

test('an unknown Codex family is refused with the catalog families before any job record', async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const result = run('node', [SCRIPT, 'task', '--json', '--model', 'codex:atsra', 'x'], {
    cwd: repo,
    env,
  });
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stdout).error as string;
  assert.match(
    error,
    /^Cannot resolve "codex:atsra": the Codex model catalog lists no atsra family, only codex:astra, /,
  );
  assert.match(error, /codex:sol/);
  assert.match(error, /codex:terra/);
  assert.match(error, /, or <id>@<provider> for another provider's model\.$/);
  assert.equal(readCompanionState(repo, env)?.jobs.length ?? 0, 0, 'no job record was written');

  // Raw ids the family grammar does not claim still pass, listed or not.
  for (const model of ['gpt-5.5', 'codex-auto-review']) {
    const ran = run('node', [SCRIPT, 'task', '--json', '--model', model, `use ${model}`], {
      cwd: repo,
      env,
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal((await waitForFakeState(binDir, 'lastThreadStart')).lastThreadStart.model, model);
  }
  assert.equal(requireCompanionState(repo, env).jobs.length, 2);
});

test('task --dry-run runs the launch checks and reports the launch without a job or a runtime', async () => {
  const repo = initializeBasicRepo();
  const codexBin = makeTempDir();
  installFakeCodex(codexBin);
  const claudeBin = makeTempDir();
  installFakeClaude(claudeBin);
  const env = buildClaudeEnv(claudeBin, buildEnv(codexBin));
  // A dry run resolves against the cached catalog; it never fetches one.
  writeCodexCatalogCache(accountCatalogModels(), { codexHome: env.CODEX_HOME });
  const dryRun = taskDryRunOf(repo, env);

  const launches: Array<[string[], Record<string, unknown>]> = [
    [
      ['--model', 'codex:sol', '--effort', 'high', 'a prompt'],
      taskDryRun({
        runtime: 'codex',
        model: 'gpt-6-sol',
        effort: 'high',
        role: null,
        sandbox: false,
      }),
    ],
    [
      ['--role', 'plan-reviewer'],
      taskDryRun({
        runtime: 'codex',
        ...codexBuiltIn('plan-reviewer'),
        role: 'plan-reviewer',
        sandbox: false,
      }),
    ],
    [
      ['--role', 'planner', '--allow', 'Bash(npm test)', 'plan it'],
      taskDryRun(
        { runtime: 'claude', ...claudeBuiltIn('planner'), role: 'planner', sandbox: false },
        ['Bash(npm test)'],
      ),
    ],
    [
      ['--role', 'implementer', '--write', '--allow', 'Bash(node:*)', '--sandbox', 'build it'],
      taskDryRun(
        { runtime: 'claude', ...claudeBuiltIn('implementer'), role: 'implementer', sandbox: true },
        ['Bash(node:*)'],
      ),
    ],
    // A provider model pins with its @provider once.
    [
      ['--model', 'codex:glm@zhipu', 'x'],
      taskDryRun({
        runtime: 'codex',
        model: 'glm-5.2@zhipu',
        effort: null,
        role: null,
        sandbox: false,
      }),
    ],
    [[], taskDryRun({ runtime: 'codex', model: null, effort: null, role: null, sandbox: false })],
  ];
  for (const [args, expected] of launches) {
    const result = await dryRun(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), expected, args.join(' '));
  }
  const text = await dryRun(['--model', 'codex:sol', '--effort', 'high'], false);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, 'Dry run: Codex gpt-6-sol, effort high, role none.\n');

  // Every refusal a launch gives, with the usual { error } contract.
  const refusals: Array<[string[], RegExp]> = [
    [
      ['--role', 'planner', '--allow', 'Bash(node:*)'],
      /^Unsupported --allow rule "Bash\(node:\*\)"/,
    ],
    [['--model', 'codex:nova'], /^Cannot resolve "codex:nova": the Codex model catalog lists no/],
    [['--model', 'codex:astra', '--effort', 'minimal'], /^Effort minimal is not a tier/],
    [['--model', 'claude:haiku', '--role', 'planner', '--effort', 'high'], /takes no effort/],
    [['--model', 'claude:opus', '--role', 'planner', '--write'], /^--write applies only/],
    // The role decides whether its run writes, on Codex as on Claude.
    [
      ['--model', 'codex:sol', '--role', 'implementer'],
      /^--role implementer needs --write: it is the only role that edits files\.$/,
    ],
    [
      ['--model', 'codex:sol', '--role', 'plan-reviewer', '--write'],
      /^--write applies only to --role implementer; plan-reviewer runs read-only\.$/,
    ],
    [
      ['--model', 'codex:sol', '--sandbox'],
      /^--sandbox enables Claude Code's Bash sandbox in a headless Claude run; Codex runs in its own sandbox\.$/,
    ],
    [['--model', 'claude:opus'], /^A Claude selection needs --role\./],
    // The Claude grammar runs on a dry run too.
    [['--model', 'claude:sonet-5', '--role', 'planner'], /^Unsupported model "claude:sonet-5"\./],
    [['--model', 'claude:-x', '--role', 'planner'], /^Unsupported model "claude:-x"\./],
  ];
  for (const [args, expected] of refusals) {
    const result = await dryRun(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(JSON.parse(result.stdout).error, expected, args.join(' '));
  }

  // Nothing was recorded, and neither runtime was ever started.
  assert.equal(readCompanionState(repo, env), null);
  assert.equal(fs.existsSync(path.join(codexBin, 'fake-codex-state.json')), false);
  assert.deepEqual(readFakeClaudeState(claudeBin).runs, []);
});

// A `codex` that only records that something ran it, and a CODEX_HOME with
// no catalog cache: what a dry run meets before setup ever fetched one.
function uncachedDryRunFixture() {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  const invocations = path.join(binDir, 'codex-invocations.log');
  writeExecutable(path.join(binDir, 'codex'), `#!/bin/sh\necho "$*" >> '${invocations}'\nexit 1\n`);
  const codexHome = makeTempDir();
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    CODEX_HOME: codexHome,
  };
  return { repo, codexHome, env, invocations, dryRun: taskDryRunOf(repo, env) };
}

test('task --dry-run with no cached catalog resolves the snapshot and never fetches or spawns', async () => {
  const { repo, codexHome, env, invocations, dryRun } = uncachedDryRunFixture();

  const astra = await dryRun(['--model', 'codex:astra', 'x']);
  assert.equal(astra.status, 0, astra.stderr);
  assert.deepEqual(
    JSON.parse(astra.stdout),
    taskDryRun({
      runtime: 'codex',
      model: 'gpt-6-astra',
      effort: null,
      role: null,
      sandbox: false,
    }),
  );
  const reviewer = await dryRun(['--role', 'plan-reviewer']);
  assert.equal(reviewer.status, 0, reviewer.stderr);
  assert.equal(
    JSON.parse(reviewer.stdout).model,
    codexBuiltIn('plan-reviewer', builtinCatalog()).model,
  );

  // A family only a fetched catalog lists is refused against the snapshot.
  const sol = await dryRun(['--model', 'codex:sol', 'x']);
  assert.equal(sol.status, 1);
  assert.equal(
    errorOf(sol),
    'Cannot resolve "codex:sol": no Codex model catalog has been fetched yet (/stereo:setup fetches it), and the built-in snapshot lists no sol family, only codex:astra. Use a listed codex:<family>[-<version>], or <id>@<provider> for another provider\'s model.',
  );

  assert.equal(fs.existsSync(invocations), false, 'no dry run spawned codex');
  assert.equal(fs.existsSync(resolveCompanionCatalogFile(codexHome)), false, 'nothing was fetched');
  assert.equal(readCompanionState(repo, env), null);
  assert.equal(loadBrokerSession(repo), null);
});

test('task --dry-run --background and --thread create no job and take no reservation', async () => {
  const { repo, codexHome, env, invocations, dryRun } = uncachedDryRunFixture();
  const seeded: JobRecord[] = [
    {
      id: 'task-codex',
      status: 'completed',
      kind: 'task',
      jobClass: 'task',
      runtime: 'codex',
      threadId: 'thr-known',
      model: 'gpt-6-sol',
      createdAt: '2026-09-25T10:00:00.000Z',
      updatedAt: '2026-09-25T10:00:00.000Z',
    },
    {
      id: 'task-claude',
      status: 'completed',
      kind: 'task',
      jobClass: 'task',
      runtime: 'claude',
      role: 'planner',
      threadId: 'sess-claude',
      model: 'claude-opus-5-5',
      createdAt: '2026-09-25T10:01:00.000Z',
      updatedAt: '2026-09-25T10:01:00.000Z',
    },
  ];
  withCodexHome(codexHome, () => seedState(repo, { jobs: seeded }));

  const opusId = claudeModelId(
    'opus',
    (latestModelVersion('claude', 'opus') as ModelVersionRow).version,
  );
  const launches: Array<[string[], Record<string, unknown>]> = [
    [
      ['--model', 'codex:astra', '--background', 'x'],
      { runtime: 'codex', model: 'gpt-6-astra', role: null },
    ],
    // --thread runs the --model and --role given; without --model, Codex's own.
    [['--thread', 'thr-known', 'x'], { runtime: 'codex', model: null, role: null }],
    [
      ['--thread', 'sess-claude', '--role', 'planner', '--model', 'claude:opus'],
      { runtime: 'claude', model: opusId, role: 'planner' },
    ],
    [['--thread', 'thr-known', '--background', 'x'], { runtime: 'codex', model: null, role: null }],
  ];
  for (const [args, expected] of launches) {
    const result = await dryRun(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true, args.join(' '));
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(payload[key], value, `${args.join(' ')}: ${key}`);
    }
  }

  assert.deepEqual(
    requireCompanionState(repo, env)
      .jobs.map((job) => job.id)
      .sort(),
    ['task-claude', 'task-codex'],
    'no job record was created',
  );
  const jobsDir = path.join(resolveCompanionStateDir(repo, env), 'jobs');
  assert.deepEqual(fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir) : [], [], 'no job file or log');
  assert.equal(findThreadReservation(codexHome, 'thr-known'), null);
  assert.equal(findThreadReservation(codexHome, 'sess-claude'), null);
  assert.equal(fs.existsSync(path.join(codexHome, 'companion-thread-locks')), false);
  assert.equal(fs.existsSync(invocations), false, 'no dry run spawned codex');
});

// A repository with both fake runtimes and a cached catalog, for dry runs.
function dryRunFixture() {
  const repo = initializeBasicRepo();
  const codexBin = makeTempDir();
  installFakeCodex(codexBin);
  const claudeBin = makeTempDir();
  installFakeClaude(claudeBin);
  const env = buildClaudeEnv(claudeBin, buildEnv(codexBin));
  writeCodexCatalogCache(accountCatalogModels(), { codexHome: env.CODEX_HOME });
  return { repo, codexBin, claudeBin, env, dryRun: taskDryRunOf(repo, env) };
}

test('a Claude implementer takes the workspace sandbox default, and --no-sandbox drops it for a run', async () => {
  const { repo, codexBin, claudeBin, env, dryRun } = dryRunFixture();
  const sandboxOf = async (args: string[]) => {
    const result = await dryRun(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    return JSON.parse(result.stdout).sandbox as boolean;
  };
  assert.equal(await sandboxOf(['--role', 'implementer', '--write', 'x']), false, 'off until set');
  const config = companion(['config', '--claude-sandbox', 'on', '--json'], repo, env);
  assert.equal(config.status, 0, config.stderr);
  assert.equal(await sandboxOf(['--role', 'implementer', '--write', 'x']), true);
  assert.equal(await sandboxOf(['--role', 'implementer', '--write', '--no-sandbox', 'x']), false);
  // Only the implementer writes, so only its launch takes the default.
  assert.equal(await sandboxOf(['--role', 'planner', 'x']), false);
  assert.equal(await sandboxOf(['--role', 'planner', '--sandbox', 'x']), true);
  assert.equal(await sandboxOf(['--model', 'codex:sol', 'x']), false);
  assert.equal(await sandboxOf(['--model', 'codex:sol', '--no-sandbox', 'x']), false);
  const both = await dryRun(['--role', 'implementer', '--write', '--sandbox', '--no-sandbox', 'x']);
  assert.equal(both.status, 1);
  assert.equal(errorOf(both), 'Choose either --sandbox or --no-sandbox.');
  assert.equal(readCompanionState(repo, env)?.jobs.length ?? 0, 0);
  assert.equal(fs.existsSync(path.join(codexBin, 'fake-codex-state.json')), false);
  assert.deepEqual(readFakeClaudeState(claudeBin).runs, []);
});

test('task --launch-args-file replays a recorded launch, strictly, with command-line flags winning', async () => {
  const { repo, codexBin, claudeBin, env, dryRun } = dryRunFixture();
  const file = path.join(repo, 'launch.json');
  const record = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
  const launch = (args: string[]) => dryRun(['--launch-args-file', file, ...args]);

  // A dry run's launchArgs replay to the same launch.
  const recorded = {
    selection: 'claude:claude-opus-5-5',
    effort: 'high',
    role: 'implementer',
    allowRules: ['Bash(npm test)'],
    sandbox: true,
  };
  record(recorded);
  const implementer = {
    runtime: 'claude' as const,
    model: 'claude-opus-5-5',
    effort: 'high',
    role: 'implementer',
    sandbox: true,
  };
  const replayed = await launch(['--write', 'build it']);
  assert.equal(replayed.status, 0, replayed.stderr);
  assert.deepEqual(JSON.parse(replayed.stdout), taskDryRun(implementer, recorded.allowRules));
  assert.deepEqual(JSON.parse(replayed.stdout).launchArgs, recorded);
  const overridden = await launch(['--write', '--effort', 'low', '--no-sandbox', 'build it']);
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.deepEqual(
    JSON.parse(overridden.stdout),
    taskDryRun({ ...implementer, effort: 'low', sandbox: false }, recorded.allowRules),
  );
  record({ selection: 'codex:gpt-6-sol', role: 'plan-reviewer' });
  const codex = await launch(['review the plan']);
  assert.equal(codex.status, 0, codex.stderr);
  assert.deepEqual(
    JSON.parse(codex.stdout),
    taskDryRun({
      runtime: 'codex',
      model: 'gpt-6-sol',
      effort: codexEffort('gpt-6-sol'),
      role: 'plan-reviewer',
      sandbox: false,
    }),
  );

  // The recorded launch is checked like any other.
  record({ selection: 'claude:fable', role: 'planner', allowRules: ['Bash(node:*)'] });
  assert.match(errorOf(await launch(['x'])), /^Unsupported --allow rule "Bash\(node:\*\)"/);
  const refusals: Array<[unknown, string]> = [
    [
      { selection: 'codex:sol', model: 'codex:sol' },
      'Unsupported key "model" in --launch-args-file; use selection, effort, role, allowRules, sandbox.',
    ],
    // Where the run works goes on the command line, never in the file.
    [
      { isolation: { cwd: repo, workspace: repo } },
      'Unsupported key "isolation" in --launch-args-file; use selection, effort, role, allowRules, sandbox.',
    ],
    [
      { allowRules: 'Bash(npm test)' },
      '--launch-args-file "allowRules" must be an array of strings.',
    ],
    [{ sandbox: 'yes' }, '--launch-args-file "sandbox" must be true or false.'],
    [{ selection: 5 }, '--launch-args-file "selection" must be a string or null.'],
    [[1], 'Provide --launch-args-file containing a JSON object.'],
  ];
  for (const [value, message] of refusals) {
    record(value);
    const result = await launch(['x']);
    assert.equal(result.status, 1, JSON.stringify(value));
    assert.equal(errorOf(result), message, JSON.stringify(value));
  }
  fs.writeFileSync(file, '{');
  assert.equal(errorOf(await launch(['x'])), 'Could not parse --launch-args-file as JSON.');

  assert.equal(readCompanionState(repo, env)?.jobs.length ?? 0, 0);
  assert.equal(fs.existsSync(path.join(codexBin, 'fake-codex-state.json')), false);
  assert.deepEqual(readFakeClaudeState(claudeBin).runs, []);
});

test('--thread runs the --model and --role given, on the thread its role ran', async () => {
  const { repo, env, dryRun } = dryRunFixture();
  withCodexHome(String(env.CODEX_HOME), () =>
    seedState(repo, {
      jobs: [
        {
          id: 'task-impl',
          status: 'completed',
          kind: 'task',
          jobClass: 'task',
          runtime: 'codex',
          role: 'implementer',
          threadId: 'thr-impl',
          createdAt: '2026-09-25T10:00:00.000Z',
          updatedAt: '2026-09-25T10:00:00.000Z',
        },
        {
          id: 'task-plan',
          status: 'completed',
          kind: 'task',
          jobClass: 'task',
          runtime: 'claude',
          role: 'planner',
          threadId: 'sess-plan',
          createdAt: '2026-09-25T10:01:00.000Z',
          updatedAt: '2026-09-25T10:01:00.000Z',
        },
      ],
    }),
  );
  const refusals: Array<[string[], string]> = [
    // A run without a role never takes over a role's thread.
    [
      ['--thread', 'thr-impl', 'x'],
      'Thread thr-impl belongs to implementer job task-impl; resume it with --role implementer.',
    ],
    [
      ['--thread', 'thr-impl', '--role', 'implementation-reviewer', 'x'],
      'Thread thr-impl belongs to implementer job task-impl; a role resumes only its own thread or session, so run the implementation-reviewer without --thread.',
    ],
    // Without --model a resume runs Codex's own model, which cannot own a
    // Claude session; nor can a Claude selection resume a Codex thread.
    [
      ['--thread', 'sess-plan', '--role', 'planner', 'x'],
      'Thread sess-plan belongs to a Claude job (task-plan); resume it with a Claude --model.',
    ],
    [
      ['--thread', 'thr-impl', '--model', 'claude:opus', '--role', 'implementer', '--write', 'x'],
      'Thread thr-impl belongs to a Codex job (task-impl); resume it with a Codex --model.',
    ],
  ];
  for (const [args, message] of refusals) {
    const result = await dryRun(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(errorOf(result), message, args.join(' '));
  }
  const implementer = await dryRun([
    '--thread',
    'thr-impl',
    '--role',
    'implementer',
    '--write',
    'x',
  ]);
  assert.equal(implementer.status, 0, implementer.stderr);
  assert.deepEqual(
    [JSON.parse(implementer.stdout).runtime, JSON.parse(implementer.stdout).model],
    ['codex', null],
  );
  // A thread no record knows runs what it is given too, never a role default.
  const unknown = await dryRun(['--role', 'plan-reviewer', '--thread', 'thr_unknown', 'again']);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.equal(JSON.parse(unknown.stdout).model, null);
});

test('a model-less launch ignores a stored entry whose effort its model does not take', async () => {
  const { repo, env, dryRun } = dryRunFixture();
  const store = (roleDefaults: Record<string, unknown>) =>
    withCodexHome(String(env.CODEX_HOME), () =>
      updateState(repo, (state) => {
        state.config.roleDefaults = roleDefaults;
      }),
    );
  // A hand-stored haiku effort (config refuses one) invalidates the entry:
  // config warns, and a model-less launch runs the built-in with that warning.
  store({ implementer: { model: 'claude:haiku', effort: 'high' } });
  const haiku = claudeModelId(
    'haiku',
    (latestModelVersion('claude', 'haiku') as ModelVersionRow).version,
  );
  const warning = `implementer stored model "claude:haiku" and effort "high" is invalid: claude:haiku takes no effort (the model rejects the parameter); drop the stored workspace effort high for ${haiku}. The built-in default will be used.`;
  const config = companion(['config', '--json'], repo, env);
  assert.equal(config.status, 0, config.stderr);
  assert.deepEqual(JSON.parse(config.stdout).warnings, [warning]);
  const modelLess = await dryRun(['--role', 'implementer', '--write', 'build it']);
  assert.equal(modelLess.status, 0, modelLess.stderr);
  assert.equal(JSON.parse(modelLess.stdout).model, claudeBuiltIn('implementer').model);
  assert.equal(modelLess.stderr, `${warning}\n`);
  // A launch that names another model runs no default, so nothing is refused.
  const named = await dryRun([
    '--role',
    'implementer',
    '--write',
    '--model',
    'claude:opus',
    'build it',
  ]);
  assert.equal(named.status, 0, named.stderr);
  assert.equal(named.stderr, '');

  // An effort off its model's ladder invalidates the whole entry: the
  // built-in runs at its version default, with the warning config gives.
  store({ implementer: { model: 'claude:opus', effort: 'ultra' } });
  const ignored = await dryRun(['--role', 'implementer', '--write', 'build it']);
  assert.equal(ignored.status, 0, ignored.stderr);
  const payload = JSON.parse(ignored.stdout);
  assert.equal(payload.effort, claudeBuiltIn('implementer').effort);
  assert.match(
    ignored.stderr,
    /^implementer stored model "claude:opus" and effort "ultra" is invalid: .* The built-in default will be used\.\n$/,
  );
});

test('--resume-last continues a rescue run only: no --role and no claude: selection', () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  for (const args of [
    ['--role', 'planner', '--resume-last'],
    ['--role', 'implementer', '--model', 'codex:sol', '--resume'],
    ['--model', 'claude:opus', '--resume-last'],
  ]) {
    const result = run(process.execPath, [SCRIPT, 'task', '--json', ...args, 'again'], {
      cwd: repo,
      env,
    });
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(
      JSON.parse(result.stdout).error,
      '--resume-last takes no --role or claude: selection; resume a known session with --thread <id>.',
    );
  }
  assert.equal(readCompanionState(repo, env), null);
  assert.equal(fs.existsSync(path.join(binDir, 'fake-codex-state.json')), false);
});

test('the three Codex launch branches refuse an unlisted stored effort before any job record', () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  const config = companion(
    [
      'config',
      '--plan-reviewer-effort',
      'minimal',
      '--implementation-reviewer-effort',
      'minimal',
      '--implementer',
      'codex:astra',
      '--implementer-effort',
      'minimal',
      '--json',
    ],
    repo,
    env,
  );
  assert.equal(config.status, 0, config.stderr);
  assert.equal(JSON.parse(config.stdout).warnings.length, 3);

  const refusal = (label: string) =>
    `The ${label}'s workspace default effort minimal is not a tier codex:astra (gpt-6-astra) lists; the catalog lists ${ASTRA_TIERS}. Pass --effort, or store another effort with /stereo:config.`;
  const planReview = companion(['plan-review', '--json', 'Review the plan'], repo, env);
  assert.equal(planReview.status, 1);
  assert.equal(errorOf(planReview), refusal('plan reviewer'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');
  const review = companion(['review', '--json'], repo, env);
  assert.equal(review.status, 1);
  assert.equal(errorOf(review), refusal('implementation reviewer'));
  // The implementer role with no --model runs its stored Codex default.
  const task = companion(
    ['task', '--role', 'implementer', '--write', '--json', 'build it'],
    repo,
    env,
  );
  assert.equal(task.status, 1);
  assert.equal(errorOf(task), refusal('implementer'));
  assert.deepEqual(readCompanionState(repo, env)?.jobs ?? [], [], 'no refusal left a record');
});

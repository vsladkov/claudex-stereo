import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { loadBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import { writeCodexCatalogCache } from '../plugins/stereo/src/models/catalog.ts';
import { claudeModelId } from '../plugins/stereo/src/models/claude-models.ts';
import { latestModelVersion } from '../plugins/stereo/src/models/model-table.ts';
import type { ModelVersionRow } from '../plugins/stereo/src/models/model-table.ts';
import {
  defaultModelEffort,
  parseCodexSelection,
  resolveCodexSelection,
} from '../plugins/stereo/src/models/registry.ts';
import { resolveDurableStateDir, resolveStateFile } from '../plugins/stereo/src/workspace/state.ts';
import {
  accountCatalogModels,
  catalogEntry,
  catalogFixture,
  makeTempDir,
  run,
  seedState,
} from './helpers.ts';
import { ROLE_DEFINITIONS } from '../plugins/stereo/src/models/role-defaults.ts';
import { SCRIPT, companion, errorOf, runCliInProcess } from './runtime-helpers.ts';

// The config CLI resolves families against the catalog cached under the test
// CODEX_HOME, which every spawned command inherits. It never launches a
// runtime, so this file spawns nothing that would need reaping and runs on
// the Windows lane.
writeCodexCatalogCache(accountCatalogModels(), { fetchedAt: '2026-09-24T00:00:00.000Z' });

const builtIn = (flag: string) =>
  ROLE_DEFINITIONS.find((definition) => definition.flag === flag)?.builtInSelection as string;

function runConfig(workspace: string, args: string[], env?: NodeJS.ProcessEnv) {
  return run(process.execPath, [SCRIPT, 'config', '--cwd', workspace, ...args], {
    cwd: workspace,
    env,
  });
}

test('config sets, reads, renders, and clears role defaults without losing other config', () => {
  const workspace = makeTempDir();
  seedState(workspace, { config: { stopReviewGate: true }, jobs: [] });

  const set = runConfig(workspace, [
    '--planner',
    'codex:terra',
    '--planner-effort',
    'high',
    '--implementation-reviewer',
    'claude:opus',
    '--json',
  ]);
  assert.equal(set.status, 0, set.stderr);
  const setPayload = JSON.parse(set.stdout);
  assert.equal(setPayload.workspaceRoot, workspace);
  assert.equal(setPayload.roleDefaults.length, 4);
  assert.deepEqual(
    setPayload.roleDefaults.find((entry: { role: string }) => entry.role === 'planner'),
    {
      role: 'planner',
      flag: 'planner',
      model: 'codex:terra',
      effort: 'high',
      route: 'codex',
      inline: false,
      invalidReason: null,
    },
  );
  // The JSON payload carries the report text the plain run would print: the
  // id and effort a model-less launch of each role runs.
  assert.match(setPayload.rendered, /^# Stereo Config\n/);
  assert.match(
    setPayload.rendered,
    /- planner: codex:terra \(effort high\) → gpt-5\.6-terra \(effort high\)\n/,
  );
  assert.match(setPayload.rendered, /\nActions taken:\n- Set planner to codex:terra for /);

  const rendered = runConfig(workspace, []);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /^# Stereo Config\n/);
  // An unset role names its built-in with the id and effort a launch runs today.
  const catalog = catalogFixture(accountCatalogModels());
  const reviewerModel = resolveCodexSelection(
    parseCodexSelection(builtIn('plan-reviewer'))!,
    catalog,
  );
  assert.ok(
    rendered.stdout.includes(
      `\n- plan-reviewer: not set → ${reviewerModel} (effort ${defaultModelEffort(reviewerModel, { catalog })}, built-in ${builtIn('plan-reviewer')})\n`,
    ),
    rendered.stdout,
  );

  const clearEffort = runConfig(workspace, ['--clear', 'planner-effort', '--json']);
  assert.equal(clearEffort.status, 0, clearEffort.stderr);
  assert.equal(
    JSON.parse(clearEffort.stdout).roleDefaults.find(
      (entry: { role: string }) => entry.role === 'planner',
    ).effort,
    null,
  );

  const clearRoles = runConfig(workspace, ['--clear', 'roles', '--json']);
  assert.equal(clearRoles.status, 0, clearRoles.stderr);
  const stored = JSON.parse(fs.readFileSync(resolveStateFile(workspace), 'utf8'));
  assert.equal(stored.config.stopReviewGate, true);
  assert.deepEqual(stored.config.roleDefaults, {});
});

test('an effort stored without a model renders beside the built-in model it applies to', () => {
  const workspace = makeTempDir();
  const set = runConfig(workspace, ['--implementer-effort', 'high', '--json']);
  assert.equal(set.status, 0, set.stderr);
  const implementer = JSON.parse(set.stdout).roleDefaults.find(
    (entry: { role: string }) => entry.role === 'implementer',
  );
  assert.equal(implementer.model, null);
  assert.equal(implementer.effort, 'high');
  const rendered = runConfig(workspace, []);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(
    rendered.stdout,
    /\n- implementer: not set \(effort high\) → claude-\S+ \(effort high, built-in claude:\S+\)\n/,
  );
});
test('flagless config is a pure read in a fresh workspace', () => {
  const workspace = makeTempDir();
  const stateDir = resolveDurableStateDir(workspace);
  const result = runConfig(workspace, ['--json']);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.actionsTaken.length, 0);
  assert.equal(payload.warnings.length, 0);
  assert.equal(payload.roleDefaults.length, 4);
  assert.ok(payload.roleDefaults.every((entry: { model: unknown }) => entry.model === null));
  assert.equal(fs.existsSync(resolveStateFile(workspace)), false);
  assert.equal(fs.existsSync(stateDir), false);
  assert.equal(loadBrokerSession(workspace), null, 'config never starts the workspace broker');

  // config --json carries the exact text the plain run prints.
  assert.match(payload.rendered, /^# Stereo Config\n/);
  const plain = runConfig(workspace, []);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(payload.rendered, plain.stdout);
  assert.equal(fs.existsSync(stateDir), false, 'the plain run is a pure read too');
});

test('config round-trips Claude routes for all four role defaults', () => {
  const workspace = makeTempDir();
  const entry = (
    role: string,
    flag: string,
    model: string,
    effort: string | null,
    inline = false,
  ) => ({
    role,
    flag,
    model,
    effort,
    route: 'claude',
    inline,
    invalidReason: null,
  });
  const expected = [
    entry('planner', 'planner', 'claude:session', null, true),
    entry('planReviewer', 'plan-reviewer', 'claude:opus-5.5', 'high'),
    entry('implementer', 'implementer', 'claude:sonnet', 'max'),
    entry('implementationReviewer', 'implementation-reviewer', 'claude:fable', null),
  ];

  const set = runConfig(workspace, [
    '--planner',
    'claude:session',
    '--plan-reviewer',
    'claude:opus-5.5',
    '--plan-reviewer-effort',
    'high',
    '--implementer',
    'claude:sonnet',
    '--implementer-effort',
    'max',
    '--implementation-reviewer',
    'claude:fable',
    '--json',
  ]);
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(JSON.parse(set.stdout).roleDefaults, expected);
  assert.deepEqual(JSON.parse(set.stdout).warnings, []);

  const read = runConfig(workspace, ['--json']);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout).roleDefaults, expected);
  const rendered = runConfig(workspace, []);
  assert.match(rendered.stdout, /\n- planner: claude:session \(inline in the Claude session\)\n/);
  assert.match(
    rendered.stdout,
    /\n- plan-reviewer: claude:opus-5\.5 \(effort high\) → claude-opus-5-5 \(effort high\)\n/,
  );
});
test('config validation fails closed with the JSON error contract', async () => {
  const cases: Array<[string[], RegExp]> = [
    [['--planner', 'claude:fabel'], /Unsupported model/],
    [['--planner', 'claude:opus-99'], /the plugin knows opus versions/],
    [['--planner', 'claude:inherit'], /claude:inherit was removed/],
    [['--planner', 'codex:claude:sonnet'], /not Codex models/],
    [['--planner-effort', 'hyper'], /Unsupported reasoning effort/],
    [['--implementer', 'claude:session'], /not a valid --implementer default/],
    [['--clear', 'unknown'], /Unsupported --clear key/],
    [
      ['--planner', 'codex:sol', '--clear', 'planner'],
      /Choose either --planner or --clear planner/,
    ],
    [
      ['--planner', 'claude:opus', '--planner-effort', 'ultra'],
      /for a Claude-routed role \(--planner-effort\)\. Use one of: low, medium, high, xhigh, max/,
    ],
    [
      ['--planner', 'claude:session', '--planner-effort', 'high'],
      /an inline session role takes no effort/,
    ],
    // No model in the call: the implementer's built-in default is Claude-routed.
    [['--implementer-effort', 'ultra'], /for a Claude-routed role/],
  ];

  // The first case through a spawned CLI (its exit code and streams), the
  // rest in process: the same command, without a process each.
  for (const [index, [args, expected]] of cases.entries()) {
    const workspace = makeTempDir();
    const result =
      index === 0
        ? runConfig(workspace, [...args, '--json'])
        : await runCliInProcess(['config', '--cwd', workspace, ...args, '--json']);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    const payload = JSON.parse(result.stdout);
    assert.match(payload.error, expected);
    assert.match(result.stderr, expected);
    assert.equal(fs.existsSync(resolveStateFile(workspace)), false);
    assert.equal(fs.existsSync(resolveDurableStateDir(workspace)), false);
  }
});

test('an effort set on its own is checked against the ladder of the stored model', () => {
  const workspace = makeTempDir();
  const implementer = runConfig(workspace, ['--implementer', 'codex:astra', '--json']);
  assert.equal(implementer.status, 0, implementer.stderr);
  // ultra is Codex-only: accepted because the stored implementer is a Codex route.
  const ultra = runConfig(workspace, ['--implementer-effort', 'ultra', '--json']);
  assert.equal(ultra.status, 0, ultra.stderr);
  const stored = JSON.parse(ultra.stdout).roleDefaults.find(
    (entry: { role: string }) => entry.role === 'implementer',
  );
  assert.equal(stored.model, 'codex:astra');
  assert.equal(stored.effort, 'ultra');
  assert.equal(stored.route, 'codex');

  const reviewer = runConfig(workspace, ['--plan-reviewer', 'claude:fable', '--json']);
  assert.equal(reviewer.status, 0, reviewer.stderr);
  const rejected = runConfig(workspace, ['--plan-reviewer-effort', 'ultra', '--json']);
  assert.equal(rejected.status, 1);
  assert.match(
    JSON.parse(rejected.stdout).error,
    /^Unsupported reasoning effort "ultra" for a Claude-routed role \(--plan-reviewer-effort\)\. Use one of: low, medium, high, xhigh, max\.$/,
  );
  const unchanged = JSON.parse(runConfig(workspace, ['--json']).stdout).roleDefaults.find(
    (entry: { role: string }) => entry.role === 'planReviewer',
  );
  assert.equal(unchanged.model, 'claude:fable');
  assert.equal(unchanged.effort, null, 'the rejected effort was not stored');
});

test('config renders every version each runtime knows, as text only', () => {
  const workspace = makeTempDir();
  const payload = JSON.parse(runConfig(workspace, ['--json']).stdout);
  assert.equal('models' in payload, false);
  // Codex: every catalog family with the id its alias resolves to and the
  // default effort per version; Claude: the shipped version table.
  const opus = latestModelVersion('claude', 'opus') as ModelVersionRow;
  const haiku = latestModelVersion('claude', 'haiku') as ModelVersionRow;
  assert.match(
    payload.rendered,
    new RegExp(
      String.raw`\nModels \(efforts are role-launch defaults; a Codex task without a role runs at Codex's own\):\n- claude:opus → ${claudeModelId('opus', opus.version)} \(effort ${opus.effort}; also [^)]+\)\n[\s\S]*- claude:haiku → ${claudeModelId('haiku', haiku.version)} \(no effort\)\n- codex:astra → gpt-6-astra \(effort xhigh\)\n- codex:luna → gpt-6-luna \(effort xhigh; also 5\.6 xhigh\)\n- codex:sol → gpt-6-sol \(effort xhigh; also 5\.6 xhigh\)\n- codex:terra → gpt-5\.6-terra \(effort xhigh\)\n`,
    ),
  );
});
test('config warns for each role whose built-in default the cached catalog lacks', () => {
  // A CODEX_HOME of its own, whose cached catalog lists astra 7 but not astra 6.
  const codexHome = makeTempDir();
  writeCodexCatalogCache(
    accountCatalogModels()
      .filter((model) => model.family !== 'astra')
      .concat(catalogEntry('gpt-7-astra')),
    { codexHome, fetchedAt: '2026-09-24T00:00:00.000Z' },
  );
  const env = { ...process.env, CODEX_HOME: codexHome };
  const reviewer = builtIn('plan-reviewer');
  const missing = (label: string) =>
    `The ${label}'s built-in default ${reviewer} cannot run: Cannot resolve "${reviewer}": the Codex model catalog lists astra versions 7 (gpt-7-astra). Use a listed codex:<family>[-<version>], or <id>@<provider> for another provider's model. Pass --model, or store another default with /stereo:config.`;
  const workspace = makeTempDir();

  const fresh = runConfig(workspace, ['--json'], env);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(JSON.parse(fresh.stdout).warnings, [
    missing('plan reviewer'),
    missing('implementation reviewer'),
  ]);
  const rendered = runConfig(workspace, [], env);
  assert.match(
    rendered.stdout,
    /- plan-reviewer: not set → cannot run \(see warnings\)\n[\s\S]*\nWarnings:\n- The plan reviewer's built-in default/,
  );

  // A stored model covers its role.
  const covered = runConfig(workspace, ['--plan-reviewer', 'codex:sol', '--json'], env);
  assert.equal(covered.status, 0, covered.stderr);
  assert.deepEqual(JSON.parse(covered.stdout).warnings, [missing('implementation reviewer')]);
});
test('a haiku effort is refused at config time; a Codex tier the catalog lacks is stored with a warning', () => {
  const workspace = makeTempDir();
  // Haiku takes no effort, so every model-less launch of this pair would fail.
  const set = runConfig(workspace, [
    '--implementer',
    'claude:haiku',
    '--implementer-effort',
    'high',
    '--json',
  ]);
  assert.equal(set.status, 1);
  assert.match(
    errorOf(set),
    /^claude:haiku takes no effort \(the model rejects the parameter\); drop --implementer-effort high for claude-haiku-\S+\.$/,
  );
  assert.equal(fs.existsSync(resolveStateFile(workspace)), false, 'nothing was stored');
  // So is a tier a Claude version lacks: the 4.6 generation has no xhigh.
  const lacking = runConfig(workspace, [
    '--implementer',
    'claude:opus-4.6',
    '--implementer-effort',
    'xhigh',
    '--json',
  ]);
  assert.equal(lacking.status, 1);
  assert.equal(
    errorOf(lacking),
    'claude-opus-4-6 does not take --implementer-effort xhigh; it takes low, medium, high, max.',
  );
  assert.equal(fs.existsSync(resolveStateFile(workspace)), false, 'nothing was stored');
  // The catalog may be stale, so a Codex tier it does not list only warns.
  const tier = runConfig(workspace, [
    '--plan-reviewer',
    'codex:astra',
    '--plan-reviewer-effort',
    'minimal',
    '--json',
  ]);
  assert.equal(tier.status, 0, tier.stderr);
  assert.ok(
    JSON.parse(tier.stdout).warnings.includes(
      "The plan reviewer's workspace default effort minimal is not a tier codex:astra (gpt-6-astra) lists; the catalog lists low, medium, high, xhigh, max, ultra. Pass --effort, or store another effort with /stereo:config.",
    ),
  );
});
test('config --claude-sandbox stores the headless Claude sandbox switch and rejects other values', () => {
  const workspace = makeTempDir();
  const before = JSON.parse(runConfig(workspace, ['--json']).stdout);
  assert.equal(before.claudeSandbox, false, 'off until set');
  assert.match(before.rendered, /^Claude sandbox: off$/m);

  const on = runConfig(workspace, ['--claude-sandbox', 'on', '--json']);
  assert.equal(on.status, 0, on.stderr);
  const onPayload = JSON.parse(on.stdout);
  assert.equal(onPayload.claudeSandbox, true);
  assert.deepEqual(onPayload.actionsTaken, [
    `Enabled the Claude Bash sandbox for headless implementers in ${workspace}.`,
  ]);
  assert.match(onPayload.rendered, /^Claude sandbox: on$/m);
  assert.equal(
    JSON.parse(fs.readFileSync(resolveStateFile(workspace), 'utf8')).config.claudeSandbox,
    true,
  );
  const rendered = runConfig(workspace, []);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /^Claude sandbox: on$/m);

  // Case-insensitive, and off is stored as an explicit false.
  const off = runConfig(workspace, ['--claude-sandbox', 'OFF', '--json']);
  assert.equal(off.status, 0, off.stderr);
  assert.equal(JSON.parse(off.stdout).claudeSandbox, false);
  assert.match(JSON.parse(off.stdout).rendered, /^Claude sandbox: off$/m);
  assert.equal(
    JSON.parse(fs.readFileSync(resolveStateFile(workspace), 'utf8')).config.claudeSandbox,
    false,
  );

  const enabledAgain = runConfig(workspace, ['--claude-sandbox', 'on', '--json']);
  assert.equal(enabledAgain.status, 0, enabledAgain.stderr);
  const maybe = runConfig(workspace, ['--claude-sandbox', 'maybe', '--json']);
  assert.equal(maybe.status, 1);
  assert.equal(JSON.parse(maybe.stdout).error, '--claude-sandbox takes on or off.');
  assert.equal(
    JSON.parse(runConfig(workspace, ['--json']).stdout).claudeSandbox,
    true,
    'a rejected value changes nothing',
  );
});

test('a Codex selection the catalog cannot resolve is stored with a warning', () => {
  const workspace = makeTempDir();
  for (const [selection, reason] of [
    ['codex:nova', /Cannot resolve "codex:nova": the Codex model catalog lists no nova family/],
    [
      'codex:sol-9',
      /the Codex model catalog lists sol versions 6 \(gpt-6-sol\), 5\.6 \(gpt-5\.6-sol\)/,
    ],
  ] as const) {
    const stored = runConfig(workspace, ['--planner', selection, '--json']);
    assert.equal(stored.status, 0, stored.stderr);
    const payload = JSON.parse(stored.stdout);
    const planner = payload.roleDefaults.find(
      (entry: { role: string }) => entry.role === 'planner',
    );
    assert.equal(planner.model, selection);
    assert.equal(planner.invalidReason, null);
    assert.equal(payload.warnings.length, 1, selection);
    assert.ok(
      payload.warnings[0].startsWith(`The planner's workspace default ${selection} cannot run: `),
      payload.warnings[0],
    );
    assert.match(payload.warnings[0], reason);
  }
});
test('switching a role to claude:session clears its stored effort, which could never apply', () => {
  const workspace = makeTempDir();
  const codex = runConfig(workspace, [
    '--planner',
    'codex:sol',
    '--planner-effort',
    'ultra',
    '--json',
  ]);
  assert.equal(codex.status, 0, codex.stderr);
  const inline = runConfig(workspace, ['--planner', 'claude:session', '--json']);
  assert.equal(inline.status, 0, inline.stderr);
  const payload = JSON.parse(inline.stdout);
  const planner = payload.roleDefaults.find((entry: { role: string }) => entry.role === 'planner');
  assert.equal(planner.model, 'claude:session');
  assert.equal(planner.effort, null);
  assert.equal(planner.invalidReason, null);
  assert.deepEqual(payload.actionsTaken, [
    `Set planner to claude:session for ${workspace}.`,
    `Cleared planner-effort for ${workspace}.`,
  ]);
  assert.deepEqual(payload.warnings, []);
});

test('config refuses a model-only change or a model clear the stored effort cannot follow', () => {
  const workspace = makeTempDir();
  const config = (args: string[]) =>
    companion(['config', '--cwd', workspace, ...args, '--json'], workspace);
  assert.equal(config(['--implementer', 'codex:astra', '--implementer-effort', 'ultra']).status, 0);
  const stored = () =>
    JSON.parse(fs.readFileSync(resolveStateFile(workspace), 'utf8')).config.roleDefaults;
  const before = stored();

  // Clearing the model leaves ultra on the Claude-routed built-in.
  const cleared = config(['--clear', 'implementer']);
  assert.equal(cleared.status, 1);
  const refusal =
    'Unsupported reasoning effort "ultra" for a Claude-routed role (the stored workspace effort). Use one of: low, medium, high, xhigh, max.';
  assert.equal(errorOf(cleared), refusal);
  // A Claude model set on its own keeps ultra too.
  const opus = config(['--implementer', 'claude:opus']);
  assert.equal(opus.status, 1);
  assert.equal(errorOf(opus), refusal);
  assert.deepEqual(stored(), before, 'a refused change stores nothing');

  // Setting or clearing the effort in the same call is accepted.
  assert.equal(config(['--implementer', 'claude:opus', '--implementer-effort', 'high']).status, 0);
  assert.deepEqual(stored().implementer, { model: 'claude:opus', effort: 'high' });
  assert.equal(config(['--implementer', 'codex:astra', '--implementer-effort', 'ultra']).status, 0);
  const both = config(['--clear', 'implementer', '--clear', 'implementer-effort']);
  assert.equal(both.status, 0, both.stderr);
  assert.equal(stored().implementer, undefined);
});

test('config --json reports whether the stop-time review gate is on', () => {
  const workspace = makeTempDir();
  const read = () =>
    JSON.parse(companion(['config', '--cwd', workspace, '--json'], workspace).stdout)
      .reviewGateEnabled;
  assert.equal(read(), false);
  seedState(workspace, { config: { stopReviewGate: true }, jobs: [] });
  assert.equal(read(), true);
});

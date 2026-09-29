import assert from 'node:assert/strict';
import test from 'node:test';

import { describeRoleDefaults } from '../plugins/stereo/src/cli/launch.ts';
import {
  BUILTIN_CATALOG_SNAPSHOT,
  builtinCatalog,
  writeCodexCatalogCache,
} from '../plugins/stereo/src/models/catalog.ts';
import { claudeModelId, parseClaudeSelection } from '../plugins/stereo/src/models/claude-models.ts';
import { latestModelVersion, MODEL_VERSIONS } from '../plugins/stereo/src/models/model-table.ts';
import type { ModelVersionRow } from '../plugins/stereo/src/models/model-table.ts';
import {
  applyRoleDefaultChanges,
  parseRoleEffort,
  parseRoleSelection,
  resolveLaunchEffort,
  resolveRoleCodexModel,
  resolveRoleDefault,
  ROLE_DEFINITIONS,
  roleDefaultFlagFor,
} from '../plugins/stereo/src/models/role-defaults.ts';
import type { RoleDefinition } from '../plugins/stereo/src/models/role-defaults.ts';
import {
  defaultModelEffort,
  parseCodexSelection,
  resolveCodexSelection,
} from '../plugins/stereo/src/models/registry.ts';
import type { ModelRuntime, ReasoningEffort } from '../plugins/stereo/src/models/registry.ts';
import type { StereoRoleDefaults } from '../plugins/stereo/src/workspace/state.ts';
import { ASTRA_TIERS, accountCatalogModels, catalogEntry, catalogFixture } from './helpers.ts';

// A launch resolves against the process catalog by default; seed the test
// CODEX_HOME the way a launch-ready check does so families resolve as live.
writeCodexCatalogCache(accountCatalogModels(), { fetchedAt: '2026-09-24T00:00:00.000Z' });
const catalog = catalogFixture(accountCatalogModels());

const definition = (flag: RoleDefinition['flag']) =>
  ROLE_DEFINITIONS.find((candidate) => candidate.flag === flag) as RoleDefinition;
const claudeId = (selection: string) => parseClaudeSelection(selection).modelArg;
const codexId = (selection: string) =>
  resolveCodexSelection(parseCodexSelection(selection)!, catalog);
const opus = latestModelVersion('claude', 'opus') as ModelVersionRow;
const opusId = claudeModelId('opus', opus.version);
const haikuId = claudeModelId(
  'haiku',
  (latestModelVersion('claude', 'haiku') as ModelVersionRow).version,
);
const implementerBuiltIn = definition('implementer').builtInSelection;
const reviewerBuiltIn = definition('plan-reviewer').builtInSelection;

// The effort a role launch of `model` takes with no effort flag.
function launchEffort(
  role: RoleDefinition['flag'] | 'reviewer' | 'adversarial-reviewer' | null,
  runtime: ModelRuntime,
  model: string,
  stored?: StereoRoleDefaults,
  requested: ReasoningEffort | null = null,
): ReasoningEffort | null {
  const flag = roleDefaultFlagFor(role);
  return resolveLaunchEffort({
    runtime,
    model,
    requested,
    roleDefault: flag ? resolveRoleDefault(flag, stored) : null,
    catalog,
  });
}

test('role selections parse without a catalog: claude:session inline, the rest by runtime', () => {
  assert.deepEqual(parseRoleSelection('planner', 'claude:session'), {
    selection: 'claude:session',
    route: 'claude',
    inline: true,
  });
  for (const selection of ['claude:opus', `claude:opus-${opus.version}`, `claude:${opusId}`]) {
    assert.deepEqual(parseRoleSelection('planner', selection), {
      selection,
      route: 'claude',
      inline: false,
    });
  }
  // A Codex selection is checked for syntax only: whether the catalog lists
  // it is judged when a command launches.
  for (const selection of ['terra', 'codex:sol-5.6', 'codex:nova', 'kimi', 'gpt-5.6-sol@openai']) {
    assert.deepEqual(parseRoleSelection('planner', selection), {
      selection,
      route: 'codex',
      inline: false,
    });
  }
});

test('role selections reject invalid addressing and session implementation', () => {
  assert.throws(
    () => parseRoleSelection('planner', 'claude:codex'),
    /Unsupported model "claude:codex" for --planner\. Use claude:<family>\[-<version>\]/,
  );
  assert.throws(
    () => parseRoleSelection('planner', 'claude:opus-99'),
    /^Error: Unsupported model "claude:opus-99" for --planner: the plugin knows opus versions/,
  );
  assert.throws(
    () => parseRoleSelection('planner', 'claude:inherit'),
    /claude:inherit was removed/,
  );
  assert.throws(() => parseRoleSelection('planner', 'codex:claude:sonnet'), /not Codex models/);
  assert.throws(() => parseRoleSelection('planner', 'codex:'), /Use codex:<model>/);
  assert.throws(
    () => parseRoleSelection('planner', 'codex:sol@a@b'),
    /Use <model> or <model>@<provider>/,
  );
  assert.throws(() => parseRoleSelection('planner', '  '), /Provide a model selection/);
  assert.throws(
    () => parseRoleSelection('implementer', 'claude:session'),
    /not a valid --implementer default/,
  );
});

test('role effort validates against the route ladder, or either ladder without a route', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.equal(parseRoleEffort('planner-effort', effort), effort);
    assert.equal(parseRoleEffort('planner-effort', effort, 'codex'), effort);
  }
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(parseRoleEffort('planner-effort', effort, 'claude'), effort);
  }
  // The Claude-ladder refusal names the flag the effort came from.
  assert.throws(
    () => parseRoleEffort('planner-effort', 'ultra', 'claude'),
    new Error(
      'Unsupported reasoning effort "ultra" for a Claude-routed role (--planner-effort). Use one of: low, medium, high, xhigh, max.',
    ),
  );
  assert.throws(() => parseRoleEffort('planner-effort', 'hyper'), /Unsupported reasoning effort/);
  assert.throws(() => parseRoleEffort('planner-effort', '  '), /Provide a reasoning effort/);
});

test('an invalid stored entry is ignored whole with one warning; a valid one is reported as stored', async () => {
  const described = await describeRoleDefaults({
    planner: { model: 'claude:fabel', effort: 'high' },
    planReviewer: { model: 'claude:opus', effort: 'ultra' },
    implementer: { model: null, effort: 'ultra' },
    implementationReviewer: { model: 'claude:session', effort: 'xhigh' },
  });
  const [planner, planReviewer, implementer, implementationReviewer] = described.entries;
  assert.match(planner?.invalidReason ?? '', /^Unsupported model "claude:fabel"/);
  // An effort off its model's ladder drops the whole entry, not only itself.
  assert.match(planReviewer?.invalidReason ?? '', /for a Claude-routed role/);
  // An effort stored alone is checked against the built-in model's route.
  assert.match(implementer?.invalidReason ?? '', /for a Claude-routed role/);
  // Beside claude:session an effort is inert: any tier some ladder names is valid.
  assert.equal(implementationReviewer?.invalidReason, null);
  assert.equal(implementationReviewer?.inline, true);
  assert.deepEqual(described.warnings, [
    `planner stored model "claude:fabel" and effort "high" is invalid: ${planner?.invalidReason} The built-in default will be used.`,
    `plan-reviewer stored model "claude:opus" and effort "ultra" is invalid: ${planReviewer?.invalidReason} The built-in default will be used.`,
    `implementer stored effort "ultra" is invalid: ${implementer?.invalidReason} The built-in default will be used.`,
  ]);
  // An unset role stores nothing, and a model-less launch runs its built-in.
  const unset = await describeRoleDefaults({});
  assert.deepEqual(unset.entries[0], {
    role: 'planner',
    flag: 'planner',
    model: null,
    effort: null,
    route: null,
    inline: false,
    invalidReason: null,
  });
  assert.deepEqual(unset.launches[0], {
    flag: 'planner',
    selection: definition('planner').builtInSelection,
    source: 'built-in',
    model: claudeId(definition('planner').builtInSelection),
    effort: defaultModelEffort(claudeId(definition('planner').builtInSelection), {
      runtime: 'claude',
    }),
    error: null,
  });
  assert.deepEqual(unset.warnings, []);
  // A Codex tier the catalog does not list is a valid entry (the catalog may
  // be stale) whose launch is refused: a warning after the invalid entries.
  // An effort on a Claude version that takes none (haiku) never fits, so it
  // invalidates the entry.
  const misfit = await describeRoleDefaults({
    implementer: { model: 'claude:haiku', effort: 'high' },
    planReviewer: { model: 'codex:astra', effort: 'minimal' },
  });
  const haikuReason = `claude:haiku takes no effort (the model rejects the parameter); drop the stored workspace effort high for ${haikuId}.`;
  assert.equal(misfit.entries[1]?.invalidReason, null);
  assert.equal(misfit.entries[2]?.invalidReason, haikuReason);
  assert.equal(misfit.launches[1]?.model, null);
  assert.deepEqual(misfit.warnings, [
    `implementer stored model "claude:haiku" and effort "high" is invalid: ${haikuReason} The built-in default will be used.`,
    misfit.launches[1]?.error,
  ]);
  assert.match(misfit.launches[1]?.error ?? '', /workspace default effort minimal is not a tier/);
});

test('role-default changes merge, prune empty entries, and clear all roles', () => {
  const merged = applyRoleDefaultChanges(
    {
      planner: { model: 'codex:sol', effort: 'high' },
      implementer: { model: 'codex:terra', effort: null },
    },
    { 'planner-effort': null, 'plan-reviewer-effort': 'medium' },
    ['implementer'],
  );
  assert.deepEqual(merged, {
    planner: { model: 'codex:sol', effort: null },
    planReviewer: { model: null, effort: 'medium' },
  });
  assert.deepEqual(applyRoleDefaultChanges(merged, {}, ['roles']), {});
});

// The shipped tables are the only floor a built-in has before any fetch:
// a Claude built-in must name a MODEL_VERSIONS row, and a Codex built-in must
// resolve against the offline catalog snapshot, so editing either table
// cannot silently leave a role default pointing at nothing.
test('every built-in role default is a pinned version that resolves against the shipped tables', () => {
  const offline = builtinCatalog();
  const snapshotIds = BUILTIN_CATALOG_SNAPSHOT.map((model) => model.id);
  for (const role of ROLE_DEFINITIONS) {
    assert.equal(role.builtInEffort, null, `${role.flag}: the built-ins name no role effort`);
    const selection = role.builtInSelection;
    if (selection.startsWith('claude:')) {
      const modelArg = claudeId(selection);
      assert.ok(
        MODEL_VERSIONS.some(
          (row) => row.runtime === 'claude' && claudeModelId(row.family, row.version) === modelArg,
        ),
        `${role.flag}: ${selection} names a MODEL_VERSIONS row`,
      );
      assert.match(selection, /^claude:[a-z]+-\d/, `${role.flag}: pins a version`);
      continue;
    }
    const resolved = resolveCodexSelection(parseCodexSelection(selection)!, offline);
    assert.ok(
      snapshotIds.includes(resolved),
      `${role.flag}: ${selection} resolved to ${resolved}, which BUILTIN_CATALOG_SNAPSHOT lacks`,
    );
  }
});

test('resolveRoleDefault judges one role once: selection, source, effort', () => {
  const builtIn = resolveRoleDefault('implementer', undefined);
  assert.deepEqual(
    [builtIn.selection, builtIn.source, builtIn.effort, builtIn.invalidReason],
    [implementerBuiltIn, 'built-in', null, null],
  );
  assert.equal(builtIn.description, `the implementer's built-in default ${implementerBuiltIn}`);

  // An effort stored alone rides the built-in model.
  const effortOnly = resolveRoleDefault('plan-reviewer', {
    planReviewer: { model: null, effort: 'high' },
  });
  assert.deepEqual(
    [effortOnly.selection, effortOnly.source, effortOnly.effort, effortOnly.effortSource],
    [reviewerBuiltIn, 'built-in', 'high', "the plan reviewer's workspace default effort"],
  );

  const stored = resolveRoleDefault('plan-reviewer', {
    planReviewer: { model: 'codex:sol', effort: 'high' },
  });
  assert.deepEqual(
    [stored.selection, stored.source, stored.effort],
    ['codex:sol', 'stored', 'high'],
  );
  assert.equal(stored.description, "the plan reviewer's workspace default codex:sol");

  // An inline selection runs the built-in in a companion command, and an
  // effort stored beside it is inert.
  const inline = resolveRoleDefault('implementation-reviewer', {
    implementationReviewer: { model: 'claude:session', effort: 'xhigh' },
  });
  assert.deepEqual(
    [inline.selection, inline.source, inline.effort, inline.invalidReason],
    [reviewerBuiltIn, 'built-in', null, null],
  );

  // An invalid entry runs the built-in with neither stored value.
  const invalid = resolveRoleDefault('implementer', {
    implementer: { model: 'claude:fabel', effort: 'high' },
  });
  assert.deepEqual([invalid.selection, invalid.effort], [implementerBuiltIn, null]);
  assert.match(
    invalid.invalidWarning ?? '',
    /^implementer stored model "claude:fabel" and effort "high" is invalid: .* The built-in default will be used\.$/,
  );
});

test('a role launch takes the effort of the role default it runs, else the version default', () => {
  const opusDefault = defaultModelEffort(opusId, { runtime: 'claude' });
  const builtInImplementer = claudeId(implementerBuiltIn);
  // The built-in pairs carry no role effort: the version default applies.
  assert.equal(
    launchEffort('implementer', 'claude', builtInImplementer),
    defaultModelEffort(builtInImplementer, { runtime: 'claude' }),
  );
  assert.equal(launchEffort('implementer', 'claude', haikuId), null);

  // A stored pair applies to its own model and role only.
  const pinned = `claude:opus-${opus.version}`;
  const stored = { implementer: { model: pinned, effort: 'low' } };
  assert.equal(launchEffort('implementer', 'claude', opusId, stored), 'low');
  assert.equal(launchEffort('planner', 'claude', opusId, stored), opusDefault);
  assert.equal(
    launchEffort('implementer', 'claude', claudeId('claude:fable'), stored),
    defaultModelEffort(claudeId('claude:fable'), { runtime: 'claude' }),
  );

  // An effort stored alone rides the built-in model and no other.
  const effortOnly = { implementer: { model: null, effort: 'medium' } };
  assert.equal(launchEffort('implementer', 'claude', builtInImplementer, effortOnly), 'medium');
  assert.equal(
    launchEffort('implementer', 'claude', haikuId, effortOnly),
    null,
    'another model runs at its version default',
  );

  // The comparison is by resolved id: an alias default matches the version
  // it resolves to today.
  const alias = { implementer: { model: 'claude:opus', effort: 'low' } };
  assert.equal(launchEffort('implementer', 'claude', opusId, alias), 'low');

  // The runtime is part of the match, and a role-less Codex run keeps
  // Codex's own effort.
  const sol = { planReviewer: { model: 'codex:sol', effort: 'high' } };
  assert.equal(launchEffort('plan-reviewer', 'codex', codexId('codex:sol'), sol), 'high');
  assert.equal(launchEffort('plan-reviewer', 'codex', codexId(reviewerBuiltIn), sol), 'xhigh');
  const claudeReviewer = { planReviewer: { model: 'claude:opus', effort: 'low' } };
  assert.equal(
    launchEffort('plan-reviewer', 'codex', codexId(reviewerBuiltIn), claudeReviewer),
    'xhigh',
  );
  assert.equal(launchEffort(null, 'codex', codexId(reviewerBuiltIn), sol), null);

  // Reviewer roles take the implementation reviewer's default, never the
  // implementer's or the plan reviewer's.
  const reviewers = { implementationReviewer: { model: 'codex:sol', effort: 'medium' } };
  for (const role of ['reviewer', 'adversarial-reviewer', 'implementation-reviewer'] as const) {
    assert.equal(launchEffort(role, 'codex', codexId('codex:sol'), reviewers), 'medium', role);
  }
  assert.equal(launchEffort('plan-reviewer', 'codex', codexId('codex:sol'), reviewers), 'xhigh');
  assert.equal(launchEffort('reviewer', 'claude', opusId, stored), opusDefault);

  // An invalid entry lends the launch neither its model nor its effort.
  const invalid = { implementer: { model: 'claude:opus', effort: 'ultra' } };
  assert.equal(launchEffort('implementer', 'claude', opusId, invalid), opusDefault);
});

test('with no role effort a role runs at its model default, and a stored role effort beats it', (t) => {
  // Change the newest opus row's default for this test, so the version
  // default differs from every stored effort below.
  const shipped = opus.effort;
  opus.effort = 'high';
  t.after(() => {
    opus.effort = shipped;
  });
  const pinned = `claude:opus-${opus.version}`;
  assert.equal(launchEffort('implementer', 'claude', opusId), 'high');
  assert.equal(
    launchEffort('implementer', 'claude', opusId, {
      implementer: { model: pinned, effort: 'low' },
    }),
    'low',
  );
  assert.equal(
    launchEffort('implementer', 'claude', opusId, {
      implementer: { model: pinned, effort: null },
    }),
    'high',
  );
});

test('an effort the model does not take is refused at launch, naming where it came from', () => {
  // A stored haiku effort invalidates its entry, so a launch takes none from it.
  assert.equal(
    launchEffort('implementer', 'claude', haikuId, {
      implementer: { model: 'claude:haiku', effort: 'high' },
    }),
    null,
  );
  // A stored Codex tier the catalog does not list.
  const stored = {
    implementer: { model: 'codex:astra', effort: 'minimal' },
    planReviewer: { model: null, effort: 'minimal' },
  };
  const astra = codexId('codex:astra');
  assert.throws(
    () => launchEffort('implementer', 'codex', astra, stored),
    new Error(
      `The implementer's workspace default effort minimal is not a tier codex:astra (${astra}) lists; the catalog lists ${ASTRA_TIERS}. Pass --effort, or store another effort with /stereo:config.`,
    ),
  );
  assert.throws(
    () => launchEffort('plan-reviewer', 'codex', astra, stored),
    /^Error: The plan reviewer's workspace default effort minimal is not a tier codex:astra/,
  );
  // An explicit effort replaces the stored one, and is checked the same way.
  assert.equal(launchEffort('implementer', 'codex', astra, stored, 'high'), 'high');
  assert.throws(
    () => launchEffort('implementer', 'codex', astra, stored, 'minimal'),
    new Error(
      `Effort minimal is not a tier codex:astra (${astra}) lists; the catalog lists ${ASTRA_TIERS}.`,
    ),
  );
  assert.throws(
    () => launchEffort('implementer', 'claude', haikuId, undefined, 'low'),
    /drop --effort low for/,
  );
  // Another model runs at its version default.
  assert.equal(launchEffort('implementer', 'codex', codexId('codex:sol'), stored), 'xhigh');
});

test('a role default the catalog cannot resolve fails naming the default', () => {
  const noAstra6 = catalogFixture([catalogEntry('gpt-7-astra'), catalogEntry('gpt-6-sol')]);
  const builtIn = resolveRoleDefault('plan-reviewer', undefined);
  const selection = parseCodexSelection(builtIn.selection)!;
  const reason = `Cannot resolve "${reviewerBuiltIn}": the Codex model catalog lists astra versions 7 (gpt-7-astra). Use a listed codex:<family>[-<version>], or <id>@<provider> for another provider's model.`;
  assert.throws(
    () => resolveRoleCodexModel(selection, noAstra6, builtIn),
    new Error(
      `The plan reviewer's built-in default ${reviewerBuiltIn} cannot run: ${reason} Pass --model, or store another default with /stereo:config.`,
    ),
  );
  // An explicit selection keeps the resolver's own error.
  assert.throws(() => resolveRoleCodexModel(selection, noAstra6, null), new Error(reason));
  // A stored default is named as the workspace's, and the snapshot names the failed fetch.
  const stored = resolveRoleDefault('implementation-reviewer', {
    implementationReviewer: { model: 'codex:sol', effort: null },
  });
  assert.throws(
    () =>
      resolveRoleCodexModel(
        parseCodexSelection(stored.selection)!,
        { ...builtinCatalog(), fetchFailure: 'connection refused' },
        stored,
      ),
    /^Error: The implementation reviewer's workspace default codex:sol cannot run: Cannot resolve "codex:sol": fetching the Codex model catalog failed \(connection refused\)/,
  );
  assert.equal(resolveRoleCodexModel(selection, catalog, builtIn), codexId(reviewerBuiltIn));
});

test('the reviewer roles take the implementation reviewer default', () => {
  assert.deepEqual(
    [
      'planner',
      'implementer',
      'plan-reviewer',
      'implementation-reviewer',
      'reviewer',
      'adversarial-reviewer',
      null,
    ].map((role) => roleDefaultFlagFor(role)),
    [
      'planner',
      'implementer',
      'plan-reviewer',
      'implementation-reviewer',
      'implementation-reviewer',
      'implementation-reviewer',
      null,
    ],
  );
});

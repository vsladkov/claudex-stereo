import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRoleDefaultChanges,
  CLAUDE_SELECTIONS,
  describeRoleDefaults,
  parseRoleEffort,
  parseRoleSelection,
} from '../plugins/stereo/src/models/role-defaults.ts';

test('role selections route the six Claude values and accepted Codex forms', () => {
  for (const selection of CLAUDE_SELECTIONS) {
    assert.deepEqual(parseRoleSelection('planner', selection), {
      selection,
      route: 'claude',
      model: null,
    });
  }

  for (const [selection, model] of [
    ['terra', 'gpt-5.6-terra'],
    ['codex:terra', 'gpt-5.6-terra'],
    ['kimi', 'kimi-k3'],
    ['gpt-5.6-sol@openai', 'gpt-5.6-sol@openai'],
  ]) {
    assert.deepEqual(parseRoleSelection('planner', selection), {
      selection,
      route: 'codex',
      model,
    });
  }
});

test('role selections reject invalid addressing and session implementation', () => {
  assert.throws(() => parseRoleSelection('planner', 'claude:codex'), /Unsupported model/);
  assert.throws(() => parseRoleSelection('planner', 'claude:fabel'), /Unsupported model/);
  assert.throws(() => parseRoleSelection('planner', 'codex:claude:sonnet'), /not Codex models/);
  assert.throws(() => parseRoleSelection('planner', 'codex:'), /Use codex:<model>/);
  assert.throws(
    () => parseRoleSelection('implementer', 'claude:session'),
    /not a valid --implementer default/,
  );
  assert.equal(parseRoleSelection('planner', 'claude:session').route, 'claude');
});

test('role effort accepts the registry values and rejects unknown values', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(parseRoleEffort('planner-effort', effort), effort);
  }
  assert.throws(() => parseRoleEffort('planner-effort', 'ultra'), /Unsupported reasoning effort/);
  assert.throws(() => parseRoleEffort('planner-effort', '  '), /Provide a reasoning effort/);
});

test('stored role defaults report invalid and inert entries without throwing', () => {
  const described = describeRoleDefaults({
    planner: { model: 'claude:fabel', effort: null },
    planReviewer: { model: 'claude:opus', effort: 'high' },
  });
  const planner = described.entries.find((entry) => entry.role === 'planner');
  const reviewer = described.entries.find((entry) => entry.role === 'planReviewer');

  assert.match(planner?.invalidReason ?? '', /Unsupported model/);
  assert.equal(reviewer?.invalidReason, null);
  assert.equal(reviewer?.route, 'claude');
  assert.ok(described.warnings.some((warning) => warning.includes('built-in default')));
  assert.ok(
    described.warnings.includes(
      'plan-reviewer effort high is inert: claude:opus is Claude-routed.',
    ),
  );
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

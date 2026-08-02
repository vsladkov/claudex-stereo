import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { makeTempDir, run } from './helpers.ts';
import { registerBrokerReaping, SCRIPT } from './runtime-helpers.ts';
import {
  resolveDurableStateDir,
  resolveStateFile,
  saveState,
} from '../plugins/stereo/src/workspace/state.ts';

registerBrokerReaping();

function runConfig(workspace: string, args: string[]) {
  return run(process.execPath, [SCRIPT, 'config', '--cwd', workspace, ...args], { cwd: workspace });
}

test('config sets, reads, renders, and clears role defaults without losing other config', () => {
  const workspace = makeTempDir();
  saveState(workspace, { config: { stopReviewGate: true }, jobs: [] });

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
      resolvedModel: 'gpt-5.6-terra',
      invalidReason: null,
    },
  );

  const rendered = runConfig(workspace, []);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /^# Stereo Config\n/);
  assert.match(rendered.stdout, /- planner: codex:terra \(effort high\)/);
  assert.match(rendered.stdout, /- plan-reviewer: not set/);

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
});

test('config round-trips Claude routes for all four role defaults', () => {
  const workspace = makeTempDir();
  const expected = [
    {
      role: 'planner',
      flag: 'planner',
      model: 'claude:session',
      effort: null,
      route: 'claude',
      resolvedModel: null,
      invalidReason: null,
    },
    {
      role: 'planReviewer',
      flag: 'plan-reviewer',
      model: 'claude:inherit',
      effort: null,
      route: 'claude',
      resolvedModel: null,
      invalidReason: null,
    },
    {
      role: 'implementer',
      flag: 'implementer',
      model: 'claude:sonnet',
      effort: null,
      route: 'claude',
      resolvedModel: null,
      invalidReason: null,
    },
    {
      role: 'implementationReviewer',
      flag: 'implementation-reviewer',
      model: 'claude:fable',
      effort: null,
      route: 'claude',
      resolvedModel: null,
      invalidReason: null,
    },
  ];

  const set = runConfig(workspace, [
    '--planner',
    'claude:session',
    '--plan-reviewer',
    'claude:inherit',
    '--implementer',
    'claude:sonnet',
    '--implementation-reviewer',
    'claude:fable',
    '--json',
  ]);
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(JSON.parse(set.stdout).roleDefaults, expected);

  const read = runConfig(workspace, ['--json']);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout).roleDefaults, expected);
});

test('config validation fails closed with the JSON error contract', () => {
  const cases: Array<[string[], RegExp]> = [
    [['--planner', 'claude:fabel'], /Unsupported model/],
    [['--planner', 'codex:claude:sonnet'], /not Codex models/],
    [['--planner-effort', 'ultra'], /Unsupported reasoning effort/],
    [['--implementer', 'claude:session'], /not a valid --implementer default/],
    [['--clear', 'unknown'], /Unsupported --clear key/],
    [
      ['--planner', 'codex:sol', '--clear', 'planner'],
      /Choose either --planner or --clear planner/,
    ],
    [
      ['--planner', 'claude:opus', '--planner-effort', 'high'],
      /applies only to a Codex-routed planner/,
    ],
  ];

  for (const [args, expected] of cases) {
    const workspace = makeTempDir();
    const result = runConfig(workspace, [...args, '--json']);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    const payload = JSON.parse(result.stdout);
    assert.match(payload.error, expected);
    assert.match(result.stderr, expected);
    assert.equal(fs.existsSync(resolveStateFile(workspace)), false);
    assert.equal(fs.existsSync(resolveDurableStateDir(workspace)), false);
  }
});

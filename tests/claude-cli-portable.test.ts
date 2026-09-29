import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import test from 'node:test';

import { loadBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import { claudeModelId } from '../plugins/stereo/src/models/claude-models.ts';
import { latestModelVersion } from '../plugins/stereo/src/models/model-table.ts';
import { loadPairPlanState } from '../plugins/stereo/src/workspace/state.ts';
import { fakeClaudeBin, readFakeClaudeState } from './fake-claude-fixture.ts';
import { makeTempDir, run } from './helpers.ts';
import { readCompanionState, SCRIPT } from './runtime-helpers.ts';

// The Windows-lane Claude run: a headless role goes through the whole CLI on
// the fake `claude` (a .cmd shim there) with no repository and no broker, so
// this file never needs git and never spawns anything it would have to reap.

// What a bare `claude:<family>` alias launches: the newest version the model
// table knows, at that version's effort (a new row moves both, not this file).
function latestClaude(family: string): { id: string; effort: string | null } {
  const row = latestModelVersion('claude', family);
  assert.ok(row, `the model table knows claude:${family}`);
  return { id: claudeModelId(family, row.version), effort: row.effort };
}

test('a Claude planner task runs through the CLI without a repository or a broker', () => {
  const cwd = makeTempDir();
  const { binDir, env } = fakeClaudeBin();
  const opus = latestClaude('opus');

  const result = run(
    process.execPath,
    [SCRIPT, 'task', '--json', '--model', 'claude:opus', '--role', 'planner', 'hi'],
    { cwd, env },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 0);
  assert.equal(payload.rawOutput, 'Handled the requested task.\nTask prompt accepted.');

  // The alias launches the newest opus version the table knows, at its effort.
  const last = readFakeClaudeState(binDir).lastRun!;
  assert.equal(last.agent, 'stereo-planner');
  assert.equal(last.model, opus.id);
  assert.equal(last.effort, opus.effort);
  assert.equal(last.permissionMode, 'dontAsk');
  assert.equal(last.prompt, 'hi');
  assert.equal(fs.realpathSync.native(last.cwd), cwd);
  assert.equal(payload.threadId, last.sessionId);
  const definition = last.agentsDefinition!['stereo-planner']!;
  assert.equal(definition.model, opus.id);
  assert.ok(String(definition.prompt).trim().length > 0);

  const job = readCompanionState(cwd, env)?.jobs[0];
  assert.equal(job?.runtime, 'claude');
  assert.equal(job?.role, 'planner');
  assert.equal(job?.kindLabel, 'planner');
  assert.equal(job?.status, 'completed');
  assert.equal(job?.model, opus.id, 'the job records the model that served it');
  assert.equal(job?.threadId, last.sessionId);
  assert.equal(loadBrokerSession(cwd), null, 'a Claude run never starts the workspace broker');
});

test('a Claude plan review runs through the CLI without a repository', () => {
  const cwd = makeTempDir();
  const { binDir, env } = fakeClaudeBin();
  const sonnet = latestClaude('sonnet');

  const result = run(
    process.execPath,
    [SCRIPT, 'plan-review', '--json', '--model', 'claude:sonnet', 'plan'],
    { cwd, env },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, 'needs-revision');
  assert.equal(payload.parseError, null);
  assert.equal(payload.model, sonnet.id);
  assert.equal(payload.effort, sonnet.effort);

  const last = readFakeClaudeState(binDir).lastRun!;
  assert.equal(last.agent, 'stereo-plan-reviewer');
  assert.equal(last.model, sonnet.id);
  assert.equal(last.effort, sonnet.effort);
  assert.ok(last.jsonSchema?.properties && 'verdict' in (last.jsonSchema.properties as object));
  assert.equal(last.resume, null);
  assert.equal(payload.threadId, last.sessionId);

  const stored = loadPairPlanState(cwd) as { reviewedBy?: string } | null;
  assert.equal(stored?.reviewedBy, `claude:${sonnet.id}`);
  const job = readCompanionState(cwd, env)?.jobs[0];
  assert.equal(job?.runtime, 'claude');
  assert.equal(job?.kind, 'plan-review');
  assert.equal(job?.status, 'completed');
  assert.equal(loadBrokerSession(cwd), null, 'a Claude run never starts the workspace broker');
});

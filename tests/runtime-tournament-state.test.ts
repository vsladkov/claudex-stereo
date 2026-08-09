import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { initGitRepo, makeTempDir } from './helpers.ts';
import { registerBrokerReaping, runCliInProcess } from './runtime-helpers.ts';
import {
  fingerprintPlanText,
  resolveDurableStateDir,
  resolveTournamentStateFile,
} from '../plugins/stereo/src/workspace/state.ts';

registerBrokerReaping();

function setupRepo(): { repo: string; env: NodeJS.ProcessEnv } {
  const repo = makeTempDir();
  initGitRepo(repo);
  return {
    repo,
    env: { ...process.env, CODEX_HOME: path.join(repo, '.codex-home') },
  };
}

let payloadCounter = 0;

function writePayload(repo: string, contents: unknown): string {
  payloadCounter += 1;
  const file = path.join(repo, `.tournament-state-payload-${payloadCounter}.json`);
  fs.writeFileSync(
    file,
    typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`,
    'utf8',
  );
  return file;
}

function storePlan(
  repo: string,
  env: NodeJS.ProcessEnv,
  plan: string,
  round = 2,
  slot = 'default',
): void {
  const stateDir = resolveDurableStateDir(repo, env.CODEX_HOME);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, slot === 'default' ? 'pair-plan.json' : `pair-plan-${slot}.json`),
    `${JSON.stringify(
      {
        plan,
        verdict: 'approve',
        round,
        updatedAt: `2026-08-01T00:0${round}:00.000Z`,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function runTournamentState(
  repo: string,
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  return runCliInProcess(['tournament-state', ...args, '--cwd', repo], {
    CODEX_HOME: env.CODEX_HOME,
  });
}

async function assertJsonError(
  repo: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  expected: string,
): Promise<void> {
  const result = await runTournamentState(repo, env, [...args, '--json']);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).error, expected);
  assert.equal(result.stderr.trim(), expected);
}

function contestants(repo: string): Array<Record<string, unknown>> {
  return [
    {
      label: 'c1',
      route: 'codex',
      selection: 'codex:sol',
      worktreePath: path.join(repo, 'worktree-c1'),
      status: 'pending',
    },
    {
      label: 'c2',
      route: 'claude',
      selection: 'claude:opus',
      worktreePath: path.join(repo, 'worktree-c2'),
      status: 'pending',
    },
  ];
}

test('tournament-state --record snapshots the plan and round-trips the durable lineup', async () => {
  const { repo, env } = setupRepo();
  const plan = '# Approved tournament plan\n\nRace two implementations.';
  storePlan(repo, env, plan);
  const stateFile = writePayload(repo, {
    baselineCommit: 'abc123',
    baselineDirtyPaths: ['README.md'],
    mainRoot: repo,
    lineupSource: 'default',
    contestants: contestants(repo),
  });

  const recorded = await runTournamentState(repo, env, [
    '--record',
    '--state-file',
    stateFile,
    '--json',
  ]);
  assert.equal(recorded.status, 0, recorded.stderr);
  const payload = JSON.parse(recorded.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.record.version, 1);
  assert.equal(payload.record.status, 'in-progress');
  assert.equal(payload.record.baselineCommit, 'abc123');
  assert.deepEqual(payload.record.contestants, contestants(repo));
  assert.match(payload.record.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.record.updatedAt, payload.record.createdAt);
  assert.equal(payload.record.plan.fingerprint, fingerprintPlanText(plan));
  assert.equal(payload.record.plan.slot, 'default');
  assert.equal(payload.planMatches, true);

  const durableFile = path.join(
    resolveDurableStateDir(repo, env.CODEX_HOME),
    'tournament-state.json',
  );
  assert.equal(resolveTournamentStateFile(repo).endsWith('tournament-state.json'), true);
  assert.equal(fs.existsSync(durableFile), true);

  const read = await runTournamentState(repo, env, ['--json']);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout).record, payload.record);
  assert.equal(JSON.parse(read.stdout).planMatches, true);
});

test('tournament-state validates record payload JSON, size, baseline, and contestants', async () => {
  const { repo, env } = setupRepo();
  const missingBaseline = writePayload(repo, { contestants: contestants(repo) });
  const nonObject = writePayload(repo, []);
  const invalidJson = writePayload(repo, '{not json');
  const oversize = writePayload(repo, `{"value":"${'x'.repeat(512 * 1024)}"}`);
  const missingContestants = writePayload(repo, { baselineCommit: 'abc123' });
  const emptyContestants = writePayload(repo, { baselineCommit: 'abc123', contestants: [] });
  const missingLabel = writePayload(repo, { baselineCommit: 'abc123', contestants: [{}] });
  const relativeWorktree = writePayload(repo, {
    baselineCommit: 'abc123',
    contestants: [{ label: 'c1', worktreePath: 'relative-worktree' }],
  });

  await assertJsonError(
    repo,
    env,
    ['--record', '--state-file', missingBaseline],
    'Provide baselineCommit in --state-file.',
  );
  await assertJsonError(
    repo,
    env,
    ['--record', '--state-file', nonObject],
    'Provide --state-file containing a JSON object.',
  );
  await assertJsonError(
    repo,
    env,
    ['--record', '--state-file', invalidJson],
    'Could not parse --state-file as JSON.',
  );
  await assertJsonError(
    repo,
    env,
    ['--record', '--state-file', oversize],
    '--state-file is larger than 512 KiB. Store bounded contestant summaries instead of verbatim reports.',
  );
  for (const stateFile of [missingContestants, emptyContestants]) {
    await assertJsonError(
      repo,
      env,
      ['--record', '--state-file', stateFile],
      'Provide a non-empty contestants array in --state-file.',
    );
  }
  await assertJsonError(
    repo,
    env,
    ['--record', '--state-file', missingLabel],
    'Provide a label in every contestants entry in --state-file.',
  );
  await assertJsonError(
    repo,
    env,
    ['--record', '--state-file', relativeWorktree],
    'Contestant worktreePath must be an absolute path.',
  );
});

test('tournament-state --update replaces contestants by label and preserves snapshots', async () => {
  const { repo, env } = setupRepo();
  storePlan(repo, env, '# First plan');
  const initialFile = writePayload(repo, {
    baselineCommit: 'abc123',
    contestants: contestants(repo),
    custom: 'before',
  });
  const recorded = await runTournamentState(repo, env, [
    '--record',
    '--state-file',
    initialFile,
    '--json',
  ]);
  assert.equal(recorded.status, 0, recorded.stderr);
  const initial = JSON.parse(recorded.stdout).record;
  const durableFile = path.join(
    resolveDurableStateDir(repo, env.CODEX_HOME),
    'tournament-state.json',
  );
  fs.writeFileSync(
    durableFile,
    `${JSON.stringify({ ...initial, updatedAt: '2000-01-01T00:00:00.000Z' }, null, 2)}\n`,
    'utf8',
  );
  const patchFile = writePayload(repo, {
    custom: 'after',
    createdAt: 'must-not-win',
    updatedAt: 'must-not-win',
    plan: { fingerprint: 'must-not-win' },
    contestants: [
      {
        label: 'c2',
        route: 'claude',
        selection: 'claude:opus',
        worktreePath: path.join(repo, 'worktree-c2'),
        status: 'completed',
        note: 'replacement',
      },
      { label: 'c3', status: 'running', jobId: 'old' },
      { label: 'c3', status: 'completed', jobId: 'new' },
    ],
  });

  const updated = await runTournamentState(repo, env, [
    '--update',
    '--state-file',
    patchFile,
    '--json',
  ]);
  assert.equal(updated.status, 0, updated.stderr);
  const record = JSON.parse(updated.stdout).record;
  assert.equal(record.custom, 'after');
  assert.equal(record.createdAt, initial.createdAt);
  assert.deepEqual(record.plan, initial.plan);
  assert.notEqual(record.updatedAt, '2000-01-01T00:00:00.000Z');
  assert.deepEqual(record.contestants, [
    contestants(repo)[0],
    {
      label: 'c2',
      route: 'claude',
      selection: 'claude:opus',
      worktreePath: path.join(repo, 'worktree-c2'),
      status: 'completed',
      note: 'replacement',
    },
    { label: 'c3', status: 'completed', jobId: 'new' },
  ]);

  const invalidArrayPatch = writePayload(repo, { contestants: 'not-an-array' });
  await assertJsonError(
    repo,
    env,
    ['--update', '--state-file', invalidArrayPatch],
    'Provide contestants in --state-file as a JSON array.',
  );

  const missing = setupRepo();
  await assertJsonError(
    missing.repo,
    missing.env,
    ['--update', '--state-file', patchFile],
    'No tournament state to update. Run /stereo:tournament first.',
  );
  await assertJsonError(
    missing.repo,
    missing.env,
    ['--complete'],
    'No tournament state to update. Run /stereo:tournament first.',
  );
});

test('tournament-state --complete applies a final patch and stamps completion', async () => {
  const { repo, env } = setupRepo();
  const stateFile = writePayload(repo, {
    baselineCommit: 'abc123',
    contestants: contestants(repo),
  });
  assert.equal(
    (await runTournamentState(repo, env, ['--record', '--state-file', stateFile, '--json'])).status,
    0,
  );
  const finalPatch = writePayload(repo, {
    winner: { label: 'c1', rule: 'single-acceptable' },
    handBack: { decision: 'automatic', applied: true },
  });

  const completed = await runTournamentState(repo, env, [
    '--complete',
    '--state-file',
    finalPatch,
    '--json',
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  const record = JSON.parse(completed.stdout).record;
  assert.equal(record.status, 'complete');
  assert.deepEqual(record.winner, { label: 'c1', rule: 'single-acceptable' });
  assert.match(record.completedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(record.updatedAt, record.completedAt);
});

test('tournament-state --clear reports worktrees, is idempotent, and leaves the plan', async () => {
  const { repo, env } = setupRepo();
  storePlan(repo, env, '# Plan retained after tournament-state clear');
  const stateFile = writePayload(repo, {
    baselineCommit: 'abc123',
    contestants: contestants(repo),
  });
  assert.equal(
    (await runTournamentState(repo, env, ['--record', '--state-file', stateFile, '--json'])).status,
    0,
  );

  const firstClear = await runTournamentState(repo, env, ['--clear', '--json']);
  assert.equal(firstClear.status, 0, firstClear.stderr);
  assert.equal(JSON.parse(firstClear.stdout).cleared, true);
  assert.deepEqual(
    JSON.parse(firstClear.stdout).worktreePaths,
    contestants(repo).map((contestant) => contestant.worktreePath),
  );
  assert.equal(
    fs.existsSync(path.join(resolveDurableStateDir(repo, env.CODEX_HOME), 'pair-plan.json')),
    true,
  );

  const secondClear = await runTournamentState(repo, env, ['--clear', '--json']);
  assert.equal(secondClear.status, 0, secondClear.stderr);
  assert.deepEqual(JSON.parse(secondClear.stdout), { cleared: false, removed: [] });
});

test('tournament-state detects plan drift without changing the recorded snapshot', async () => {
  const { repo, env } = setupRepo();
  storePlan(repo, env, '# First plan', 1);
  const stateFile = writePayload(repo, {
    baselineCommit: 'abc123',
    contestants: contestants(repo),
  });
  const recorded = await runTournamentState(repo, env, [
    '--record',
    '--state-file',
    stateFile,
    '--json',
  ]);
  const snapshot = JSON.parse(recorded.stdout).record.plan;

  storePlan(repo, env, '# Revised plan', 3);
  const read = await runTournamentState(repo, env, ['--json']);
  assert.equal(read.status, 0, read.stderr);
  const payload = JSON.parse(read.stdout);
  assert.equal(payload.planMatches, false);
  assert.deepEqual(payload.record.plan, snapshot);
  assert.equal(payload.plan.fingerprint, fingerprintPlanText('# Revised plan'));
});

test('tournament-state snapshots and compares only the selected plan slot', async () => {
  const { repo, env } = setupRepo();
  const namedPlan = '# Named plan';
  storePlan(repo, env, namedPlan, 2, 'windows-lane');
  storePlan(repo, env, '# Default plan', 1);
  const stateFile = writePayload(repo, {
    baselineCommit: 'abc123',
    contestants: contestants(repo),
  });

  const recorded = await runTournamentState(repo, env, [
    '--record',
    '--slot',
    'Windows-Lane',
    '--state-file',
    stateFile,
    '--json',
  ]);
  assert.equal(recorded.status, 0, recorded.stderr);
  const recordedPayload = JSON.parse(recorded.stdout);
  assert.equal(recordedPayload.record.plan.slot, 'windows-lane');
  assert.equal(recordedPayload.record.plan.fingerprint, fingerprintPlanText(namedPlan));
  assert.equal(recordedPayload.planMatches, true);

  storePlan(repo, env, '# Mutated default plan', 3);
  const afterDefaultMutation = await runTournamentState(repo, env, ['--json']);
  assert.equal(JSON.parse(afterDefaultMutation.stdout).planMatches, true);

  storePlan(repo, env, '# Mutated named plan', 4, 'windows-lane');
  const afterNamedMutation = await runTournamentState(repo, env, ['--json']);
  assert.equal(JSON.parse(afterNamedMutation.stdout).planMatches, false);
});

test('tournament-state exposes corrupt state and rejects conflicting or misplaced flags', async () => {
  const { repo, env } = setupRepo();
  const durableDir = resolveDurableStateDir(repo, env.CODEX_HOME);
  fs.mkdirSync(durableDir, { recursive: true });
  fs.writeFileSync(path.join(durableDir, 'tournament-state.json'), '{broken', 'utf8');

  const read = await runTournamentState(repo, env, ['--json']);
  assert.equal(read.status, 0, read.stderr);
  const payload = JSON.parse(read.stdout);
  assert.equal(payload.available, false);
  assert.equal(payload.unreadable, true);
  assert.equal(payload.path, path.join(durableDir, 'tournament-state.json'));
  assert.equal(typeof payload.parseError, 'string');

  const patchFile = writePayload(repo, {
    baselineCommit: 'abc123',
    contestants: contestants(repo),
  });
  await assertJsonError(
    repo,
    env,
    ['--record', '--clear', '--state-file', patchFile],
    'Choose one of --record, --update, --complete, or --clear.',
  );
  await assertJsonError(
    repo,
    env,
    ['--state-file', patchFile],
    '--state-file applies only to --record, --update, or --complete.',
  );
  await assertJsonError(
    repo,
    env,
    ['unexpected'],
    'tournament-state takes only flags; unexpected positional arguments.',
  );
  await assertJsonError(repo, env, ['--record'], 'Provide --state-file for --record.');
  await assertJsonError(repo, env, ['--update'], 'Provide --state-file for --update.');

  for (const args of [
    ['--update', '--slot', 'named'],
    ['--complete', '--slot', 'named'],
    ['--clear', '--slot', 'named'],
    ['--slot', 'named'],
  ]) {
    await assertJsonError(repo, env, args, '--slot applies only to --record.');
  }
});

test('tournament-state renders a readable non-JSON report', async () => {
  const { repo, env } = setupRepo();
  const stateFile = writePayload(repo, {
    baselineCommit: 'abc123',
    lineupSource: 'explicit',
    contestants: contestants(repo),
  });
  const recorded = await runTournamentState(repo, env, ['--record', '--state-file', stateFile]);

  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(recorded.stdout, /^# Stereo Tournament State/m);
  assert.match(recorded.stdout, /- c1 codex:sol \(codex\) status pending/);
});

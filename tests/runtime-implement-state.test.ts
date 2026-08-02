import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { initGitRepo, makeTempDir } from './helpers.ts';
import { registerBrokerReaping } from './runtime-helpers.ts';
import { runCli } from '../plugins/stereo/src/cli/main.ts';
import {
  fingerprintPlanText,
  resolveDurableStateDir,
  resolveImplementStateFile,
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
  const file = path.join(repo, `.implement-state-payload-${payloadCounter}.json`);
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

async function runImplementState(
  repo: string,
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  const previousCodexHome = process.env.CODEX_HOME;
  const previousExitCode = process.exitCode;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalLog = console.log;
  let stdout = '';
  let stderr = '';
  process.env.CODEX_HOME = env.CODEX_HOME;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  console.log = (...values: unknown[]) => {
    stdout += `${values.map(String).join(' ')}\n`;
  };
  try {
    await runCli(['implement-state', ...args, '--cwd', repo]);
    return { status: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalLog;
    process.exitCode = previousExitCode;
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }
}

async function assertJsonError(
  repo: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  expected: string,
): Promise<void> {
  const result = await runImplementState(repo, env, [...args, '--json']);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).error, expected);
  assert.equal(result.stderr.trim(), expected);
}

test('implement-state --record snapshots the plan and round-trips durable launch state', async () => {
  const { repo, env } = setupRepo();
  const plan = '# Approved plan\n\nImplement durable state.';
  storePlan(repo, env, plan);
  const stateFile = writePayload(repo, {
    baselineCommit: 'abc123',
    baselineDirtyPaths: ['README.md'],
    jobId: 'task-launch-1',
    isolated: true,
    worktree: {
      path: path.join(repo, 'isolated-worktree'),
      baselineCommit: 'abc123',
    },
  });

  const recorded = await runImplementState(repo, env, [
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
  assert.equal(payload.record.round, 0);
  assert.deepEqual(payload.record.rounds, []);
  assert.equal(payload.record.jobId, 'task-launch-1');
  assert.equal(payload.record.isolated, true);
  assert.deepEqual(payload.record.worktree, {
    path: path.join(repo, 'isolated-worktree'),
    baselineCommit: 'abc123',
  });
  assert.equal(payload.record.plan.fingerprint, fingerprintPlanText(plan));
  assert.equal(payload.record.plan.slot, 'default');
  assert.equal(payload.planMatches, true);

  const durableFile = path.join(
    resolveDurableStateDir(repo, env.CODEX_HOME),
    'implement-state.json',
  );
  assert.equal(resolveImplementStateFile(repo).endsWith('implement-state.json'), true);
  assert.equal(fs.existsSync(durableFile), true);

  const read = await runImplementState(repo, env, ['--json']);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout).record, payload.record);
});

test('implement-state validates record payload shape, JSON, size, and baseline commit', async () => {
  const { repo, env } = setupRepo();
  const missingBaseline = writePayload(repo, { round: 0 });
  const nonObject = writePayload(repo, []);
  const invalidJson = writePayload(repo, '{not json');
  const oversize = writePayload(repo, `{"value":"${'x'.repeat(512 * 1024)}"}`);
  const invalidRound = writePayload(repo, { baselineCommit: 'abc123', round: '1' });
  const missingWorktreePath = writePayload(repo, { baselineCommit: 'abc123', isolated: true });
  const relativeWorktreePath = writePayload(repo, {
    baselineCommit: 'abc123',
    isolated: true,
    worktree: { path: 'relative-worktree' },
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
    '--state-file is larger than 512 KiB. Store bounded round summaries instead of verbatim reports.',
  );
  await assertJsonError(
    repo,
    env,
    ['--record', '--state-file', invalidRound],
    'Unsupported implementation round "1". Use a non-negative integer.',
  );
  await assertJsonError(
    repo,
    env,
    ['--record', '--state-file', missingWorktreePath],
    'Provide worktree.path in --state-file when isolated is true.',
  );
  await assertJsonError(
    repo,
    env,
    ['--record', '--state-file', relativeWorktreePath],
    'worktree.path must be an absolute path.',
  );
});

test('implement-state --update merges rounds and preserves creation and plan snapshots', async () => {
  const { repo, env } = setupRepo();
  storePlan(repo, env, '# First plan');
  const initialFile = writePayload(repo, {
    baselineCommit: 'abc123',
    jobId: 'task-first',
    custom: 'before',
    rounds: [{ round: 1, verdict: 'changes-requested' }],
  });
  const recorded = await runImplementState(repo, env, [
    '--record',
    '--state-file',
    initialFile,
    '--json',
  ]);
  const initial = JSON.parse(recorded.stdout).record;
  const patchFile = writePayload(repo, {
    jobId: 'task-second',
    custom: 'after',
    createdAt: 'must-not-win',
    updatedAt: 'must-not-win',
    plan: { fingerprint: 'must-not-win' },
    rounds: [
      { round: 1, verdict: 'fixed' },
      { round: 2, verdict: 'changes-requested' },
    ],
  });

  const updated = await runImplementState(repo, env, [
    '--update',
    '--state-file',
    patchFile,
    '--json',
  ]);
  assert.equal(updated.status, 0, updated.stderr);
  const record = JSON.parse(updated.stdout).record;
  assert.equal(record.jobId, 'task-second');
  assert.equal(record.custom, 'after');
  assert.equal(record.createdAt, initial.createdAt);
  assert.deepEqual(record.plan, initial.plan);
  assert.notEqual(record.updatedAt, 'must-not-win');
  assert.deepEqual(record.rounds, [
    { round: 1, verdict: 'fixed' },
    { round: 2, verdict: 'changes-requested' },
  ]);

  const missing = setupRepo();
  await assertJsonError(
    missing.repo,
    missing.env,
    ['--update', '--state-file', patchFile],
    'No implementation state to update. Run /stereo:implement first.',
  );
  await assertJsonError(
    missing.repo,
    missing.env,
    ['--complete'],
    'No implementation state to update. Run /stereo:implement first.',
  );
});

test('implement-state detects a re-stored plan without changing the recorded snapshot', async () => {
  const { repo, env } = setupRepo();
  storePlan(repo, env, '# First plan', 1);
  const stateFile = writePayload(repo, { baselineCommit: 'abc123' });
  const recorded = await runImplementState(repo, env, [
    '--record',
    '--state-file',
    stateFile,
    '--json',
  ]);
  const snapshot = JSON.parse(recorded.stdout).record.plan;

  storePlan(repo, env, '# Revised plan', 3);
  const read = await runImplementState(repo, env, ['--json']);
  assert.equal(read.status, 0, read.stderr);
  const payload = JSON.parse(read.stdout);
  assert.equal(payload.planMatches, false);
  assert.deepEqual(payload.record.plan, snapshot);
  assert.equal(payload.plan.fingerprint, fingerprintPlanText('# Revised plan'));
});

test('implement-state --record snapshots and later compares against the selected plan slot', async () => {
  const { repo, env } = setupRepo();
  const namedPlan = '# Named plan';
  storePlan(repo, env, namedPlan, 2, 'windows-lane');
  storePlan(repo, env, '# Default plan', 1);
  const stateFile = writePayload(repo, { baselineCommit: 'abc123' });

  const recorded = await runImplementState(repo, env, [
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
  assert.equal(recordedPayload.plan.slot, 'windows-lane');
  assert.equal(recordedPayload.planMatches, true);

  storePlan(repo, env, '# Mutated default plan', 3);
  const afterDefaultMutation = await runImplementState(repo, env, ['--json']);
  assert.equal(afterDefaultMutation.status, 0, afterDefaultMutation.stderr);
  assert.equal(JSON.parse(afterDefaultMutation.stdout).planMatches, true);

  storePlan(repo, env, '# Mutated named plan', 4, 'windows-lane');
  const afterNamedMutation = await runImplementState(repo, env, ['--json']);
  assert.equal(afterNamedMutation.status, 0, afterNamedMutation.stderr);
  const changedPayload = JSON.parse(afterNamedMutation.stdout);
  assert.equal(changedPayload.plan.slot, 'windows-lane');
  assert.equal(changedPayload.planMatches, false);
});

test('implement-state reads pre-slot records against the default plan', async () => {
  const { repo, env } = setupRepo();
  const plan = '# Pre-upgrade default plan';
  storePlan(repo, env, plan);
  const durableDir = resolveDurableStateDir(repo, env.CODEX_HOME);
  fs.writeFileSync(
    path.join(durableDir, 'implement-state.json'),
    `${JSON.stringify(
      {
        version: 1,
        status: 'in-progress',
        plan: { fingerprint: fingerprintPlanText(plan) },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const read = await runImplementState(repo, env, ['--json']);
  assert.equal(read.status, 0, read.stderr);
  const payload = JSON.parse(read.stdout);
  assert.equal(payload.record.plan.slot, undefined);
  assert.equal(payload.plan.slot, 'default');
  assert.equal(payload.planMatches, true);
});

test('implement-state --complete applies a final patch and --clear is idempotent', async () => {
  const { repo, env } = setupRepo();
  const worktreePath = path.join(repo, 'isolated-worktree');
  const stateFile = writePayload(repo, {
    baselineCommit: 'abc123',
    isolated: true,
    worktree: { path: worktreePath, baselineCommit: 'abc123' },
  });
  assert.equal(
    (await runImplementState(repo, env, ['--record', '--state-file', stateFile, '--json'])).status,
    0,
  );
  const finalPatch = writePayload(repo, { latestVerdict: 'accepted', round: 2 });
  const completed = await runImplementState(repo, env, [
    '--complete',
    '--state-file',
    finalPatch,
    '--json',
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  const record = JSON.parse(completed.stdout).record;
  assert.equal(record.status, 'complete');
  assert.equal(record.latestVerdict, 'accepted');
  assert.equal(record.round, 2);
  assert.match(record.completedAt, /^\d{4}-\d{2}-\d{2}T/);

  const firstClear = await runImplementState(repo, env, ['--clear', '--json']);
  assert.equal(firstClear.status, 0, firstClear.stderr);
  assert.equal(JSON.parse(firstClear.stdout).cleared, true);
  assert.equal(JSON.parse(firstClear.stdout).worktreePath, worktreePath);
  const secondClear = await runImplementState(repo, env, ['--clear', '--json']);
  assert.equal(secondClear.status, 0, secondClear.stderr);
  assert.deepEqual(JSON.parse(secondClear.stdout), { cleared: false, removed: [] });
});

test('implement-state --clear leaves the stored plan intact', async () => {
  const { repo, env } = setupRepo();
  storePlan(repo, env, '# Plan retained after implementation-state clear');
  const stateFile = writePayload(repo, { baselineCommit: 'abc123' });
  assert.equal(
    (await runImplementState(repo, env, ['--record', '--state-file', stateFile, '--json'])).status,
    0,
  );

  const cleared = await runImplementState(repo, env, ['--clear', '--json']);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(JSON.parse(cleared.stdout).cleared, true);
  assert.equal(
    fs.existsSync(path.join(resolveDurableStateDir(repo, env.CODEX_HOME), 'pair-plan.json')),
    true,
  );
});

test('implement-state exposes corrupt state and rejects conflicting or misplaced flags', async () => {
  const { repo, env } = setupRepo();
  const durableDir = resolveDurableStateDir(repo, env.CODEX_HOME);
  fs.mkdirSync(durableDir, { recursive: true });
  fs.writeFileSync(path.join(durableDir, 'implement-state.json'), '{broken', 'utf8');

  const read = await runImplementState(repo, env, ['--json']);
  assert.equal(read.status, 0, read.stderr);
  const payload = JSON.parse(read.stdout);
  assert.equal(payload.available, false);
  assert.equal(payload.unreadable, true);
  assert.equal(payload.path, path.join(durableDir, 'implement-state.json'));
  assert.equal(typeof payload.parseError, 'string');

  const patchFile = writePayload(repo, { baselineCommit: 'abc123' });
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
    'implement-state takes only flags; unexpected positional arguments.',
  );

  for (const args of [
    ['--update', '--slot', 'named'],
    ['--complete', '--slot', 'named'],
    ['--clear', '--slot', 'named'],
    ['--slot', 'named'],
  ]) {
    await assertJsonError(repo, env, args, '--slot applies only to --record.');
  }
});

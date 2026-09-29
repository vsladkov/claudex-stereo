import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  buildDoctorReport,
  findStalledJobs,
  handleDoctor,
} from '../plugins/stereo/src/cli/commands/doctor.ts';
import { parseWorktreePorcelain } from '../plugins/stereo/src/platform/git.ts';
import { renderDoctorReport } from '../plugins/stereo/src/render/render.ts';
import { COMPANION_ENTRY } from '../plugins/stereo/src/shared/paths.ts';
import type { DoctorRenderReport } from '../plugins/stereo/src/render/render.ts';
import {
  getConfig,
  resolveDurableStateDir,
  saveImplementState,
  saveTournamentState,
  setConfig,
  upsertJob,
  writeJobFile,
} from '../plugins/stereo/src/workspace/state.ts';
import { captureStdout, doctorDeps, makeTempDir, setupReportFixture } from './helpers.ts';

async function captureJsonOutput(runCommand: () => Promise<void>): Promise<unknown> {
  return JSON.parse(await captureStdout(runCommand));
}

test('doctor reports the broker record, reachability, liveness, and log path', async () => {
  const workspace = makeTempDir();
  const report = await buildDoctorReport(
    workspace,
    [],
    doctorDeps({
      loadBrokerSession: () => ({
        endpoint: 'unix:/tmp/doctor.sock',
        pid: 4242,
        pidFile: '/tmp/doctor/broker.pid',
        logFile: '/tmp/doctor/broker.log',
        sessionDir: '/tmp/doctor',
      }),
      probeBrokerEndpoint: async () => true,
      ops: { processHasExited: () => false },
    }),
  );

  assert.equal(report.broker.logFile, '/tmp/doctor/broker.log');
  assert.equal(report.broker.endpointReachable, true);
  assert.equal(report.broker.pidAlive, true);
  assert.match(renderDoctorReport(report), /\/tmp\/doctor\/broker\.log/);
});

test('doctor does not probe when no broker record exists', async () => {
  let probes = 0;
  const report = await buildDoctorReport(
    makeTempDir(),
    [],
    doctorDeps({
      probeBrokerEndpoint: async () => {
        probes += 1;
        return true;
      },
    }),
  );

  assert.equal(report.broker.recorded, false);
  assert.equal(report.broker.endpointReachable, null);
  assert.equal(probes, 0);
});

test('doctor resolves the durable directory under the active Codex home', async () => {
  const workspace = makeTempDir();
  const report = await buildDoctorReport(workspace, [], doctorDeps());

  assert.equal(report.state.durableStateDir, resolveDurableStateDir(workspace));
});

test('doctor points an in-progress implementation record to --resume', async () => {
  const workspace = makeTempDir();
  saveImplementState(workspace, {
    status: 'in-progress',
    baselineCommit: 'abc123',
    round: 2,
    worktree: { path: path.join(workspace, 'stereo-worktrees', 'implement') },
  });

  const report = await buildDoctorReport(workspace, [], doctorDeps());

  assert.equal(report.implementRecord.present, true);
  assert.equal(report.implementRecord.baselineCommit, 'abc123');
  assert.equal(report.implementRecord.round, 2);
  assert.match(report.nextSteps.join('\n'), /\/stereo:implement --resume/);
});

test('doctor points an in-progress tournament record to --resume', async () => {
  const workspace = makeTempDir();
  saveTournamentState(workspace, {
    status: 'in-progress',
    baselineCommit: 'def456',
    contestants: [{ label: 'alpha' }, { label: 'beta' }],
    winner: { label: 'beta' },
  });

  const report = await buildDoctorReport(workspace, [], doctorDeps());

  assert.equal(report.tournamentRecord.present, true);
  assert.equal(report.tournamentRecord.baselineCommit, 'def456');
  assert.equal(report.tournamentRecord.contestants, 2);
  assert.equal(report.tournamentRecord.winner, 'beta');
  assert.match(report.nextSteps.join('\n'), /\/stereo:tournament --resume/);

  const absent = await buildDoctorReport(makeTempDir(), [], doctorDeps());
  assert.equal(absent.tournamentRecord.present, false);
  assert.doesNotMatch(absent.nextSteps.join('\n'), /\/stereo:tournament --resume/);
});

test('doctor keeps only stereo worktrees and emits the exact removal command', async () => {
  const workspace = makeTempDir();
  const stranded = path.join(workspace, 'stereo-worktrees', 'candidate');
  const report = await buildDoctorReport(
    workspace,
    [],
    doctorDeps({
      listWorktrees: () => ({
        available: true,
        detail: null,
        entries: [
          { path: stranded, head: 'abc123', detached: true, branch: null },
          { path: path.join(workspace, 'ordinary'), head: 'def456', detached: false, branch: null },
        ],
      }),
    }),
  );

  assert.equal(report.worktrees.entries.length, 1);
  assert.equal(
    report.worktrees.entries[0]?.removeCommand,
    `node '${COMPANION_ENTRY}' worktree remove --main '${workspace}' --path '${stranded}'`,
  );

  const unavailable = await buildDoctorReport(
    workspace,
    [],
    doctorDeps({
      listWorktrees: () => ({ available: false, entries: [], detail: 'not a repository' }),
    }),
  );
  assert.equal(unavailable.worktrees.available, false);
  assert.deepEqual(unavailable.worktrees.entries, []);
});

test('git worktree parsing retains a record carrying a prunable attribute', () => {
  const worktree = path.join(makeTempDir(), 'stereo-worktrees', 'deleted');
  const entries = parseWorktreePorcelain(
    [
      `worktree ${worktree}`,
      'HEAD abc123',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n'),
  );

  assert.deepEqual(entries, [{ path: worktree, head: 'abc123', detached: true, branch: null }]);
});

test('doctor flags and resets a future SessionStart announcement watermark', async () => {
  const workspace = makeTempDir();
  setConfig(workspace, 'lastJobAnnouncementAt', '2999-01-01T00:00:00.000Z');
  const before = await buildDoctorReport(workspace, [], doctorDeps());
  assert.equal(before.jobAnnouncements.parsed, true);
  assert.equal(before.jobAnnouncements.future, true);
  assert.match(before.nextSteps.join('\n'), /reset/i);

  const payload = (await captureJsonOutput(() =>
    handleDoctor(['--cwd', workspace, '--reset-job-announcements', '--json'], doctorDeps()),
  )) as DoctorRenderReport;

  assert.equal(getConfig(workspace).lastJobAnnouncementAt, null);
  assert.equal(payload.actionsTaken.length, 1);
  assert.equal(payload.jobAnnouncements.lastJobAnnouncementAt, null);
});

test('doctor prints the embedded setup next steps once and no model listing', async () => {
  const setup = setupReportFixture();
  const warning =
    'The plan reviewer\'s built-in default codex:astra-6 cannot run: Unknown Codex family "astra" in "codex:astra-6".';
  setup.nextSteps = [warning];
  const warned = await buildDoctorReport(
    makeTempDir(),
    [],
    doctorDeps({ buildSetupReport: async () => setup }),
  );
  const rendered = renderDoctorReport(warned);
  assert.equal(rendered.split(warning).length, 2, 'the warning is printed once');
  assert.doesNotMatch(rendered, /\nModels|- Codex catalog:|codex:astra →/);
});

test('doctor --json carries the exact text the plain run prints', async () => {
  const workspace = makeTempDir();
  const deps = doctorDeps();
  const plain = await captureStdout(() => handleDoctor(['--cwd', workspace], deps));
  const payload = (await captureJsonOutput(() =>
    handleDoctor(['--cwd', workspace, '--json'], deps),
  )) as DoctorRenderReport & { rendered: string };

  assert.match(plain, /^# Stereo Setup\n/);
  assert.match(plain, /\n# Stereo Diagnostics\n/);
  assert.equal(payload.rendered, plain);
  assert.equal(payload.rendered, renderDoctorReport(payload));
});

const STALLED_WORKER_PID = 2147483647;
const ORPHANED_CLAUDE_PID = 2147483646;

// A running Claude job whose worker is gone while its headless child lives
// on; the index and the job file both carry the record.
function seedStalledClaudeJob(workspace: string, id = 'task-stalled'): void {
  const record = {
    id,
    status: 'running',
    phase: 'running',
    title: 'Claude Task',
    jobClass: 'task',
    runtime: 'claude' as const,
    pid: STALLED_WORKER_PID,
    claudePid: ORPHANED_CLAUDE_PID,
    threadId: 'sess-stalled',
    createdAt: '2026-09-25T08:00:00.000Z',
    startedAt: '2026-09-25T08:00:01.000Z',
  };
  writeJobFile(workspace, id, record);
  upsertJob(workspace, record);
}

// Only the worker pid is dead; every other pid (the Claude child) is alive.
const workerGone = (pid: number): boolean => pid === STALLED_WORKER_PID;

test('doctor lists an active job whose worker is gone and points at /stereo:cancel', async () => {
  const workspace = makeTempDir();
  seedStalledClaudeJob(workspace);

  const report = await buildDoctorReport(
    workspace,
    [],
    doctorDeps({ ops: { processHasExited: workerGone } }),
  );
  assert.deepEqual(report.stalledJobs, [
    {
      id: 'task-stalled',
      title: 'Claude Task',
      status: 'running',
      runtime: 'claude',
      pid: STALLED_WORKER_PID,
    },
  ]);
  assert.ok(
    report.nextSteps.includes(
      'Job task-stalled still shows as running but its worker process is gone; settle it with /stereo:cancel task-stalled.',
    ),
  );
  assert.match(
    renderDoctorReport(report),
    /\nStalled jobs: 1 found\n- task-stalled \(running, Claude Task\): worker pid 2147483647 is gone\n/,
  );

  // A live worker is not stalled, and an empty workspace has nothing to report.
  const live = await buildDoctorReport(workspace, [], doctorDeps());
  assert.deepEqual(live.stalledJobs, []);
  const clean = await buildDoctorReport(
    makeTempDir(),
    [],
    doctorDeps({ ops: { processHasExited: () => true } }),
  );
  assert.deepEqual(clean.stalledJobs, []);
  assert.match(renderDoctorReport(clean), /\nStalled jobs: none\n/);
  assert.doesNotMatch(clean.nextSteps.join('\n'), /stereo:cancel/);
});

test('a queued job counts as stalled only once it is old enough to have started', async () => {
  const workspace = makeTempDir();
  const everyPidDead = doctorDeps({ ops: { processHasExited: () => true } });
  upsertJob(workspace, { id: 'task-fresh', status: 'queued', pid: null });
  upsertJob(workspace, {
    id: 'task-old',
    status: 'queued',
    pid: null,
    createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  });
  upsertJob(workspace, { id: 'task-spawned', status: 'queued', pid: 4242 });
  upsertJob(workspace, { id: 'task-finished', status: 'completed', pid: null });

  const stalled = findStalledJobs(workspace, everyPidDead);
  assert.deepEqual(stalled.map((job) => job.id).sort(), ['task-old', 'task-spawned']);
  assert.deepEqual(
    stalled.find((job) => job.id === 'task-old'),
    {
      id: 'task-old',
      title: null,
      status: 'queued',
      runtime: 'codex',
      pid: null,
    },
  );
  // A queued record whose worker pid is dead is stalled at once; one with a
  // live worker is simply still starting.
  assert.deepEqual(
    findStalledJobs(workspace, doctorDeps({ ops: { processHasExited: () => false } })).map(
      (job) => job.id,
    ),
    ['task-old'],
  );

  const report = await buildDoctorReport(workspace, [], everyPidDead);
  assert.match(
    renderDoctorReport(report),
    /\nStalled jobs: 2 found\n- task-spawned \(queued\): worker pid 4242 is gone\n- task-old \(queued\): no worker was recorded\n/,
  );
  assert.match(
    report.nextSteps.join('\n'),
    /Job task-spawned still shows as queued .*\/stereo:cancel task-spawned\.\n.*\/stereo:cancel task-old\./,
  );
});

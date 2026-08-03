import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildDoctorReport, handleDoctor } from '../plugins/stereo/src/cli/commands/doctor.ts';
import type { DoctorDeps } from '../plugins/stereo/src/cli/commands/doctor.ts';
import type { buildSetupReport } from '../plugins/stereo/src/cli/commands/setup.ts';
import { readModelCatalogDrift } from '../plugins/stereo/src/models/catalog-cache.ts';
import { MODEL_REGISTRY } from '../plugins/stereo/src/models/registry.ts';
import { parseWorktreePorcelain } from '../plugins/stereo/src/platform/git.ts';
import { renderDoctorReport } from '../plugins/stereo/src/render/render.ts';
import type { DoctorRenderReport } from '../plugins/stereo/src/render/render.ts';
import {
  getConfig,
  resolveDurableStateDir,
  saveImplementState,
  setConfig,
} from '../plugins/stereo/src/workspace/state.ts';
import { makeTempDir } from './helpers.ts';

function setupReport(): Awaited<ReturnType<typeof buildSetupReport>> {
  return {
    ready: true,
    node: { available: true, detail: 'ok' },
    nodeEngine: {
      version: '24.0.0',
      major: 24,
      supported: true,
      detail: 'v24.0.0 (>= 24 required)',
    },
    npm: { available: true, detail: 'ok' },
    codex: { available: true, detail: 'ok' },
    writeSandbox: { available: true, detail: 'ok' },
    auth: {
      available: true,
      loggedIn: true,
      detail: 'ok',
      source: 'app-server',
      authMethod: 'chatgpt',
      verified: true,
      requiresOpenaiAuth: true,
      provider: 'openai',
      configuredProviders: [],
    },
    rateLimits: null,
    providers: { active: 'openai', configured: [], aliases: [] },
    sessionRuntime: {
      mode: 'direct',
      label: 'direct startup',
      detail: 'fixture runtime',
      endpoint: null,
    },
    strandedReservations: [],
    reviewGateEnabled: false,
    roleDefaults: [],
    actionsTaken: [],
    nextSteps: [],
  };
}

function catalogReport(): ReturnType<typeof readModelCatalogDrift> {
  return {
    available: false,
    path: '/catalog/models_cache.json',
    reason: 'fixture unavailable',
    fetchedAt: null,
    clientVersion: null,
    entries: [],
    warnings: [],
  };
}

function doctorDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    buildSetupReport: async () => setupReport(),
    loadBrokerSession: () => null,
    probeBrokerEndpoint: async () => false,
    processHasExited: () => false,
    listWorktrees: () => ({ available: true, entries: [], detail: null }),
    readModelCatalogDrift: () => catalogReport(),
    ...overrides,
  };
}

async function captureJsonOutput(runCommand: () => Promise<void>): Promise<unknown> {
  const originalLog = console.log;
  let stdout = '';
  console.log = (...values: unknown[]) => {
    stdout += `${values.map(String).join(' ')}\n`;
  };
  try {
    await runCommand();
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(stdout);
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
      processHasExited: () => false,
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
    `git -C "${workspace}" worktree remove --force "${stranded}"`,
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

test('model catalog drift distinguishes missing, unsupported, unavailable, and third-party rows', () => {
  const codexHome = makeTempDir();
  const cacheFile = path.join(codexHome, 'models_cache.json');
  const registryRows = Object.entries(MODEL_REGISTRY).filter(
    ([, entry]) =>
      !('modelProvider' in entry && entry.modelProvider) && entry.model.startsWith('gpt-'),
  );
  const writeCache = (models: Array<Record<string, unknown>>): void => {
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        fetched_at: '2026-08-03T00:00:00.000Z',
        client_version: 'test',
        models,
      }),
      'utf8',
    );
  };
  const allSupported = registryRows.map(([, entry]) => ({
    slug: entry.model,
    supported_in_api: true,
  }));

  writeCache([...allSupported, { slug: MODEL_REGISTRY.kimi.model, supported_in_api: false }]);
  const green = readModelCatalogDrift(codexHome);
  assert.equal(green.available, true);
  assert.deepEqual(green.warnings, []);
  assert.equal(
    green.entries.some((entry) => entry.model === MODEL_REGISTRY.kimi.model),
    false,
  );

  writeCache(
    allSupported.map((entry, index) =>
      index === 0 ? { ...entry, supported_in_api: false } : entry,
    ),
  );
  const unsupported = readModelCatalogDrift(codexHome);
  assert.equal(unsupported.warnings.length, 1);
  assert.match(unsupported.warnings[0]!, new RegExp(registryRows[0]![1].model));

  writeCache(allSupported.slice(1));
  const missing = readModelCatalogDrift(codexHome);
  assert.equal(missing.warnings.length, 1);
  assert.match(missing.warnings[0]!, new RegExp(registryRows[0]![1].model));

  fs.unlinkSync(cacheFile);
  const absent = readModelCatalogDrift(codexHome);
  assert.equal(absent.available, false);
  assert.deepEqual(absent.warnings, []);

  fs.writeFileSync(cacheFile, '{broken', 'utf8');
  const malformed = readModelCatalogDrift(codexHome);
  assert.equal(malformed.available, false);
  assert.deepEqual(malformed.warnings, []);
});

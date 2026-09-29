import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { captureStderr, makeTempDir, seedState, useTempCodexHome, waitFor } from './helpers.ts';
import { SESSION_HOOK, runNodeWithTimeout } from './runtime-helpers.ts';
import type { NodeRunOutcome } from './runtime-helpers.ts';
import { loadBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import { buildSingleJobSnapshot } from '../plugins/stereo/src/jobs/job-control.ts';
import {
  readJsonFileTolerant,
  withFileLock,
  writeTextAtomic,
} from '../plugins/stereo/src/shared/fs.ts';
import {
  clearImplementState,
  clearPairPlanState,
  DEFAULT_PLAN_SLOT,
  fingerprintPlanText,
  getConfig,
  listJobs,
  listPairPlanSlots,
  loadState,
  loadPairPlanState,
  normalizePlanSlot,
  planSlotOrDefault,
  readStoredJobOrNull,
  resolveDurableStateDir,
  resolveJobFile,
  resolveJobLogFile,
  readImplementStateFile,
  resolveImplementStateFile,
  resolvePairPlanFile,
  resolvePairPlanMarkdownFile,
  resolveStateDir,
  resolveStateFile,
  savePairPlanState,
  saveImplementState,
  setConfig,
  updateState,
  upsertJob,
  writeJobFile,
} from '../plugins/stereo/src/workspace/state.ts';
import type { JobRecord } from '../plugins/stereo/src/workspace/state.ts';

test('resolveStateDir uses the temp fallback when CLAUDE_PLUGIN_DATA is absent', () => {
  const workspace = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    const stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(path.join(os.tmpdir(), 'codex-companion')), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test('resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided', () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, 'state')), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, 'state').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test('durable state is rooted in CODEX_HOME while broker state remains plugin-scoped', () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const codexHome = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  process.env.CODEX_HOME = codexHome;

  try {
    assert.equal(resolveStateDir(workspace).startsWith(path.join(pluginDataDir, 'state')), true);
    assert.equal(
      resolveDurableStateDir(workspace).startsWith(path.join(codexHome, 'companion-state')),
      true,
    );
    assert.equal(resolveStateFile(workspace).startsWith(resolveDurableStateDir(workspace)), true);
    assert.equal(
      resolveJobFile(workspace, 'job-1').startsWith(resolveDurableStateDir(workspace)),
      true,
    );
    assert.equal(
      resolvePairPlanFile(workspace).startsWith(resolveDurableStateDir(workspace)),
      true,
    );
    assert.equal(
      resolveImplementStateFile(workspace).startsWith(resolveDurableStateDir(workspace)),
      true,
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
    if (previousCodexHome == null) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }
});

function withStateHomes<T>(pluginDataDir: string, codexHome: string, fn: () => T): T {
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  process.env.CODEX_HOME = codexHome;
  try {
    return fn();
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
    if (previousCodexHome == null) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }
}

function writeLegacyWorkspace(
  workspace: string,
  options: { jobId?: string; stateSummary?: string } = {},
): {
  legacyDir: string;
  legacyJobFile: string;
  legacyLogFile: string;
  legacyPairPlanFile: string;
} {
  const jobId = options.jobId ?? 'legacy-job';
  const legacyDir = resolveStateDir(workspace);
  const legacyJobsDir = path.join(legacyDir, 'jobs');
  const legacyJobFile = path.join(legacyJobsDir, `${jobId}.json`);
  const legacyLogFile = path.join(legacyJobsDir, `${jobId}.log`);
  const legacyPairPlanFile = path.join(legacyDir, 'pair-plan.json');
  fs.mkdirSync(legacyJobsDir, { recursive: true });
  fs.writeFileSync(legacyLogFile, '[2026-07-25T12:00:00.000Z] legacy progress\n', 'utf8');
  fs.writeFileSync(
    legacyJobFile,
    `${JSON.stringify(
      {
        id: jobId,
        status: 'failed',
        summary: options.stateSummary ?? 'Legacy job',
        logFile: legacyLogFile,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  fs.writeFileSync(
    legacyPairPlanFile,
    `${JSON.stringify({ plan: 'Approved legacy plan', threadId: 'thr_legacy' }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(legacyDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: true },
        jobs: [
          {
            id: jobId,
            status: 'failed',
            summary: options.stateSummary ?? 'Legacy job',
            logFile: legacyLogFile,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { legacyDir, legacyJobFile, legacyLogFile, legacyPairPlanFile };
}

test('legacy state migrates jobs, logs, pair plan, and rewritten absolute log paths', () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const codexHome = makeTempDir();

  withStateHomes(pluginDataDir, codexHome, () => {
    const legacy = writeLegacyWorkspace(workspace);
    const durableDir = resolveDurableStateDir(workspace);
    const durableJobFile = path.join(durableDir, 'jobs', 'legacy-job.json');
    const durableLogFile = path.join(durableDir, 'jobs', 'legacy-job.log');
    fs.writeFileSync(
      path.join(legacy.legacyDir, 'broker.json'),
      `${JSON.stringify({ endpoint: '/tmp/legacy-broker.sock', pid: 123 })}\n`,
      'utf8',
    );

    const state = loadState(workspace);

    assert.equal(state.config.stopReviewGate, true);
    assert.equal(state.jobs[0]?.logFile, durableLogFile);
    assert.equal(JSON.parse(fs.readFileSync(durableJobFile, 'utf8')).logFile, durableLogFile);
    assert.equal(
      fs.readFileSync(durableLogFile, 'utf8'),
      '[2026-07-25T12:00:00.000Z] legacy progress\n',
    );
    assert.deepEqual(loadPairPlanState(workspace), {
      plan: 'Approved legacy plan',
      threadId: 'thr_legacy',
    });
    assert.equal(fs.existsSync(legacy.legacyJobFile), true);
    assert.equal(fs.existsSync(legacy.legacyLogFile), true);
    assert.equal(fs.existsSync(legacy.legacyPairPlanFile), true);
    assert.equal(loadBrokerSession(workspace)?.pid, 123);

    // Simulate the plugin-data wipe that follows an uninstall. Durable state
    // and its rewritten log references remain usable.
    fs.rmSync(legacy.legacyDir, { recursive: true });
    assert.equal(loadState(workspace).jobs[0]?.logFile, durableLogFile);
    assert.equal(
      fs.readFileSync(durableLogFile, 'utf8'),
      '[2026-07-25T12:00:00.000Z] legacy progress\n',
    );
    assert.deepEqual(
      buildSingleJobSnapshot(workspace, 'legacy-job', {
        maxProgressLines: 20,
      }).job.progressPreview,
      ['legacy progress'],
    );
    assert.deepEqual(loadPairPlanState(workspace), {
      plan: 'Approved legacy plan',
      threadId: 'thr_legacy',
    });
    assert.equal(loadBrokerSession(workspace), null);
  });
});

test('legacy migration ignores legacy data when durable state already exists', () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const codexHome = makeTempDir();

  withStateHomes(pluginDataDir, codexHome, () => {
    writeLegacyWorkspace(workspace, { stateSummary: 'Legacy summary' });
    const durableDir = resolveDurableStateDir(workspace);
    fs.mkdirSync(path.join(durableDir, 'jobs'), { recursive: true });
    fs.writeFileSync(
      path.join(durableDir, 'state.json'),
      `${JSON.stringify(
        {
          version: 1,
          config: { stopReviewGate: false },
          jobs: [{ id: 'durable-job', status: 'completed', summary: 'Durable summary' }],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const state = loadState(workspace);
    assert.deepEqual(
      state.jobs.map((job) => job.id),
      ['durable-job'],
    );
    assert.equal(state.jobs[0]?.summary, 'Durable summary');
  });
});

test('legacy migration preserves corrupt job bytes, publishes its marker, and warns once', () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const codexHome = makeTempDir();

  withStateHomes(pluginDataDir, codexHome, () => {
    const legacy = writeLegacyWorkspace(workspace, { jobId: 'job-valid' });
    const corruptSource = path.join(legacy.legacyDir, 'jobs', 'job-corrupt.json');
    const corruptBytes = '{corrupt legacy job\n';
    fs.writeFileSync(corruptSource, corruptBytes, 'utf8');
    const durableDir = resolveDurableStateDir(workspace);
    const corruptDestination = path.join(durableDir, 'jobs', 'job-corrupt.json');
    let stderr = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.deepEqual(
        loadState(workspace).jobs.map((job) => job.id),
        ['job-valid'],
      );
      assert.equal(fs.existsSync(path.join(durableDir, 'state.json')), true);
      assert.equal(fs.readFileSync(corruptDestination, 'utf8'), corruptBytes);
      assert.match(stderr, /Stereo: skipped 1 unreadable legacy job file\(s\)/);
      assert.match(stderr, new RegExp(corruptSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      fs.writeFileSync(corruptSource, '{changed after migration', 'utf8');
      loadState(workspace);
      assert.equal(fs.readFileSync(corruptDestination, 'utf8'), corruptBytes);
      assert.equal((stderr.match(/Stereo: skipped/g) ?? []).length, 1);
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});

test('legacy migration never clobbers a per-job file created by a v1.7 writer', () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const codexHome = makeTempDir();

  withStateHomes(pluginDataDir, codexHome, () => {
    writeLegacyWorkspace(workspace);
    const durableDir = resolveDurableStateDir(workspace);
    const durableJobFile = path.join(durableDir, 'jobs', 'legacy-job.json');
    const liveContents = `${JSON.stringify(
      { id: 'legacy-job', status: 'running', summary: 'Live v1.7 writer' },
      null,
      2,
    )}\n`;
    fs.mkdirSync(path.dirname(durableJobFile), { recursive: true });
    fs.writeFileSync(durableJobFile, liveContents, 'utf8');

    loadState(workspace);

    assert.equal(fs.readFileSync(durableJobFile, 'utf8'), liveContents);
  });
});

test('missing legacy and durable state loads a fresh default', () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const codexHome = makeTempDir();

  withStateHomes(pluginDataDir, codexHome, () => {
    assert.deepEqual(loadState(workspace), {
      version: 1,
      config: { stopReviewGate: false, roleDefaults: {}, lastJobAnnouncementAt: null },
      jobs: [],
    });
  });
});

test('role defaults normalize on read and write while preserving valid selections', () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: true,
          roleDefaults: {
            planner: { model: '  codex:terra  ', effort: ' high ' },
            planReviewer: { model: 42, effort: 'medium' },
            implementer: { model: null, effort: null },
            implementationReviewer: 'not an object',
            constructor: { model: 'claude:opus' },
          },
          lastJobAnnouncementAt: 42,
        },
        jobs: [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const loaded = loadState(workspace);
  assert.deepEqual(loaded.config, {
    stopReviewGate: true,
    roleDefaults: {
      planner: { model: 'codex:terra', effort: 'high' },
      planReviewer: { model: null, effort: 'medium' },
    },
    lastJobAnnouncementAt: null,
  });

  seedState(workspace, loaded);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).config.roleDefaults, {
    planner: { model: 'codex:terra', effort: 'high' },
    planReviewer: { model: null, effort: 'medium' },
  });
});

test('plan slot names normalize case and reject unsafe filename components', () => {
  assert.equal(normalizePlanSlot(null), DEFAULT_PLAN_SLOT);
  assert.equal(normalizePlanSlot(undefined), DEFAULT_PLAN_SLOT);
  assert.equal(normalizePlanSlot(''), DEFAULT_PLAN_SLOT);
  assert.equal(normalizePlanSlot('   '), DEFAULT_PLAN_SLOT);
  assert.equal(normalizePlanSlot(' Windows_Lane-2 '), 'windows_lane-2');
  assert.equal(planSlotOrDefault(' WINDOWS-LANE '), 'windows-lane');
  assert.equal(planSlotOrDefault('../invalid'), DEFAULT_PLAN_SLOT);

  const invalidMessage = (value: string) =>
    `Unsupported plan slot "${value}". Plan slots may contain only letters, digits, hyphens, and underscores, must start with a letter or digit, and may be at most 64 characters.`;
  for (const value of ['..', 'a/b', '-lead', '.hidden', 'a'.repeat(65)]) {
    assert.throws(() => normalizePlanSlot(value), new Error(invalidMessage(value)));
  }
});

test('plan slot paths preserve the default filenames and suffix named slots', () => {
  const workspace = makeTempDir();
  const durableDir = resolveDurableStateDir(workspace);

  assert.equal(resolvePairPlanFile(workspace), path.join(durableDir, 'pair-plan.json'));
  assert.equal(resolvePairPlanMarkdownFile(workspace), path.join(durableDir, 'pair-plan.md'));
  assert.equal(
    resolvePairPlanFile(workspace, 'windows-lane'),
    path.join(durableDir, 'pair-plan-windows-lane.json'),
  );
  assert.equal(
    resolvePairPlanMarkdownFile(workspace, 'windows-lane'),
    path.join(durableDir, 'pair-plan-windows-lane.md'),
  );
});

test('pair plan save, load, and clear operations are independent per slot', () => {
  const workspace = makeTempDir();
  const defaultPlan = { plan: '# Default plan\n' };
  const windowsPlan = { plan: '# Windows plan\n' };

  savePairPlanState(workspace, defaultPlan);
  savePairPlanState(workspace, windowsPlan, 'windows-lane');
  fs.writeFileSync(resolvePairPlanMarkdownFile(workspace), '# Default export\n', 'utf8');
  fs.writeFileSync(
    resolvePairPlanMarkdownFile(workspace, 'windows-lane'),
    '# Windows export\n',
    'utf8',
  );

  assert.deepEqual(loadPairPlanState(workspace), defaultPlan);
  assert.deepEqual(loadPairPlanState(workspace, 'windows-lane'), windowsPlan);
  assert.deepEqual(clearPairPlanState(workspace, 'windows-lane'), [
    resolvePairPlanFile(workspace, 'windows-lane'),
    resolvePairPlanMarkdownFile(workspace, 'windows-lane'),
  ]);
  assert.deepEqual(loadPairPlanState(workspace), defaultPlan);
  assert.equal(fs.existsSync(resolvePairPlanFile(workspace)), true);
  assert.equal(fs.existsSync(resolvePairPlanMarkdownFile(workspace)), true);
  assert.equal(fs.existsSync(resolvePairPlanFile(workspace, 'windows-lane')), false);
});

test('listPairPlanSlots inventories only reachable JSON plan slots in stable order', () => {
  const emptyWorkspace = makeTempDir();
  assert.deepEqual(listPairPlanSlots(emptyWorkspace), []);
  assert.equal(fs.existsSync(resolveDurableStateDir(emptyWorkspace)), false);

  const workspace = makeTempDir();
  savePairPlanState(workspace, { plan: '# Zulu\n' }, 'zulu');
  savePairPlanState(workspace, { plan: '# Default\n' });
  savePairPlanState(workspace, { plan: '# Alpha\n' }, 'alpha');
  const durableDir = resolveDurableStateDir(workspace);
  fs.writeFileSync(path.join(durableDir, 'pair-plan-export.md'), '# Ignore\n', 'utf8');
  fs.writeFileSync(path.join(durableDir, 'implement-state.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(durableDir, 'pair-plan-bad.name.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(durableDir, 'pair-plan-default.json'), '{}\n', 'utf8');

  assert.deepEqual(listPairPlanSlots(workspace), ['default', 'alpha', 'zulu']);
});

test('clearPairPlanState removes both artifacts and is idempotent', () => {
  const workspace = makeTempDir();
  const planPath = resolvePairPlanFile(workspace);
  const markdownPath = resolvePairPlanMarkdownFile(workspace);
  savePairPlanState(workspace, { plan: '# Stored plan\n' });
  fs.writeFileSync(markdownPath, '# Exported plan\n', 'utf8');

  assert.deepEqual(clearPairPlanState(workspace), [planPath, markdownPath]);
  assert.equal(fs.existsSync(planPath), false);
  assert.equal(fs.existsSync(markdownPath), false);
  assert.deepEqual(clearPairPlanState(workspace), []);
});

test('implementation state round-trips in the durable directory and clears idempotently', () => {
  const workspace = makeTempDir();
  const statePath = resolveImplementStateFile(workspace);
  const record = { version: 1, baselineCommit: 'abc123', round: 2 };

  assert.equal(statePath.startsWith(resolveDurableStateDir(workspace)), true);
  assert.deepEqual(saveImplementState(workspace, record), record);
  assert.deepEqual(readImplementStateFile(workspace).record, record);
  assert.deepEqual(clearImplementState(workspace), [statePath]);
  assert.equal(readImplementStateFile(workspace).record, null);
  assert.deepEqual(clearImplementState(workspace), []);
});

test('fingerprintPlanText is stable and rejects empty or non-string plans', () => {
  const fingerprint = fingerprintPlanText('# Plan\n\nImplement it.');
  assert.match(fingerprint ?? '', /^[a-f0-9]{32}$/);
  assert.equal(fingerprintPlanText('# Plan\n\nImplement it.'), fingerprint);
  assert.notEqual(fingerprintPlanText('# Plan\n\nImplement something else.'), fingerprint);
  assert.equal(fingerprintPlanText(''), null);
  assert.equal(fingerprintPlanText('   '), null);
  assert.equal(fingerprintPlanText({ plan: 'text' }), null);
});

test('clearPairPlanState creates no durable directory when nothing is stored', () => {
  const workspace = makeTempDir();
  const durableDir = resolveDurableStateDir(workspace);
  assert.deepEqual(clearPairPlanState(workspace), []);
  assert.equal(fs.existsSync(durableDir), false);
});

test('clearPairPlanState migrates then removes a legacy pair plan permanently', () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const codexHome = makeTempDir();

  withStateHomes(pluginDataDir, codexHome, () => {
    writeLegacyWorkspace(workspace);
    const durablePlan = resolvePairPlanFile(workspace);
    assert.deepEqual(clearPairPlanState(workspace), [durablePlan]);
    assert.equal(loadPairPlanState(workspace), null);
    assert.equal(fs.existsSync(durablePlan), false);
  });
});

test('ordinary durable JSON writers preserve bytes and leave no temporary files', () => {
  const workspace = makeTempDir();
  const state = seedState(workspace, {
    version: 1,
    config: { stopReviewGate: true },
    jobs: [],
  });
  const stateFile = resolveStateFile(workspace);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), `${JSON.stringify(state, null, 2)}\n`);

  const jobFile = writeJobFile(workspace, 'atomic-job', {
    id: 'atomic-job',
    status: 'running',
  });
  writeJobFile(workspace, 'atomic-job', {
    id: 'atomic-job',
    status: 'completed',
    summary: 'Replacement contents',
  });
  assert.equal(
    fs.readFileSync(jobFile, 'utf8'),
    `${JSON.stringify(
      {
        id: 'atomic-job',
        status: 'completed',
        summary: 'Replacement contents',
      },
      null,
      2,
    )}\n`,
  );

  const pairPlan = {
    plan: '# Atomic plan\n',
    verdict: 'approve',
  };
  savePairPlanState(workspace, pairPlan);
  assert.equal(
    fs.readFileSync(resolvePairPlanFile(workspace), 'utf8'),
    `${JSON.stringify(pairPlan, null, 2)}\n`,
  );

  const durableFiles = fs.readdirSync(resolveDurableStateDir(workspace), {
    recursive: true,
    encoding: 'utf8',
  });
  assert.equal(
    durableFiles.some((file) => file.endsWith('.tmp')),
    false,
  );
});

test('ordinary durable JSON writers clean up a temporary file after rename failure', () => {
  const workspace = makeTempDir();
  const jobFile = resolveJobFile(workspace, 'rename-failure');
  fs.mkdirSync(jobFile);

  assert.throws(() =>
    writeJobFile(workspace, 'rename-failure', {
      id: 'rename-failure',
      status: 'running',
    }),
  );

  const tempPrefix = `${path.basename(jobFile)}.`;
  assert.deepEqual(
    fs
      .readdirSync(path.dirname(jobFile))
      .filter((file) => file.startsWith(tempPrefix) && file.endsWith('.tmp')),
    [],
  );
});

test('writeTextAtomic preserves exact bytes and leaves no temporary files', () => {
  const workspace = makeTempDir();
  const durableDir = resolveDurableStateDir(workspace);
  const textFile = path.join(durableDir, 'atomic-text.md');
  const contents = '# Atomic text\n\nExact trailing bytes.\n';
  fs.mkdirSync(durableDir, { recursive: true });

  writeTextAtomic(textFile, contents);

  assert.equal(fs.readFileSync(textFile, 'utf8'), contents);
  assert.equal(
    fs.readdirSync(durableDir).some((file) => file.endsWith('.tmp')),
    false,
  );
});

test('writeTextAtomic cleans up a temporary file after rename failure', () => {
  const workspace = makeTempDir();
  const durableDir = resolveDurableStateDir(workspace);
  const textFile = path.join(durableDir, 'rename-failure.md');
  fs.mkdirSync(textFile, { recursive: true });

  assert.throws(() => writeTextAtomic(textFile, 'replacement contents'));

  const tempPrefix = `${path.basename(textFile)}.`;
  assert.deepEqual(
    fs
      .readdirSync(durableDir)
      .filter((file) => file.startsWith(tempPrefix) && file.endsWith('.tmp')),
    [],
  );
});

test('state index strips request payloads from legacy, updated, and new jobs', () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const legacyJobs = [
    {
      id: 'legacy-plan',
      status: 'completed',
      summary: 'Legacy plan review',
      request: { kind: 'plan-review', plan: 'large legacy plan' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'legacy-task',
      status: 'completed',
      summary: 'Legacy task',
      request: { prompt: 'large legacy task' },
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    {
      id: 'unrelated-job',
      status: 'running',
      phase: 'starting',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
  ];

  for (const job of legacyJobs.slice(0, 2)) {
    fs.writeFileSync(
      resolveJobFile(workspace, job.id),
      `${JSON.stringify(job, null, 2)}\n`,
      'utf8',
    );
  }
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: legacyJobs }, null, 2)}\n`,
    'utf8',
  );

  const loaded = loadState(workspace);
  assert.equal(
    loaded.jobs.every((job) => !Object.hasOwn(job, 'request')),
    true,
  );

  upsertJob(workspace, {
    id: 'unrelated-job',
    phase: 'investigating',
  });

  const persistedAfterUpdate = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(
    persistedAfterUpdate.jobs.every((job: JobRecord) => !Object.hasOwn(job, 'request')),
    true,
  );
  assert.equal(
    persistedAfterUpdate.jobs.find((job: JobRecord) => job.id === 'unrelated-job').phase,
    'investigating',
  );
  for (const job of legacyJobs.slice(0, 2)) {
    const storedJob = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), 'utf8'));
    assert.deepEqual(storedJob.request, job.request);
  }

  upsertJob(workspace, {
    id: 'new-request-job',
    status: 'queued',
    request: { prompt: 'new large task' },
  });

  const persistedAfterInsert = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(
    persistedAfterInsert.jobs.every((job: JobRecord) => !Object.hasOwn(job, 'request')),
    true,
  );
  assert.equal(
    loadState(workspace).jobs.every((job) => !Object.hasOwn(job, 'request')),
    true,
  );
});

test('a stale snapshot write preserves a concurrently written terminal row over its running one', () => {
  const workspace = makeTempDir();
  seedState(workspace, {
    jobs: [
      {
        id: 'job-race',
        status: 'running',
        phase: 'running',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  const stale = loadState(workspace);
  seedState(workspace, {
    jobs: [
      {
        id: 'job-race',
        status: 'completed',
        phase: 'done',
        updatedAt: '2026-01-01T00:01:00.000Z',
      },
    ],
  });

  seedState(workspace, stale);

  const row = loadState(workspace).jobs.find((job) => job.id === 'job-race');
  assert.equal(row?.status, 'completed');
  assert.equal(row?.phase, 'done');
});

test('a state write treats terminal status as absorbing even when a running candidate is newer', () => {
  const workspace = makeTempDir();
  seedState(workspace, {
    jobs: [
      {
        id: 'job-absorbing',
        status: 'failed',
        errorMessage: 'terminal truth',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });

  seedState(workspace, {
    jobs: [
      {
        id: 'job-absorbing',
        status: 'running',
        phase: 'late stale writer',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
  });

  const row = loadState(workspace).jobs.find((job) => job.id === 'job-absorbing');
  assert.equal(row?.status, 'failed');
  assert.equal(row?.errorMessage, 'terminal truth');
  assert.equal(row?.phase, undefined);
});

test("a stale snapshot write keeps the caller's newer row and another writer's newer unrelated row", () => {
  const workspace = makeTempDir();
  seedState(workspace, {
    jobs: [
      { id: 'job-owned', status: 'running', phase: 'old', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'job-other', status: 'running', phase: 'old', updatedAt: '2026-01-01T00:00:00Z' },
    ],
  });
  const callerSnapshot = loadState(workspace);
  const callerOwned = callerSnapshot.jobs.find((job) => job.id === 'job-owned');
  assert.ok(callerOwned);
  callerOwned.phase = 'caller update';
  callerOwned.updatedAt = '2026-01-01T00:02:00Z';

  seedState(workspace, {
    jobs: [
      { id: 'job-owned', status: 'running', phase: 'old', updatedAt: '2026-01-01T00:00:00Z' },
      {
        id: 'job-other',
        status: 'running',
        phase: 'concurrent update',
        updatedAt: '2026-01-01T00:03:00Z',
      },
    ],
  });

  seedState(workspace, callerSnapshot);

  const rows = new Map(loadState(workspace).jobs.map((job) => [job.id, job]));
  assert.equal(rows.get('job-owned')?.phase, 'caller update');
  assert.equal(rows.get('job-other')?.phase, 'concurrent update');
});

test('job artifact resolvers reject unsafe job ids', () => {
  const workspace = makeTempDir();
  for (const jobId of ['../escape', 'a/b', '']) {
    assert.throws(() => resolveJobFile(workspace, jobId), /Unsupported job id/);
    assert.throws(() => resolveJobLogFile(workspace, jobId), /Unsupported job id/);
  }
});

test('a state write retains an unsafe indexed id without resolving or deleting its artifacts', () => {
  const workspace = makeTempDir();
  seedState(workspace, { jobs: [] });
  const stateFile = resolveStateFile(workspace);
  const escapedJobFile = path.join(resolveDurableStateDir(workspace), 'escape.json');
  const escapedLogFile = path.join(resolveDurableStateDir(workspace), 'escape.log');
  fs.writeFileSync(escapedJobFile, 'sentinel job bytes\n', 'utf8');
  fs.writeFileSync(escapedLogFile, 'sentinel log bytes\n', 'utf8');
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: '../escape',
            status: 'completed',
            logFile: escapedLogFile,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  assert.doesNotThrow(() => seedState(workspace, { jobs: [] }));
  assert.equal(loadState(workspace).jobs[0]?.id, '../escape');
  assert.equal(fs.readFileSync(escapedJobFile, 'utf8'), 'sentinel job bytes\n');
  assert.equal(fs.readFileSync(escapedLogFile, 'utf8'), 'sentinel log bytes\n');
});

test('a state write prunes dropped job artifacts when indexed jobs exceed the cap', () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, 'utf8');
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: 'completed' }, null, 2), 'utf8');
    return {
      id: jobId,
      status: 'completed',
      logFile,
      updatedAt,
      createdAt: updatedAt,
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  seedState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs,
  });

  const prunedJobFile = resolveJobFile(workspace, 'job-0');
  const retainedJobFile = resolveJobFile(workspace, 'job-50');
  const retainedLogFile = resolveJobLogFile(workspace, 'job-50');
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job: JobRecord) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`),
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort(),
  );
});

test("a state write keeps a live job's artifacts and index entry when dropped by a stale snapshot", () => {
  const workspace = makeTempDir();
  const jobFile = resolveJobFile(workspace, 'job-live');
  const logFile = resolveJobLogFile(workspace, 'job-live');
  fs.writeFileSync(logFile, 'running\n', 'utf8');
  fs.writeFileSync(
    jobFile,
    `${JSON.stringify({ id: 'job-live', status: 'running', logFile, request: { kind: 'task', prompt: 'big' }, updatedAt: '2026-01-02T00:00:00.000Z' }, null, 2)}\n`,
    'utf8',
  );
  // The on-disk index knows about the live job...
  seedState(workspace, {
    version: 1,
    config: {},
    jobs: [{ id: 'job-live', status: 'running', logFile, updatedAt: '2026-01-02T00:00:00.000Z' }],
  });

  // ...but a concurrent writer saves a stale snapshot that omits it.
  seedState(workspace, { version: 1, config: {}, jobs: [] });

  assert.equal(fs.existsSync(jobFile), true);
  assert.equal(fs.existsSync(logFile), true);
  const jobs = loadState(workspace).jobs;
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0]);
  assert.equal(jobs[0].id, 'job-live');
  assert.equal(jobs[0].status, 'running');
  assert.equal('request' in jobs[0], false);
});

test('a state write still deletes terminal jobs dropped from the snapshot', () => {
  const workspace = makeTempDir();
  const jobFile = resolveJobFile(workspace, 'job-done');
  const logFile = resolveJobLogFile(workspace, 'job-done');
  fs.writeFileSync(logFile, 'done\n', 'utf8');
  fs.writeFileSync(
    jobFile,
    `${JSON.stringify({ id: 'job-done', status: 'completed', logFile, updatedAt: '2026-01-02T00:00:00.000Z' }, null, 2)}\n`,
    'utf8',
  );
  seedState(workspace, {
    version: 1,
    config: {},
    jobs: [{ id: 'job-done', status: 'completed', logFile, updatedAt: '2026-01-02T00:00:00.000Z' }],
  });

  seedState(workspace, { version: 1, config: {}, jobs: [] });

  assert.equal(fs.existsSync(jobFile), false);
  assert.equal(fs.existsSync(logFile), false);
  assert.equal(loadState(workspace).jobs.length, 0);
});

// A job-done row with its job file and log, plus a non-default config: the
// state a transient read error must never reset or prune.
function seedFinishedWorkspace(workspace: string): { jobFile: string; logFile: string } {
  const jobFile = resolveJobFile(workspace, 'job-done');
  const logFile = resolveJobLogFile(workspace, 'job-done');
  fs.writeFileSync(logFile, 'done\n', 'utf8');
  const job = {
    id: 'job-done',
    status: 'completed',
    logFile,
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
  fs.writeFileSync(jobFile, `${JSON.stringify(job)}\n`, 'utf8');
  seedState(workspace, { version: 1, config: { stopReviewGate: true }, jobs: [job] });
  return { jobFile, logFile };
}

function failStateReads(
  t: TestContext,
  stateFile: string,
  failures: number,
  code = 'EMFILE',
): { calls: () => number } {
  const originalRead = fs.readFileSync;
  let calls = 0;
  t.mock.method(fs, 'readFileSync', ((file: fs.PathOrFileDescriptor, options?: unknown) => {
    if (file === stateFile) {
      calls += 1;
      if (calls <= failures) {
        throw Object.assign(new Error(`${code}: injected failure, open '${stateFile}'`), { code });
      }
    }
    return originalRead(file, options as Parameters<typeof fs.readFileSync>[1]);
  }) as typeof fs.readFileSync);
  return { calls: () => calls };
}

test('a state read that fails for an I/O reason is retried, then thrown, never reset', (t) => {
  const workspace = makeTempDir();
  const { jobFile, logFile } = seedFinishedWorkspace(workspace);
  const stateFile = resolveStateFile(workspace);
  const before = fs.readFileSync(stateFile, 'utf8');

  // A brief failure is retried and the real state comes back.
  failStateReads(t, stateFile, 2, 'EBUSY');
  assert.equal(loadState(workspace).config.stopReviewGate, true);
  t.mock.restoreAll();

  // A lasting one is thrown: nothing is written, moved aside, or deleted.
  const lasting = failStateReads(t, stateFile, Number.POSITIVE_INFINITY);
  const isReadFailure = (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'EMFILE' &&
    (error as Error).message.startsWith(`Could not read the state file ${stateFile}:`);
  assert.throws(() => loadState(workspace), isReadFailure);
  assert.ok(lasting.calls() > 1, 'the read was retried');
  assert.throws(
    () =>
      updateState(workspace, (state) => {
        state.jobs = [];
      }),
    isReadFailure,
  );
  t.mock.restoreAll();

  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  assert.equal(fs.existsSync(jobFile), true);
  assert.equal(fs.existsSync(logFile), true);
  assert.deepEqual(
    fs.readdirSync(path.dirname(stateFile)).filter((name) => name.includes('.corrupt-')),
    [],
  );
});

test('a state write takes over a stale index lock of a dead writer and writes under a fresh one', () => {
  const workspace = makeTempDir();
  seedState(workspace, { jobs: [] });
  const lockPath = `${resolveStateFile(workspace)}.lock`;

  // A lock a dead writer left behind, older than the stale threshold: it is
  // taken over rather than waited out (the timeout fallback would leave it).
  fs.writeFileSync(lockPath, '2147483600', 'utf8');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  seedState(workspace, {
    jobs: [{ id: 'job-after-stale-lock', status: 'queued', updatedAt: '2026-01-01T00:00:00Z' }],
  });
  assert.equal(fs.existsSync(lockPath), false, 'the stale lock is gone');
  assert.deepEqual(
    loadState(workspace).jobs.map((job) => job.id),
    ['job-after-stale-lock'],
  );

  // The read-modify-write runs under the lock, which names this process
  // (`<pid> <token>`) and is released once the write is done.
  const updated = updateState(workspace, (state) => {
    assert.match(
      fs.readFileSync(lockPath, 'utf8'),
      new RegExp(`^${process.pid} [0-9a-f-]{36}$`),
      'held while mutating',
    );
    state.config.stopReviewGate = true;
    state.jobs.push({ id: 'job-updated', status: 'queued', updatedAt: '2026-01-02T00:00:00Z' });
  });
  assert.equal(updated.config.stopReviewGate, true);
  assert.equal(fs.existsSync(lockPath), false, 'the lock is released after the write');
  const reloaded = loadState(workspace);
  assert.equal(reloaded.config.stopReviewGate, true);
  assert.deepEqual(reloaded.jobs.map((job) => job.id).sort(), [
    'job-after-stale-lock',
    'job-updated',
  ]);
});

test('two state writers that overlap under the lock both keep their rows', () => {
  const workspace = makeTempDir();
  seedState(workspace, { jobs: [] });
  const lockPath = `${resolveStateFile(workspace)}.lock`;
  const row = (id: string): JobRecord => ({
    id,
    status: 'running',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  // Each job has its file, as the production writers leave it.
  writeJobFile(workspace, 'job-first', row('job-first'));
  writeJobFile(workspace, 'job-second', row('job-second'));

  updateState(workspace, (state) => {
    // Two waiters can both take one stale lock over: a second holder gets in
    // while this one still holds it, and writes first.
    fs.rmSync(lockPath);
    upsertJob(workspace, row('job-second'));
    state.jobs.unshift(row('job-first'));
  });

  assert.deepEqual(
    loadState(workspace)
      .jobs.map((job) => job.id)
      .sort(),
    ['job-first', 'job-second'],
  );
});

const STATE_MODULE = fileURLToPath(
  new URL('../plugins/stereo/src/workspace/state.ts', import.meta.url),
);

// One writer process: it announces itself on its ready file, waits for the
// shared go file so every writer's read-merge-write cycles overlap, then
// upserts its own ids. upsertJob writes no per-job file, so a row a stale
// unlocked snapshot drops is gone for good: only the index lock keeps it.
const UPSERT_WRITER_SOURCE = [
  "import fs from 'node:fs';",
  "import { pathToFileURL } from 'node:url';",
  'const [stateModule, workspace, readyFile, goFile, worker, count] = process.argv.slice(1);',
  'const { upsertJob } = await import(pathToFileURL(stateModule).href);',
  "fs.writeFileSync(readyFile, '');",
  'const until = Date.now() + 30000;',
  'const pause = new Int32Array(new SharedArrayBuffer(4));',
  'while (!fs.existsSync(goFile)) {',
  '  if (Date.now() > until) { process.exit(3); }',
  '  Atomics.wait(pause, 0, 0, 5);',
  '}',
  'for (let index = 0; index < Number(count); index += 1) {',
  "  upsertJob(workspace, { id: `job-${worker}-${index}`, status: 'queued' });",
  '}',
].join('\n');

test('writers in separate processes serialize on the index lock and every row survives', async (t) => {
  const codexHome = useTempCodexHome(t, 'state-lock-home-');
  const workspace = makeTempDir();
  const barrier = makeTempDir();
  const goFile = path.join(barrier, 'go');
  // 36 rows stay under the MAX_JOBS prune cap, so every one must be listed.
  const writers = 6;
  const perWriter = 6;
  const env = { ...process.env, CODEX_HOME: codexHome };
  const exited: NodeRunOutcome[] = [];
  const runs = Array.from({ length: writers }, (_, worker) =>
    runNodeWithTimeout(
      [
        '--input-type=module',
        '-e',
        UPSERT_WRITER_SOURCE,
        STATE_MODULE,
        workspace,
        path.join(barrier, `ready-${worker}`),
        goFile,
        String(worker),
        String(perWriter),
      ],
      { env, timeoutMs: 60_000 },
    ).then((outcome) => {
      exited.push(outcome);
      return outcome;
    }),
  );
  // Release them together once all are loaded (or stop waiting if one died).
  await waitFor(
    () =>
      exited.length > 0 ||
      fs.readdirSync(barrier).filter((name) => name.startsWith('ready-')).length === writers,
    { timeoutMs: 45_000 },
  );
  fs.writeFileSync(goFile, '');
  const outcomes = await Promise.all(runs);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 0, `${outcome.timedOut ? 'timed out: ' : ''}${outcome.stderr}`);
  }

  const expected = Array.from({ length: writers }, (_, worker) =>
    Array.from({ length: perWriter }, (_, index) => `job-${worker}-${index}`),
  ).flat();
  assert.deepEqual(
    loadState(workspace)
      .jobs.map((job) => job.id)
      .sort(),
    expected.sort(),
  );
  assert.equal(fs.existsSync(`${resolveStateFile(workspace)}.lock`), false, 'no lock is left');
});

test('a writer that cannot take a fresh index lock in its budget writes unlocked and leaves it', () => {
  const workspace = makeTempDir();
  seedState(workspace, { jobs: [] });
  const lockPath = `${resolveStateFile(workspace)}.lock`;
  // A live writer's lock: fresh, so it is waited on, never taken over.
  const held = '424242 held-by-a-live-writer';
  fs.writeFileSync(lockPath, held, 'utf8');

  const started = Date.now();
  updateState(
    workspace,
    (state) => {
      state.jobs.push({ id: 'job-unlocked', status: 'queued' });
    },
    { attempts: 3 },
  );
  // A deadline already past allows one attempt, then the same fallback.
  updateState(
    workspace,
    (state) => {
      state.config.stopReviewGate = true;
    },
    { deadline: Date.now() },
  );
  const elapsed = Date.now() - started;

  const state = loadState(workspace);
  assert.deepEqual(
    state.jobs.map((job) => job.id),
    ['job-unlocked'],
  );
  assert.equal(state.config.stopReviewGate, true);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), held, 'the holder keeps its lock');
  // The default budget waits seconds (and takes a lock over once stale).
  assert.ok(elapsed < 2500, `the small budget bounded the wait (${elapsed} ms)`);
  fs.rmSync(lockPath);
});

// The one SessionStart budget test: the hook announces a finished job and
// writes its watermark past an index lock another writer keeps holding.
test('SessionStart writes its watermark past a held index lock within its hook budget', async (t) => {
  const hooks = JSON.parse(
    fs.readFileSync(
      fileURLToPath(new URL('../plugins/stereo/hooks/hooks.json', import.meta.url)),
      'utf8',
    ),
  ) as { hooks: { SessionStart: Array<{ hooks: Array<{ timeout: number }> }> } };
  const budgetMs = (hooks.hooks.SessionStart[0]?.hooks[0]?.timeout ?? 0) * 1000;
  assert.ok(budgetMs > 0, 'hooks.json gives SessionStart a timeout');

  const codexHome = useTempCodexHome(t, 'session-start-lock-home-');
  const workspace = makeTempDir();
  // A job finished after the watermark: the hook announces it and moves the
  // watermark, which is the one state write it makes.
  seedState(workspace, {
    config: { stopReviewGate: false, lastJobAnnouncementAt: '2026-08-01T10:00:00.000Z' },
    jobs: [
      {
        id: 'plan-finished',
        status: 'completed',
        kind: 'plan-review',
        createdAt: '2026-08-01T10:15:00.000Z',
        completedAt: '2026-08-01T10:45:00.000Z',
        updatedAt: '2026-08-01T10:45:00.000Z',
      },
    ],
  });
  const lockPath = `${resolveStateFile(workspace)}.lock`;
  const held = '424242 held-by-a-live-writer';
  fs.writeFileSync(lockPath, held, 'utf8');
  // Keep the lock fresh for as long as the hook runs, as a live holder would,
  // so it never turns stale however slowly this machine starts node.
  const refresh = setInterval(() => {
    const now = new Date();
    fs.utimesSync(lockPath, now, now);
  }, 250);
  t.after(() => clearInterval(refresh));

  const started = Date.now();
  const outcome = await runNodeWithTimeout([SESSION_HOOK, 'SessionStart'], {
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: codexHome },
    timeoutMs: budgetMs * 3,
  });
  const elapsed = Date.now() - started;
  clearInterval(refresh);

  assert.equal(outcome.timedOut, false, 'the hook ended on its own');
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(JSON.parse(outcome.stdout).hookSpecificOutput.additionalContext, /plan-finished/);
  // The watermark write fell back to unlocked; the holder's lock is intact.
  assert.equal(loadState(workspace).config.lastJobAnnouncementAt, '2026-08-01T10:45:00.000Z');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), held, 'the lock was never taken over');
  // A small lock budget costs half a second: the old 200-attempt wait
  // outlasted the 5 s stale threshold. Windows runners start node too slowly
  // for a wall-clock bound to mean anything; the fallback and the kept lock
  // above are the contract there.
  if (process.platform !== 'win32') {
    assert.ok(elapsed < 4500, `SessionStart took ${elapsed} ms of its ${budgetMs} ms budget`);
  }
  fs.rmSync(lockPath);
});

// The unreadable state files moved aside so far.
function corruptCopies(workspace: string): string[] {
  const dir = path.dirname(resolveStateFile(workspace));
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('state.json.corrupt-'))
    .sort()
    .map((name) => path.join(dir, name));
}

test('the first write after an unreadable state read moves the corrupt file aside', () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const corruptBytes = '{"config": {"stopReviewGate": true}, "jobs": [\n';
  fs.writeFileSync(stateFile, corruptBytes, 'utf8');

  // Reads fall back to defaults and leave the file alone.
  const read = captureStderr(() => loadState(workspace));
  assert.deepEqual(read.value.jobs, []);
  assert.match(read.stderr, /Ignoring unreadable state file/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), corruptBytes);
  assert.deepEqual(corruptCopies(workspace), []);

  const write = captureStderr(() => setConfig(workspace, 'stopReviewGate', true));
  assert.match(write.stderr, /Moved unreadable state file .* aside to .*state\.json\.corrupt-/);
  assert.equal(getConfig(workspace).stopReviewGate, true);

  const after = corruptCopies(workspace);
  assert.equal(after.length, 1);
  const copy = after[0] as string;
  assert.match(path.basename(copy), /^state\.json\.corrupt-\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
  assert.equal(fs.readFileSync(copy, 'utf8'), corruptBytes);

  // A healthy file is replaced as usual: no further copies appear.
  upsertJob(workspace, { id: 'task-after', status: 'completed', jobClass: 'task' });
  assert.equal(corruptCopies(workspace).length, 1);
  assert.equal(listJobs(workspace)[0]?.id, 'task-after');
});

test('a state file that parses to a non-object counts as unreadable', () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, '[]\n', 'utf8');

  assert.match(captureStderr(() => loadState(workspace)).stderr, /Ignoring unreadable state file/);
  captureStderr(() => setConfig(workspace, 'stopReviewGate', true));
  const [copy] = corruptCopies(workspace);
  assert.ok(copy);
  assert.equal(fs.readFileSync(copy, 'utf8'), '[]\n');
});

test('withFileLock keeps the work errors apart from contention and runs the work once', () => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, 'file.lock');
  let calls = 0;
  const exists = Object.assign(new Error('the work hit an existing file'), { code: 'EEXIST' });
  assert.throws(
    () =>
      withFileLock(lockPath, () => {
        calls += 1;
        throw exists;
      }),
    (error: unknown) => error === exists,
  );
  assert.equal(calls, 1, 'an EEXIST from the work is not lock contention');
  assert.equal(fs.existsSync(lockPath), false, 'the lock is released');

  // A holder whose lock was taken over meanwhile leaves its successor's lock.
  withFileLock(lockPath, () => {
    fs.writeFileSync(lockPath, '4242 successor-token', 'utf8');
  });
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '4242 successor-token');

  // A lock that cannot be taken in time is a timeout naming the lock.
  assert.throws(
    () => withFileLock(lockPath, () => 'never', { attempts: 2 }),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        `Timed out waiting for the lock ${lockPath}. If no Stereo process holds it, delete it and retry.`,
  );
  // With the unlocked fallback the work runs anyway, holding nothing.
  assert.equal(
    withFileLock(lockPath, () => 'unlocked', { attempts: 2, unlockedFallback: true }),
    'unlocked',
  );
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '4242 successor-token', 'the holder keeps it');
});

test('withFileLock holds its lock exclusively while the work runs', () => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, 'file.lock');
  const inner = withFileLock(lockPath, () => {
    assert.match(fs.readFileSync(lockPath, 'utf8'), new RegExp(`^${process.pid} [0-9a-f-]{36}$`));
    // A fresh lock is waited on, whoever holds it: no second holder.
    assert.throws(
      () => withFileLock(lockPath, () => 'never', { attempts: 3 }),
      /Timed out waiting for the lock/,
    );
    return 'held';
  });
  assert.equal(inner, 'held');
  assert.deepEqual(fs.readdirSync(dir), [], 'released, nothing left behind');
});

test('a stale lock is taken over by its age alone, and only while it holds what was read', (t) => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, 'file.lock');
  const old = new Date(Date.now() - 60_000);
  const writeStale = (contents: string, mtime: Date = old): void => {
    fs.writeFileSync(lockPath, contents, 'utf8');
    fs.utimesSync(lockPath, mtime, mtime);
  };

  // Older than staleMs: taken over, even though the pid it names (this live
  // process) still runs; the pid is informational.
  writeStale(`${process.pid} slow-holder`, new Date(Date.now() - 10_000));
  assert.equal(
    withFileLock(lockPath, () => 'taken', { attempts: 3 }),
    'taken',
  );
  assert.equal(fs.existsSync(lockPath), false);

  // Between the read and the removal a successor replaced the stale lock:
  // the re-read sees other contents, so the successor's lock is never deleted.
  const successor = '4242 successor-token';
  writeStale('2147483641 stale-holder');
  const originalStat = fs.statSync;
  let raced = false;
  t.mock.method(fs, 'statSync', ((target: fs.PathLike, options?: fs.StatSyncOptions) => {
    if (!raced && String(target) === lockPath) {
      raced = true;
      writeStale(successor);
    }
    return originalStat(target, options);
  }) as typeof fs.statSync);
  const unlinkSync = t.mock.method(fs, 'unlinkSync');
  assert.throws(
    () => withFileLock(lockPath, () => 'never', { attempts: 1 }),
    /Timed out waiting for the lock/,
  );
  t.mock.restoreAll();
  assert.equal(raced, true);
  assert.equal(unlinkSync.mock.callCount(), 0, 'nothing was removed');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), successor, 'the successor keeps its lock');
  fs.rmSync(lockPath);
});

test('a held lock that cannot be read is never taken over, and each retry sleeps', (t) => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, 'file.lock');
  // Stale: readable, it would be taken over.
  fs.writeFileSync(lockPath, '2147483646 dead-holder', 'utf8');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', ((file: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(file) === lockPath) {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    }
    return originalRead(file, options as Parameters<typeof fs.readFileSync>[1]);
  }) as typeof fs.readFileSync);
  const startedAt = Date.now();
  assert.throws(
    () => withFileLock(lockPath, () => 'never', { attempts: 4 }),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        `Timed out waiting for the lock ${lockPath}. If no Stereo process holds it, delete it and retry.`,
  );
  t.mock.restoreAll();
  assert.ok(Date.now() - startedAt >= 40, 'every attempt slept before the next');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '2147483646 dead-holder', 'never taken over');
});

test('a release that fails for a moment is retried, and the lock ends up free', (t) => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, 'file.lock');
  const originalUnlink = fs.unlinkSync;
  let failures = 0;
  t.mock.method(fs, 'unlinkSync', (target: fs.PathLike) => {
    if (String(target) === lockPath && failures < 2) {
      failures += 1;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return originalUnlink(target);
  });
  assert.equal(
    withFileLock(lockPath, () => 'done', { attempts: 2 }),
    'done',
  );
  t.mock.restoreAll();
  assert.equal(failures, 2, 'the release failed twice before it went through');
  assert.deepEqual(fs.readdirSync(dir), [], 'no lock is left');
});

test('the tolerant JSON reader reports missing, unreadable, and parsed records', () => {
  const dir = makeTempDir();
  assert.deepEqual(readJsonFileTolerant(path.join(dir, 'absent.json')), {
    missing: true,
    record: null,
    parseError: null,
  });
  fs.writeFileSync(path.join(dir, 'torn.json'), '{"a":', 'utf8');
  const torn = readJsonFileTolerant(path.join(dir, 'torn.json'));
  assert.equal(torn.missing, false);
  assert.equal(torn.record, null);
  assert.equal(typeof torn.parseError, 'string');
  fs.writeFileSync(path.join(dir, 'ok.json'), '{"a":1}', 'utf8');
  assert.deepEqual(readJsonFileTolerant(path.join(dir, 'ok.json')), {
    missing: false,
    record: { a: 1 },
    parseError: null,
  });

  const workspace = makeTempDir();
  fs.writeFileSync(resolveJobFile(workspace, 'job-array'), '[1, 2]', 'utf8');
  assert.equal(readStoredJobOrNull(workspace, 'job-array'), null, 'a non-object is no record');
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir } from './helpers.ts';
import { loadBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import { buildSingleJobSnapshot } from '../plugins/stereo/src/jobs/job-control.ts';
import {
  clearImplementState,
  clearPairPlanState,
  DEFAULT_PLAN_SLOT,
  fingerprintPlanText,
  listPairPlanSlots,
  loadImplementState,
  loadState,
  loadPairPlanState,
  normalizePlanSlot,
  planSlotOrDefault,
  resolveDurableStateDir,
  resolveJobFile,
  resolveJobLogFile,
  resolveImplementStateFile,
  resolvePairPlanFile,
  resolvePairPlanMarkdownFile,
  resolveStateDir,
  resolveStateFile,
  savePairPlanState,
  saveImplementState,
  saveState,
  upsertJob,
  writeTextAtomic,
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

  saveState(workspace, loaded);
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
  assert.deepEqual(loadImplementState(workspace), record);
  assert.deepEqual(clearImplementState(workspace), [statePath]);
  assert.equal(loadImplementState(workspace), null);
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
  const state = saveState(workspace, {
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

test('saveState preserves a concurrently written terminal row over a stale running snapshot', () => {
  const workspace = makeTempDir();
  saveState(workspace, {
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
  saveState(workspace, {
    jobs: [
      {
        id: 'job-race',
        status: 'completed',
        phase: 'done',
        updatedAt: '2026-01-01T00:01:00.000Z',
      },
    ],
  });

  saveState(workspace, stale);

  const row = loadState(workspace).jobs.find((job) => job.id === 'job-race');
  assert.equal(row?.status, 'completed');
  assert.equal(row?.phase, 'done');
});

test('saveState treats terminal status as absorbing even when a running candidate is newer', () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    jobs: [
      {
        id: 'job-absorbing',
        status: 'failed',
        errorMessage: 'terminal truth',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });

  saveState(workspace, {
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

test("saveState keeps the caller's newer row and another writer's newer unrelated row", () => {
  const workspace = makeTempDir();
  saveState(workspace, {
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

  saveState(workspace, {
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

  saveState(workspace, callerSnapshot);

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

test('saveState retains an unsafe indexed id without resolving or deleting its artifacts', () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
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

  assert.doesNotThrow(() => saveState(workspace, { jobs: [] }));
  assert.equal(loadState(workspace).jobs[0]?.id, '../escape');
  assert.equal(fs.readFileSync(escapedJobFile, 'utf8'), 'sentinel job bytes\n');
  assert.equal(fs.readFileSync(escapedLogFile, 'utf8'), 'sentinel log bytes\n');
});

test('saveState prunes dropped job artifacts when indexed jobs exceed the cap', () => {
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

  saveState(workspace, {
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

test("saveState keeps a live job's artifacts and index entry when dropped by a stale snapshot", () => {
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
  saveState(workspace, {
    version: 1,
    config: {},
    jobs: [{ id: 'job-live', status: 'running', logFile, updatedAt: '2026-01-02T00:00:00.000Z' }],
  });

  // ...but a concurrent writer saves a stale snapshot that omits it.
  saveState(workspace, { version: 1, config: {}, jobs: [] });

  assert.equal(fs.existsSync(jobFile), true);
  assert.equal(fs.existsSync(logFile), true);
  const jobs = loadState(workspace).jobs;
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0]);
  assert.equal(jobs[0].id, 'job-live');
  assert.equal(jobs[0].status, 'running');
  assert.equal('request' in jobs[0], false);
});

test('saveState still deletes terminal jobs dropped from the snapshot', () => {
  const workspace = makeTempDir();
  const jobFile = resolveJobFile(workspace, 'job-done');
  const logFile = resolveJobLogFile(workspace, 'job-done');
  fs.writeFileSync(logFile, 'done\n', 'utf8');
  fs.writeFileSync(
    jobFile,
    `${JSON.stringify({ id: 'job-done', status: 'completed', logFile, updatedAt: '2026-01-02T00:00:00.000Z' }, null, 2)}\n`,
    'utf8',
  );
  saveState(workspace, {
    version: 1,
    config: {},
    jobs: [{ id: 'job-done', status: 'completed', logFile, updatedAt: '2026-01-02T00:00:00.000Z' }],
  });

  saveState(workspace, { version: 1, config: {}, jobs: [] });

  assert.equal(fs.existsSync(jobFile), false);
  assert.equal(fs.existsSync(logFile), false);
  assert.equal(loadState(workspace).jobs.length, 0);
});

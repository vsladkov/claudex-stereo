import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.ts";
import {
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  upsertJob
} from "../plugins/stereo/src/workspace/state.ts";
import type { JobRecord } from "../plugins/stereo/src/workspace/state.ts";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("state index strips request payloads from legacy, updated, and new jobs", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const legacyJobs = [
    {
      id: "legacy-plan",
      status: "completed",
      summary: "Legacy plan review",
      request: { kind: "plan-review", plan: "large legacy plan" },
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    {
      id: "legacy-task",
      status: "completed",
      summary: "Legacy task",
      request: { prompt: "large legacy task" },
      updatedAt: "2026-01-02T00:00:00.000Z"
    },
    {
      id: "unrelated-job",
      status: "running",
      phase: "starting",
      updatedAt: "2026-01-03T00:00:00.000Z"
    }
  ];

  for (const job of legacyJobs.slice(0, 2)) {
    fs.writeFileSync(resolveJobFile(workspace, job.id), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  }
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: legacyJobs }, null, 2)}\n`,
    "utf8"
  );

  const loaded = loadState(workspace);
  assert.equal(loaded.jobs.every((job) => !Object.hasOwn(job, "request")), true);

  upsertJob(workspace, {
    id: "unrelated-job",
    phase: "investigating"
  });

  const persistedAfterUpdate = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(persistedAfterUpdate.jobs.every((job: JobRecord) => !Object.hasOwn(job, "request")), true);
  assert.equal(
    persistedAfterUpdate.jobs.find((job: JobRecord) => job.id === "unrelated-job").phase,
    "investigating"
  );
  for (const job of legacyJobs.slice(0, 2)) {
    const storedJob = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
    assert.deepEqual(storedJob.request, job.request);
  }

  upsertJob(workspace, {
    id: "new-request-job",
    status: "queued",
    request: { prompt: "new large task" }
  });

  const persistedAfterInsert = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(persistedAfterInsert.jobs.every((job: JobRecord) => !Object.hasOwn(job, "request")), true);
  assert.equal(loadState(workspace).jobs.every((job) => !Object.hasOwn(job, "request")), true);
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job: JobRecord) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("saveState keeps a live job's artifacts and index entry when dropped by a stale snapshot", () => {
  const workspace = makeTempDir();
  const jobFile = resolveJobFile(workspace, "job-live");
  const logFile = resolveJobLogFile(workspace, "job-live");
  fs.writeFileSync(logFile, "running\n", "utf8");
  fs.writeFileSync(
    jobFile,
    `${JSON.stringify({ id: "job-live", status: "running", logFile, request: { kind: "task", prompt: "big" }, updatedAt: "2026-01-02T00:00:00.000Z" }, null, 2)}\n`,
    "utf8"
  );
  // The on-disk index knows about the live job...
  saveState(workspace, {
    version: 1,
    config: {},
    jobs: [{ id: "job-live", status: "running", logFile, updatedAt: "2026-01-02T00:00:00.000Z" }]
  });

  // ...but a concurrent writer saves a stale snapshot that omits it.
  saveState(workspace, { version: 1, config: {}, jobs: [] });

  assert.equal(fs.existsSync(jobFile), true);
  assert.equal(fs.existsSync(logFile), true);
  const jobs = loadState(workspace).jobs;
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0]);
  assert.equal(jobs[0].id, "job-live");
  assert.equal(jobs[0].status, "running");
  assert.equal("request" in jobs[0], false);
});

test("saveState still deletes terminal jobs dropped from the snapshot", () => {
  const workspace = makeTempDir();
  const jobFile = resolveJobFile(workspace, "job-done");
  const logFile = resolveJobLogFile(workspace, "job-done");
  fs.writeFileSync(logFile, "done\n", "utf8");
  fs.writeFileSync(
    jobFile,
    `${JSON.stringify({ id: "job-done", status: "completed", logFile, updatedAt: "2026-01-02T00:00:00.000Z" }, null, 2)}\n`,
    "utf8"
  );
  saveState(workspace, {
    version: 1,
    config: {},
    jobs: [{ id: "job-done", status: "completed", logFile, updatedAt: "2026-01-02T00:00:00.000Z" }]
  });

  saveState(workspace, { version: 1, config: {}, jobs: [] });

  assert.equal(fs.existsSync(jobFile), false);
  assert.equal(fs.existsSync(logFile), false);
  assert.equal(loadState(workspace).jobs.length, 0);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { makeTempDir } from "./helpers.ts";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  enrichJob,
  filterJobsForCurrentSession,
  readJobProgressPreview,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "../plugins/stereo/scripts/lib/job-control.mjs";
import { saveState } from "../plugins/stereo/scripts/lib/state.mjs";

const DEAD_PID = 2147483647;
const IS_WINDOWS = process.platform === "win32";

function useTempCodexHome(t) {
  const previous = process.env.CODEX_HOME;
  const codexHome = makeTempDir("codex-home-");
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
  });
  return codexHome;
}

function seedJobs(workspace, jobs) {
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });
}

function jobAt(id, minute, patch = {}) {
  const stamp = `2026-03-18T15:${String(minute).padStart(2, "0")}:00.000Z`;
  return {
    id,
    status: "completed",
    title: `Job ${id}`,
    sessionId: "sess-current",
    createdAt: stamp,
    updatedAt: stamp,
    ...patch
  };
}

test("sortJobsNewestFirst orders by updatedAt descending", () => {
  const sorted = sortJobsNewestFirst([jobAt("old", 1), jobAt("new", 30), jobAt("mid", 15)]);
  assert.deepEqual(
    sorted.map((job) => job.id),
    ["new", "mid", "old"]
  );
});

test("filterJobsForCurrentSession prefers an explicit session id", () => {
  const jobs = [jobAt("a", 1, { sessionId: "sess-a" }), jobAt("b", 2, { sessionId: "sess-b" })];
  assert.deepEqual(
    filterJobsForCurrentSession(jobs, { sessionId: "sess-b" }).map((job) => job.id),
    ["b"]
  );
  assert.equal(filterJobsForCurrentSession(jobs, {}).length >= 1, true);
});

test("resolveResultJob reports a referenced running job as still running", (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  seedJobs(workspace, [
    jobAt("task-running", 10, { status: "running", pid: process.pid }),
    jobAt("task-finished", 5)
  ]);

  const resolved = resolveResultJob(workspace, "task-finished");
  assert.equal(resolved.job.id, "task-finished");

  assert.throws(() => resolveResultJob(workspace, "task-running"), /still running/);
  assert.throws(() => resolveResultJob(workspace, "task-nonexistent"), /No finished job found/);
});

test("resolveResultJob rejects ambiguous prefixes", (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  seedJobs(workspace, [jobAt("task-abc", 1), jobAt("task-abd", 2)]);

  assert.throws(() => resolveResultJob(workspace, "task-ab"), /ambiguous/);
  assert.equal(resolveResultJob(workspace, "task-abc").job.id, "task-abc");
});

test("resolveCancelableJob reports missing and inactive references distinctly", (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  seedJobs(workspace, [
    jobAt("task-finished", 5),
    jobAt("task-running", 10, { status: "running", pid: process.pid, sessionId: "sess-current" })
  ]);

  assert.equal(resolveCancelableJob(workspace, "task-running").job.id, "task-running");
  assert.throws(() => resolveCancelableJob(workspace, "task-finished"), /No active job found for "task-finished"/);

  seedJobs(workspace, [jobAt("task-finished", 5)]);
  assert.throws(() => resolveCancelableJob(workspace, "", { env: {} }), /No active Codex jobs to cancel/);
});

test("buildStatusSnapshot keeps recent finished jobs when many jobs are active", (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  const active = [1, 2, 3].map((n) => jobAt(`running-${n}`, 40 + n, { status: "running", pid: process.pid }));
  const finished = [...Array(10).keys()].map((n) => jobAt(`finished-${n}`, 30 - n));
  seedJobs(workspace, [...active, ...finished]);

  const snapshot = buildStatusSnapshot(workspace, { env: { CODEX_COMPANION_SESSION_ID: "sess-current" } });
  assert.equal(snapshot.running.length, 3);
  assert.equal(snapshot.latestFinished.id, "finished-0");
  // Active jobs must not consume the recent budget: 8 finished jobs beyond the
  // latest one are still listed.
  assert.equal(snapshot.recent.length, 8);
  assert.deepEqual(
    snapshot.recent.map((job) => job.id),
    [...Array(8).keys()].map((n) => `finished-${n + 1}`)
  );
});

test("buildSingleJobSnapshot reports unknown references with its own message", (t) => {
  useTempCodexHome(t);
  const workspace = makeTempDir();
  seedJobs(workspace, [jobAt("task-known", 1)]);

  assert.equal(buildSingleJobSnapshot(workspace, "task-known").job.id, "task-known");
  assert.throws(() => buildSingleJobSnapshot(workspace, "task-unknown"), /No job found for "task-unknown"/);
});

test("enrichJob marks running jobs with dead pids as stalled", { skip: IS_WINDOWS }, () => {
  const stalled = enrichJob(jobAt("task-stalled", 1, { status: "running", pid: DEAD_PID }));
  assert.equal(stalled.phase, "stalled");

  const alive = enrichJob(jobAt("task-alive", 2, { status: "running", pid: process.pid }));
  assert.notEqual(alive.phase, "stalled");

  const noPid = enrichJob(jobAt("task-nopid", 3, { status: "running" }));
  assert.notEqual(noPid.phase, "stalled");

  const finished = enrichJob(jobAt("task-done", 4, { status: "completed", pid: DEAD_PID }));
  assert.notEqual(finished.phase, "stalled");
});

test("readJobProgressPreview tails large logs without losing recent lines", () => {
  const dir = makeTempDir();
  const logFile = path.join(dir, "job.log");
  const filler = `[2026-03-18T15:00:00.000Z] filler line ${"x".repeat(80)}\n`;
  const lines = [];
  while (lines.length * filler.length < 96 * 1024) {
    lines.push(filler);
  }
  lines.push("[2026-03-18T15:59:00.000Z] penultimate marker\n");
  lines.push("[2026-03-18T16:00:00.000Z] final marker\n");
  fs.writeFileSync(logFile, lines.join(""), "utf8");

  const preview = readJobProgressPreview(logFile, 2);
  assert.deepEqual(preview, ["penultimate marker", "final marker"]);
});

test("readJobProgressPreview drops a partial multi-byte character at the tail cut", () => {
  const dir = makeTempDir();
  const logFile = path.join(dir, "job.log");
  const markers = "[2026-03-18T15:59:00.000Z] penultimate marker\n[2026-03-18T16:00:00.000Z] final marker\n";
  // One huge line of 2-byte characters so the 64KB window boundary lands
  // inside it; force the cut to an odd byte offset so it splits a character.
  let content = `[2026-03-18T15:00:00.000Z] head\n${"é".repeat(60000)}\n`;
  const tailBytes = 64 * 1024;
  if ((Buffer.byteLength(content + markers, "utf8") - tailBytes) % 2 === 0) {
    content = `x${content}`;
  }
  fs.writeFileSync(logFile, content + markers, "utf8");
  assert.equal(Buffer.byteLength(content + markers, "utf8") > tailBytes, true);

  const preview = readJobProgressPreview(logFile, 4);
  assert.deepEqual(preview, ["penultimate marker", "final marker"]);
  assert.equal(preview.some((line) => line.includes("�")), false);
});

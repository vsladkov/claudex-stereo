import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import test, { afterEach } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.ts";
import { drainCreatedTempDirs, initGitRepo, makeTempDir, run } from "./helpers.ts";
import { reapWorkspaceBroker } from "./broker-reaper.ts";
import { terminateProcessTree } from "../plugins/stereo/src/platform/process.ts";
import { parseBrokerEndpoint } from "../plugins/stereo/src/broker/endpoint.ts";
import {
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  sendBrokerShutdown,
  spawnBrokerProcess,
  waitForBrokerEndpoint
} from "../plugins/stereo/src/broker/lifecycle.ts";
import type { BrokerSession } from "../plugins/stereo/src/broker/lifecycle.ts";
import {
  acquireThreadReservation,
  releaseThreadReservation
} from "../plugins/stereo/src/runtime/index.ts";
import { resolveStateDir } from "../plugins/stereo/src/workspace/state.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function processIsAlive(pid: number | null | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Every workspace this file created gets its broker reaped after each test:
// the companion CLI auto-starts a detached broker per workspace, and without
// a SessionEnd there is nothing else to stop it (one unswept full run used
// to strand ~40 broker processes).
afterEach(async () => {
  for (const dir of drainCreatedTempDirs()) {
    await reapWorkspaceBroker(dir);
  }
});

const PLUGIN_ROOT = path.join(ROOT, "plugins", "stereo");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.ts");
const BROKER_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "app-server-broker.ts");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.ts");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.ts");

async function waitFor<T>(
  predicate: () => T | Promise<T>,
  { timeoutMs = 5000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<NonNullable<Awaited<T>>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function withCodexHome<T>(codexHome: string, fn: () => T): T {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
  }
}

function brokerEndpointConnectable(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ path: parseBrokerEndpoint(endpoint).path });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

interface NodeRunOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runNodeWithTimeout(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<NodeRunOutcome> {
  return new Promise<NodeRunOutcome>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 5000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        status: code,
        signal,
        stdout,
        stderr,
        timedOut
      });
    });
  });
}

function readFakeState(binDir: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT" || error instanceof SyntaxError) {
      return {};
    }
    throw error;
  }
}

test("readFakeState treats missing and partially written fixture state as not ready", async () => {
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  let pollCount = 0;

  assert.deepEqual(readFakeState(binDir), {});
  fs.writeFileSync(statePath, "{", "utf8");
  assert.deepEqual(readFakeState(binDir), {});
  setTimeout(
    () => fs.writeFileSync(statePath, `${JSON.stringify({ turnStarts: [{ threadId: "thr_ready" }] })}\n`, "utf8"),
    20
  );

  const state = await waitFor(() => {
    pollCount += 1;
    const current = readFakeState(binDir);
    return current.turnStarts?.length ? current : null;
  }, { timeoutMs: 1000, intervalMs: 5 });

  assert.equal(state.turnStarts[0].threadId, "thr_ready");
  assert.equal(pollCount > 1, true);
});

interface CompanionStateFile {
  jobs: Array<Record<string, any>>;
  [key: string]: any;
}

function readCompanionState(cwd: string): CompanionStateFile {
  return JSON.parse(fs.readFileSync(path.join(resolveStateDir(cwd), "state.json"), "utf8"));
}

function readJobLog(cwd: string, jobId: string): string {
  const state = readCompanionState(cwd);
  const job = state.jobs.find((candidate) => candidate.id === jobId);
  assert.ok(job, `Expected job ${jobId} in companion state.`);
  return fs.readFileSync(job.logFile, "utf8");
}

function findThreadReservation(
  codexHome: string,
  threadId: string
): { path: string; record: Record<string, any> } | null {
  const lockDir = path.join(codexHome, "companion-thread-locks");
  if (!fs.existsSync(lockDir)) {
    return null;
  }
  for (const entry of fs.readdirSync(lockDir)) {
    if (!entry.endsWith(".lock")) {
      continue;
    }
    const lockPath = path.join(lockDir, entry);
    const record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (record.threadId === threadId) {
      return { path: lockPath, record };
    }
  }
  return null;
}

function initializeBasicRepo(): string {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function registerSessionCleanup(t: TestContext, cwd: string, env: NodeJS.ProcessEnv): void {
  t.after(() => {
    run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
      cwd,
      env,
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        cwd
      })
    });
  });
}

test("setup reports ready when fake codex is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.codex.detail, /advanced runtime available/);
  assert.equal(payload.sessionRuntime.mode, "direct");
  if (process.platform !== "win32") {
    assert.equal(payload.writeSandbox.available, true);
  }
});

test("setup and status surface stranded thread reservations on every route", (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  const jobId = "reservation-status-job";
  const logFile = path.join(jobsDir, `${jobId}.log`);
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(logFile, "[2026-07-20T12:00:00.000Z] Waiting for status poll\n", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Reservation visibility fixture",
            logFile,
            createdAt: "2026-07-20T12:00:00.000Z",
            startedAt: "2026-07-20T12:00:01.000Z",
            updatedAt: "2026-07-20T12:00:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const reservations = withCodexHome(env.CODEX_HOME, () => {
    const dead = acquireThreadReservation("status-dead-thread", {
      jobId: "status-dead-job",
      pid: 2147483647
    });
    const deadCleanup = acquireThreadReservation("status-dead-cleanup-thread", {
      jobId: "status-dead-cleanup-job",
      pid: 2147483647
    });
    fs.writeFileSync(
      deadCleanup.cleanupPath,
      `${JSON.stringify({
        pid: 2147483647,
        jobId: "status-dead-cleanup-job",
        createdAt: "2026-07-20T12:00:00.000Z"
      })}\n`,
      "utf8"
    );
    const liveOwner = acquireThreadReservation("status-live-owner-thread", {
      jobId: "status-live-owner-job",
      pid: process.pid
    });
    fs.writeFileSync(
      liveOwner.cleanupPath,
      `${JSON.stringify({
        pid: 2147483647,
        jobId: "status-orphaned-claim-job",
        createdAt: "2026-07-20T12:00:00.000Z"
      })}\n`,
      "utf8"
    );
    return { dead, deadCleanup, liveOwner };
  });

  t.after(() => {
    for (const target of [
      reservations.dead.path,
      reservations.dead.cleanupPath,
      reservations.deadCleanup.path,
      reservations.deadCleanup.cleanupPath,
      reservations.liveOwner.cleanupPath
    ]) {
      try {
        fs.unlinkSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    releaseThreadReservation(reservations.liveOwner);
  });

  const setupJson = run(process.execPath, [SCRIPT, "setup", "--json"], { cwd: repo, env });
  assert.equal(setupJson.status, 0, setupJson.stderr);
  assert.ok(setupJson.stdout.trim(), JSON.stringify(setupJson));
  const setupPayload = JSON.parse(setupJson.stdout);
  assert.equal(setupPayload.strandedReservations.length, 3);
  const cleanupEntry = setupPayload.strandedReservations.find(
    (entry: Record<string, any>) => entry.kind === "stranded-cleanup"
  );
  const claimEntry = setupPayload.strandedReservations.find(
    (entry: Record<string, any>) => entry.kind === "orphaned-claim"
  );
  assert.ok(cleanupEntry);
  assert.ok(claimEntry);

  const cleanupStep = setupPayload.nextSteps.find(
    (step: string) => step.includes(`\`${reservations.deadCleanup.path}\``)
  );
  assert.ok(cleanupStep);
  assert.ok(cleanupStep.includes(`\`${reservations.deadCleanup.cleanupPath}\``));
  const claimStep = setupPayload.nextSteps.find(
    (step: string) => step.includes(`\`${reservations.liveOwner.cleanupPath}\``)
  );
  assert.ok(claimStep);
  assert.equal(claimStep.includes(`\`${reservations.liveOwner.path}\``), false);

  const renderedSetup = run(process.execPath, [SCRIPT, "setup"], { cwd: repo, env });
  assert.equal(renderedSetup.status, 0, renderedSetup.stderr);
  assert.match(renderedSetup.stdout, /- thread reservations: 3 stranded \(see next steps\)/);

  const aggregateStatus = run(process.execPath, [SCRIPT, "status"], { cwd: repo, env });
  assert.equal(aggregateStatus.status, 0, aggregateStatus.stderr);
  assert.match(aggregateStatus.stdout, /Warnings:/);
  assert.ok(aggregateStatus.stdout.includes(`\`${reservations.dead.path}\``));
  assert.ok(aggregateStatus.stdout.includes(`\`${reservations.deadCleanup.cleanupPath}\``));
  assert.ok(aggregateStatus.stdout.includes(`\`${reservations.liveOwner.cleanupPath}\``));
  assert.equal(aggregateStatus.stdout.includes(`\`${reservations.liveOwner.path}\``), false);

  const referencedStatus = run(process.execPath, [SCRIPT, "status", jobId], { cwd: repo, env });
  assert.equal(referencedStatus.status, 0, referencedStatus.stderr);
  assert.match(referencedStatus.stdout, /# Codex Job Status[\s\S]*Warnings:/);
  assert.ok(referencedStatus.stdout.includes(`\`${reservations.liveOwner.cleanupPath}\``));

  const referencedJson = run(process.execPath, [SCRIPT, "status", jobId, "--json"], { cwd: repo, env });
  assert.equal(referencedJson.status, 0, referencedJson.stderr);
  assert.equal(JSON.parse(referencedJson.stdout).strandedReservations.length, 3);

  const waitedJson = run(
    process.execPath,
    [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "25", "--json"],
    { cwd: repo, env }
  );
  assert.equal(waitedJson.status, 0, waitedJson.stderr);
  const waitedPayload = JSON.parse(waitedJson.stdout);
  assert.equal(waitedPayload.waitTimedOut, true);
  assert.equal(waitedPayload.strandedReservations.length, 3);

  for (const target of [
    reservations.dead.path,
    reservations.deadCleanup.path,
    reservations.deadCleanup.cleanupPath,
    reservations.liveOwner.cleanupPath
  ]) {
    fs.unlinkSync(target);
  }

  const clearedSetup = run(process.execPath, [SCRIPT, "setup"], { cwd: repo, env });
  assert.equal(clearedSetup.status, 0, clearedSetup.stderr);
  assert.match(clearedSetup.stdout, /- thread reservations: none stranded/);

  const clearedAggregate = run(process.execPath, [SCRIPT, "status"], { cwd: repo, env });
  assert.equal(clearedAggregate.status, 0, clearedAggregate.stderr);
  assert.doesNotMatch(clearedAggregate.stdout, /Warnings:/);
  const clearedReferenced = run(process.execPath, [SCRIPT, "status", jobId], { cwd: repo, env });
  assert.equal(clearedReferenced.status, 0, clearedReferenced.stderr);
  assert.doesNotMatch(clearedReferenced.stdout, /Warnings:/);
});

test("setup reports a blocked write sandbox", { skip: process.platform === "win32" }, () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "sandbox-blocked");
  const env = buildEnv(binDir);

  const jsonResult = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env
  });

  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const payload = JSON.parse(jsonResult.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.writeSandbox.available, false);
  assert.match(payload.writeSandbox.detail, /bwrap/);
  assert.equal(payload.nextSteps.some((step: string) => /task --write|\/stereo:implement/.test(step)), true);

  const renderedResult = run("node", [SCRIPT, "setup"], {
    cwd: ROOT,
    env
  });
  assert.equal(renderedResult.status, 0, renderedResult.stderr);
  assert.match(renderedResult.stdout, /- write sandbox: blocked/);
});

test("setup treats an unsupported sandbox probe as inconclusive", { skip: process.platform === "win32" }, () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "sandbox-unsupported");
  const env = buildEnv(binDir);

  const jsonResult = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env
  });

  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const payload = JSON.parse(jsonResult.stdout);
  assert.equal(payload.writeSandbox.available, null);
  assert.match(payload.writeSandbox.detail, /unsupported/i);
  assert.equal(payload.nextSteps.some((step: string) => /task --write|\/stereo:implement/.test(step)), false);

  const renderedResult = run("node", [SCRIPT, "setup"], {
    cwd: ROOT,
    env
  });
  assert.equal(renderedResult.status, 0, renderedResult.stderr);
  assert.match(renderedResult.stdout, /- write sandbox: .*unsupported/i);
});

test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "api-key-account-only");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, "apiKey");
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /API key configured \(unverified\)/);
});

test("setup is ready when the active provider does not require OpenAI login", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup treats custom providers with app-server-ready config as ready", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "env-key-provider");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup reports not ready when app-server config read fails", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /config\/read failed for cwd/);
});

test("review renders a no-findings result from app-server review/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
});

test("a task-worker bootstrap failure marks the job failed instead of leaving it queued", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-ghost",
            status: "queued",
            title: "Codex Task",
            jobClass: "task",
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  // No per-job file exists, so the worker's bootstrap read fails.
  const result = run("node", [SCRIPT, "task-worker", "--cwd", workspace, "--job-id", "task-ghost"], {
    cwd: workspace
  });

  assert.notEqual(result.status, 0);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const ghost = state.jobs.find((job: Record<string, any>) => job.id === "task-ghost");
  assert.equal(ghost.status, "failed");
  assert.match(ghost.errorMessage, /No stored job found/);
});

test("--json inside prompt text does not switch error output to JSON", () => {
  const repo = makeTempDir();
  initGitRepo(repo);

  // Two argv entries so normalizeArgv keeps them as separate tokens and the
  // prompt text stays a positional (a single raw string would flag-parse it).
  // process.execPath (not PATH-resolved "node"): the stripped PATH exists to
  // hide codex, but must not swap in an older system node that cannot run .ts.
  const result = run(process.execPath, [SCRIPT, "task", "--prompt-file", "does-not-exist.md", "explain the --json flag"], {
    cwd: repo,
    env: { ...process.env, PATH: "/usr/bin:/bin" }
  });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /\{"error"/);
  assert.match(result.stderr, /Could not read --prompt-file/);
});

test("a foreground task with no prompt fast-fails without creating a job record", () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const result = run(process.execPath, [SCRIPT, "task"], { cwd: repo, env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Provide a prompt, a prompt file, piped stdin, or use --resume-last\./);
  // Validation must run before any job exists: the background path already
  // fast-failed here, the foreground path used to leave a failed job behind.
  const statusResult = run(process.execPath, [SCRIPT, "status", "--all", "--json"], { cwd: repo, env });
  assert.equal(statusResult.status, 0, statusResult.stderr);
  const snapshot = JSON.parse(statusResult.stdout);
  assert.deepEqual(snapshot.jobs ?? [], []);
});

test("a pre-parse failure with a real --json flag still emits stdout JSON", () => {
  const result = run("node", [SCRIPT, "definitely-not-a-subcommand", "--json"], {
    cwd: makeTempDir()
  });

  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).error, /./);
});

test("task completes when the turn/start response omits the turn object", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-start-no-turn");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Regression: a start response without turn.id used to buffer every
  // notification forever and hang the capture.
  const result = run("node", [SCRIPT, "task", "finish without a turn id"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task runs when the active provider does not require OpenAI login", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check auth preflight"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task runs without auth preflight so Codex can refresh an expired session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check refreshable auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("transfer delegates the current Claude session directly to native import", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-native-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Native transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/stereo:transfer" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );
  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumeCommand, "codex resume thr_1");
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.sessionId, sessionId);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.threads.length, 1);
  assert.equal(fakeState.threads[0].ephemeral, false);
  assert.equal(fakeState.threads[0].name, "Native transfer");
  assert.equal(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message: Record<string, any>) => message.text),
    ["Initial request", "Initial answer", "/stereo:transfer"]
  );
});

test("transfer reports an actionable upgrade error when native import is unsupported", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-unsupported");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Continue this work." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support Claude session transfer/);
  assert.match(result.stderr, /@openai\/codex@latest/);
  assert.match(JSON.parse(result.stdout).error, /does not support Claude session transfer/);
});

test("transfer fails visibly when native import completes without a ledger record", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-fails");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Do not lose this request." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not record an imported thread/);
});

test("transfer rejects sources outside the Claude projects directory", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sourcePath = path.join(home, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
});

test("task reports the actual Codex auth error when the run is rejected", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "auth-run-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check failed auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication expired; run codex login/);
});

test("review accepts the quoted raw argument style for built-in base-branch review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
});

test("adversarial review renders structured findings over app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review accepts the same base-branch targeting as review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Branch review against main|against main/i);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review asks Codex to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /lightweight summary/i);
  assert.match(state.lastTurnStart.prompt, /read-only git commands/i);
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test("review includes reasoning output when the app server returns it", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reasoning:/);
  assert.match(result.stdout, /Reviewed the changed files and checked the likely regression paths first|Reviewed the changed files and checked the likely regression paths/i);
});

test("review logs reasoning summaries and review output to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  assert.match(log, /Review output/);
  assert.match(log, /Reviewed uncommitted changes\./);
});

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
});

test("task-resume-candidate returns the latest rescue thread from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

test("task --resume-last ignores running tasks from other Claude sessions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other-running",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Other session active task",
            updatedAt: "2026-03-24T20:05:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
});

test("session start hook exports the Claude session id, transcript path, and plugin data dir", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export CODEX_COMPANION_SESSION_ID='sess-current'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

test("write task output focuses on the Codex result without generic follow-up hints", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Handled the requested task.\nTask prompt accepted.\n\nNote: this write-capable run reported no file changes.\n"
  );
});

test("task --resume acts like --resume-last without leaking the flag into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("task --fresh is treated as routing control and does not leak into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");
});

test("task forwards model selection and reasoning effort to app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--model", "spark", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastTurnStart.effort, "low");

  const maxResult = run(
    "node",
    [SCRIPT, "task", "--model", "spark", "--effort", "max", "investigate the parser regression"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(maxResult.status, 0, maxResult.stderr);
  const maxState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(maxState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(maxState.lastTurnStart.effort, "max");
});

test("task logs reasoning summaries and assistant messages to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task logs subagent reasoning and messages with a subagent prefix", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger reasoning:/);
  assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  assert.match(log, /Subagent design-challenger:/);
  assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./
  );
});

test("task waits for the main thread to complete before returning the final result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task ignores later subagent messages when choosing the final returned output", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-late-subagent-message");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task can finish after subagent work even if the parent turn/completed event is missing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task using the shared broker still completes when Codex spawns subagents", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

test("review rejects focus text because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status! > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /\/stereo:adversarial-review focus on auth/i);
});

test("review rejects staged-only scope because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status! > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("adversarial review rejects staged-only scope to match review target selection", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status! > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review accepts --background while still running as a tracked review job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.review, "Review");
  assert.match(launchPayload.codex.stdout, /No material issues found/);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Codex Status/);
  assert.match(status.stdout, /Codex Review/);
  assert.match(status.stdout, /completed/);
});

test("status shows phases, hints, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-live.log");
  const progressMessages = [
    "Starting Codex Review.",
    "Thread ready (thr_1).",
    "Turn started (turn_1).",
    "Searching: status implementation",
    "Running command: npm test",
    "Reviewer started: current changes"
  ];
  fs.writeFileSync(
    logFile,
    progressMessages.map((message, index) => `[2026-03-18T15:30:0${index}.000Z] ${message}`).join("\n"),
    "utf8"
  );

  const finishedLogFile = path.join(jobsDir, "review-done.log");
  fs.writeFileSync(finishedLogFile, "[2026-03-18T15:11:10.000Z] Review output\n", "utf8");
  const finishedJobFile = path.join(jobsDir, "review-done.json");
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: "review-done",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-live",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_1",
            summary: "Review working tree diff",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_done",
            summary: "Review main...HEAD",
            logFile: finishedLogFile,
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(result.stdout, /\| Job \| Kind \| Status \| Phase \| Elapsed \| Codex Session ID \| Summary \| Actions \|/);
  assert.match(result.stdout, /\| review-live \| review \| running \| reviewing \| .* \| thr_1 \| Review working tree diff \|/);
  assert.match(result.stdout, /`\/stereo:status review-live`<br>`\/stereo:cancel review-live`/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Session runtime: direct startup/);
  // Non-verbose output is the documented compact shape: the table carries the
  // running job; Live details and Progress blocks are verbose-only.
  assert.doesNotMatch(result.stdout, /Live details:/);
  assert.doesNotMatch(result.stdout, /Progress:/);
  for (const message of progressMessages) {
    assert.equal(result.stdout.includes(message), false);
  }
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /Codex session ID: thr_done/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_done/);
  assert.doesNotMatch(result.stdout, /  (?:Created|Started|Completed):/);
  assert.equal(result.stdout.includes(finishedLogFile), false);

  const verboseResult = run("node", [SCRIPT, "status", "--verbose"], {
    cwd: workspace
  });

  assert.equal(verboseResult.status, 0, verboseResult.stderr);
  assert.match(verboseResult.stdout, /Live details:/);
  assert.match(verboseResult.stdout, /Progress:/);
  assert.match(verboseResult.stdout, /Phase: reviewing/);
  assert.match(verboseResult.stdout, /Codex session ID: thr_1/);
  assert.match(verboseResult.stdout, /Resume in Codex: codex resume thr_1/);
  for (const message of progressMessages) {
    assert.equal(verboseResult.stdout.includes(message), true);
  }
  assert.match(verboseResult.stdout, /  Created: 2026-03-18T15:30:00\.000Z/);
  assert.match(verboseResult.stdout, /  Completed: 2026-03-18T15:11:10\.000Z/);
  assert.equal(verboseResult.stdout.includes(finishedLogFile), true);

  const verboseJsonResult = run("node", [SCRIPT, "status", "--verbose", "--json"], {
    cwd: workspace
  });

  assert.equal(verboseJsonResult.status, 0, verboseJsonResult.stderr);
  const verbosePayload = JSON.parse(verboseJsonResult.stdout);
  assert.equal(verbosePayload.running[0].progressPreview.length, 6);

  const singleRunningResult = run("node", [SCRIPT, "status", "review-live", "--verbose"], {
    cwd: workspace
  });

  assert.equal(singleRunningResult.status, 0, singleRunningResult.stderr);
  for (const message of progressMessages) {
    assert.equal(singleRunningResult.stdout.includes(message), true);
  }
  assert.match(singleRunningResult.stdout, /  Created: 2026-03-18T15:30:00\.000Z/);
  assert.match(singleRunningResult.stdout, /  Started: 2026-03-18T15:30:01\.000Z/);

  const waitResult = run(
    "node",
    [SCRIPT, "status", "review-live", "--verbose", "--wait", "--timeout-ms", "25", "--json"],
    { cwd: workspace }
  );

  assert.equal(waitResult.status, 0, waitResult.stderr);
  const waitPayload = JSON.parse(waitResult.stdout);
  assert.equal(waitPayload.waitTimedOut, true);
  assert.equal(waitPayload.job.progressPreview.length, 6);

  const singleCompletedResult = run("node", [SCRIPT, "status", "review-done", "--verbose"], {
    cwd: workspace
  });

  assert.equal(singleCompletedResult.status, 0, singleCompletedResult.stderr);
  assert.match(singleCompletedResult.stdout, /  Completed: 2026-03-18T15:11:10\.000Z/);

  const aliasResult = run("node", [SCRIPT, "status", "-v"], {
    cwd: workspace
  });

  assert.equal(aliasResult.status, 0, aliasResult.stderr);
  assert.match(aliasResult.stdout, /  Created: 2026-03-18T15:30:00\.000Z/);
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            logFile: currentLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-other",
            kind: "review",
            kindLabel: "review",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Previous session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            startedAt: "2026-03-18T15:20:05.000Z",
            completedAt: "2026-03-18T15:21:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ["review-current"]
  );
});

test("status preserves adversarial review kind labels", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-adv.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-adv-live",
            kind: "adversarial-review",
            status: "running",
            title: "Codex Adversarial Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_adv_live",
            summary: "Adversarial review current changes",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-adv",
            kind: "adversarial-review",
            status: "completed",
            title: "Codex Adversarial Review",
            jobClass: "review",
            threadId: "thr_adv_done",
            summary: "Adversarial review working tree diff",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| review-adv-live \| adversarial-review \| running \| reviewing \|/);
  assert.match(result.stdout, /- review-adv \| completed \| adversarial-review \| Codex Adversarial Review/);
  // The running job's session id lives in the table cell (details are
  // verbose-only); the finished job keeps its detail line.
  assert.match(result.stdout, /\| thr_adv_live \|/);
  assert.match(result.stdout, /Codex session ID: thr_adv_done/);
});

test("status --wait times out cleanly when a job is still active", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("result returns the stored output for the latest finished job by default", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-finished.json"),
    JSON.stringify(
      {
        id: "review-finished",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n",
        result: {
          codex: {
            stdout: "Reviewed uncommitted changes.\nNo material issues found."
          }
        },
        threadId: "thr_review_finished"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-finished",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_review_finished",
            summary: "Review working tree diff",
            createdAt: "2026-03-18T15:00:00.000Z",
            updatedAt: "2026-03-18T15:01:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  // The stored rendering (with its heading) is preferred over raw stdout for
  // review-class jobs.
  assert.equal(
    result.stdout,
    "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n\nCodex session ID: thr_review_finished\nResume in Codex: codex resume thr_review_finished\n"
  );
});

test("result without a job id prefers the latest finished job from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-current.json"),
    JSON.stringify(
      {
        id: "review-current",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_current",
        result: {
          codex: {
            stdout: "Current session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(jobsDir, "review-other.json"),
    JSON.stringify(
      {
        id: "review-other",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_other",
        result: {
          codex: {
            stdout: "Old session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            createdAt: "2026-03-18T15:10:00.000Z",
            updatedAt: "2026-03-18T15:11:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Current session output.\n\nCodex session ID: thr_current\nResume in Codex: codex resume thr_current\n"
  );
});

test("result for a finished write-capable task returns the raw Codex final response", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const taskRun = run("node", [SCRIPT, "task", "--write", "fix the flaky integration test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run("node", [SCRIPT, "result"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(result.stdout, /Note: this write-capable run reported no file changes\./);
  assert.match(result.stdout, /Codex session ID: thr_[a-z0-9]+/i);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_[a-z0-9]+/i);
});

test("cancel stops an active background job and marks it cancelled", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid!, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid!, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            pid: sleeper.pid,
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const cancelResult = run("node", [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(sleeper.pid!, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException | null)?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((job: Record<string, any>) => job.id === "task-live");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

test("cancel without a job id ignores active jobs from other Claude sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run("node", [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active Codex jobs to cancel for this session\./);
  assert.match(JSON.parse(cancel.stdout).error, /No active Codex jobs to cancel for this session\./);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
});

test("cancel with a job id can still target an active job from another Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const cancel = run("node", [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "cancelled");
});

test("cancel sends turn interrupt to the shared app-server before killing a brokered task", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate: Record<string, any>) => candidate.id === jobId);
    if (job?.status === "running" && job.threadId && job.turnId) {
      return job;
    }
    return null;
  }, { timeoutMs: 15000 });

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.turnInterruptAttempted, true);
  assert.equal(cancelPayload.turnInterrupted, true);

  await waitFor(() => {
    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return fakeState.lastInterrupt ?? null;
  });

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: runningJob.threadId,
    turnId: runningJob.turnId
  });

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("session end removes only the ending session's active jobs and preserves finished results", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "review-completed.json");
  const runningJobFile = path.join(jobsDir, "review-running.json");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "review-completed" }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: "review-running" }, null, 2), "utf8");

  t.after(() => {
    try {
      process.kill(-sleeper.pid!, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid!, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-completed",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-current",
            logFile: completedLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          },
          {
            id: "review-running",
            status: "running",
            title: "Codex Review",
            sessionId: "sess-current",
            pid: sleeper.pid,
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-other",
            logFile: otherSessionLog,
            createdAt: "2026-03-18T15:34:00.000Z",
            updatedAt: "2026-03-18T15:35:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);
  // The ending session's finished job keeps its record and log so
  // /stereo:result still works after the session closes.
  assert.equal(fs.existsSync(completedLog), true);
  assert.equal(fs.existsSync(completedJobFile), true);
  assert.deepEqual(
    fs.readdirSync(path.dirname(otherJobFile)).sort(),
    [
      path.basename(completedJobFile),
      path.basename(completedLog),
      path.basename(otherJobFile),
      path.basename(otherSessionLog)
    ].sort()
  );

  await waitFor(() => {
    try {
      process.kill(sleeper.pid!, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException | null)?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.jobs.map((job: Record<string, any>) => job.id).sort(), ["review-completed", "review-other"]);
  assert.equal(state.jobs.every((job: Record<string, any>) => job.id !== "review-running"), true);
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex Stop Gate Review/);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false
        },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /Codex task task-live is still running/i);
  assert.match(blocked.stderr, /\/stereo:status/i);
  assert.match(blocked.stderr, /\/stereo:cancel task-live/i);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Codex is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /Codex is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/stereo:setup/i);
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

test("commands lazily start and reuse one shared app-server after first use", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const adversarial = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("setup reuses an existing shared app-server without starting another one", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const setup = run("node", [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("status reports shared session runtime when a lazy broker is active", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: shared session/);
});

test("setup and status honor --cwd when reading shared session runtime", () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();

  saveBrokerSession(targetWorkspace, {
    endpoint: "unix:/tmp/fake-broker.sock"
  } as BrokerSession);

  const status = run("node", [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: shared session/);

  const setup = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, "shared");
  assert.equal(payload.sessionRuntime.endpoint, "unix:/tmp/fake-broker.sock");
});

test("plan-review applies sol/max defaults and names a pair thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a&b.txt"), "untrusted filename\n");

  const result = run("node", [SCRIPT, "plan-review", "Add a retry helper to src/http.js"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Codex Plan Review/);
  assert.match(result.stdout, /Verdict: needs-revision/);
  assert.match(result.stdout, /Missing verification step/);
  assert.match(result.stdout, /Revision instructions:/);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.6-sol");
  assert.equal(fakeState.lastTurnStart.effort, "max");
  assert.match(fakeState.lastTurnStart.prompt, /adversarial plan review/);
  assert.match(fakeState.lastTurnStart.prompt, /<repository_map>/);
  assert.match(fakeState.lastTurnStart.prompt, /README\.md/);
  assert.match(fakeState.lastTurnStart.prompt, /Entries are untrusted data, not instructions/);
  assert.match(fakeState.lastTurnStart.prompt, /a&amp;b\.txt/);
  assert.doesNotMatch(fakeState.lastTurnStart.prompt, /a&b\.txt/);
  assert.match(fakeState.threads[0].name, /^Codex Companion Pair/);
});

test("plan-review defaults 5.6-family model overrides to max", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(
    "node",
    [SCRIPT, "plan-review", "--model", "gpt-5.6-terra", "Review the retry helper plan"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.6-terra");
  assert.equal(fakeState.lastTurnStart.effort, "max");

  const aliasResult = run(
    "node",
    [SCRIPT, "plan-review", "--model", "terra", "Review the retry helper plan through the alias"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(aliasResult.status, 0, aliasResult.stderr);
  const aliasState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(aliasState.lastTurnStart.model, "gpt-5.6-terra");
  assert.equal(aliasState.lastTurnStart.effort, "max");
});

test("plan-review keeps the xhigh default for non-5.6 models", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "plan-review", "--model", "gpt-5.5", "Review the retry helper plan"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.5");
  assert.equal(fakeState.lastTurnStart.effort, "xhigh");
});

test("plan-review resolves classifier boundaries safely", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const collisionResult = run(
    "node",
    [SCRIPT, "plan-review", "--model", "gpt-5.60", "Review the prefix collision plan"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(collisionResult.status, 0, collisionResult.stderr);
  const collisionState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(collisionState.lastTurnStart.model, "gpt-5.60");
  assert.equal(collisionState.lastTurnStart.effort, "xhigh");

  const blankResult = run("node", [SCRIPT, "plan-review", "--model", "", "Review the blank model plan"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(blankResult.status, 0, blankResult.stderr);
  const blankState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(blankState.lastTurnStart.model, "gpt-5.6-sol");
  assert.equal(blankState.lastTurnStart.effort, "max");
});

test("plan-review reports approve with the plan-review-approve fixture behavior", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "plan-review-approve");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "plan-review", "Ship the retry helper plan"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict: approve/);
  assert.match(result.stdout, /No material findings\./);
});

test("plan-review --thread resumes the same pair thread read-only and stores plan state", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const first = run("node", [SCRIPT, "plan-review", "--json", "Initial plan draft"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout);
  assert.equal(firstPayload.round, 1);
  assert.equal(firstPayload.model, "gpt-5.6-sol");
  assert.equal(firstPayload.effort, "max");
  assert.equal(firstPayload.result.verdict, "needs-revision");
  const threadId = firstPayload.threadId;
  assert.ok(threadId);

  const second = run(
    "node",
    [SCRIPT, "plan-review", "--json", "--thread", threadId, "--round", "2", "Revised plan draft"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );
  assert.equal(second.status, 0, second.stderr);
  const secondPayload = JSON.parse(second.stdout);
  assert.equal(secondPayload.round, 2);
  assert.equal(secondPayload.threadId, threadId);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastResume.threadId, threadId);
  assert.equal(fakeState.lastResume.sandbox, "read-only");
  assert.equal(fakeState.lastTurnStart.threadId, threadId);
  assert.match(fakeState.lastTurnStart.prompt, /revision that responds to your earlier findings/);
  assert.doesNotMatch(fakeState.lastTurnStart.prompt, /<repository_map>/);

  const planState = run("node", [SCRIPT, "plan-state", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(planState.status, 0, planState.stderr);
  const planPayload = JSON.parse(planState.stdout);
  assert.equal(planPayload.available, true);
  assert.equal(planPayload.round, 2);
  assert.equal(planPayload.verdict, "needs-revision");
  assert.equal(planPayload.threadId, threadId);
  assert.match(planPayload.plan, /Revised plan draft/);

  // A malformed round must not clobber the last good stored plan state.
  // Stop the standing broker first so the swapped fixture is actually spawned,
  // and wait until the endpoint stops answering (the dying broker could still
  // serve one more round with the old fixture otherwise).
  installFakeCodex(binDir, "invalid-json");
  const brokerSession = loadBrokerSession(repo);
  if (brokerSession?.endpoint) {
    await sendBrokerShutdown(brokerSession.endpoint).catch(() => {});
    await waitFor(async () => !(await waitForBrokerEndpoint(brokerSession.endpoint, 100)));
    if (brokerSession.pid && processIsAlive(brokerSession.pid)) {
      terminateProcessTree(brokerSession.pid);
    }
  }
  const third = run(
    "node",
    [SCRIPT, "plan-review", "--json", "--thread", threadId, "--round", "3", "Broken round draft"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );
  assert.equal(third.status, 0, third.stderr);
  const thirdPayload = JSON.parse(third.stdout);
  assert.ok(thirdPayload.parseError);

  const preserved = run("node", [SCRIPT, "plan-state", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(preserved.status, 0, preserved.stderr);
  const preservedPayload = JSON.parse(preserved.stdout);
  assert.equal(preservedPayload.round, 2);
  assert.equal(preservedPayload.verdict, "needs-revision");
  assert.match(preservedPayload.plan, /Revised plan draft/);
});

test("plan-state reports unavailable before any plan review has run", () => {
  const workspace = makeTempDir();

  const result = run("node", [SCRIPT, "plan-state", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).available, false);
});

test("plan-review works without a git repository and omits the repository map", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "plan-review", "Review a plan outside git"], {
    cwd: workspace,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict:/);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.doesNotMatch(fakeState.lastTurnStart.prompt, /<repository_map>/);
});

test("task --write --thread escalates the resumed thread to workspace-write", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const first = run("node", [SCRIPT, "plan-review", "--json", "Initial plan draft"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout).threadId;
  assert.ok(threadId);

  const impl = run("node", [SCRIPT, "task", "--write", "--thread", threadId, "implement the approved plan"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(impl.status, 0, impl.stderr);
  assert.equal(
    impl.stdout,
    "Handled the requested task.\nTask prompt accepted.\n\nNote: this write-capable run reported no file changes.\n"
  );
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastResume.threadId, threadId);
  assert.equal(fakeState.lastResume.sandbox, "workspace-write");
  assert.equal(fakeState.lastTurnStart.threadId, threadId);
  assert.equal(fakeState.lastTurnStart.prompt, "implement the approved plan");
});

test("task rejects --thread combined with resume or fresh flags", () => {
  const repo = makeTempDir();

  const resume = run("node", [SCRIPT, "task", "--thread", "thr_9", "--resume-last", "follow up"], {
    cwd: repo
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /Choose either --thread <id> or --resume\/--resume-last\/--fresh\./);

  const fresh = run("node", [SCRIPT, "task", "--thread", "thr_9", "--fresh", "follow up"], {
    cwd: repo
  });
  assert.equal(fresh.status, 1);
  assert.match(fresh.stderr, /Choose either --thread <id> or --resume\/--resume-last\/--fresh\./);
});

test("plan-review --background enqueues a detached worker and stores structured results", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "plan-review", "--background", "--json", "Plan under background review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^plan-/);

  const stateDir = resolveStateDir(repo);
  const stateAfterLaunch = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const indexedAfterLaunch = stateAfterLaunch.jobs.find((job: Record<string, any>) => job.id === launchPayload.jobId);
  assert.ok(indexedAfterLaunch);
  assert.equal(Object.hasOwn(indexedAfterLaunch, "request"), false);
  const jobFile = path.join(stateDir, "jobs", `${launchPayload.jobId}.json`);
  const storedAfterLaunch = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(storedAfterLaunch.request.kind, "plan-review");
  assert.match(storedAfterLaunch.request.plan, /Plan under background review/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  assert.equal(JSON.parse(waitedStatus.stdout).job.status, "completed");

  const resultPayload = await waitFor(
    () => {
      const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
        cwd: repo,
        env: buildEnv(binDir)
      });
      if (result.status !== 0) {
        return null;
      }
      return JSON.parse(result.stdout);
    },
    { timeoutMs: 15000 }
  );

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.equal(resultPayload.storedJob.result.result.verdict, "needs-revision");
  assert.match(resultPayload.storedJob.rendered, /# Codex Plan Review/);
  const stateAfterCompletion = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const indexedAfterCompletion = stateAfterCompletion.jobs.find((job: Record<string, any>) => job.id === launchPayload.jobId);
  assert.ok(indexedAfterCompletion);
  assert.equal(Object.hasOwn(indexedAfterCompletion, "request"), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(jobFile, "utf8")), "request"), true);

  const planState = run("node", [SCRIPT, "plan-state", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(planState.status, 0, planState.stderr);
  assert.equal(JSON.parse(planState.stdout).available, true);
});

test("task --write --thread retries privately when the shared runtime ignores escalation", async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "stale-write-escalation");
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, "plan-review", "--json", "Initial implementation plan"], {
    cwd: repo,
    env
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;
  const staleBroker = loadBrokerSession(repo);
  assert.ok(staleBroker);

  const implementation = run(
    process.execPath,
    [SCRIPT, "task", "--write", "--thread", threadId, "implement the approved plan"],
    { cwd: repo, env }
  );
  assert.equal(implementation.status, 0, implementation.stderr);
  assert.match(implementation.stdout, /Handled the requested task/);

  const state = readCompanionState(repo);
  const taskJob = state.jobs.find((job) => job.jobClass === "task");
  assert.ok(taskJob);
  const log = readJobLog(repo, taskJob.id);
  assert.match(log, /resumed the thread read-only; retrying the write run on a private runtime/i);
  assert.match(log, /Drained the stale shared Codex runtime/);
  assert.equal(fs.existsSync(path.join(binDir, "fake-codex-state.json")), true);
  const fakeStateAfterRetry = readFakeState(binDir);
  assert.equal(fakeStateAfterRetry.appServerStarts, 2);
  assert.equal(fakeStateAfterRetry.lastResume?.sandbox, "workspace-write");
  assert.equal(await brokerEndpointConnectable(staleBroker.endpoint), false);
  assert.deepEqual(loadBrokerSession(repo), staleBroker);

  const followUp = run(process.execPath, [SCRIPT, "task", "verify the implementation"], {
    cwd: repo,
    env
  });
  assert.equal(followUp.status, 0, followUp.stderr);
  assert.equal(readFakeState(binDir).appServerStarts, 3);
  assert.notEqual(loadBrokerSession(repo)?.endpoint, staleBroker.endpoint);
});

test("task --write --thread fails clearly when write escalation is refused", (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "resume-never-escalates");
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, "plan-review", "--json", "Initial implementation plan"], {
    cwd: repo,
    env
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;

  const result = run(
    process.execPath,
    [SCRIPT, "task", "--write", "--thread", threadId, "implement the approved plan"],
    { cwd: repo, env }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /resumed thread .* read-only despite the workspace-write request/i);
  assert.equal(readFakeState(binDir).appServerStarts, 2);
});

test("a direct fallback write does not disturb a busy shared runtime", async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-turn");
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, "plan-review", "--json", "Target thread plan"], {
    cwd: repo,
    env
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;
  const broker = loadBrokerSession(repo);
  assert.ok(broker);

  const launched = run(
    process.execPath,
    [SCRIPT, "task", "--background", "--json", "keep the shared runtime busy"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  await waitFor(() => {
    const state = readFakeState(binDir);
    return Array.isArray(state.turnStarts) && state.turnStarts.length >= 2;
  }, { timeoutMs: 10000 });

  const write = run(
    process.execPath,
    [SCRIPT, "task", "--write", "--thread", threadId, "implement while another turn runs"],
    { cwd: repo, env }
  );
  assert.equal(write.status, 0, write.stderr);

  const waited = run(
    process.execPath,
    [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env }
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");
  assert.equal(fs.existsSync(path.join(binDir, "fake-codex-state.json")), true);
  assert.equal(readFakeState(binDir).appServerStarts, 2);
  assert.equal(await brokerEndpointConnectable(broker.endpoint), true);
  assert.equal(loadBrokerSession(repo)?.endpoint, broker.endpoint);
});

test("a broker-routed turn fails promptly when the child app-server dies mid-turn", async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "die-mid-turn");
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const broker = await ensureBrokerSession(repo, {
    env,
    scriptPath: BROKER_SCRIPT,
    timeoutMs: 4000
  });
  assert.ok(broker);
  assert.ok(loadBrokerSession(repo));

  const result = await runNodeWithTimeout([SCRIPT, "task", "exercise the dying runtime"], {
    cwd: repo,
    env,
    timeoutMs: 5000
  });
  assert.equal(result.timedOut, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /app-server connection closed before the turn completed/i);
});

test("a resume followed by app-server death fails instead of hanging", async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "die-after-resume");
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, "plan-review", "--json", "Create a resumable thread"], {
    cwd: repo,
    env
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;

  const result = await runNodeWithTimeout([SCRIPT, "task", "--thread", threadId, "continue after resume"], {
    cwd: repo,
    env,
    timeoutMs: 5000
  });
  assert.equal(result.timedOut, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /app-server connection closed before the turn completed/i);
});

test("background write task results retain the no-file-changes note", (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const launched = run(
    process.execPath,
    [SCRIPT, "task", "--background", "--write", "--json", "implement the small fix"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const waited = run(
    process.execPath,
    [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env }
  );
  assert.equal(waited.status, 0, waited.stderr);

  const result = run(process.execPath, [SCRIPT, "result", jobId], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Note: this write-capable run reported no file changes\./);
});

test("an endpoint-pinned runtime is never drained after a private write retry", async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "stale-write-escalation");
  const env = buildEnv(binDir);
  const sessionDir = makeTempDir("pinned-broker-");
  const endpoint =
    process.platform === "win32"
      ? `pipe:\\\\.\\pipe\\codex-pinned-${process.pid}-${Date.now()}`
      : `unix:${path.join(sessionDir, "broker.sock")}`;
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const broker = spawnBrokerProcess({
    scriptPath: BROKER_SCRIPT,
    cwd: repo,
    endpoint,
    pidFile,
    logFile,
    env
  });
  assert.equal(await waitForBrokerEndpoint(endpoint, 4000), true);
  t.after(async () => {
    await sendBrokerShutdown(endpoint).catch(() => {});
    if (broker.pid && processIsAlive(broker.pid)) {
      await waitFor(() => !processIsAlive(broker.pid!), { timeoutMs: 2000 }).catch(() => {});
      if (processIsAlive(broker.pid)) {
        terminateProcessTree(broker.pid);
      }
    }
  });

  const pinnedEnv = {
    ...env,
    CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint
  };
  const plan = run(process.execPath, [SCRIPT, "plan-review", "--json", "Pinned runtime plan"], {
    cwd: repo,
    env: pinnedEnv
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;
  assert.equal(loadBrokerSession(repo), null);

  const write = run(
    process.execPath,
    [SCRIPT, "task", "--write", "--thread", threadId, "implement from the pinned thread"],
    { cwd: repo, env: pinnedEnv }
  );
  assert.equal(write.status, 0, write.stderr);
  assert.equal(readFakeState(binDir).appServerStarts, 2);
  assert.equal(await brokerEndpointConnectable(endpoint), true);
  assert.equal(process.kill(broker.pid!, 0), true);

  const taskJob = readCompanionState(repo).jobs.find((job) => job.jobClass === "task");
  assert.match(readJobLog(repo, taskJob!.id), /not plugin-owned/i);
});

test("a resumed thread is reserved for exactly one run", async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-turn");
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, "plan-review", "--json", "Reservation target plan"], {
    cwd: repo,
    env
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;

  const live = withCodexHome(env.CODEX_HOME, () =>
    acquireThreadReservation(threadId, {
      jobId: "holding-job",
      pid: process.pid
    })
  );
  const blocked = run(process.execPath, [SCRIPT, "task", "--thread", threadId, "competing run"], {
    cwd: repo,
    env
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /already being used by another Codex run \(job holding-job\)/);
  releaseThreadReservation(live);

  const dead = withCodexHome(env.CODEX_HOME, () =>
    acquireThreadReservation(threadId, {
      jobId: "crashed-job",
      pid: 2147483647
    })
  );
  const stale = run(process.execPath, [SCRIPT, "task", "--thread", threadId, "retry after crash"], {
    cwd: repo,
    env
  });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /previous Codex run \(job crashed-job, pid 2147483647\) appears to have crashed/i);
  assert.match(stale.stderr, new RegExp(dead.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(fs.existsSync(dead.path), true);
  releaseThreadReservation(dead);

  const normal = run(process.execPath, [SCRIPT, "task", "--thread", threadId, "normal resume"], {
    cwd: repo,
    env
  });
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(fs.existsSync(dead.path), false);

  const launched = run(
    process.execPath,
    [SCRIPT, "task", "--background", "--json", "--thread", threadId, "slow reserved resume"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  // Conjunction gate (not just "a reservation exists"): the reservation must
  // belong to THIS job and its turn must have started, otherwise a lingering
  // reservation from the earlier foreground run can satisfy the wait early
  // and the post-completion null assertion races the release.
  await waitFor(() => {
    const reservation = findThreadReservation(env.CODEX_HOME, threadId);
    const job = readCompanionState(repo).jobs.find((candidate) => candidate.id === jobId);
    return reservation?.record.jobId === jobId && job?.turnId ? reservation : null;
  }, { timeoutMs: 10000 });
  const waited = run(
    process.execPath,
    [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env }
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(findThreadReservation(env.CODEX_HOME, threadId), null);
});

test("a fresh persistent thread is reserved before its id is published", async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-turn");
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const launched = run(
    process.execPath,
    [SCRIPT, "task", "--background", "--json", "start a slow fresh thread"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const running = await waitFor(() => {
    const job = readCompanionState(repo).jobs.find((candidate) => candidate.id === jobId);
    const reservation = job?.threadId ? findThreadReservation(env.CODEX_HOME, job.threadId) : null;
    const turnStarts: Array<Record<string, any>> = readFakeState(binDir).turnStarts ?? [];
    const turnStarted = job?.threadId
      ? turnStarts.some((entry) => entry.threadId === job.threadId)
      : false;
    return job?.status === "running" && job.threadId && reservation && turnStarted ? { job, reservation } : null;
  }, { timeoutMs: 10000 });

  const competitor = run(
    process.execPath,
    [SCRIPT, "task", "--thread", running.job.threadId, "compete with the fresh owner"],
    { cwd: repo, env }
  );
  assert.notEqual(competitor.status, 0);
  assert.match(competitor.stderr, new RegExp(`job ${jobId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(fs.existsSync(path.join(binDir, "fake-codex-state.json")), true);
  const turnStarts: Array<Record<string, any>> = readFakeState(binDir).turnStarts ?? [];
  assert.equal(turnStarts.filter((entry) => entry.threadId === running.job.threadId).length, 1);

  const waited = run(
    process.execPath,
    [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env }
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(findThreadReservation(env.CODEX_HOME, running.job.threadId), null);

  const resumed = run(
    process.execPath,
    [SCRIPT, "task", "--thread", running.job.threadId, "resume after the owner finishes"],
    { cwd: repo, env }
  );
  assert.equal(resumed.status, 0, resumed.stderr);
});

test("/stereo:cancel releases task and plan-review thread reservations", async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-turn");
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, "plan-review", "--json", "Cancellation target plan"], {
    cwd: repo,
    env
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;

  const taskLaunch = run(
    process.execPath,
    [SCRIPT, "task", "--background", "--json", "--thread", threadId, "slow cancellable task"],
    { cwd: repo, env }
  );
  assert.equal(taskLaunch.status, 0, taskLaunch.stderr);
  const taskJobId = JSON.parse(taskLaunch.stdout).jobId;
  await waitFor(() => {
    const reservation = findThreadReservation(env.CODEX_HOME, threadId);
    const job = readCompanionState(repo).jobs.find((candidate) => candidate.id === taskJobId);
    return reservation?.record.jobId === taskJobId && job?.turnId ? reservation : null;
  }, { timeoutMs: 10000 });

  const taskCancel = run(process.execPath, [SCRIPT, "cancel", taskJobId, "--json"], {
    cwd: repo,
    env
  });
  assert.equal(taskCancel.status, 0, taskCancel.stderr);
  assert.match(JSON.parse(taskCancel.stdout).reservationCleanup, /released|none-found/);
  assert.equal(findThreadReservation(env.CODEX_HOME, threadId), null);
  assert.match(readJobLog(repo, taskJobId), /Thread reservation cleanup:/);

  const resumed = run(process.execPath, [SCRIPT, "task", "--thread", threadId, "resume immediately"], {
    cwd: repo,
    env
  });
  assert.equal(resumed.status, 0, resumed.stderr);

  const planLaunch = run(
    process.execPath,
    [
      SCRIPT,
      "plan-review",
      "--background",
      "--json",
      "--thread",
      threadId,
      "--round",
      "2",
      "slow cancellable plan review"
    ],
    { cwd: repo, env }
  );
  assert.equal(planLaunch.status, 0, planLaunch.stderr);
  const planJobId = JSON.parse(planLaunch.stdout).jobId;
  await waitFor(() => {
    const reservation = findThreadReservation(env.CODEX_HOME, threadId);
    const job = readCompanionState(repo).jobs.find((candidate) => candidate.id === planJobId);
    return reservation?.record.jobId === planJobId && job?.turnId ? reservation : null;
  }, { timeoutMs: 10000 });

  const planCancel = run(process.execPath, [SCRIPT, "cancel", planJobId, "--json"], {
    cwd: repo,
    env
  });
  assert.equal(planCancel.status, 0, planCancel.stderr);
  assert.match(JSON.parse(planCancel.stdout).reservationCleanup, /released|none-found/);
  assert.equal(findThreadReservation(env.CODEX_HOME, threadId), null);
  assert.match(readJobLog(repo, planJobId), /Thread reservation cleanup:/);
});

test("cancel never removes a foreign thread reservation", async (t) => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-turn");
  const env = buildEnv(binDir);
  registerSessionCleanup(t, repo, env);

  const plan = run(process.execPath, [SCRIPT, "plan-review", "--json", "Foreign lock target"], {
    cwd: repo,
    env
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;
  const launched = run(
    process.execPath,
    [SCRIPT, "task", "--background", "--json", "--thread", threadId, "own the reservation briefly"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const reservation = await waitFor(() => {
    const lock = findThreadReservation(env.CODEX_HOME, threadId);
    const job = readCompanionState(repo).jobs.find((candidate) => candidate.id === jobId);
    return lock && job?.turnId ? lock : null;
  }, { timeoutMs: 10000 });
  fs.writeFileSync(
    reservation.path,
    `${JSON.stringify({ ...reservation.record, jobId: "foreign-job" })}\n`,
    "utf8"
  );

  const cancelled = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).reservationCleanup, "mismatch-skipped");
  assert.equal(fs.existsSync(reservation.path), true);
  assert.match(readJobLog(repo, jobId), /mismatch-skipped/);
  releaseThreadReservation({
    path: reservation.path,
    token: reservation.record.token
  });
});

test("SessionEnd releases reservations for the session jobs it kills", async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-turn");
  const sessionId = "session-reservation-cleanup";
  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: sessionId
  };

  const plan = run(process.execPath, [SCRIPT, "plan-review", "--json", "Session cleanup target"], {
    cwd: repo,
    env
  });
  assert.equal(plan.status, 0, plan.stderr);
  const threadId = JSON.parse(plan.stdout).threadId;
  const launched = run(
    process.execPath,
    [SCRIPT, "task", "--background", "--json", "--thread", threadId, "session-owned work"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  await waitFor(() => {
    const lock = findThreadReservation(env.CODEX_HOME, threadId);
    const job = readCompanionState(repo).jobs.find((candidate) => candidate.id === jobId);
    return lock && job?.turnId ? lock : null;
  }, { timeoutMs: 10000 });

  const ended = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: sessionId,
      cwd: repo
    })
  });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(findThreadReservation(env.CODEX_HOME, threadId), null);
  assert.equal(readCompanionState(repo).jobs.some((job) => job.id === jobId), false);
});

test("cancel discovers a lock when neither job record contains a thread id", () => {
  const workspace = makeTempDir();
  const codexHome = makeTempDir("cancel-scan-codex-home-");
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  const jobId = "task-no-thread-id";
  const deadPid = 2147483646;
  fs.mkdirSync(jobsDir, { recursive: true });
  const reservation = withCodexHome(codexHome, () =>
    acquireThreadReservation("hidden-thread", {
      jobId,
      pid: deadPid
    })
  );
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    jobFile,
    `${JSON.stringify(
      {
        id: jobId,
        status: "running",
        title: "Codex Task",
        jobClass: "task",
        pid: deadPid,
        logFile,
        request: {
          kind: "task",
          prompt: "cancel before progress"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            pid: deadPid,
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const cancelled = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_HOME: codexHome
    }
  });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).reservationCleanup, "scan-released");
  assert.equal(fs.existsSync(reservation.path), false);
});

test("the same thread is exclusive across workspaces and plugin state roots", () => {
  const workspaceA = initializeBasicRepo();
  const workspaceB = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const codexHome = path.join(binDir, "shared-codex-home");
  const reservation = withCodexHome(codexHome, () =>
    acquireThreadReservation("cross-workspace-thread", {
      jobId: "workspace-a-job",
      pid: process.pid
    })
  );

  const result = run(
    process.execPath,
    [SCRIPT, "task", "--thread", "cross-workspace-thread", "competing workspace B run"],
    {
      cwd: workspaceB,
      env: {
        ...buildEnv(binDir),
        CODEX_HOME: codexHome,
        CLAUDE_PLUGIN_DATA: path.join(workspaceB, ".plugin-data-b")
      }
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already being used by another Codex run \(job workspace-a-job\)/);
  assert.equal(fs.existsSync(path.join(binDir, "fake-codex-state.json")), false);
  assert.equal(path.dirname(reservation.path), path.join(codexHome, "companion-thread-locks"));
  releaseThreadReservation(reservation);

  assert.notEqual(workspaceA, workspaceB);
});

test("SessionEnd tears down an idle workspace broker with no kill fallback", async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const first = run(process.execPath, [SCRIPT, "task", "warm the broker up"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const session = loadBrokerSession(repo);
  assert.ok(session, "expected the task run to auto-start a workspace broker");
  assert.equal(processIsAlive(session.pid), true);

  const cleanup = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-idle", cwd: repo })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);

  await waitFor(() => !processIsAlive(session.pid), { timeoutMs: 4000 });
  assert.equal(loadBrokerSession(repo), null);
  assert.equal(fs.existsSync(session.sessionDir ?? ""), false);
});

test("SessionEnd leaves a busy shared broker (and its session state) running", async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-turn");
  const env = buildEnv(binDir);

  const launch = run(process.execPath, [SCRIPT, "task", "--background", "--json", "slow shared turn"], {
    cwd: repo,
    env
  });
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;
  await waitFor(() => {
    const job = readCompanionState(repo).jobs.find((candidate) => candidate.id === jobId);
    return job?.turnId ? job : null;
  }, { timeoutMs: 10000 });

  const session = loadBrokerSession(repo);
  assert.ok(session, "expected the background task to auto-start a workspace broker");

  // A different session ends while the turn is in flight: the shared broker
  // (and the state the surviving session needs to find it) must survive.
  const cleanup = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-other", cwd: repo })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);

  assert.equal(processIsAlive(session.pid), true, "busy broker must not be killed by another session's end");
  assert.ok(loadBrokerSession(repo), "busy broker session state must survive");

  const finished = run(
    process.execPath,
    [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env }
  );
  assert.equal(finished.status, 0, finished.stderr);
});

test("SessionEnd hard-kills only a wedged broker that is provably still alive", async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
    detached: true
  });
  sleeper.unref();
  assert.ok(sleeper.pid);

  const sessionDir = makeTempDir("wedged-broker-");
  const pidFile = path.join(sessionDir, "broker.pid");
  fs.writeFileSync(pidFile, String(sleeper.pid), "utf8");
  saveBrokerSession(repo, {
    endpoint: `unix:${path.join(sessionDir, "gone.sock")}`,
    pid: sleeper.pid,
    pidFile,
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir
  });

  try {
    const cleanup = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-wedged", cwd: repo })
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);

    // Unreachable endpoint + live pid = wedged: the kill fallback applies.
    await waitFor(() => !processIsAlive(sleeper.pid), { timeoutMs: 4000 });
    assert.equal(loadBrokerSession(repo), null);
  } finally {
    if (processIsAlive(sleeper.pid)) {
      terminateProcessTree(sleeper.pid!);
    }
  }
});

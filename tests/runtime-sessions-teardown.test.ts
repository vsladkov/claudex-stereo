import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeEnv,
  installFakeClaude,
  readFakeClaudeState,
  removeFakeClaudeRunDirs,
} from './fake-claude-fixture.ts';
import { buildEnv, installFakeCodex } from './fake-codex-fixture.ts';
import { makeTempDir, processIsAlive, run, waitFor } from './helpers.ts';
import {
  SCRIPT,
  SESSION_HOOK,
  initializeBasicRepo,
  readCompanionState,
  readJobLogIfReadable,
  readJsonIfReadable,
  registerBrokerReaping,
  requireCompanionState,
  runNodeWithTimeout,
  seedRunningJob,
  spawnStandIn,
  stopStandIn,
} from './runtime-helpers.ts';
import { PROCESS_MARKERS } from '../plugins/stereo/src/platform/process.ts';
import { loadBrokerSession, saveBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import { cleanupSessionJobs } from '../plugins/stereo/src/hooks/session-lifecycle.ts';
import {
  readSessionWorkspaces,
  recordSessionWorkspace,
  resolveSessionRegistryFile,
} from '../plugins/stereo/src/workspace/session-registry.ts';
import {
  listJobs,
  resolveDurableStateDir,
  resolveJobFile,
  setConfig,
  upsertJob,
} from '../plugins/stereo/src/workspace/state.ts';

registerBrokerReaping();

test('SessionEnd tears down an idle workspace broker with no kill fallback', async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const first = run(process.execPath, [SCRIPT, 'task', 'warm the broker up'], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const session = loadBrokerSession(repo);
  assert.ok(session, 'expected the task run to auto-start a workspace broker');
  assert.equal(processIsAlive(session.pid), true);

  const cleanup = run(process.execPath, [SESSION_HOOK, 'SessionEndSweep'], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-idle', cwd: repo }),
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);

  await waitFor(() => !processIsAlive(session.pid), { timeoutMs: 4000 });
  assert.equal(loadBrokerSession(repo), null);
  assert.equal(fs.existsSync(session.sessionDir ?? ''), false);
});

test('SessionEnd leaves a busy shared broker (and its session state) running', async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-turn');
  const env = buildEnv(binDir);

  const launch = run(
    process.execPath,
    [SCRIPT, 'task', '--background', '--json', 'slow shared turn'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;
  await waitFor(
    () => {
      const job = readCompanionState(repo, env)?.jobs.find((candidate) => candidate.id === jobId);
      return job?.turnId ? job : null;
    },
    { timeoutMs: 10000 },
  );

  const session = loadBrokerSession(repo);
  assert.ok(session, 'expected the background task to auto-start a workspace broker');

  // A different session ends while the turn is in flight: the shared broker
  // (and the state the surviving session needs to find it) must survive.
  const cleanup = run(process.execPath, [SESSION_HOOK, 'SessionEndSweep'], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-other', cwd: repo }),
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);

  assert.equal(
    processIsAlive(session.pid),
    true,
    "busy broker must not be killed by another session's end",
  );
  assert.ok(loadBrokerSession(repo), 'busy broker session state must survive');

  const finished = run(
    process.execPath,
    [SCRIPT, 'status', jobId, '--wait', '--timeout-ms', '15000', '--json'],
    { cwd: repo, env },
  );
  assert.equal(finished.status, 0, finished.stderr);
});

test("SessionEnd reaps the broker after killing this session's own running job", async () => {
  const repo = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'slow-turn');
  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: 'sess-own' };

  const launch = run(
    process.execPath,
    [SCRIPT, 'task', '--background', '--json', 'own slow turn'],
    {
      cwd: repo,
      env,
    },
  );
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;
  await waitFor(
    () => {
      const job = readCompanionState(repo, env)?.jobs.find((candidate) => candidate.id === jobId);
      return job?.turnId ? job : null;
    },
    { timeoutMs: 10000 },
  );

  const session = loadBrokerSession(repo);
  assert.ok(session, 'expected the background task to auto-start a workspace broker');

  // The ending session owns the running job: the sweep must kill the job
  // first, then reap the now-idle broker (bounded busy retry covers the
  // orphaned turn winding down after the worker dies).
  const cleanup = run(process.execPath, [SESSION_HOOK, 'SessionEndSweep'], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-own', cwd: repo }),
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);

  await waitFor(() => !processIsAlive(session.pid), { timeoutMs: 4000 });
  assert.equal(loadBrokerSession(repo), null, 'broker session state must be cleared');
  const job = requireCompanionState(repo, env).jobs.find((candidate) => candidate.id === jobId);
  assert.equal(job, undefined, 'the killed job must leave the index');
});

test('SessionEnd clears the record of a broker that answers wrongly and kills nothing', async (t) => {
  const repo = initializeBasicRepo();
  // A stand-in broker: a live pid that looks like one on its command line.
  const broker = spawnStandIn(PROCESS_MARKERS.broker);
  assert.ok(broker.pid);
  t.after(() => stopStandIn(broker));
  const sessionDir = makeTempDir('wedged-broker-');
  const socketPath = path.join(sessionDir, 'broker.sock');
  const listener = net.createServer((socket) => {
    // Answer wrongly, then close our side so the server can shut down.
    socket.on('data', () => {
      socket.end(`${JSON.stringify({ id: 1, result: { ok: false } })}\n`);
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => listener.listen(socketPath, resolve));
  t.after(() => listener.close());
  const pidFile = path.join(sessionDir, 'broker.pid');
  fs.writeFileSync(pidFile, String(broker.pid), 'utf8');
  saveBrokerSession(repo, {
    endpoint: `unix:${socketPath}`,
    pid: broker.pid,
    pidFile,
    logFile: path.join(sessionDir, 'broker.log'),
    sessionDir,
  });

  // The listener lives in this process, so the sweep must run asynchronously
  // (a synchronous runner would block the listener's answer).
  const swept = await runNodeWithTimeout([SESSION_HOOK, 'SessionEndSweep'], {
    cwd: repo,
    env: process.env,
    timeoutMs: 20000,
  });
  assert.equal(swept.status, 0, swept.stderr);
  assert.equal(loadBrokerSession(repo), null, 'the record is cleared');
  assert.equal(fs.existsSync(pidFile), false, 'with the files of its session');
  // The recorded pid may be anyone's by now: the sweep never kills it.
  assert.equal(processIsAlive(broker.pid), true);
});

test('the SessionEnd hook hands the sweep to a detached process and returns', async (t) => {
  const repo = initializeBasicRepo();
  const worker = spawnStandIn(PROCESS_MARKERS.worker, { cwd: repo });
  assert.ok(worker.pid);
  t.after(() => stopStandIn(worker));
  const sessionId = 'sess-hand-off';
  seedRunningJob(repo, 'task-hand-off', sessionId, worker.pid);
  assert.equal(recordSessionWorkspace(sessionId, repo), true);
  const registryFile = resolveSessionRegistryFile(sessionId);
  assert.ok(registryFile);

  // The hook as Claude Code runs it, somewhere else and with no session in
  // its environment: the input alone names the session and its directory,
  // and the sweep gets it on its own stdin.
  const ended = run(process.execPath, [SESSION_HOOK, 'SessionEnd'], {
    cwd: makeTempDir(),
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: sessionId, cwd: repo }),
  });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(ended.stdout, '');
  assert.equal(ended.stderr, '');

  // The sweep runs on after the hook returned: the job is cancelled and its
  // worker stopped, then its row and the session registry go.
  await waitFor(
    () =>
      !processIsAlive(worker.pid) &&
      readCompanionState(repo)?.jobs.some((job) => job.id === 'task-hand-off') === false &&
      !fs.existsSync(registryFile),
    { timeoutMs: 15000 },
  );
});

test("SessionEnd for /clear keeps the session's running job and both of its processes", async (t) => {
  const repo = initializeBasicRepo();
  const stateDir = resolveDurableStateDir(repo);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  // Stand-ins carry the marker SessionEnd checks before killing a recorded pid.
  const worker = spawnStandIn(PROCESS_MARKERS.worker, { cwd: repo });
  const claudeChild = spawnStandIn(PROCESS_MARKERS.claude, { cwd: repo });
  assert.ok(worker.pid && claudeChild.pid);
  t.after(() => {
    for (const child of [worker, claudeChild]) {
      stopStandIn(child);
    }
  });

  const logFile = path.join(jobsDir, 'task-clear.log');
  const jobFile = path.join(jobsDir, 'task-clear.json');
  fs.writeFileSync(logFile, 'running\n', 'utf8');
  const record = {
    id: 'task-clear',
    status: 'running',
    title: 'Claude Task',
    runtime: 'claude',
    sessionId: 'sess-clear',
    pid: worker.pid,
    claudePid: claudeChild.pid,
    logFile,
    createdAt: '2026-03-18T15:32:00.000Z',
    updatedAt: '2026-03-18T15:33:00.000Z',
  };
  fs.writeFileSync(jobFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [record] }, null, 2)}\n`,
    'utf8',
  );
  const endSession = (reason?: string) =>
    run(process.execPath, [SESSION_HOOK, 'SessionEndSweep'], {
      cwd: repo,
      env: { ...process.env, CODEX_COMPANION_SESSION_ID: 'sess-clear' },
      input: JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 'sess-clear',
        cwd: repo,
        ...(reason ? { reason } : {}),
      }),
    });

  // The session also launched into another root; /clear must keep that
  // registry too, since a later real end of the same id still needs it.
  assert.equal(recordSessionWorkspace('sess-clear', repo), true);
  const registryFile = resolveSessionRegistryFile('sess-clear');
  assert.ok(registryFile);
  assert.equal(fs.existsSync(registryFile), true);

  // /clear ends the session but keeps the user at the keyboard: the job
  // keeps running, with its record, so it stays resumable.
  const cleared = endSession('clear');
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(fs.existsSync(registryFile), true, 'the session registry survives /clear');
  const kept = requireCompanionState(repo).jobs.find((job) => job.id === 'task-clear');
  assert.equal(kept?.status, 'running');
  assert.equal(kept?.pid, worker.pid);
  assert.equal(kept?.claudePid, claudeChild.pid);
  assert.equal(processIsAlive(worker.pid), true);
  assert.equal(processIsAlive(claudeChild.pid), true);
  assert.equal(fs.existsSync(jobFile), true);
  assert.equal(fs.existsSync(logFile), true);

  // A real session end kills the worker and the recorded Claude child, which
  // leads its own process group and is out of the worker tree's reach.
  const ended = endSession();
  assert.equal(ended.status, 0, ended.stderr);
  await waitFor(() => !processIsAlive(worker.pid) && !processIsAlive(claudeChild.pid), {
    timeoutMs: 10000,
  });
  assert.equal(
    readCompanionState(repo)?.jobs.some((job) => job.id === 'task-clear'),
    false,
  );
  assert.equal(fs.existsSync(registryFile), false, 'a real end removes the registry');
});

test('SessionEnd leaves a broker alone when its idle probe only times out', async (t) => {
  const repo = initializeBasicRepo();
  // A stand-in broker: it must look like one on its command line to be killed.
  const sleeper = spawnStandIn(PROCESS_MARKERS.broker);
  assert.ok(sleeper.pid);
  t.after(() => stopStandIn(sleeper));

  // An endpoint that accepts the probe and never answers it. The sweep is run
  // asynchronously so this server stays live: once the probe gives up and
  // ends its side, the server closes the connection and the sweep can exit.
  const sessionDir = makeTempDir('silent-broker-');
  const socketPath = path.join(sessionDir, 'silent.sock');
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.on('error', () => {});
    // Read (and discard) the request: a paused socket never sees the sweep's
    // FIN, and without 'end' the connection would stay open forever.
    socket.resume();
    socket.on('end', () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  t.after(() => server.close());
  const pidFile = path.join(sessionDir, 'broker.pid');
  fs.writeFileSync(pidFile, String(sleeper.pid), 'utf8');
  saveBrokerSession(repo, {
    endpoint: `unix:${socketPath}`,
    pid: sleeper.pid!,
    pidFile,
    logFile: path.join(sessionDir, 'broker.log'),
    sessionDir,
  });

  // No stdin: the sweep takes the cwd from the process and has no jobs to stop.
  const cleanup = await runNodeWithTimeout([SESSION_HOOK, 'SessionEndSweep'], {
    cwd: repo,
    env: process.env,
    timeoutMs: 20000,
  });
  assert.equal(cleanup.timedOut, false, 'the sweep exits once the probe gives up');
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.ok(connections >= 1, 'the probe reached the endpoint');
  // A probe that merely ran out of time proves nothing about the broker: its
  // record and files stay, and the live pid is never killed.
  assert.ok(loadBrokerSession(repo), 'the record stays');
  assert.equal(fs.existsSync(pidFile), true);
  assert.equal(processIsAlive(sleeper.pid), true);
});

test('SessionEnd sweeps a job this session launched in another workspace root', async (t) => {
  // The session runs in launchDir; its job lives in `workspace` through
  // --workspace, so the sweep only learns of it from the session registry.
  const launchDir = makeTempDir();
  const workspace = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, 'interruptible-slow-task');
  const sessionId = 'sess-cross-workspace';
  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: sessionId };
  const registryFile = resolveSessionRegistryFile(sessionId, env.CODEX_HOME);
  assert.ok(registryFile);
  assert.equal(fs.existsSync(registryFile), false);

  const launched = run(
    process.execPath,
    [SCRIPT, 'task', '--background', '--json', '--workspace', workspace, 'work in the other root'],
    { cwd: launchDir, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId as string;
  t.after(() => {
    run(process.execPath, [SCRIPT, 'cancel', jobId, '--json', '--workspace', workspace], {
      cwd: launchDir,
      env,
    });
  });
  assert.deepEqual(readSessionWorkspaces(sessionId, env.CODEX_HOME), [workspace]);
  assert.equal(
    readCompanionState(launchDir, env)?.jobs.some((job) => job.id === jobId) ?? false,
    false,
    'the launch directory never sees the job',
  );

  const running = await waitFor(
    () => {
      const job = readCompanionState(workspace, env)?.jobs.find(
        (candidate) => candidate.id === jobId,
      );
      return job?.status === 'running' && job.turnId ? job : null;
    },
    { timeoutMs: 15000 },
  );
  const workerPid = running.pid as number;
  assert.equal(running.sessionId, sessionId);
  assert.ok(processIsAlive(workerPid), 'the worker is running');
  const broker = loadBrokerSession(workspace);
  assert.ok(broker, "the job started the other root's broker");

  const ended = run(process.execPath, [SESSION_HOOK, 'SessionEndSweep'], {
    cwd: launchDir,
    env,
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: sessionId, cwd: launchDir }),
  });
  assert.equal(ended.status, 0, ended.stderr);

  await waitFor(() => !processIsAlive(workerPid), { timeoutMs: 10000 });
  // The other root's broker is asked to go too: nothing else would ask it.
  await waitFor(() => !processIsAlive(broker.pid), { timeoutMs: 4000 });
  assert.equal(loadBrokerSession(workspace), null, "the other root's broker record is cleared");
  assert.equal(
    requireCompanionState(workspace, env).jobs.some((job) => job.id === jobId),
    false,
    "the killed job leaves the other root's index",
  );
  assert.equal(fs.existsSync(registryFile), false, 'the session registry is removed');
  assert.deepEqual(readSessionWorkspaces(sessionId, env.CODEX_HOME), []);
});

test('SessionEnd falls back to CLAUDE_PROJECT_DIR when the hook input names no cwd', async (t) => {
  const repo = initializeBasicRepo();
  const worker = spawnStandIn(PROCESS_MARKERS.worker, { cwd: repo });
  assert.ok(worker.pid);
  t.after(() => stopStandIn(worker));
  seedRunningJob(repo, 'task-project-dir', 'sess-project-dir', worker.pid!);

  // The sweep runs somewhere else and its input carries no cwd: only the
  // project-directory variable names the workspace to sweep.
  const ended = run(process.execPath, [SESSION_HOOK, 'SessionEndSweep'], {
    cwd: makeTempDir(),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      CODEX_COMPANION_SESSION_ID: 'sess-project-dir',
    },
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-project-dir' }),
  });
  assert.equal(ended.status, 0, ended.stderr);
  await waitFor(() => !processIsAlive(worker.pid), { timeoutMs: 10000 });
  assert.equal(
    readCompanionState(repo)?.jobs.some((job) => job.id === 'task-project-dir'),
    false,
    'the running job is swept from the project directory',
  );
});

test('SessionEnd sweeping a Claude job launched in another root stops its orphaned child', async (t) => {
  // The session runs in launchDir; its Claude job lives in `workspace`
  // through --workspace. Its worker is killed outright first, so only the
  // recorded child pid, reached through the session registry, can stop the
  // headless child.
  const launchDir = makeTempDir();
  const workspace = initializeBasicRepo();
  const binDir = makeTempDir();
  installFakeClaude(binDir, 'interruptible');
  t.after(() => removeFakeClaudeRunDirs(binDir));
  const sessionId = 'sess-cross-claude';
  const env = { ...buildClaudeEnv(binDir), CODEX_COMPANION_SESSION_ID: sessionId };

  const launched = run(
    process.execPath,
    [
      SCRIPT,
      'task',
      '--background',
      '--json',
      '--workspace',
      workspace,
      '--model',
      'claude:opus',
      '--role',
      'planner',
      'hold in the other root',
    ],
    { cwd: launchDir, env },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId as string;
  t.after(() => {
    run(process.execPath, [SCRIPT, 'cancel', jobId, '--json', '--workspace', workspace], {
      cwd: launchDir,
      env,
    });
  });
  assert.deepEqual(readSessionWorkspaces(sessionId), [workspace]);

  const running = await waitFor(
    () => {
      const job = readCompanionState(workspace, env)?.jobs.find(
        (candidate) => candidate.id === jobId,
      );
      return job?.status === 'running' && typeof job.claudePid === 'number' ? job : null;
    },
    { timeoutMs: 15000 },
  );
  const workerPid = running.pid as number;
  const claudePid = running.claudePid as number;
  t.after(() => {
    if (processIsAlive(claudePid)) {
      process.kill(claudePid, 'SIGKILL');
    }
  });
  await waitFor(
    () =>
      readJsonIfReadable<{ claudePid?: number }>(resolveJobFile(workspace, jobId))?.claudePid ===
      claudePid,
    { timeoutMs: 10000 },
  );
  // Let the fake finish its start-up writes before its reader vanishes.
  await waitFor(
    () =>
      /Assistant message captured: Working until told to stop/.test(
        readJobLogIfReadable(workspace, jobId, env),
      ),
    { timeoutMs: 15000 },
  );
  process.kill(workerPid, 'SIGKILL');
  await waitFor(() => !processIsAlive(workerPid), { timeoutMs: 10000 });
  assert.equal(processIsAlive(claudePid), true, 'the child survives its worker');

  const ended = run(process.execPath, [SESSION_HOOK, 'SessionEndSweep'], {
    cwd: launchDir,
    env,
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: sessionId, cwd: launchDir }),
  });
  assert.equal(ended.status, 0, ended.stderr);
  await waitFor(() => readFakeClaudeState(binDir).terminated?.signal === 'SIGTERM', {
    timeoutMs: 10000,
  });
  await waitFor(() => !processIsAlive(claudePid), { timeoutMs: 10000 });
  assert.equal(
    requireCompanionState(workspace, env).jobs.some((job) => job.id === jobId),
    false,
    "the swept job leaves the other root's index",
  );
  assert.deepEqual(readSessionWorkspaces(sessionId), [], 'the session registry is removed');
});

test('SessionEnd keeps the stored role defaults and announcement watermark while sweeping a running job', async (t) => {
  const repo = initializeBasicRepo();
  const worker = spawnStandIn(PROCESS_MARKERS.worker, { cwd: repo });
  assert.ok(worker.pid);
  t.after(() => stopStandIn(worker));
  seedRunningJob(repo, 'task-swept', 'sess-config', worker.pid);
  // Config the session wrote after its job started: the sweep rewrites the
  // index from a fresh load, so none of it may be lost.
  const roleDefaults = { planner: { model: 'codex:sol', effort: 'high' } };
  setConfig(repo, 'roleDefaults', roleDefaults);
  setConfig(repo, 'lastJobAnnouncementAt', '2026-09-25T08:00:00.000Z');

  const ended = run(process.execPath, [SESSION_HOOK, 'SessionEndSweep'], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: 'sess-config' },
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-config', cwd: repo }),
  });
  assert.equal(ended.status, 0, ended.stderr);
  await waitFor(() => !processIsAlive(worker.pid), { timeoutMs: 10000 });
  const state = requireCompanionState(repo);
  assert.equal(
    state.jobs.some((job) => job.id === 'task-swept'),
    false,
    'the running job is swept',
  );
  assert.deepEqual(state.config.roleDefaults, roleDefaults);
  assert.equal(state.config.lastJobAnnouncementAt, '2026-09-25T08:00:00.000Z');
  assert.equal(state.config.stopReviewGate, false);
});

test('SessionEnd counts only stopped Codex workers toward the busy-broker retry', async (t) => {
  const workspace = makeTempDir();
  const sessionId = 'sess-end-count';
  const codexWorker = spawnStandIn(PROCESS_MARKERS.worker);
  const claudeWorker = spawnStandIn(PROCESS_MARKERS.worker);
  t.after(() => {
    stopStandIn(codexWorker);
    stopStandIn(claudeWorker);
  });
  const base = { jobClass: 'task', kind: 'task', sessionId };
  upsertJob(workspace, { ...base, id: 'task-queued', status: 'queued', pid: null });
  upsertJob(workspace, { ...base, id: 'task-gone', status: 'running', pid: 2 ** 22 + 17 });

  const queuedOnly = cleanupSessionJobs([workspace], sessionId);
  assert.equal(queuedOnly.codexKilled, 0);
  assert.deepEqual(
    listJobs(workspace).map((job) => job.id),
    [],
  );

  upsertJob(workspace, {
    ...base,
    id: 'task-claude',
    status: 'running',
    runtime: 'claude',
    pid: claudeWorker.pid as number,
  });
  upsertJob(workspace, {
    ...base,
    id: 'task-codex',
    status: 'running',
    runtime: 'codex',
    pid: codexWorker.pid as number,
  });
  const running = cleanupSessionJobs([workspace], sessionId);
  assert.deepEqual(listJobs(workspace), [], 'both stops were confirmed');
  assert.equal(running.codexKilled, 1);
});

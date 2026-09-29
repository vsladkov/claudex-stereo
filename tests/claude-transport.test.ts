import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import type { RunCommandFn } from '../plugins/stereo/src/platform/process.ts';
import {
  getClaudeAuthStatus,
  getClaudeAvailability,
  resetClaudeAvailabilityCache,
} from '../plugins/stereo/src/runtime/claude-availability.ts';
import {
  buildClaudeArgs,
  pickServedModel,
  schemaForClaude,
} from '../plugins/stereo/src/runtime/claude-runner.ts';
import { probeClaudeBinary, spawnClaudePrint } from '../plugins/stereo/src/transport/claude-cli.ts';
import type { ClaudeStreamEvent } from '../plugins/stereo/src/transport/claude-cli.ts';
import { fakeClaudeBin, plainArgs, readFakeClaudeState } from './fake-claude-fixture.ts';
import { makeTempDir, processIsAlive, waitFor } from './helpers.ts';
import { ROOT, runNodeWithTimeout } from './runtime-helpers.ts';

// The headless Claude transport: spawn-level checks against the fake
// `claude` (on Windows the fake is a `.cmd` shim whose script runs under this
// Node; on POSIX the script is spawned directly), its binary resolution, its
// timers and kills, and its callback safety. How a command launches on each
// platform is process.test.ts's.

function killIfAlive(pid: number | null | undefined): void {
  if (pid && processIsAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone meanwhile.
    }
  }
}

test('spawnClaudePrint delivers the settings and schema flags intact through the fake CLI', async () => {
  const { binDir, env } = fakeClaudeBin();
  const cwd = makeTempDir();
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['approve', 'needs-revision'] },
      summary: { type: 'string', description: 'One line: what & why' },
    },
    required: ['verdict'],
    additionalProperties: false,
  };
  const args = buildClaudeArgs({
    model: 'sonnet',
    effort: 'xhigh',
    write: false,
    agentsFile: null,
    agentName: null,
    grants: ['Bash(npm test *)'],
    outputSchema: schema,
  });
  const events: ClaudeStreamEvent[] = [];
  const outcome = await spawnClaudePrint({
    binary: env.CLAUDE_CODE_EXECPATH,
    cwd,
    env,
    args,
    prompt: 'Review "this" & that | now',
    onEvent: (event) => events.push(event),
  });

  assert.equal(outcome.spawnError, null);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.signal, null);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.firstUnparsedLine, null);
  assert.equal(outcome.result?.subtype, 'success');
  assert.deepEqual(outcome.result?.structured_output, {
    verdict: 'approve',
    summary: 'No blocking issues found.',
    findings: [],
    next_steps: [],
  });
  assert.equal(events[0]?.type, 'system');
  assert.equal(events[0]?.subtype, 'init');
  assert.equal(events.at(-1)?.type, 'result');

  const run = readFakeClaudeState(binDir).lastRun!;
  assert.equal(run.flags.settings, '{"disableAllHooks":true}');
  assert.deepEqual(JSON.parse(String(run.flags['json-schema'])), schemaForClaude(schema));
  assert.equal(run.flags['output-format'], 'stream-json');
  assert.equal(run.flags['setting-sources'], 'project');
  assert.equal(run.flags['permission-prompts'], 'none');
  assert.equal(run.flags['strict-mcp-config'], true);
  assert.equal(run.model, 'sonnet');
  assert.equal(run.effort, 'xhigh');
  assert.equal(run.permissionMode, 'dontAsk');
  assert.deepEqual(run.allowedTools, ['Bash(npm test *)']);
  assert.equal(run.prompt, 'Review "this" & that | now', 'the prompt travels on stdin');
  assert.equal(fs.realpathSync.native(run.cwd), cwd);
  assert.equal(run.sessionId, outcome.result?.session_id);
});

test('the availability and auth probes read the fake CLI through the transport binary', (t) => {
  resetClaudeAvailabilityCache();
  t.after(resetClaudeAvailabilityCache);
  const { env } = fakeClaudeBin();
  const binary = env.CLAUDE_CODE_EXECPATH;

  const availability = getClaudeAvailability(makeTempDir(), { env });
  assert.deepEqual(availability, {
    available: true,
    detail: '2.1.281 (Claude Code)',
    version: '2.1.281',
    binary,
  });
  const auth = getClaudeAuthStatus(makeTempDir(), { env });
  assert.deepEqual(auth, {
    available: true,
    loggedIn: true,
    detail: 'Claude login active for fake@example.com (team)',
  });

  const loggedOut = getClaudeAuthStatus(makeTempDir(), { env: fakeClaudeBin('logged-out').env });
  assert.equal(loggedOut.available, true);
  assert.equal(loggedOut.loggedIn, false);
  assert.match(
    loggedOut.detail,
    /^not logged in \(.*"loggedIn":false.*\); run `claude auth login`$/,
  );

  const old = getClaudeAvailability(makeTempDir(), { env: fakeClaudeBin('old-version').env });
  assert.equal(old.available, false);
  assert.equal(old.version, '2.1.200');
  assert.match(old.detail, /Claude roles need Claude Code 2\.1\.281 or newer/);
});

test('the served model is the requested family, not an auxiliary call that spent more', () => {
  const usage = {
    'claude-opus-5-5-20260901': { outputTokens: 40, canonicalModel: 'claude-opus-5-5-20260901' },
    'claude-haiku-4-5': { outputTokens: 9000 },
  };
  assert.equal(pickServedModel(usage, null, 'claude-opus-5-5'), 'claude-opus-5-5');
  // A request with no family to read: the family the session started on.
  assert.equal(pickServedModel(usage, 'claude-opus-5-5-20260901', 'raw/model'), 'claude-opus-5-5');
  // The requested family is absent (the CLI served another): the init
  // model's family still outranks the auxiliary call.
  assert.equal(
    pickServedModel(
      { 'claude-sonnet-5': { outputTokens: 10 }, 'claude-haiku-4-5': { outputTokens: 50 } },
      'claude-sonnet-5',
      'claude-opus-5-5',
    ),
    'claude-sonnet-5',
  );
  // No family to go by at all: the most output, as before.
  assert.equal(pickServedModel(usage, null, null), 'claude-haiku-4-5');
  // A Haiku run is served by Haiku.
  assert.equal(pickServedModel(usage, null, 'claude-haiku-4-5'), 'claude-haiku-4-5');
  // No usage table: the init model, normalized.
  assert.equal(pickServedModel(undefined, 'claude-opus-5-5-20260901', 'opus'), 'claude-opus-5-5');
});

// A --version answer, from a fake runner: no binary ever runs.
function answering(stdout: string): RunCommandFn {
  return (command, args = []) => ({
    command,
    args,
    status: 0,
    signal: null,
    stdout,
    stderr: '',
    error: null,
  });
}

function binaryFor(env: NodeJS.ProcessEnv, answer = '2.1.281 (Claude Code)\n'): string {
  return probeClaudeBinary({ env, run: answering(answer) }).binary;
}

test('probeClaudeBinary ignores a CLAUDE_CODE_EXECPATH that names Node itself', () => {
  // A parent started as `node cli.js` exports its Node binary, which is no
  // Claude at all: the CLI on PATH is used instead.
  const nodeDir = makeTempDir();
  for (const name of ['node', 'node.exe', 'NODE.EXE']) {
    assert.equal(binaryFor({ CLAUDE_CODE_EXECPATH: path.join(nodeDir, name) }), 'claude');
  }
  const claude = path.join(nodeDir, 'claude');
  assert.equal(binaryFor({ CLAUDE_CODE_EXECPATH: claude }), claude);
  assert.equal(binaryFor({ CLAUDE_CODE_EXECPATH: '   ' }), 'claude');
  assert.equal(binaryFor({}), 'claude');
});

test('probeClaudeBinary takes CLAUDE_CODE_EXECPATH only when --version names Claude Code', () => {
  // Node under another name answers with its own version: the CLI on PATH runs.
  for (const name of ['nodejs', 'node24']) {
    const execPath = path.join(makeTempDir(), name);
    assert.equal(binaryFor({ CLAUDE_CODE_EXECPATH: execPath }, 'v24.1.0\n'), 'claude', name);
  }
  // A native install is named by its version, and answers as Claude Code.
  const native = path.join(makeTempDir(), '2.1.281');
  assert.equal(binaryFor({ CLAUDE_CODE_EXECPATH: native }), native);
  // The answer that picked the binary is the one the probe returns.
  const probe = probeClaudeBinary({
    env: { CLAUDE_CODE_EXECPATH: native },
    run: answering('2.1.281 (Claude Code)\n'),
  });
  assert.equal(probe.version.stdout, '2.1.281 (Claude Code)\n');
});

// ---------------------------------------------------------------------------
// Timers and kills

test('a child that lingers after its result is stopped after the grace, result intact, even with the inactivity kill off', async (t) => {
  const { binDir, env } = fakeClaudeBin('result-then-hang');
  const started = Date.now();
  const outcome = await spawnClaudePrint({
    binary: env.CLAUDE_CODE_EXECPATH,
    cwd: makeTempDir(),
    env,
    args: plainArgs(),
    prompt: 'report, then linger',
    // No inactivity kill: only the post-result deadline can end the run.
    inactivityTimeoutMs: 0,
    // Short, so the test does not sit out the 10 s production default.
    postResultGraceMs: 300,
  });
  const pid = readFakeClaudeState(binDir).lastRun!.pid;
  t.after(() => killIfAlive(pid));

  // The result stands; the exit was forced, but it was not a timeout.
  assert.equal(outcome.spawnError, null);
  assert.equal(outcome.result?.subtype, 'success');
  assert.equal(outcome.result?.result, 'Done, but lingering.');
  assert.equal(outcome.exitForced, true);
  assert.equal(outcome.timedOut, false, 'a post-result kill is not a timeout');
  assert.equal(outcome.callbackError, null);
  assert.ok(Date.now() - started < 8000, 'the deadline, not the child, ended the run');
  if (process.platform !== 'win32') {
    assert.equal(outcome.signal, 'SIGTERM', 'the polite signal was enough');
  }
  await waitFor(() => !processIsAlive(pid), { timeoutMs: 5000 });
});

test(
  'the inactivity kill escalates to SIGKILL when the child ignores SIGTERM',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { binDir, env } = fakeClaudeBin('stubborn');
    const outcome = await spawnClaudePrint({
      binary: env.CLAUDE_CODE_EXECPATH,
      cwd: makeTempDir(),
      env,
      args: plainArgs(),
      prompt: 'go silent',
      inactivityTimeoutMs: 2000,
      // Short, so the test does not sit out the production grace.
      killGraceMs: 200,
    });
    const pid = readFakeClaudeState(binDir).lastRun!.pid;
    t.after(() => killIfAlive(pid));

    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.exitForced, true);
    assert.equal(outcome.result, null);
    // The child never honoured the polite signal: only the hard one ended it.
    assert.equal(outcome.signal, 'SIGKILL');
    assert.equal(readFakeClaudeState(binDir).terminated, undefined);
    await waitFor(() => !processIsAlive(pid), { timeoutMs: 5000 });
  },
);

test('a child that keeps writing stderr after its result is stopped at the fixed deadline', async (t) => {
  const { binDir, env } = fakeClaudeBin('result-then-stderr');
  const started = Date.now();
  const outcome = await spawnClaudePrint({
    binary: env.CLAUDE_CODE_EXECPATH,
    cwd: makeTempDir(),
    env,
    args: plainArgs(),
    prompt: 'report, then chatter',
    // Far longer than the test: only the post-result deadline can end it.
    inactivityTimeoutMs: 120_000,
    postResultGraceMs: 400,
  });
  const pid = readFakeClaudeState(binDir).lastRun!.pid;
  t.after(() => killIfAlive(pid));

  assert.equal(outcome.result?.result, 'Done, still talking.');
  assert.match(outcome.stderr, /still flushing/, 'the chatter kept coming after the result');
  assert.equal(outcome.exitForced, true);
  assert.equal(outcome.timedOut, false);
  assert.ok(Date.now() - started < 8000, 'stderr after the result never re-armed the deadline');
  await waitFor(() => !processIsAlive(pid), { timeoutMs: 5000 });
});

test(
  'a background process the child left in its group dies with the run',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { binDir, env } = fakeClaudeBin('background-sleeper');
    const outcome = await spawnClaudePrint({
      binary: env.CLAUDE_CODE_EXECPATH,
      cwd: makeTempDir(),
      env,
      args: plainArgs(),
      prompt: 'start a helper',
      inactivityTimeoutMs: 120_000,
    });
    const sleeperPid = readFakeClaudeState(binDir).sleeperPid;
    assert.ok(sleeperPid, 'the fake recorded its helper');
    t.after(() => killIfAlive(sleeperPid));

    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.exitForced, false);
    assert.equal(outcome.result?.result, 'Started a helper.');
    // The child exited on its own; the group kill that follows reaches what
    // it left behind.
    await waitFor(() => !processIsAlive(sleeperPid), { timeoutMs: 5000 });
  },
);

test(
  'an exited child whose group still holds the pipes settles, and the holder dies',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { binDir, env } = fakeClaudeBin('exit-with-pipe-holder');
    const started = Date.now();
    const outcome = await spawnClaudePrint({
      binary: env.CLAUDE_CODE_EXECPATH,
      cwd: makeTempDir(),
      env,
      args: plainArgs(),
      prompt: 'leave a helper behind',
      // Far longer than the test: only the exit-time group kill can settle it.
      inactivityTimeoutMs: 120_000,
      postResultGraceMs: 120_000,
      exitDrainMs: 120_000,
    });
    const holderPid = readFakeClaudeState(binDir).pipeHolderPid;
    assert.ok(holderPid, 'the fake recorded its pipe holder');
    t.after(() => killIfAlive(holderPid));

    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.exitForced, false, 'the child exited by itself');
    assert.equal(outcome.result?.result, 'Left a helper holding the pipes.');
    assert.ok(Date.now() - started < 8000, 'the run settled without waiting for the holder');
    await waitFor(() => !processIsAlive(holderPid), { timeoutMs: 5000 });
  },
);

test(
  'a holder outside the group cannot keep an exited run open',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { binDir, env } = fakeClaudeBin('exit-with-escaped-pipe-holder');
    const started = Date.now();
    const outcome = await spawnClaudePrint({
      binary: env.CLAUDE_CODE_EXECPATH,
      cwd: makeTempDir(),
      env,
      args: plainArgs(),
      prompt: 'leave a detached helper behind',
      inactivityTimeoutMs: 120_000,
      postResultGraceMs: 120_000,
      exitDrainMs: 300,
    });
    const holderPid = readFakeClaudeState(binDir).pipeHolderPid;
    t.after(() => killIfAlive(holderPid));

    // The group kill cannot reach a session of its own; the run stops
    // waiting for the pipes shortly after the child is gone.
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.result?.result, 'Left a helper holding the pipes.');
    assert.ok(Date.now() - started < 8000, 'the run settled after the exit drain');
  },
);

test(
  'the leftover group is signalled once, at exit, and never again at close',
  { skip: process.platform === 'win32' },
  async (t) => {
    // By close the leader has been reaped, so its pid (the group id) may
    // already lead an unrelated group: a second group kill could reach it.
    const { binDir, env } = fakeClaudeBin();
    const signalled: Array<number | string> = [];
    const realKill = process.kill;
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      signalled.push(pid);
      return realKill.call(process, pid, signal);
    }) as typeof process.kill;
    t.after(() => {
      process.kill = realKill;
    });
    const outcome = await spawnClaudePrint({
      binary: env.CLAUDE_CODE_EXECPATH,
      cwd: makeTempDir(),
      env,
      args: plainArgs(),
      prompt: 'hello',
    });
    process.kill = realKill;
    const pid = readFakeClaudeState(binDir).lastRun!.pid;

    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(
      signalled.filter((target) => target === -pid),
      [-pid],
      'one group signal, from the exit handler',
    );
  },
);

// ---------------------------------------------------------------------------
// Callback safety

test('a throwing onEvent is recorded and the stream is still read to the end', async () => {
  const { binDir, env } = fakeClaudeBin();
  const seen: string[] = [];
  const outcome = await spawnClaudePrint({
    binary: env.CLAUDE_CODE_EXECPATH,
    cwd: makeTempDir(),
    env,
    args: plainArgs(),
    prompt: 'hello',
    onEvent: (event: ClaudeStreamEvent) => {
      seen.push(event.type);
      if (event.type === 'system') {
        throw new Error('listener failed');
      }
    },
  });
  const pid = readFakeClaudeState(binDir).lastRun!.pid;

  assert.equal(outcome.callbackError?.message, 'listener failed');
  assert.equal(outcome.exitCode, 0, 'the child ran to its own exit');
  assert.equal(outcome.result?.subtype, 'success');
  assert.equal(seen.at(-1), 'result', 'every later event still reached the callback');
  await waitFor(() => !processIsAlive(pid), { timeoutMs: 5000 });
});

test('a throwing onSpawn is recorded without abandoning the child', async () => {
  const { binDir, env } = fakeClaudeBin();
  const outcome = await spawnClaudePrint({
    binary: env.CLAUDE_CODE_EXECPATH,
    cwd: makeTempDir(),
    env,
    args: plainArgs(),
    prompt: 'hello',
    onSpawn: () => {
      throw new Error('could not record the pid');
    },
  });
  const pid = readFakeClaudeState(binDir).lastRun!.pid;
  assert.equal(outcome.callbackError?.message, 'could not record the pid');
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result?.subtype, 'success');
  await waitFor(() => !processIsAlive(pid), { timeoutMs: 5000 });
});

test('a companion that dies of an uncaught exception takes its headless child along', async (t) => {
  const { binDir, env } = fakeClaudeBin('interruptible');
  const cwd = makeTempDir();
  const pidFile = path.join(cwd, 'child.pid');
  // The crash comes from outside the callbacks (a timer the listener
  // scheduled), so only the process exit hook stands between it and an
  // orphaned child that would otherwise wait forever.
  const source = `
import fs from 'node:fs';
const { spawnClaudePrint } = await import(process.env.TRANSPORT_URL);
spawnClaudePrint({
  binary: process.env.CLAUDE_CODE_EXECPATH,
  cwd: process.cwd(),
  env: process.env,
  args: JSON.parse(process.env.CLAUDE_ARGS),
  prompt: 'hold',
  onSpawn: (pid) => fs.writeFileSync(process.env.PID_FILE, String(pid)),
  onEvent: (event) => {
    if (event.type === 'assistant') {
      setTimeout(() => {
        throw new Error('crash mid-run');
      }, 0);
    }
  },
});
`;
  const outcome = await runNodeWithTimeout(['--input-type=module', '-e', source], {
    cwd,
    env: {
      ...env,
      TRANSPORT_URL: pathToFileURL(
        path.join(ROOT, 'plugins', 'stereo', 'src', 'transport', 'claude-cli.ts'),
      ).href,
      CLAUDE_ARGS: JSON.stringify(plainArgs()),
      PID_FILE: pidFile,
    },
    timeoutMs: 15000,
  });
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => killIfAlive(childPid));

  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /crash mid-run/);
  assert.equal(readFakeClaudeState(binDir).lastRun!.pid, childPid);
  await waitFor(() => !processIsAlive(childPid), { timeoutMs: 5000 });
  // SIGKILL, not the polite signal: the fake had no chance to record one.
  assert.equal(readFakeClaudeState(binDir).terminated, undefined);
});

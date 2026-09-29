import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { loadBrokerSession } from '../plugins/stereo/src/broker/lifecycle.ts';
import {
  buildClaudeEnv as buildChildEnv,
  runClaudeTurn,
} from '../plugins/stereo/src/runtime/claude-runner.ts';
import {
  acquireThreadReservation,
  releaseThreadReservation,
} from '../plugins/stereo/src/runtime/reservations.ts';
import {
  readReservationRecord,
  threadReservationPath,
} from '../plugins/stereo/src/workspace/thread-lock-io.ts';
import { fakeClaudeBin, readFakeClaudeState } from './fake-claude-fixture.ts';
import { makeTempDir } from './helpers.ts';
import { companion, initializeBasicRepo, requireCompanionState, ROOT } from './runtime-helpers.ts';

// The Claude runner: the headless child's environment and bookkeeping, and
// the task payload it produces through the companion (every command numbered
// in call order, the last edit named). The transport under it is in
// claude-transport.test.ts. Every run here is a Claude run on the fake
// `claude`, which never starts a broker, so this file spawns nothing that
// would need reaping and runs on the Windows lane.

const IMPLEMENTATION_REVIEW_SCHEMA = path.join(
  ROOT,
  'plugins',
  'stereo',
  'schemas',
  'implementation-review-output.schema.json',
);

// The stored record keeps the command capture the foreground --json answer slims.
function storedTaskResult(
  repo: string,
  env: NodeJS.ProcessEnv,
  jobId: string,
): Record<string, any> {
  const stored = companion(['result', jobId, '--json'], repo, env);
  assert.equal(stored.status, 0, stored.stderr);
  return JSON.parse(stored.stdout).storedJob.result;
}

// Each payload test runs one job in a fresh repository.
function onlyJobId(repo: string, env: NodeJS.ProcessEnv): string {
  const jobs = requireCompanionState(repo, env).jobs;
  assert.equal(jobs.length, 1);
  return String(jobs[0]!.id);
}

// ---------------------------------------------------------------------------
// The runner

test('the headless child runs with the terminal title disabled and Bash kept at the root', async () => {
  assert.equal(buildChildEnv({}, 'high').CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
  assert.equal(buildChildEnv({}, null).CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
  assert.equal(buildChildEnv({}, null).CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR, '1');

  const { binDir, env } = fakeClaudeBin();
  const result = await runClaudeTurn(makeTempDir(), {
    binary: env.CLAUDE_CODE_EXECPATH,
    model: 'sonnet',
    effort: null,
    role: null,
    prompt: 'hello',
    env,
  });
  assert.equal(result.status, 0, String(result.error));
  assert.equal(readFakeClaudeState(binDir).lastRun!.envDisableTerminalTitle, '1');
  assert.equal(readFakeClaudeState(binDir).lastRun!.envMaintainWorkingDir, '1');
});

test("the child's --settings carries the user's apiKeyHelper and nothing else from user settings", async () => {
  const { binDir, env } = fakeClaudeBin();
  const configDir = makeTempDir();
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({ apiKeyHelper: '/opt/keys/helper.sh', model: 'haiku', hooks: { Stop: [] } }),
  );
  const withHelper = await runClaudeTurn(makeTempDir(), {
    binary: env.CLAUDE_CODE_EXECPATH,
    model: 'sonnet',
    effort: null,
    role: null,
    prompt: 'hello',
    env: { ...env, CLAUDE_CONFIG_DIR: configDir },
  });
  assert.equal(withHelper.status, 0, String(withHelper.error));
  assert.deepEqual(JSON.parse(String(readFakeClaudeState(binDir).lastRun!.flags.settings)), {
    disableAllHooks: true,
    apiKeyHelper: '/opt/keys/helper.sh',
  });

  // No helper in the user's settings: the child's settings stay as they were.
  const without = await runClaudeTurn(makeTempDir(), {
    binary: env.CLAUDE_CODE_EXECPATH,
    model: 'sonnet',
    effort: null,
    role: null,
    prompt: 'hello',
    env: { ...env, CLAUDE_CONFIG_DIR: makeTempDir() },
  });
  assert.equal(without.status, 0, String(without.error));
  assert.deepEqual(JSON.parse(String(readFakeClaudeState(binDir).lastRun!.flags.settings)), {
    disableAllHooks: true,
  });
});

test('a read-only role runs its checks as in CI; the implementer keeps the parent environment', async () => {
  const { binDir, env } = fakeClaudeBin();
  const parent: NodeJS.ProcessEnv = { ...env };
  delete parent.CI;
  const reader = await runClaudeTurn(initializeBasicRepo(), {
    binary: env.CLAUDE_CODE_EXECPATH,
    model: 'sonnet',
    effort: null,
    role: 'reviewer',
    prompt: 'review',
    env: parent,
  });
  assert.equal(reader.status, 0, String(reader.error));
  assert.equal(readFakeClaudeState(binDir).lastRun!.envCi, '1');

  const writer = await runClaudeTurn(initializeBasicRepo(), {
    binary: env.CLAUDE_CODE_EXECPATH,
    model: 'sonnet',
    effort: null,
    role: 'implementer',
    prompt: 'implement',
    env: parent,
  });
  assert.equal(writer.status, 0, String(writer.error));
  assert.equal(readFakeClaudeState(binDir).lastRun!.envCi, null);
});

test('a progress sink that throws at the start still frees the session and the agents file', async (t) => {
  const { binDir, env } = fakeClaudeBin();
  // os.tmpdir() follows these at call time: the run's agents directory lands
  // in a directory no other test process writes to.
  const tmp = makeTempDir();
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  const sessionId = 'sess-progress-throws';
  await assert.rejects(
    runClaudeTurn(makeTempDir(), {
      binary: env.CLAUDE_CODE_EXECPATH,
      model: 'sonnet',
      effort: null,
      role: 'planner',
      prompt: 'hello',
      resumeSessionId: sessionId,
      env,
      onProgress: () => {
        throw new Error('progress sink broke');
      },
    }),
    /progress sink broke/,
  );
  assert.equal(readFakeClaudeState(binDir).runs.length, 0, 'nothing was spawned');
  assert.deepEqual(
    fs.readdirSync(tmp).filter((name) => name.startsWith('stereo-claude-')),
    [],
    'the agents directory was removed',
  );
  // The session lock was given back: the next run can take it.
  releaseThreadReservation(acquireThreadReservation(sessionId, { jobId: 'next' }));
});

test('the runner reports the child pid with its spawn time and puts both on the session lock', async () => {
  const { env } = fakeClaudeBin();
  const before = Date.now();
  // Written from the callback: a holder keeps the types from narrowing to null.
  const seen: {
    spawned: { childPid?: number | null; childStart?: string | null } | null;
    lock: Record<string, unknown> | null;
  } = { spawned: null, lock: null };
  const result = await runClaudeTurn(makeTempDir(), {
    binary: env.CLAUDE_CODE_EXECPATH,
    model: 'sonnet',
    effort: null,
    role: null,
    prompt: 'hello',
    env,
    onProgress: (update) => {
      if (typeof update === 'string') {
        return;
      }
      if (update.childPid) {
        seen.spawned = update;
      }
      if (update.threadId && /session ready/.test(update.message)) {
        seen.lock = readReservationRecord(threadReservationPath(update.threadId)) as Record<
          string,
          unknown
        > | null;
      }
    },
  });
  const after = Date.now();
  assert.equal(result.status, 0, result.error?.message);
  const { childPid, childStart } = seen.spawned ?? {};
  assert.equal(typeof childPid, 'number');
  // Its start token: the exact Linux one, else the spawn's wall time.
  const wallMs = Number(/^wall:(\d+)$/.exec(String(childStart))?.[1]);
  assert.ok(
    process.platform === 'linux'
      ? /^linux:[^:\s]+:\d+$/.test(String(childStart))
      : wallMs >= before && wallMs <= after,
    `start ${childStart} within the run`,
  );
  // A fresh session takes the pid and its start token along when init names it.
  assert.equal(seen.lock?.['childPid'], childPid);
  assert.equal(seen.lock?.['childPidStart'], childStart);
});

test(
  'a session lock that cannot be removed does not fail a finished run',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async (t) => {
    const { env } = fakeClaudeBin();
    const sessionId = 'sess-lock-stays';
    const lockPath = threadReservationPath(sessionId);
    const lockDir = path.dirname(lockPath);
    t.after(() => {
      fs.chmodSync(lockDir, 0o755);
      fs.rmSync(lockPath, { force: true });
    });
    const result = await runClaudeTurn(makeTempDir(), {
      binary: env.CLAUDE_CODE_EXECPATH,
      model: 'sonnet',
      effort: null,
      role: null,
      prompt: 'hello',
      resumeSessionId: sessionId,
      env,
      onProgress: (update) => {
        if (typeof update !== 'string' && /Assistant message captured/.test(update.message)) {
          // From here on nothing can be removed from the lock directory.
          fs.chmodSync(lockDir, 0o555);
        }
      },
    });
    assert.equal(result.status, 0, result.error?.message);
    assert.equal(fs.existsSync(lockPath), true, 'the lock stayed for the next acquire');
  },
);

test('a callback failure inside the runner fails the run with its message', async () => {
  const { env } = fakeClaudeBin();
  const result = await runClaudeTurn(makeTempDir(), {
    binary: env.CLAUDE_CODE_EXECPATH,
    model: 'sonnet',
    effort: null,
    role: null,
    prompt: 'hello',
    env,
    onProgress: (update) => {
      if (typeof update !== 'string' && /session ready/.test(update.message)) {
        throw new Error('progress log unwritable');
      }
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.error?.message, 'Claude run failed: progress log unwritable');
  // What the run produced is still reported next to the failure.
  assert.equal(result.finalMessage, 'Handled the requested task.\nTask prompt accepted.');
});

test('a run that dies before its result reports the init model in its normalized form', async () => {
  const { env } = fakeClaudeBin('die-mid-run');
  const result = await runClaudeTurn(makeTempDir(), {
    binary: env.CLAUDE_CODE_EXECPATH,
    model: 'opus',
    effort: null,
    role: null,
    prompt: 'hello',
    env: { ...env, FAKE_CLAUDE_SERVED_MODEL: 'claude-opus-5-5-20260901' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.servedModel, 'claude-opus-5-5');
});

test('a resume that dies before its init still reports the session it resumed', async () => {
  // A CLI that answers --version as Claude Code and exits before any event.
  const entry = path.join(makeTempDir(), 'claude.cjs');
  fs.writeFileSync(
    entry,
    [
      'if (process.argv[2] === "--version") {',
      '  process.stdout.write("2.1.281 (Claude Code)\\n");',
      '} else {',
      '  process.exit(3);',
      '}',
    ].join('\n'),
  );
  const result = await runClaudeTurn(makeTempDir(), {
    binary: entry,
    model: 'sonnet',
    effort: null,
    role: null,
    prompt: 'hello',
    resumeSessionId: 'sess-dies-before-init',
    env: { ...process.env, CLAUDE_CODE_EXECPATH: entry },
  });
  assert.equal(result.status, 1);
  assert.match(result.error?.message ?? '', /exited with code 3 before reporting a result/);
  assert.equal(result.threadId, 'sess-dies-before-init');
});

// ---------------------------------------------------------------------------
// The task payload

test('a Claude implementer payload numbers its commands and names the last edit', () => {
  const repo = initializeBasicRepo();
  const { binDir, env } = fakeClaudeBin();
  const result = companion(
    ['task', '--json', '--write', '--model', 'claude:opus', '--role', 'implementer', 'go'],
    repo,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  // Write (1), npm test (2), npm run lint (3).
  assert.equal(payload.lastEditOrder, 1);
  assert.equal(payload.effort, readFakeClaudeState(binDir).lastRun!.effort);
  assert.equal(typeof payload.effort, 'string', 'the applied effort is reported');
  assert.equal('result' in payload, false, 'no schema, no parsed result');
  assert.equal('parseError' in payload, false);

  const stored = storedTaskResult(repo, env, onlyJobId(repo, env));
  assert.equal(stored.lastEditOrder, 1);
  // Both checks ran after the last edit, so their order says they speak for
  // the final edit; the orchestrator trusts the green one.
  assert.deepEqual(
    (stored.commandExecutions as Array<Record<string, unknown>>).map((item) => [
      item.command,
      item.order,
      item.exitCode,
    ]),
    [
      ['npm test', 2, 0],
      ['npm run lint', 3, 1],
    ],
  );
  assert.equal(loadBrokerSession(repo), null, 'a Claude run never starts the workspace broker');
});

test('a shell command after the tests is recorded in order and is never an edit', () => {
  const repo = initializeBasicRepo();
  const { env } = fakeClaudeBin('verify-then-format');
  const result = companion(
    ['task', '--json', '--write', '--model', 'claude:opus', '--role', 'implementer', 'go'],
    repo,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  const stored = storedTaskResult(repo, env, onlyJobId(repo, env));
  assert.equal(stored.lastEditOrder, 1, 'a Bash call is never an edit');
  assert.deepEqual(
    (stored.commandExecutions as Array<Record<string, unknown>>).map((item) => [
      item.command,
      item.exitCode,
    ]),
    [
      ['npm test', 0],
      ['npm run lint', 1],
      ['npx prettier --write src', 0],
      ['npm test && git status', 0],
    ],
  );
});

test('a background call is marked and has no exit code', () => {
  const repo = initializeBasicRepo();
  const { env } = fakeClaudeBin('background-bash');
  const result = companion(
    ['task', '--json', '--write', '--model', 'claude:opus', '--role', 'implementer', 'go'],
    repo,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  const stored = storedTaskResult(repo, env, onlyJobId(repo, env));
  const executions = stored.commandExecutions as Array<Record<string, unknown>>;
  assert.deepEqual(
    executions.map((item) => [item.command, item.exitCode]),
    [
      ['npm test', 0],
      ['npm run lint', 1],
      ['npm run dev', null],
      ['npm test', 0],
    ],
  );
  assert.deepEqual(
    executions.map((item) => item.runInBackground ?? null),
    [null, null, true, null],
  );
});

test('every run of a command is recorded with its order and outcome', async () => {
  const repo = initializeBasicRepo();
  const { env } = fakeClaudeBin('reruns');
  const result = await runClaudeTurn(repo, {
    binary: env.CLAUDE_CODE_EXECPATH,
    model: 'opus',
    effort: null,
    role: 'implementer',
    prompt: 'go',
    env,
  });
  assert.deepEqual(
    result.commandExecutions.map((item) => [item.order, item.command, item.status, item.exitCode]),
    [
      [2, 'npm test', 'completed', 0],
      [3, 'npm run lint', 'completed', 1],
      [4, 'npm test', 'completed', 1],
      [5, 'npm run lint', 'completed', 0],
      [6, 'npx tsc --noEmit', 'completed', 0],
      [7, 'npm run lint', 'completed', 0],
      [8, 'npm run build', 'completed', 0],
      [9, 'npm run build', 'denied', null],
      [10, 'npx vitest run', 'completed', 0],
      [11, 'npx vitest run', 'interrupted', null],
    ],
  );
});

test('a denied write is still the last edit call', () => {
  const repo = initializeBasicRepo();
  const { env } = fakeClaudeBin('denied-write');
  const result = companion(
    ['task', '--json', '--write', '--model', 'claude:opus', '--role', 'implementer', 'go'],
    repo,
    env,
  );
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  // Write (1), npm test (2), npm run lint (3), the denied Write (4).
  assert.equal(payload.lastEditOrder, 4);
  const stored = storedTaskResult(repo, env, onlyJobId(repo, env));
  assert.deepEqual(
    (stored.commandExecutions as Array<Record<string, unknown>>).map((item) => item.order),
    [2, 3],
  );
});

test('a read-only Claude task has no edit and orders its denied command', () => {
  const repo = initializeBasicRepo();
  const { env } = fakeClaudeBin('bash-denied');
  const result = companion(
    ['task', '--json', '--model', 'claude:sonnet', '--effort', 'high', '--role', 'planner', 'plan'],
    repo,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.lastEditOrder, null);
  assert.equal(payload.effort, 'high');

  const stored = storedTaskResult(repo, env, onlyJobId(repo, env));
  // Read (1), the denied Bash (2).
  assert.deepEqual(
    (stored.commandExecutions as Array<Record<string, unknown>>).map((item) => [
      item.command,
      item.status,
      item.order,
    ]),
    [['npm test', 'denied', 2]],
  );
});

test('a Claude task with an output schema reports the parsed result', () => {
  const repo = initializeBasicRepo();
  const { env } = fakeClaudeBin();
  const result = companion(
    [
      'task',
      '--json',
      '--model',
      'claude:sonnet',
      '--role',
      'implementation-reviewer',
      '--output-schema',
      IMPLEMENTATION_REVIEW_SCHEMA,
      'check the implementation',
    ],
    repo,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.result, {
    acceptable: true,
    summary: 'Implementation matches the plan.',
    fixes: [],
  });
  assert.equal(payload.parseError, null);
  assert.equal(payload.rawOutput, JSON.stringify(payload.result));
});

test('a Claude task whose answer does not parse reports the parse error', () => {
  const repo = initializeBasicRepo();
  const { env } = fakeClaudeBin('invalid-structured');
  const result = companion(
    [
      'task',
      '--json',
      '--model',
      'claude:sonnet',
      '--role',
      'implementation-reviewer',
      '--output-schema',
      IMPLEMENTATION_REVIEW_SCHEMA,
      'check the implementation',
    ],
    repo,
    env,
  );
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, null);
  assert.equal(typeof payload.parseError, 'string');
  assert.ok(payload.parseError.length > 0);
  assert.equal(payload.rawOutput, 'not json at all');
});

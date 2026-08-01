import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeTempDir, initGitRepo, run } from './helpers.ts';
import { drainCreatedTempDirs } from './helpers.ts';
import { reapWorkspaceBroker } from './broker-reaper.ts';
import { resolveDurableStateDir } from '../plugins/stereo/src/workspace/state.ts';
import {
  evaluateStopReview,
  interpretStopReviewSpawn,
  parseStopReviewOutput,
  resolveStopReviewTimeoutMs,
} from '../plugins/stereo/src/hooks/stop-review-gate.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every workspace this file created gets its broker reaped after each test:
// the companion CLI auto-starts a detached broker per workspace, and without
// a SessionEnd there is nothing else to stop it (one unswept full run used
// to strand ~40 broker processes).
afterEach(async () => {
  for (const dir of drainCreatedTempDirs()) {
    await reapWorkspaceBroker(dir);
  }
});
const HOOKS_FILE = path.join(ROOT, 'plugins', 'stereo', 'hooks', 'hooks.json');

test('parseStopReviewOutput accepts ALLOW verdicts', () => {
  assert.deepEqual(parseStopReviewOutput('ALLOW: no code changes in the previous turn'), {
    ok: true,
    reason: null,
  });
  assert.equal(parseStopReviewOutput('ALLOW: fine\nextra detail lines').ok, true);
});

test('parseStopReviewOutput blocks with the reported reason', () => {
  const blocked = parseStopReviewOutput('BLOCK: the new handler swallows errors');
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason!, /the new handler swallows errors/);

  const bare = parseStopReviewOutput('BLOCK:\nfollow-up context');
  assert.equal(bare.ok, false);
  assert.match(bare.reason!, /follow-up context/);
});

test('parseStopReviewOutput fails closed on empty or unexpected output', () => {
  assert.equal(parseStopReviewOutput('').ok, false);
  assert.match(parseStopReviewOutput('').reason!, /no final output/);
  assert.equal(parseStopReviewOutput(null).ok, false);
  assert.equal(parseStopReviewOutput('verdict: looks good').ok, false);
  assert.match(parseStopReviewOutput('verdict: looks good').reason!, /unexpected answer/);
});

test('stop review timeout defaults below the hooks.json Stop budget and honors the override', () => {
  const defaultTimeout = resolveStopReviewTimeoutMs({});
  const hooks = JSON.parse(fs.readFileSync(HOOKS_FILE, 'utf8'));
  const stopHook = hooks.hooks.Stop.flatMap((entry: Record<string, any>) => entry.hooks ?? [])[0];
  assert.equal(typeof stopHook.timeout, 'number');
  // The inner spawnSync timeout must fire before the hook harness kills the
  // process, or the graceful "timed out" block decision is never emitted.
  assert.equal(defaultTimeout < stopHook.timeout * 1000, true);

  assert.equal(resolveStopReviewTimeoutMs({ CODEX_STOP_REVIEW_TIMEOUT_MS: '5000' }), 5000);
  assert.equal(
    resolveStopReviewTimeoutMs({ CODEX_STOP_REVIEW_TIMEOUT_MS: 'not-a-number' }),
    defaultTimeout,
  );
  assert.equal(resolveStopReviewTimeoutMs({ CODEX_STOP_REVIEW_TIMEOUT_MS: '-1' }), defaultTimeout);
});

test('interpretStopReviewSpawn distinguishes overflow, timeout, command, and JSON failures', () => {
  const overflow = interpretStopReviewSpawn(
    {
      error: Object.assign(new Error('overflow'), { code: 'ENOBUFS' }),
      status: null,
      stdout: '',
      stderr: '',
    },
    120_000,
  );
  assert.equal(overflow.ok, false);
  assert.match(overflow.reason!, /produced more output than the review hook can buffer/);

  const timeout = interpretStopReviewSpawn(
    {
      error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      status: null,
      stdout: '',
      stderr: '',
    },
    120_000,
  );
  assert.match(timeout.reason!, /timed out after 2 minutes/);

  const failed = interpretStopReviewSpawn(
    { status: 1, stdout: '', stderr: 'review failed' },
    120_000,
  );
  assert.match(failed.reason!, /review task failed: review failed/);

  const invalid = interpretStopReviewSpawn({ status: 0, stdout: '{not-json', stderr: '' }, 120_000);
  assert.match(invalid.reason!, /returned invalid JSON/);

  const allowed = interpretStopReviewSpawn(
    { status: 0, stdout: JSON.stringify({ rawOutput: 'ALLOW: clean' }), stderr: '' },
    120_000,
  );
  assert.deepEqual(allowed, { ok: true, reason: null });
});

const STOP_HOOK = path.join(ROOT, 'plugins', 'stereo', 'scripts', 'stop-review-gate-hook.ts');
const IS_WINDOWS = process.platform === 'win32';

function seedRunningJob(repo: string, sessionId: string): void {
  const stateDir = resolveDurableStateDir(repo);
  const jobsDir = path.join(stateDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  const runningLog = path.join(jobsDir, 'task-running.log');
  fs.writeFileSync(runningLog, 'running\n', 'utf8');
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: 'task-live',
            status: 'running',
            title: 'Codex Task',
            jobClass: 'task',
            sessionId,
            logFile: runningLog,
            createdAt: '2026-03-18T15:32:00.000Z',
            updatedAt: '2026-03-18T15:33:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function makeRepo(): string {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  return repo;
}

test(
  'the hook still runs when invoked through a symlinked install path',
  { skip: IS_WINDOWS },
  () => {
    const repo = makeRepo();
    seedRunningJob(repo, 'sess-current');

    const linkDir = makeTempDir('stop-hook-link-');
    const link = path.join(linkDir, 'stop-review-gate-hook.ts');
    try {
      fs.symlinkSync(STOP_HOOK, link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EPERM') {
        return;
      }
      throw error;
    }

    const result = run('node', [link], {
      cwd: repo,
      env: { ...process.env, CODEX_COMPANION_SESSION_ID: 'sess-current' },
      input: JSON.stringify({ cwd: repo, session_id: 'sess-current' }),
    });

    // Proof that main() executed despite argv[1] being a symlink: the
    // running-task note is emitted from inside main().
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Codex task task-live is still running/i);
  },
);

test('malformed hook stdin degrades to empty input instead of crashing the gate', () => {
  const repo = makeRepo();
  seedRunningJob(repo, 'sess-current');

  const result = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: 'sess-current' },
    input: 'not-json{{{',
  });

  // Exit 1 here would be a non-blocking hook error: an enabled gate would be
  // silently bypassed. Malformed stdin must behave exactly like empty stdin.
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Codex task task-live is still running/i);
});

test('an empty session_id falls back to the env session for the running-task note', () => {
  const repo = makeRepo();
  seedRunningJob(repo, 'sess-env');

  const withFallback = run('node', [STOP_HOOK], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: 'sess-env' },
    input: JSON.stringify({ cwd: repo, session_id: '' }),
  });
  assert.equal(withFallback.status, 0, withFallback.stderr);
  assert.match(withFallback.stderr, /task-live is still running/i);

  const otherSession = run('node', [STOP_HOOK], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: 'sess-other' },
    input: JSON.stringify({ cwd: repo, session_id: '' }),
  });
  assert.equal(otherSession.status, 0, otherSession.stderr);
  assert.doesNotMatch(otherSession.stderr, /task-live is still running/i);
});

test('evaluateStopReview fails closed when the review machinery throws', () => {
  const outcome = evaluateStopReview('/tmp', {}, () => {
    throw new Error('template placeholder exploded');
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /hook itself failed: template placeholder exploded/);

  const passthrough = evaluateStopReview('/tmp', {}, () => ({ ok: true, reason: null }));
  assert.deepEqual(passthrough, { ok: true, reason: null });
});

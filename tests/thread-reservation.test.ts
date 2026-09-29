import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acquireThreadReservation,
  describeStrandedReservation,
  listStrandedThreadReservations,
  releaseThreadReservation,
} from '../plugins/stereo/src/runtime/index.ts';
import type { StrandedReservationEntry } from '../plugins/stereo/src/runtime/index.ts';
import {
  recordReservationChildPid,
  releaseLiveReservations,
} from '../plugins/stereo/src/runtime/reservations.ts';
import {
  PROCESS_MARKERS,
  currentProcessOwner,
  currentProcessStartToken,
} from '../plugins/stereo/src/platform/process.ts';
import type { ProcessOps } from '../plugins/stereo/src/platform/process.ts';
import {
  acquireCleanupClaim,
  claimAndDeleteThreadLock,
  reapDeadCleanupClaim,
  releaseCleanupClaim,
} from '../plugins/stereo/src/workspace/thread-lock-io.ts';
import {
  processOps,
  ticksOf,
  useTempCodexHome,
  withTicks,
  writeReservationLock,
} from './helpers.ts';
import { readJsonIfReadable } from './runtime-helpers.ts';

const DEAD_PID = 2147483647;
const LIVE_PID = 2147483008;

// What the stranded scan judges by, liveness alone: LIVE_PID runs, every
// other pid has exited, and no identity is read (a live pid may be the
// recorded process or any process that got its pid).
const scanOps = processOps({
  processHasExited: (pid) => pid !== LIVE_PID,
  readProcessIdentity: () => {
    throw new Error('the scan reads no identity');
  },
});

interface ReservationPathPair {
  lockPath: string;
  claimPath: string;
}

function reservationPaths(codexHome: string, threadId: string): ReservationPathPair {
  const digest = crypto.createHash('sha256').update(String(threadId)).digest('hex').slice(0, 32);
  const lockPath = path.join(codexHome, 'companion-thread-locks', `${digest}.lock`);
  return { lockPath, claimPath: `${lockPath}.cleanup` };
}

function lockRecord(threadId: string, { jobId, pid }: { jobId: string; pid: number }) {
  return {
    token: `token-${threadId}`,
    pid,
    jobId,
    threadId,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function claimRecord({ jobId, pid }: { jobId: string; pid: number }) {
  return {
    pid,
    jobId,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function writeRecord(recordPath: string, record: unknown) {
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function entrySortPath(entry: StrandedReservationEntry) {
  return entry.path ?? entry.paths?.[0] ?? '';
}

test('thread reservations are exclusive, path-safe, and token-released', (t) => {
  const codexHome = useTempCodexHome(t);
  const reservation = acquireThreadReservation('../escape', { jobId: 'job-owner' });

  assert.equal(path.dirname(reservation.path), path.join(codexHome, 'companion-thread-locks'));
  assert.match(path.basename(reservation.path), /^[a-f0-9]{32}\.lock$/);
  assert.throws(
    () => acquireThreadReservation('../escape', { jobId: 'job-contender' }),
    /already being used by another companion run/,
  );

  const original = JSON.parse(fs.readFileSync(reservation.path, 'utf8'));
  fs.writeFileSync(
    reservation.path,
    `${JSON.stringify({ ...original, token: 'foreign-token' })}\n`,
    'utf8',
  );
  assert.equal(releaseThreadReservation(reservation).released, false);
  assert.equal(fs.existsSync(reservation.path), true);

  fs.writeFileSync(reservation.path, `${JSON.stringify(original)}\n`, 'utf8');
  assert.equal(releaseThreadReservation(reservation).released, true);
  assert.equal(fs.existsSync(reservation.path), false);

  fs.writeFileSync(reservation.cleanupPath, '{}\n', 'utf8');
  assert.throws(
    () => acquireThreadReservation('../escape', { jobId: 'job-after-cleanup-crash' }),
    (error: Error) => {
      assert.match(error.message, /if it appears stuck, run `\/stereo:setup`/);
      assert.doesNotMatch(error.message, /delete .*\.lock/i);
      return true;
    },
  );
  fs.unlinkSync(reservation.cleanupPath);

  // A lock whose owner is dead is taken over, not left for a manual delete.
  const dead = writeReservationLock('dead-thread', { jobId: 'job-dead', pid: DEAD_PID });
  const successor = acquireThreadReservation('dead-thread', { jobId: 'job-next' });
  assert.equal(successor.path, dead.path);
  assert.notEqual(successor.token, dead.token);
  assert.equal(JSON.parse(fs.readFileSync(successor.path, 'utf8')).jobId, 'job-next');
  assert.equal(fs.existsSync(successor.cleanupPath), false);
  // The dead owner's handle no longer matches the file and releases nothing.
  assert.equal(releaseThreadReservation(dead).released, false);
  assert.equal(releaseThreadReservation(successor).released, true);
});

test('acquisition reaps a cleanup claim left by a dead process', (t) => {
  const codexHome = useTempCodexHome(t);
  const paths = reservationPaths(codexHome, 'dead-cleanup-claim');
  writeRecord(paths.claimPath, claimRecord({ jobId: 'crashed-cleaner', pid: DEAD_PID }));

  const reservation = acquireThreadReservation('dead-cleanup-claim', {
    jobId: 'replacement-owner',
  });

  assert.equal(fs.existsSync(paths.claimPath), false);
  assert.equal(fs.existsSync(reservation.path), true);
  releaseThreadReservation(reservation);
});

test('acquisition preserves a cleanup claim owned by a live process', (t) => {
  const codexHome = useTempCodexHome(t);
  const paths = reservationPaths(codexHome, 'live-cleanup-claim');
  writeRecord(paths.claimPath, claimRecord({ jobId: 'live-cleaner', pid: process.pid }));
  t.after(() => {
    if (fs.existsSync(paths.claimPath)) {
      fs.unlinkSync(paths.claimPath);
    }
  });

  assert.throws(
    () => acquireThreadReservation('live-cleanup-claim', { jobId: 'contender' }),
    /cleanup is already in progress/,
  );
  assert.equal(fs.existsSync(paths.claimPath), true);
});

test('claimAndDeleteThreadLock retries once after reaping a dead cleanup claim', (t) => {
  useTempCodexHome(t);
  const reservation = writeReservationLock('dead-claim-delete', {
    jobId: 'reservation-owner',
    pid: DEAD_PID,
  });
  writeRecord(reservation.cleanupPath, claimRecord({ jobId: 'crashed-cleaner', pid: DEAD_PID }));

  const removed = claimAndDeleteThreadLock(reservation.path, {
    verify: (record) => record.token === reservation.token,
  });

  assert.equal(removed, true);
  assert.equal(fs.existsSync(reservation.path), false);
  assert.equal(fs.existsSync(reservation.cleanupPath), false);
  releaseThreadReservation(reservation);
});

test('the signal-time release frees every reservation this process holds, and no lock another owner replaced', (t) => {
  useTempCodexHome(t);
  const held = [acquireThreadReservation('live-first'), acquireThreadReservation('live-second')];
  const replaced = acquireThreadReservation('live-replaced');
  const replacement = {
    ...JSON.parse(fs.readFileSync(replaced.path, 'utf8')),
    token: 'replacement-token',
    jobId: 'replacement-job',
  };
  fs.writeFileSync(replaced.path, `${JSON.stringify(replacement)}\n`, 'utf8');
  t.after(() => releaseThreadReservation({ path: replaced.path, token: replacement.token }));

  releaseLiveReservations();
  assert.deepEqual(
    held.map((reservation) => fs.existsSync(reservation.path)),
    [false, false],
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(replaced.path, 'utf8')), replacement);
});

test('the stranded scan reaps dead claims and dead owner locks, and lists none of them', (t) => {
  const codexHome = useTempCodexHome(t);
  const paths: Record<string, ReservationPathPair> = {};

  function seedLock(name: string, pid: number) {
    const pair = reservationPaths(codexHome, name);
    paths[name] = pair;
    writeRecord(pair.lockPath, lockRecord(name, { jobId: `job-${name}`, pid }));
  }

  function seedClaim(name: string, pid: number) {
    const pair = paths[name] ?? reservationPaths(codexHome, name);
    paths[name] = pair;
    writeRecord(pair.claimPath, claimRecord({ jobId: `job-${name}`, pid }));
  }

  seedLock('live-lock', LIVE_PID);
  seedLock('live-lock-live-claim', LIVE_PID);
  seedClaim('live-lock-live-claim', LIVE_PID);
  seedLock('dead-lock', DEAD_PID);
  seedLock('dead-lock-live-claim', DEAD_PID);
  seedClaim('dead-lock-live-claim', LIVE_PID);
  seedLock('dead-lock-dead-claim', DEAD_PID);
  seedClaim('dead-lock-dead-claim', DEAD_PID);
  seedClaim('dead-claim', DEAD_PID);
  seedClaim('live-claim', LIVE_PID);
  seedLock('live-lock-dead-claim', LIVE_PID);
  seedClaim('live-lock-dead-claim', DEAD_PID);

  assert.deepEqual(listStrandedThreadReservations(scanOps), []);

  // What is left of each pair: [its lock, its claim].
  const left = Object.fromEntries(
    Object.entries(paths).map(([name, pair]) => [
      name,
      [fs.existsSync(pair.lockPath), fs.existsSync(pair.claimPath)],
    ]),
  );
  assert.deepEqual(left, {
    'live-lock': [true, false],
    'live-lock-live-claim': [true, true],
    'dead-lock': [false, false],
    // A live cleaner holds the claim: the pair is its to settle.
    'dead-lock-live-claim': [true, true],
    'dead-lock-dead-claim': [false, false],
    'dead-claim': [false, false],
    'live-claim': [false, true],
    'live-lock-dead-claim': [true, false],
  });
});

test('stranded reservation scanning handles malformed records and directory failures', (t) => {
  const codexHome = useTempCodexHome(t);
  const lockDir = path.join(codexHome, 'companion-thread-locks');
  assert.deepEqual(listStrandedThreadReservations(), []);

  fs.writeFileSync(lockDir, 'not a directory\n', 'utf8');
  const [scanError] = listStrandedThreadReservations();
  assert.ok(scanError);
  assert.equal(scanError.kind, 'scan-error');
  assert.equal(scanError.path, lockDir);
  assert.ok(describeStrandedReservation(scanError).includes(`\`${lockDir}\``));
  fs.unlinkSync(lockDir);
  fs.mkdirSync(lockDir, { recursive: true });

  const malformed: Array<[string, string]> = [
    [path.join(lockDir, 'empty.lock'), '{}\n'],
    [path.join(lockDir, 'null.lock.cleanup'), 'null\n'],
    [path.join(lockDir, 'array.lock'), '[]\n'],
    [path.join(lockDir, 'string-pid.lock.cleanup'), '{"pid":"123","jobId":"job-string-pid"}\n'],
  ];
  for (const [recordPath, contents] of malformed) {
    fs.writeFileSync(recordPath, contents, 'utf8');
  }

  const invalidLockPair = {
    lockPath: path.join(lockDir, 'invalid-lock-pair.lock'),
    claimPath: path.join(lockDir, 'invalid-lock-pair.lock.cleanup'),
  };
  fs.writeFileSync(invalidLockPair.lockPath, '{}\n', 'utf8');
  writeRecord(
    invalidLockPair.claimPath,
    claimRecord({ jobId: 'job-live-claim', pid: process.pid }),
  );

  const invalidClaimPair = {
    lockPath: path.join(lockDir, 'invalid-claim-pair.lock'),
    claimPath: path.join(lockDir, 'invalid-claim-pair.lock.cleanup'),
  };
  writeRecord(
    invalidClaimPair.lockPath,
    lockRecord('invalid-claim-pair', { jobId: 'job-live-owner', pid: process.pid }),
  );
  fs.writeFileSync(invalidClaimPair.claimPath, '{}\n', 'utf8');

  const unreadable = listStrandedThreadReservations();
  assert.equal(unreadable.length, 6);
  assert.ok(unreadable.every((entry) => entry.kind === 'unreadable'));
  for (const entry of unreadable) {
    const remedy = describeStrandedReservation(entry);
    assert.match(remedy, /could not be validated/i);
  }

  const invalidClaimEntry = unreadable.find((entry) =>
    entry.paths?.includes(invalidClaimPair.claimPath),
  );
  assert.ok(invalidClaimEntry?.paths);
  assert.deepEqual(invalidClaimEntry.paths, [invalidClaimPair.claimPath]);
  assert.equal(invalidClaimEntry.paths.includes(invalidClaimPair.lockPath), false);

  const sortPaths = unreadable.map(entrySortPath);
  assert.deepEqual(
    sortPaths,
    [...sortPaths].sort((left, right) => left.localeCompare(right)),
  );
});

test('the shared cleanup core verifies under an exclusive claim', (t) => {
  useTempCodexHome(t);
  const accepted = writeReservationLock('shared-core-accepted', {
    jobId: 'job-shared-core',
    pid: DEAD_PID,
  });
  let verified = false;
  const acceptedRemoved = claimAndDeleteThreadLock(accepted.path, {
    verify: (record) => {
      assert.equal(fs.existsSync(accepted.cleanupPath), true, 'verified under the claim');
      verified = true;
      return (
        record.threadId === accepted.threadId &&
        record.pid === accepted.pid &&
        record.token === accepted.token
      );
    },
  });
  assert.equal(acceptedRemoved, true);
  assert.equal(verified, true);
  assert.equal(fs.existsSync(accepted.path), false);
  assert.equal(fs.existsSync(accepted.cleanupPath), false);

  const rejected = writeReservationLock('shared-core-rejected', {
    jobId: 'job-shared-core-rejected',
    pid: DEAD_PID,
  });
  assert.equal(claimAndDeleteThreadLock(rejected.path, { verify: () => false }), false);
  assert.equal(fs.existsSync(rejected.path), true);
  assert.equal(fs.existsSync(rejected.cleanupPath), false);
  releaseThreadReservation(rejected);

  const foreignClaim = writeReservationLock('shared-core-foreign-claim', {
    jobId: 'job-foreign-claim',
    pid: DEAD_PID,
  });
  const claim = claimRecord({ jobId: 'foreign-cleaner', pid: process.pid });
  writeRecord(foreignClaim.cleanupPath, claim);
  assert.equal(claimAndDeleteThreadLock(foreignClaim.path, { verify: () => true }), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(foreignClaim.cleanupPath, 'utf8')), claim);
  assert.equal(fs.existsSync(foreignClaim.path), true);
  fs.unlinkSync(foreignClaim.cleanupPath);
  releaseThreadReservation(foreignClaim);
});

test('a dead claimant claim replaced by a live one before the reap is never deleted', (t) => {
  const codexHome = useTempCodexHome(t);
  const paths = reservationPaths(codexHome, 'claim-race');
  writeRecord(paths.claimPath, claimRecord({ jobId: 'job-dead-cleaner', pid: DEAD_PID }));
  const liveClaim = `${JSON.stringify({ ...currentProcessOwner(), jobId: 'job-live-cleaner' })}\n`;
  // The claimant is judged dead; before the removal re-reads the claim, a
  // live cleaner has reaped it and taken its own.
  const reaped = reapDeadCleanupClaim(paths.claimPath, {
    isClaimantAlive: () => {
      fs.rmSync(paths.claimPath);
      fs.writeFileSync(paths.claimPath, liveClaim);
      return false;
    },
  });
  assert.equal(reaped, false, 'a live claim is left');
  assert.equal(fs.readFileSync(paths.claimPath, 'utf8'), liveClaim);

  // While its holder lives nobody else gets the claim; its release frees it.
  assert.equal(acquireCleanupClaim(paths.lockPath), null);
  releaseCleanupClaim({ path: paths.claimPath, contents: liveClaim });
  const next = acquireCleanupClaim(paths.lockPath);
  assert.ok(next, 'the claim is free once its holder released it');
  releaseCleanupClaim(next);
  assert.deepEqual(fs.readdirSync(path.dirname(paths.claimPath)), []);
});

test('recordReservationChildPid notes the child on the live lock and leaves a replaced one alone', (t) => {
  useTempCodexHome(t);
  const reservation = acquireThreadReservation('child-pid-thread', { jobId: 'job-child' });
  assert.equal(recordReservationChildPid(reservation, { pid: 4242, start: 'wall:1' }), true);
  const stored = JSON.parse(fs.readFileSync(reservation.path, 'utf8'));
  assert.equal(stored.childPid, 4242);
  assert.equal(stored.token, reservation.token);
  assert.equal(stored.jobId, 'job-child');
  assert.deepEqual(
    fs.readdirSync(path.dirname(reservation.path)).filter((name) => name.endsWith('.tmp')),
    [],
    'the rewrite leaves no temporary file',
  );

  // A lock another run has replaced is not this run's to annotate.
  fs.writeFileSync(
    reservation.path,
    `${JSON.stringify({ ...stored, token: 'replacement-token' })}\n`,
    'utf8',
  );
  assert.equal(recordReservationChildPid(reservation, { pid: 4243, start: 'wall:1' }), false);
  assert.equal(JSON.parse(fs.readFileSync(reservation.path, 'utf8')).childPid, 4242);
  fs.unlinkSync(reservation.path);
  assert.equal(
    recordReservationChildPid(reservation, { pid: 4244, start: 'wall:1' }),
    false,
    'nor is a missing one',
  );
  releaseThreadReservation(reservation);
});

interface StoodIn {
  /** What the process runs; null when its command line cannot be read. */
  commandLine: string | null;
  /** The start token the process shows, when the record carries one to compare. */
  start?: string;
}

// Synthetic pids answering the process seams: a pid in the table is alive,
// any other pid has exited. Nothing is spawned, probed, or signalled.
function standIns(table: Map<number, StoodIn>): ProcessOps {
  return processOps({
    processHasExited: (pid) => !table.has(pid),
    readProcessIdentity: (pid) => {
      const entry = table.get(pid);
      return entry && entry.commandLine !== null
        ? { commandLine: entry.commandLine, start: entry.start ?? null }
        : null;
    },
    terminate: () => {
      throw new Error('a reservation check signals nobody');
    },
  });
}

const IMPOSTOR_PID = 2147483001;
const WORKER_PID = 2147483002;
const UNREADABLE_PID = 2147483003;
const CLAUDE_CHILD_PID = 2147483004;
const FOREIGN_CHILD_PID = 2147483005;
const STOOD_IN_DEAD_PID = 2147483006;
const BROKER_PID = 2147483007;
const REUSED_PID = 2147483009;
const WORKER_COMMAND_LINE = 'node /plugin/scripts/codex-companion.ts task';
const CLAUDE_COMMAND_LINE = `claude -p ${PROCESS_MARKERS.claude} none --output-format`;
// Linux start tokens with no boot id, which no host reads as an earlier
// boot's: the recorded one, and the one the process on that pid shows now.
const RECORDED_START = 'linux:-:111111';
const LATER_START = 'linux:-:222222';

test('the takeover guard reaps only an owner that is gone or provably foreign', (t) => {
  useTempCodexHome(t);
  const ops = standIns(
    new Map<number, StoodIn>([
      [IMPOSTOR_PID, { commandLine: 'node -e setInterval stand-in:impostor' }],
      [REUSED_PID, { commandLine: WORKER_COMMAND_LINE, start: LATER_START }],
      [WORKER_PID, { commandLine: WORKER_COMMAND_LINE, start: RECORDED_START }],
      [BROKER_PID, { commandLine: 'node /plugin/scripts/app-server-broker.ts serve' }],
      [UNREADABLE_PID, { commandLine: null }],
    ]),
  );

  // Alive, but a reused pid: it runs no companion CLI (a broker holds no
  // lock), or one that started at another time than the recorded owner.
  // Taken over.
  for (const [pid, threadId] of [
    [IMPOSTOR_PID, 'stood-in-impostor'],
    [BROKER_PID, 'stood-in-broker'],
    [REUSED_PID, 'stood-in-reused'],
  ] as const) {
    const stale = writeReservationLock(threadId, {
      jobId: 'job-reused',
      pid,
      pidStart: RECORDED_START,
    });
    const successor = acquireThreadReservation(threadId, { jobId: 'job-successor' }, ops);
    assert.equal(successor.path, stale.path);
    assert.equal(readJsonIfReadable<{ jobId?: string }>(successor.path)?.jobId, 'job-successor');
    assert.equal(fs.existsSync(successor.cleanupPath), false);
    assert.equal(releaseThreadReservation(stale).released, false);
    assert.equal(releaseThreadReservation(successor).released, true);
  }

  // A live companion, and a live pid whose command line cannot be read,
  // keep their lock: only a contradicted identity is foreign.
  for (const [pid, threadId] of [
    [WORKER_PID, 'stood-in-worker'],
    [UNREADABLE_PID, 'stood-in-unreadable'],
  ] as const) {
    const held = writeReservationLock(threadId, {
      jobId: `job-${pid}`,
      pid,
      ...(pid === WORKER_PID ? { pidStart: RECORDED_START } : {}),
    });
    assert.throws(() => acquireThreadReservation(threadId, { jobId: 'job-contender' }, ops), {
      message: `Thread or session ${threadId} is already being used by another companion run (job job-${pid}). Wait for it or cancel it first.`,
    });
    assert.equal(readJsonIfReadable<{ jobId?: string }>(held.path)?.jobId, `job-${pid}`);
    assert.equal(fs.existsSync(held.cleanupPath), false);
    assert.equal(releaseThreadReservation(held).released, true);
  }
});

test('a dead owner whose Claude child may still run refuses the takeover', (t) => {
  useTempCodexHome(t);
  const table = new Map<number, StoodIn>([
    [CLAUDE_CHILD_PID, { commandLine: CLAUDE_COMMAND_LINE, start: RECORDED_START }],
    [FOREIGN_CHILD_PID, { commandLine: 'vim notes.txt' }],
    [REUSED_PID, { commandLine: CLAUDE_COMMAND_LINE, start: LATER_START }],
  ]);
  const ops = standIns(table);

  const orphaned = writeReservationLock('stood-in-orphan', {
    jobId: 'job-orphaned',
    pid: STOOD_IN_DEAD_PID,
    childPid: CLAUDE_CHILD_PID,
    childPidStart: RECORDED_START,
  });
  const contend = () => acquireThreadReservation('stood-in-orphan', { jobId: 'job-next' }, ops);
  assert.throws(contend, {
    message: `A previous companion run (job job-orphaned, pid ${STOOD_IN_DEAD_PID}) is gone, and the Claude process it started (pid ${CLAUDE_CHILD_PID}) may still be running on thread or session stood-in-orphan. Check that pid ${CLAUDE_CHILD_PID} is that Claude process, end it if so (for example \`kill ${CLAUDE_CHILD_PID}\`, or Task Manager on Windows), then retry.`,
  });
  assert.equal(fs.existsSync(orphaned.path), true, 'the lock stays while the child may run');
  assert.equal(fs.existsSync(orphaned.cleanupPath), false, 'no claim is left behind');

  // Once the child is gone the thread is free again.
  table.delete(CLAUDE_CHILD_PID);
  const successor = contend();
  assert.equal(successor.path, orphaned.path);
  assert.equal(readJsonIfReadable<{ jobId?: string }>(successor.path)?.jobId, 'job-next');
  assert.equal(fs.existsSync(successor.cleanupPath), false);
  releaseThreadReservation(successor);

  // A recorded child pid that now runs something else, or another Claude
  // process started at another time, is not that child: it does not hold
  // the thread.
  for (const [childPid, threadId] of [
    [FOREIGN_CHILD_PID, 'stood-in-foreign-child'],
    [REUSED_PID, 'stood-in-reused-child'],
  ] as const) {
    const reused = writeReservationLock(threadId, {
      jobId: 'job-reused-child',
      pid: STOOD_IN_DEAD_PID,
      childPid,
      childPidStart: RECORDED_START,
    });
    const next = acquireThreadReservation(threadId, { jobId: 'job-after-reuse' }, ops);
    assert.equal(next.path, reused.path);
    assert.equal(readJsonIfReadable<{ jobId?: string }>(next.path)?.jobId, 'job-after-reuse');
    releaseThreadReservation(next);
  }
});

// A takeover can lose to another cleaner's claim appearing after the entry
// check, or to another acquirer slipping in after the reap. Both are races
// between processes, so the other party is played by the two fs calls it
// would have interleaved with.
test('a takeover lost to a concurrent cleaner or acquirer asks for a retry', (t) => {
  const codexHome = useTempCodexHome(t);
  const threadId = 'contested-takeover';
  const paths = reservationPaths(codexHome, threadId);
  const original = {
    existsSync: Object.getOwnPropertyDescriptor(fs, 'existsSync')!,
    writeFileSync: Object.getOwnPropertyDescriptor(fs, 'writeFileSync')!,
  };
  const restore = (): void => {
    Object.defineProperty(fs, 'existsSync', original.existsSync);
    Object.defineProperty(fs, 'writeFileSync', original.writeFileSync);
  };
  t.after(restore);
  const stub = (name: keyof typeof original, value: unknown): void => {
    Object.defineProperty(fs, name, { ...original[name], value });
  };
  const eexist = (): Error =>
    Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
  const seedDeadOwner = (): void =>
    writeRecord(paths.lockPath, lockRecord(threadId, { jobId: 'job-dead', pid: DEAD_PID }));
  const refusal = (): string => {
    try {
      acquireThreadReservation(threadId, { jobId: 'job-late' });
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('expected the takeover to be refused');
  };
  const messages: string[] = [];

  // 1. A cleaner claims the dead owner's lock the moment this run has looked
  //    for a claim and seen none: the takeover claim fails, the lock is the
  //    cleaner's to remove.
  seedDeadOwner();
  let claimPending = true;
  stub('existsSync', (target: fs.PathLike) => {
    if (String(target) === paths.claimPath && claimPending) {
      claimPending = false;
      writeRecord(paths.claimPath, claimRecord({ jobId: 'other-cleaner', pid: process.pid }));
      return false;
    }
    return original.existsSync.value.call(fs, target);
  });
  messages.push(refusal());
  restore();
  assert.equal(fs.existsSync(paths.lockPath), true, 'the lock is left to the cleaner');
  fs.unlinkSync(paths.claimPath);
  fs.unlinkSync(paths.lockPath);

  // 2. The reap succeeds, but another acquirer's record lands before this
  //    run's retry.
  seedDeadOwner();
  let competitorWrites = 0;
  stub(
    'writeFileSync',
    (target: fs.PathOrFileDescriptor, data: unknown, options?: fs.WriteFileOptions) => {
      if (
        String(target) === paths.lockPath &&
        !original.existsSync.value.call(fs, paths.lockPath)
      ) {
        competitorWrites += 1;
        original.writeFileSync.value.call(
          fs,
          paths.lockPath,
          `${JSON.stringify(lockRecord(threadId, { jobId: 'job-competitor', pid: process.pid }))}\n`,
          'utf8',
        );
        throw eexist();
      }
      return original.writeFileSync.value.call(fs, target, data, options);
    },
  );
  messages.push(refusal());
  restore();
  assert.equal(competitorWrites, 1);
  fs.unlinkSync(paths.lockPath);
  assert.equal(fs.existsSync(paths.claimPath), false, 'the takeover claim is released');

  // One message for every lost takeover: a retry, never a manual delete.
  assert.deepEqual(
    messages,
    Array(2).fill(
      `Session or thread ${threadId} is busy or being reclaimed by another companion run; retry in a moment.`,
    ),
  );
});

test('a lock released between the create and the read is created again, not reported unreadable', (t) => {
  const codexHome = useTempCodexHome(t);
  const threadId = 'released-mid-acquire';
  const paths = reservationPaths(codexHome, threadId);
  const original = Object.getOwnPropertyDescriptor(fs, 'writeFileSync')!;
  t.after(() => Object.defineProperty(fs, 'writeFileSync', original));
  // The first create finds the previous run's lock; the run releases it
  // before this acquirer reads it.
  let creates = 0;
  Object.defineProperty(fs, 'writeFileSync', {
    ...original,
    value: (target: fs.PathOrFileDescriptor, data: unknown, options?: fs.WriteFileOptions) => {
      if (String(target) === paths.lockPath) {
        creates += 1;
        if (creates === 1) {
          throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
        }
      }
      return original.value.call(fs, target, data, options);
    },
  });
  const reservation = acquireThreadReservation(threadId, { jobId: 'job-next' });
  Object.defineProperty(fs, 'writeFileSync', original);
  assert.equal(creates, 2);
  assert.equal(readJsonIfReadable<{ jobId?: string }>(paths.lockPath)?.jobId, 'job-next');
  assert.equal(releaseThreadReservation(reservation).released, true);
});

test('the stranded scan reaps a dead owner lock only once its Claude child is provably gone', (t) => {
  useTempCodexHome(t);
  const gone = writeReservationLock('scan-child-gone', {
    jobId: 'job-child-gone',
    pid: DEAD_PID,
    childPid: DEAD_PID - 1,
  });
  const held = writeReservationLock('scan-child-held', {
    jobId: 'job-child-held',
    pid: DEAD_PID,
    childPid: LIVE_PID,
  });

  assert.deepEqual(listStrandedThreadReservations(scanOps), [], 'neither is listed');
  assert.equal(fs.existsSync(gone.path), false, 'owner and child gone: reaped');
  assert.equal(fs.existsSync(held.path), true, 'left to the next acquire');
  assert.equal(fs.existsSync(held.cleanupPath), false, 'no claim is left behind');
  assert.equal(releaseThreadReservation(held).released, true);
});

test('a dead record the scan cannot remove is listed with its path', (t) => {
  const codexHome = useTempCodexHome(t);
  const lock = writeReservationLock('scan-stuck-lock', { jobId: 'job-stuck', pid: DEAD_PID });
  const { claimPath } = reservationPaths(codexHome, 'scan-stuck-claim');
  writeRecord(claimPath, claimRecord({ jobId: 'job-stuck-claim', pid: DEAD_PID }));
  const stuck = [lock.path, claimPath];
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (target: fs.PathLike) => {
    if (stuck.includes(String(target))) {
      throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${String(target)}'`), {
        code: 'EPERM',
      });
    }
    return unlink(target);
  });
  const listed = listStrandedThreadReservations();
  t.mock.restoreAll();

  const expected: StrandedReservationEntry[] = [
    {
      kind: 'scan-error',
      path: lock.path,
      detail: `EPERM: operation not permitted, unlink '${lock.path}'`,
    },
    {
      kind: 'scan-error',
      path: claimPath,
      detail: 'a cleanup claim whose process is gone could not be removed',
    },
  ];
  assert.deepEqual(
    listed,
    expected.sort((left, right) => entrySortPath(left).localeCompare(entrySortPath(right))),
  );
  assert.equal(fs.existsSync(lock.cleanupPath), false, 'the scan released its own claim');
  assert.ok(describeStrandedReservation(listed[0]).includes(`\`${entrySortPath(listed[0]!)}\``));

  // Removable again: the next scan reaps both and lists nothing.
  assert.deepEqual(listStrandedThreadReservations(), []);
  assert.deepEqual(
    stuck.map((target) => fs.existsSync(target)),
    [false, false],
  );
});

test('a lock naming this very pid with an earlier start is a reused pid: taken over', (t) => {
  const codexHome = useTempCodexHome(t);
  const paths = reservationPaths(codexHome, 'reused-own-pid');
  // This pid's earlier process: an earlier start of the same kind as this one's.
  const own = currentProcessStartToken();
  const earlier = own.startsWith('linux:')
    ? withTicks(own, ticksOf(own) - 1)
    : `wall:${Date.now() - 86_400_000}`;
  const stale = {
    ...lockRecord('reused-own-pid', { jobId: 'job-earlier', pid: process.pid }),
    pidStart: earlier,
  };
  writeRecord(paths.lockPath, stale);
  const successor = acquireThreadReservation('reused-own-pid', { jobId: 'job-now' });
  assert.equal(successor.path, paths.lockPath);
  assert.equal(readJsonIfReadable<{ jobId?: string }>(successor.path)?.jobId, 'job-now');
  assert.equal(
    releaseThreadReservation({ path: paths.lockPath, token: stale.token }).released,
    false,
  );

  // Recorded with this process's own start, the lock is live: busy.
  assert.throws(
    () => acquireThreadReservation('reused-own-pid', { jobId: 'job-third' }),
    /already being used by another companion run \(job job-now\)/,
  );
  assert.equal(releaseThreadReservation(successor).released, true);
});

test('a lock the filesystem briefly refuses to read is retried, and never earns a delete hint', (t) => {
  const codexHome = useTempCodexHome(t);
  const threadId = 'busy-lock-read';
  const paths = reservationPaths(codexHome, threadId);
  writeRecord(paths.lockPath, lockRecord(threadId, { jobId: 'job-live', pid: process.pid }));
  const refuse = (times: number): void => {
    const original = fs.readFileSync;
    let calls = 0;
    t.mock.method(fs, 'readFileSync', ((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file) === paths.lockPath && calls < times) {
        calls += 1;
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${String(file)}'`), {
          code: 'EBUSY',
        });
      }
      return original(file, options as Parameters<typeof fs.readFileSync>[1]);
    }) as typeof fs.readFileSync);
  };
  const contend = () => acquireThreadReservation(threadId, { jobId: 'job-contender' });

  // A scan holding the file for a moment: the retry reads the live owner.
  refuse(2);
  assert.throws(contend, /already being used by another companion run \(job job-live\)/);
  t.mock.restoreAll();

  // A file that stays unreadable: a retry is asked for, not a delete.
  refuse(Number.POSITIVE_INFINITY);
  assert.throws(contend, (error: Error) => {
    assert.match(error.message, /could not be read \(EBUSY: .*\)\. Retry in a moment\./);
    assert.doesNotMatch(error.message, /[Dd]elete/);
    return true;
  });
  t.mock.restoreAll();
  assert.equal(fs.existsSync(paths.lockPath), true, 'the live lock is untouched');
  fs.rmSync(paths.lockPath, { force: true });
});

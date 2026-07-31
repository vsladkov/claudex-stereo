import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import {
  acquireThreadReservation,
  describeStrandedReservation,
  listStrandedThreadReservations,
  releaseThreadReservation,
  releaseThreadReservationForCancelledJob,
} from '../plugins/stereo/src/runtime/index.ts';
import type { StrandedReservationEntry } from '../plugins/stereo/src/runtime/index.ts';
import {
  markLiveReservationPhase,
  releaseEligibleLiveReservations,
} from '../plugins/stereo/src/runtime/reservations.ts';
import { releaseLockForDeadOwner } from '../plugins/stereo/src/broker/server.ts';
import { claimAndDeleteThreadLock } from '../plugins/stereo/src/workspace/thread-lock-io.ts';
import { makeTempDir } from './helpers.ts';

const DEAD_PID = 2147483647;

interface ReservationPathPair {
  lockPath: string;
  claimPath: string;
}

function useTempCodexHome(t: TestContext) {
  const previous = process.env.CODEX_HOME;
  const codexHome = makeTempDir('codex-home-');
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  return entry.lockPath ?? entry.claimPath ?? entry.path ?? entry.paths?.[0] ?? '';
}

test('thread reservations are exclusive, path-safe, and token-released', (t) => {
  const codexHome = useTempCodexHome(t);
  const reservation = acquireThreadReservation('../escape', {
    jobId: 'job-owner',
    pid: process.pid,
  });

  assert.equal(path.dirname(reservation.path), path.join(codexHome, 'companion-thread-locks'));
  assert.match(path.basename(reservation.path), /^[a-f0-9]{32}\.lock$/);
  assert.throws(
    () => acquireThreadReservation('../escape', { jobId: 'job-contender', pid: process.pid }),
    /already being used by another Codex run/,
  );

  const original = JSON.parse(fs.readFileSync(reservation.path, 'utf8'));
  fs.writeFileSync(
    reservation.path,
    `${JSON.stringify({ ...original, token: 'foreign-token' })}\n`,
    'utf8',
  );
  assert.equal(releaseThreadReservation(reservation).status, 'token-mismatch');
  assert.equal(fs.existsSync(reservation.path), true);

  fs.writeFileSync(reservation.path, `${JSON.stringify(original)}\n`, 'utf8');
  assert.equal(releaseThreadReservation(reservation).released, true);
  assert.equal(fs.existsSync(reservation.path), false);

  fs.writeFileSync(reservation.cleanupPath, '{}\n', 'utf8');
  assert.throws(
    () =>
      acquireThreadReservation('../escape', { jobId: 'job-after-cleanup-crash', pid: process.pid }),
    (error: Error) => {
      assert.match(error.message, /if it appears stuck, run `\/stereo:setup`/);
      assert.doesNotMatch(error.message, /delete .*\.lock/i);
      return true;
    },
  );
  fs.unlinkSync(reservation.cleanupPath);

  const dead = acquireThreadReservation('dead-thread', {
    jobId: 'job-dead',
    pid: 2147483647,
  });
  assert.throws(
    () => acquireThreadReservation('dead-thread', { jobId: 'job-next', pid: process.pid }),
    new RegExp(
      `appears to have crashed[\\s\\S]*${dead.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    ),
  );
  releaseThreadReservation(dead);
});

test('acquisition reaps a cleanup claim left by a dead process', (t) => {
  const codexHome = useTempCodexHome(t);
  const paths = reservationPaths(codexHome, 'dead-cleanup-claim');
  writeRecord(paths.claimPath, claimRecord({ jobId: 'crashed-cleaner', pid: DEAD_PID }));

  const reservation = acquireThreadReservation('dead-cleanup-claim', {
    jobId: 'replacement-owner',
    pid: process.pid,
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

test('claimAndDeleteThreadLock retries once after reaping a dead cleanup claim', async (t) => {
  useTempCodexHome(t);
  const reservation = acquireThreadReservation('dead-claim-delete', {
    jobId: 'reservation-owner',
    pid: DEAD_PID,
  });
  writeRecord(reservation.cleanupPath, claimRecord({ jobId: 'crashed-cleaner', pid: DEAD_PID }));

  const result = await claimAndDeleteThreadLock(reservation.threadId, {
    verify: (record) => ({ ok: record.token === reservation.token }),
  });

  assert.equal(result.released, true);
  assert.equal(fs.existsSync(reservation.path), false);
  assert.equal(fs.existsSync(reservation.cleanupPath), false);
  releaseThreadReservation(reservation);
});

test('live reservations release only in pre-turn and post-turn phases', (t) => {
  useTempCodexHome(t);
  const preTurn = acquireThreadReservation('live-pre-turn');
  const postTurn = acquireThreadReservation('live-post-turn');
  const inFlight = acquireThreadReservation('live-in-flight');
  const normallyReleased = acquireThreadReservation('live-normal-release');
  t.after(() => {
    for (const reservation of [preTurn, postTurn, inFlight, normallyReleased]) {
      releaseThreadReservation(reservation);
    }
  });

  markLiveReservationPhase(postTurn, 'post-turn');
  markLiveReservationPhase(inFlight, 'in-flight');
  markLiveReservationPhase({ ...preTurn }, 'post-turn');

  assert.equal(releaseThreadReservation(normallyReleased).released, true);
  assert.deepEqual(releaseEligibleLiveReservations(), { released: 2, retained: 1 });
  assert.equal(fs.existsSync(preTurn.path), false);
  assert.equal(fs.existsSync(postTurn.path), false);
  assert.equal(fs.existsSync(inFlight.path), true);
  assert.deepEqual(releaseEligibleLiveReservations(), { released: 0, retained: 1 });

  assert.equal(releaseThreadReservation(inFlight).released, true);
  assert.deepEqual(releaseEligibleLiveReservations(), { released: 0, retained: 0 });
  assert.deepEqual(releaseEligibleLiveReservations(), { released: 0, retained: 0 });
});

test('signal-time release never unlinks a reservation replaced by another owner', (t) => {
  useTempCodexHome(t);
  const reservation = acquireThreadReservation('live-token-mismatch');
  markLiveReservationPhase(reservation, 'post-turn');
  const replacement = {
    ...JSON.parse(fs.readFileSync(reservation.path, 'utf8')),
    token: 'replacement-token',
    jobId: 'replacement-job',
  };
  fs.writeFileSync(reservation.path, `${JSON.stringify(replacement)}\n`, 'utf8');
  t.after(() => {
    releaseThreadReservation({ path: reservation.path, token: replacement.token });
    releaseThreadReservation(reservation);
  });

  assert.deepEqual(releaseEligibleLiveReservations(), { released: 0, retained: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(reservation.path, 'utf8')), replacement);
  assert.deepEqual(releaseEligibleLiveReservations(), { released: 0, retained: 1 });
});

test('signal-time release retains an eligible reservation with a foreign job id', (t) => {
  useTempCodexHome(t);
  const reservation = acquireThreadReservation('live-job-mismatch', {
    jobId: 'original-job',
  });
  markLiveReservationPhase(reservation, 'post-turn');
  const replacement = {
    ...JSON.parse(fs.readFileSync(reservation.path, 'utf8')),
    jobId: 'foreign-job',
  };
  fs.writeFileSync(reservation.path, `${JSON.stringify(replacement)}\n`, 'utf8');
  t.after(() => {
    try {
      fs.unlinkSync(reservation.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        throw error;
      }
    }
    releaseThreadReservation(reservation);
  });

  assert.deepEqual(releaseEligibleLiveReservations(), { released: 0, retained: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(reservation.path, 'utf8')), replacement);
  assert.deepEqual(releaseEligibleLiveReservations(), { released: 0, retained: 1 });
});

test('stranded reservation scanning reconciles every readable lock and claim state', (t) => {
  const codexHome = useTempCodexHome(t);
  const paths: Record<string, ReservationPathPair> = {};

  function seedLock(name: string, pid: number) {
    const pair = reservationPaths(codexHome, name);
    paths[name] = pair;
    writeRecord(pair.lockPath, lockRecord(name, { jobId: `job-${name}`, pid }));
    return pair;
  }

  function seedClaim(name: string, pid: number) {
    const pair = paths[name] ?? reservationPaths(codexHome, name);
    paths[name] = pair;
    writeRecord(pair.claimPath, claimRecord({ jobId: `job-${name}`, pid }));
    return pair;
  }

  seedLock('live-lock', process.pid);
  seedLock('live-lock-live-claim', process.pid);
  seedClaim('live-lock-live-claim', process.pid);
  seedLock('dead-lock', DEAD_PID);
  seedLock('dead-lock-live-claim', DEAD_PID);
  seedClaim('dead-lock-live-claim', process.pid);
  seedLock('dead-lock-dead-claim', DEAD_PID);
  seedClaim('dead-lock-dead-claim', DEAD_PID);
  seedClaim('orphaned-dead-claim', DEAD_PID);
  seedClaim('orphaned-live-claim', process.pid);
  seedLock('live-lock-dead-claim', process.pid);
  seedClaim('live-lock-dead-claim', DEAD_PID);

  const stranded = listStrandedThreadReservations();
  assert.equal(stranded.length, 4);

  assert.deepEqual(
    stranded.find((entry) => entry.lockPath === paths['dead-lock']!.lockPath),
    {
      kind: 'stranded-reservation',
      lockPath: paths['dead-lock']!.lockPath,
      threadId: 'dead-lock',
      jobId: 'job-dead-lock',
      pid: DEAD_PID,
    },
  );

  const strandedCleanup = stranded.find(
    (entry) => entry.lockPath === paths['dead-lock-dead-claim']!.lockPath,
  );
  assert.deepEqual(strandedCleanup, {
    kind: 'stranded-cleanup',
    lockPath: paths['dead-lock-dead-claim']!.lockPath,
    claimPath: paths['dead-lock-dead-claim']!.claimPath,
    threadId: 'dead-lock-dead-claim',
    jobId: 'job-dead-lock-dead-claim',
    pid: DEAD_PID,
  });
  assert.ok(strandedCleanup);
  const cleanupRemedy = describeStrandedReservation(strandedCleanup);
  assert.match(cleanupRemedy, /Delete both/);
  assert.ok(cleanupRemedy.includes(`\`${strandedCleanup.lockPath}\``));
  assert.ok(cleanupRemedy.includes(`\`${strandedCleanup.claimPath}\``));

  assert.deepEqual(
    stranded.find((entry) => entry.claimPath === paths['orphaned-dead-claim']!.claimPath),
    {
      kind: 'orphaned-claim',
      claimPath: paths['orphaned-dead-claim']!.claimPath,
      jobId: 'job-orphaned-dead-claim',
      pid: DEAD_PID,
    },
  );

  const claimOnly = stranded.find(
    (entry) => entry.claimPath === paths['live-lock-dead-claim']!.claimPath,
  );
  assert.deepEqual(claimOnly, {
    kind: 'orphaned-claim',
    claimPath: paths['live-lock-dead-claim']!.claimPath,
    jobId: 'job-live-lock-dead-claim',
    pid: DEAD_PID,
  });
  const claimOnlyRemedy = describeStrandedReservation(claimOnly);
  assert.ok(claimOnlyRemedy.includes(`\`${paths['live-lock-dead-claim']!.claimPath}\``));
  assert.equal(claimOnlyRemedy.includes(`\`${paths['live-lock-dead-claim']!.lockPath}\``), false);

  for (const healthyName of [
    'live-lock',
    'live-lock-live-claim',
    'dead-lock-live-claim',
    'orphaned-live-claim',
  ]) {
    assert.equal(
      stranded.some(
        (entry) =>
          entry.lockPath === paths[healthyName]!.lockPath ||
          entry.claimPath === paths[healthyName]!.claimPath,
      ),
      false,
      `${healthyName} should not be reported`,
    );
  }

  const sortPaths = stranded.map(entrySortPath);
  assert.deepEqual(
    sortPaths,
    [...sortPaths].sort((left, right) => left.localeCompare(right)),
  );
  assert.deepEqual(listStrandedThreadReservations(), stranded);
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
    assert.doesNotMatch(remedy, /crashed Codex run|Delete both/i);
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

test('cancel cleanup discovers a reservation without a recorded thread id', async (t) => {
  useTempCodexHome(t);
  const reservation = acquireThreadReservation('scan-thread', {
    jobId: 'job-scan',
    pid: 8111,
  });

  const result = await releaseThreadReservationForCancelledJob(
    { jobId: 'job-scan', pid: 8111 },
    { isProcessAlive: () => false },
  );

  assert.equal(result.status, 'scan-released');
  assert.equal(fs.existsSync(reservation.path), false);
});

test('cancel cleanup re-reads after owner death and preserves a successor', async (t) => {
  useTempCodexHome(t);
  const owner = acquireThreadReservation('successor-thread', {
    jobId: 'job-owner-a',
    pid: 8222,
  });
  const enteredWait = deferred();
  const resumeWait = deferred();
  let ownerAlive = true;

  const cleanup = releaseThreadReservationForCancelledJob(
    { threadId: 'successor-thread', jobId: 'job-owner-a', pid: 8222 },
    {
      isProcessAlive: () => ownerAlive,
      pollMs: 1,
      timeoutMs: 1000,
      duringDeathWait: async () => {
        enteredWait.resolve();
        await resumeWait.promise;
      },
    },
  );

  await enteredWait.promise;
  assert.equal(releaseThreadReservation(owner).released, true);
  const successor = acquireThreadReservation('successor-thread', {
    jobId: 'job-owner-b',
    pid: process.pid,
  });
  ownerAlive = false;
  resumeWait.resolve();

  const result = await cleanup;
  assert.equal(result.status, 'mismatch-skipped');
  assert.equal(fs.existsSync(successor.path), true);
  releaseThreadReservation(successor);
});

test('cancel cleanup admits one claimant and never removes a later owner', async (t) => {
  useTempCodexHome(t);
  const owner = acquireThreadReservation('claimed-thread', {
    jobId: 'job-claimed',
    pid: 8333,
  });
  const beforeUnlink = deferred();
  const resumeUnlink = deferred();

  const firstCleanup = releaseThreadReservationForCancelledJob(
    { threadId: 'claimed-thread', jobId: 'job-claimed', pid: 8333 },
    {
      isProcessAlive: () => false,
      beforeUnlink: async () => {
        beforeUnlink.resolve();
        await resumeUnlink.promise;
      },
    },
  );
  await beforeUnlink.promise;

  const secondCleanup = await releaseThreadReservationForCancelledJob(
    { threadId: 'claimed-thread', jobId: 'job-claimed', pid: 8333 },
    { isProcessAlive: () => false },
  );
  assert.equal(secondCleanup.status, 'claim-skipped');
  assert.throws(
    () => acquireThreadReservation('claimed-thread', { jobId: 'job-contender', pid: process.pid }),
    /Reservation cleanup is already in progress/,
  );

  resumeUnlink.resolve();
  assert.equal((await firstCleanup).status, 'released');
  assert.equal(fs.existsSync(owner.path), false);

  const successor = acquireThreadReservation('claimed-thread', {
    jobId: 'job-successor',
    pid: process.pid,
  });
  const staleCleanup = await releaseThreadReservationForCancelledJob(
    { threadId: 'claimed-thread', jobId: 'job-claimed', pid: 8333 },
    { isProcessAlive: () => false },
  );
  assert.equal(staleCleanup.status, 'mismatch-skipped');
  assert.equal(fs.existsSync(successor.path), true);
  releaseThreadReservation(successor);
});

test('the shared cleanup core verifies under an exclusive claim and preserves hook ordering', async (t) => {
  useTempCodexHome(t);
  const accepted = acquireThreadReservation('shared-core-accepted', {
    jobId: 'job-shared-core',
    pid: DEAD_PID,
  });
  let hookRan = false;
  const acceptedResult = await claimAndDeleteThreadLock(accepted.threadId, {
    verify: (record) => ({
      ok:
        record.threadId === accepted.threadId &&
        record.pid === accepted.pid &&
        record.token === accepted.token,
    }),
    beforeUnlink: ({ lockPath, cleanupPath }) => {
      assert.equal(fs.existsSync(lockPath), true);
      assert.equal(fs.existsSync(cleanupPath), true);
      hookRan = true;
    },
  });
  assert.equal(acceptedResult.released, true);
  assert.equal(hookRan, true);
  assert.equal(fs.existsSync(accepted.path), false);
  assert.equal(fs.existsSync(accepted.cleanupPath), false);

  const rejected = acquireThreadReservation('shared-core-rejected', {
    jobId: 'job-shared-core-rejected',
    pid: DEAD_PID,
  });
  const rejectedResult = await claimAndDeleteThreadLock(rejected.threadId, {
    verify: () => ({ ok: false, reason: 'expected rejection' }),
  });
  assert.equal(rejectedResult.status, 'verification-failed');
  assert.equal(fs.existsSync(rejected.path), true);
  assert.equal(fs.existsSync(rejected.cleanupPath), false);
  releaseThreadReservation(rejected);

  const foreignClaim = acquireThreadReservation('shared-core-foreign-claim', {
    jobId: 'job-foreign-claim',
    pid: DEAD_PID,
  });
  const claim = claimRecord({ jobId: 'foreign-cleaner', pid: process.pid });
  writeRecord(foreignClaim.cleanupPath, claim);
  const claimResult = await claimAndDeleteThreadLock(foreignClaim.threadId, {
    verify: () => ({ ok: true }),
  });
  assert.equal(claimResult.status, 'claim-exists');
  assert.deepEqual(JSON.parse(fs.readFileSync(foreignClaim.cleanupPath, 'utf8')), claim);
  assert.equal(fs.existsSync(foreignClaim.path), true);
  fs.unlinkSync(foreignClaim.cleanupPath);
  releaseThreadReservation(foreignClaim);
});

test('broker cleanup releases only the captured dead reservation identity', async (t) => {
  useTempCodexHome(t);
  const matching = acquireThreadReservation('broker-release-match', {
    jobId: 'job-broker-match',
    pid: DEAD_PID,
  });
  let livenessProbes = 0;
  const matchingResult = await releaseLockForDeadOwner(
    matching.threadId,
    { pid: matching.pid, token: matching.token },
    {
      isProcessAlive: () => {
        livenessProbes += 1;
        return livenessProbes === 1;
      },
      timeoutMs: 100,
      pollMs: 1,
    },
  );
  assert.equal(matchingResult.released, true);
  assert.equal(livenessProbes >= 2, true);
  assert.equal(fs.existsSync(matching.path), false);

  for (const mismatch of ['token', 'pid', 'thread'] as const) {
    const reservation = acquireThreadReservation(`broker-release-${mismatch}`, {
      jobId: `job-broker-${mismatch}`,
      pid: DEAD_PID,
    });
    const original = JSON.parse(fs.readFileSync(reservation.path, 'utf8'));
    if (mismatch === 'thread') {
      fs.writeFileSync(
        reservation.path,
        `${JSON.stringify({ ...original, threadId: 'replacement-thread' })}\n`,
        'utf8',
      );
    }
    const identity = {
      pid: mismatch === 'pid' ? DEAD_PID - 1 : reservation.pid,
      token: mismatch === 'token' ? 'replacement-token' : reservation.token,
    };
    const result = await releaseLockForDeadOwner(reservation.threadId, identity, {
      isProcessAlive: () => false,
      timeoutMs: 0,
      pollMs: 1,
    });
    assert.equal(result.released, false, mismatch);
    assert.equal(fs.existsSync(reservation.path), true, mismatch);
    fs.unlinkSync(reservation.path);
    releaseThreadReservation(reservation);
  }

  const live = acquireThreadReservation('broker-release-live', {
    jobId: 'job-broker-live',
    pid: process.pid,
  });
  const liveResult = await releaseLockForDeadOwner(
    live.threadId,
    { pid: live.pid, token: live.token },
    { isProcessAlive: () => true, timeoutMs: 0, pollMs: 1 },
  );
  assert.equal(liveResult.released, false);
  assert.match(liveResult.reason, /remained alive/);
  assert.equal(fs.existsSync(live.path), true);
  releaseThreadReservation(live);
});

test('cancel and broker cleanup serialize through one claim', async (t) => {
  useTempCodexHome(t);
  const reservation = acquireThreadReservation('concurrent-cleaners', {
    jobId: 'job-concurrent-cleaners',
    pid: 8555,
  });

  const [cancelResult, brokerResult] = await Promise.all([
    releaseThreadReservationForCancelledJob(
      {
        threadId: reservation.threadId,
        jobId: reservation.jobId,
        pid: reservation.pid,
      },
      { isProcessAlive: () => false },
    ),
    releaseLockForDeadOwner(
      reservation.threadId,
      { pid: reservation.pid, token: reservation.token },
      { isProcessAlive: () => false, timeoutMs: 0, pollMs: 1 },
    ),
  ]);

  assert.equal(Number(cancelResult.released) + Number(brokerResult.released), 1);
  assert.equal(fs.existsSync(reservation.path), false);
  assert.equal(fs.existsSync(reservation.cleanupPath), false);
});

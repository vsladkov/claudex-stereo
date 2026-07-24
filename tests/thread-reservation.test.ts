import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import {
  acquireThreadReservation,
  describeStrandedReservation,
  listStrandedThreadReservations,
  releaseThreadReservation,
  releaseThreadReservationForCancelledJob
} from "../plugins/stereo/src/runtime/index.ts";
import type { StrandedReservationEntry } from "../plugins/stereo/src/runtime/index.ts";
import { makeTempDir } from "./helpers.ts";

const DEAD_PID = 2147483647;

interface ReservationPathPair {
  lockPath: string;
  claimPath: string;
}

function useTempCodexHome(t: TestContext) {
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function reservationPaths(codexHome: string, threadId: string): ReservationPathPair {
  const digest = crypto.createHash("sha256").update(String(threadId)).digest("hex").slice(0, 32);
  const lockPath = path.join(codexHome, "companion-thread-locks", `${digest}.lock`);
  return { lockPath, claimPath: `${lockPath}.cleanup` };
}

function lockRecord(threadId: string, { jobId, pid }: { jobId: string; pid: number }) {
  return {
    token: `token-${threadId}`,
    pid,
    jobId,
    threadId,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function claimRecord({ jobId, pid }: { jobId: string; pid: number }) {
  return {
    pid,
    jobId,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function writeRecord(recordPath: string, record: unknown) {
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`, "utf8");
}

function entrySortPath(entry: StrandedReservationEntry) {
  return entry.lockPath ?? entry.claimPath ?? entry.path ?? entry.paths?.[0] ?? "";
}

test("thread reservations are exclusive, path-safe, and token-released", (t) => {
  const codexHome = useTempCodexHome(t);
  const reservation = acquireThreadReservation("../escape", {
    jobId: "job-owner",
    pid: process.pid
  });

  assert.equal(path.dirname(reservation.path), path.join(codexHome, "companion-thread-locks"));
  assert.match(path.basename(reservation.path), /^[a-f0-9]{32}\.lock$/);
  assert.throws(
    () => acquireThreadReservation("../escape", { jobId: "job-contender", pid: process.pid }),
    /already being used by another Codex run/
  );

  const original = JSON.parse(fs.readFileSync(reservation.path, "utf8"));
  fs.writeFileSync(reservation.path, `${JSON.stringify({ ...original, token: "foreign-token" })}\n`, "utf8");
  assert.equal(releaseThreadReservation(reservation).status, "token-mismatch");
  assert.equal(fs.existsSync(reservation.path), true);

  fs.writeFileSync(reservation.path, `${JSON.stringify(original)}\n`, "utf8");
  assert.equal(releaseThreadReservation(reservation).released, true);
  assert.equal(fs.existsSync(reservation.path), false);

  fs.writeFileSync(reservation.cleanupPath, "{}\n", "utf8");
  assert.throws(
    () => acquireThreadReservation("../escape", { jobId: "job-after-cleanup-crash", pid: process.pid }),
    (error: Error) => {
      assert.match(error.message, /if it appears stuck, run `\/stereo:setup`/);
      assert.doesNotMatch(error.message, /delete .*\.lock/i);
      return true;
    }
  );
  fs.unlinkSync(reservation.cleanupPath);

  const dead = acquireThreadReservation("dead-thread", {
    jobId: "job-dead",
    pid: 2147483647
  });
  assert.throws(
    () => acquireThreadReservation("dead-thread", { jobId: "job-next", pid: process.pid }),
    new RegExp(`appears to have crashed[\\s\\S]*${dead.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  releaseThreadReservation(dead);
});

test("stranded reservation scanning reconciles every readable lock and claim state", (t) => {
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

  seedLock("live-lock", process.pid);
  seedLock("live-lock-live-claim", process.pid);
  seedClaim("live-lock-live-claim", process.pid);
  seedLock("dead-lock", DEAD_PID);
  seedLock("dead-lock-live-claim", DEAD_PID);
  seedClaim("dead-lock-live-claim", process.pid);
  seedLock("dead-lock-dead-claim", DEAD_PID);
  seedClaim("dead-lock-dead-claim", DEAD_PID);
  seedClaim("orphaned-dead-claim", DEAD_PID);
  seedClaim("orphaned-live-claim", process.pid);
  seedLock("live-lock-dead-claim", process.pid);
  seedClaim("live-lock-dead-claim", DEAD_PID);

  const stranded = listStrandedThreadReservations();
  assert.equal(stranded.length, 4);

  assert.deepEqual(
    stranded.find((entry) => entry.lockPath === paths["dead-lock"]!.lockPath),
    {
      kind: "stranded-reservation",
      lockPath: paths["dead-lock"]!.lockPath,
      threadId: "dead-lock",
      jobId: "job-dead-lock",
      pid: DEAD_PID
    }
  );

  const strandedCleanup = stranded.find(
    (entry) => entry.lockPath === paths["dead-lock-dead-claim"]!.lockPath
  );
  assert.deepEqual(strandedCleanup, {
    kind: "stranded-cleanup",
    lockPath: paths["dead-lock-dead-claim"]!.lockPath,
    claimPath: paths["dead-lock-dead-claim"]!.claimPath,
    threadId: "dead-lock-dead-claim",
    jobId: "job-dead-lock-dead-claim",
    pid: DEAD_PID
  });
  assert.ok(strandedCleanup);
  const cleanupRemedy = describeStrandedReservation(strandedCleanup);
  assert.match(cleanupRemedy, /Delete both/);
  assert.ok(cleanupRemedy.includes(`\`${strandedCleanup.lockPath}\``));
  assert.ok(cleanupRemedy.includes(`\`${strandedCleanup.claimPath}\``));

  assert.deepEqual(
    stranded.find((entry) => entry.claimPath === paths["orphaned-dead-claim"]!.claimPath),
    {
      kind: "orphaned-claim",
      claimPath: paths["orphaned-dead-claim"]!.claimPath,
      jobId: "job-orphaned-dead-claim",
      pid: DEAD_PID
    }
  );

  const claimOnly = stranded.find(
    (entry) => entry.claimPath === paths["live-lock-dead-claim"]!.claimPath
  );
  assert.deepEqual(claimOnly, {
    kind: "orphaned-claim",
    claimPath: paths["live-lock-dead-claim"]!.claimPath,
    jobId: "job-live-lock-dead-claim",
    pid: DEAD_PID
  });
  const claimOnlyRemedy = describeStrandedReservation(claimOnly);
  assert.ok(claimOnlyRemedy.includes(`\`${paths["live-lock-dead-claim"]!.claimPath}\``));
  assert.equal(claimOnlyRemedy.includes(`\`${paths["live-lock-dead-claim"]!.lockPath}\``), false);

  for (const healthyName of [
    "live-lock",
    "live-lock-live-claim",
    "dead-lock-live-claim",
    "orphaned-live-claim"
  ]) {
    assert.equal(
      stranded.some(
        (entry) =>
          entry.lockPath === paths[healthyName]!.lockPath ||
          entry.claimPath === paths[healthyName]!.claimPath
      ),
      false,
      `${healthyName} should not be reported`
    );
  }

  const sortPaths = stranded.map(entrySortPath);
  assert.deepEqual(sortPaths, [...sortPaths].sort((left, right) => left.localeCompare(right)));
  assert.deepEqual(listStrandedThreadReservations(), stranded);
});

test("stranded reservation scanning handles malformed records and directory failures", (t) => {
  const codexHome = useTempCodexHome(t);
  const lockDir = path.join(codexHome, "companion-thread-locks");
  assert.deepEqual(listStrandedThreadReservations(), []);

  fs.writeFileSync(lockDir, "not a directory\n", "utf8");
  const [scanError] = listStrandedThreadReservations();
  assert.ok(scanError);
  assert.equal(scanError.kind, "scan-error");
  assert.equal(scanError.path, lockDir);
  assert.ok(describeStrandedReservation(scanError).includes(`\`${lockDir}\``));
  fs.unlinkSync(lockDir);
  fs.mkdirSync(lockDir, { recursive: true });

  const malformed: Array<[string, string]> = [
    [path.join(lockDir, "empty.lock"), "{}\n"],
    [path.join(lockDir, "null.lock.cleanup"), "null\n"],
    [path.join(lockDir, "array.lock"), "[]\n"],
    [path.join(lockDir, "string-pid.lock.cleanup"), '{"pid":"123","jobId":"job-string-pid"}\n']
  ];
  for (const [recordPath, contents] of malformed) {
    fs.writeFileSync(recordPath, contents, "utf8");
  }

  const invalidLockPair = {
    lockPath: path.join(lockDir, "invalid-lock-pair.lock"),
    claimPath: path.join(lockDir, "invalid-lock-pair.lock.cleanup")
  };
  fs.writeFileSync(invalidLockPair.lockPath, "{}\n", "utf8");
  writeRecord(invalidLockPair.claimPath, claimRecord({ jobId: "job-live-claim", pid: process.pid }));

  const invalidClaimPair = {
    lockPath: path.join(lockDir, "invalid-claim-pair.lock"),
    claimPath: path.join(lockDir, "invalid-claim-pair.lock.cleanup")
  };
  writeRecord(
    invalidClaimPair.lockPath,
    lockRecord("invalid-claim-pair", { jobId: "job-live-owner", pid: process.pid })
  );
  fs.writeFileSync(invalidClaimPair.claimPath, "{}\n", "utf8");

  const unreadable = listStrandedThreadReservations();
  assert.equal(unreadable.length, 6);
  assert.ok(unreadable.every((entry) => entry.kind === "unreadable"));
  for (const entry of unreadable) {
    const remedy = describeStrandedReservation(entry);
    assert.match(remedy, /could not be validated/i);
    assert.doesNotMatch(remedy, /crashed Codex run|Delete both/i);
  }

  const invalidClaimEntry = unreadable.find((entry) => entry.paths?.includes(invalidClaimPair.claimPath));
  assert.ok(invalidClaimEntry?.paths);
  assert.deepEqual(invalidClaimEntry.paths, [invalidClaimPair.claimPath]);
  assert.equal(invalidClaimEntry.paths.includes(invalidClaimPair.lockPath), false);

  const sortPaths = unreadable.map(entrySortPath);
  assert.deepEqual(sortPaths, [...sortPaths].sort((left, right) => left.localeCompare(right)));
});

test("cancel cleanup discovers a reservation without a recorded thread id", async (t) => {
  useTempCodexHome(t);
  const reservation = acquireThreadReservation("scan-thread", {
    jobId: "job-scan",
    pid: 8111
  });

  const result = await releaseThreadReservationForCancelledJob(
    { jobId: "job-scan", pid: 8111 },
    { isProcessAlive: () => false }
  );

  assert.equal(result.status, "scan-released");
  assert.equal(fs.existsSync(reservation.path), false);
});

test("cancel cleanup re-reads after owner death and preserves a successor", async (t) => {
  useTempCodexHome(t);
  const owner = acquireThreadReservation("successor-thread", {
    jobId: "job-owner-a",
    pid: 8222
  });
  const enteredWait = deferred();
  const resumeWait = deferred();
  let ownerAlive = true;

  const cleanup = releaseThreadReservationForCancelledJob(
    { threadId: "successor-thread", jobId: "job-owner-a", pid: 8222 },
    {
      isProcessAlive: () => ownerAlive,
      pollMs: 1,
      timeoutMs: 1000,
      duringDeathWait: async () => {
        enteredWait.resolve();
        await resumeWait.promise;
      }
    }
  );

  await enteredWait.promise;
  assert.equal(releaseThreadReservation(owner).released, true);
  const successor = acquireThreadReservation("successor-thread", {
    jobId: "job-owner-b",
    pid: process.pid
  });
  ownerAlive = false;
  resumeWait.resolve();

  const result = await cleanup;
  assert.equal(result.status, "mismatch-skipped");
  assert.equal(fs.existsSync(successor.path), true);
  releaseThreadReservation(successor);
});

test("cancel cleanup admits one claimant and never removes a later owner", async (t) => {
  useTempCodexHome(t);
  const owner = acquireThreadReservation("claimed-thread", {
    jobId: "job-claimed",
    pid: 8333
  });
  const beforeUnlink = deferred();
  const resumeUnlink = deferred();

  const firstCleanup = releaseThreadReservationForCancelledJob(
    { threadId: "claimed-thread", jobId: "job-claimed", pid: 8333 },
    {
      isProcessAlive: () => false,
      beforeUnlink: async () => {
        beforeUnlink.resolve();
        await resumeUnlink.promise;
      }
    }
  );
  await beforeUnlink.promise;

  const secondCleanup = await releaseThreadReservationForCancelledJob(
    { threadId: "claimed-thread", jobId: "job-claimed", pid: 8333 },
    { isProcessAlive: () => false }
  );
  assert.equal(secondCleanup.status, "claim-skipped");
  assert.throws(
    () => acquireThreadReservation("claimed-thread", { jobId: "job-contender", pid: process.pid }),
    /Reservation cleanup is already in progress/
  );

  resumeUnlink.resolve();
  assert.equal((await firstCleanup).status, "released");
  assert.equal(fs.existsSync(owner.path), false);

  const successor = acquireThreadReservation("claimed-thread", {
    jobId: "job-successor",
    pid: process.pid
  });
  const staleCleanup = await releaseThreadReservationForCancelledJob(
    { threadId: "claimed-thread", jobId: "job-claimed", pid: 8333 },
    { isProcessAlive: () => false }
  );
  assert.equal(staleCleanup.status, "mismatch-skipped");
  assert.equal(fs.existsSync(successor.path), true);
  releaseThreadReservation(successor);
});

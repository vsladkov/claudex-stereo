import assert from "node:assert/strict";
import test from "node:test";

import { describeStrandedReservation } from "../plugins/stereo/src/runtime/reservations.ts";
import type { StrandedReservationEntry } from "../plugins/stereo/src/runtime/reservations.ts";

// describeStrandedReservation is pure: it renders remedies from the entry
// object alone, so these tests use synthetic entries and no CODEX_HOME.

test("stranded-reservation names the crashed owner and the single lock to delete", () => {
  const entry: StrandedReservationEntry = {
    kind: "stranded-reservation",
    lockPath: "/codex-home/companion-thread-locks/abc123.lock",
    threadId: "thr_42",
    jobId: "task-crashed",
    pid: 4242
  };

  assert.equal(
    describeStrandedReservation(entry),
    "A crashed Codex run (job task-crashed, pid 4242) left thread thr_42 reserved. " +
      "Delete `/codex-home/companion-thread-locks/abc123.lock` to release it."
  );
});

test("stranded-reservation renders missing owner fields as unknown", () => {
  const entry: StrandedReservationEntry = {
    kind: "stranded-reservation",
    lockPath: "/locks/orphan.lock",
    jobId: null
  };

  assert.equal(
    describeStrandedReservation(entry),
    "A crashed Codex run (job unknown, pid unknown) left thread unknown reserved. " +
      "Delete `/locks/orphan.lock` to release it."
  );
});

test("stranded-cleanup instructs deleting both the lock and the cleanup claim", () => {
  const entry: StrandedReservationEntry = {
    kind: "stranded-cleanup",
    lockPath: "/locks/pair.lock",
    claimPath: "/locks/pair.lock.cleanup",
    threadId: "thr_9",
    jobId: "task-9",
    pid: 77
  };

  assert.equal(
    describeStrandedReservation(entry),
    "A crashed Codex run (job task-9, pid 77) left thread thr_9 reserved with an abandoned cleanup claim. " +
      "Delete both `/locks/pair.lock` and `/locks/pair.lock.cleanup` to release it."
  );
});

test("orphaned-claim instructs deleting only the claim, never the live lock", () => {
  const entry: StrandedReservationEntry = {
    kind: "orphaned-claim",
    claimPath: "/locks/live.lock.cleanup",
    jobId: "task-5",
    pid: 55
  };

  assert.equal(
    describeStrandedReservation(entry),
    "A crashed reservation cleanup (job task-5, pid 55) left an orphaned claim. " +
      "Delete only `/locks/live.lock.cleanup`; do not delete any accompanying live thread lock."
  );
});

test("unreadable pluralizes by path count and lists every affected path", () => {
  assert.equal(
    describeStrandedReservation({ kind: "unreadable", paths: ["/locks/bad.lock"] }),
    "Thread reservation data at `/locks/bad.lock` could not be validated. " +
      "Inspect the affected file, then delete only invalid records after confirming no live Codex run owns them."
  );

  assert.equal(
    describeStrandedReservation({
      kind: "unreadable",
      paths: ["/locks/bad.lock", "/locks/bad.lock.cleanup"]
    }),
    "Thread reservation data at `/locks/bad.lock` and `/locks/bad.lock.cleanup` could not be validated. " +
      "Inspect the affected files, then delete only invalid records after confirming no live Codex run owns them."
  );

  assert.equal(
    describeStrandedReservation({
      kind: "unreadable",
      paths: ["/locks/a.lock", "/locks/b.lock", "/locks/c.lock"]
    }),
    "Thread reservation data at `/locks/a.lock`, `/locks/b.lock`, and `/locks/c.lock` could not be validated. " +
      "Inspect the affected files, then delete only invalid records after confirming no live Codex run owns them."
  );

  // An entry without paths keeps a readable fallback instead of crashing.
  assert.equal(
    describeStrandedReservation({ kind: "unreadable" }),
    "Thread reservation data at the affected file could not be validated. " +
      "Inspect the affected files, then delete only invalid records after confirming no live Codex run owns them."
  );
});

test("scan-error reports the failing directory and detail", () => {
  assert.equal(
    describeStrandedReservation({
      kind: "scan-error",
      path: "/codex-home/companion-thread-locks",
      detail: "EACCES: permission denied"
    }),
    "Thread reservations could not be scanned at `/codex-home/companion-thread-locks`: " +
      "EACCES: permission denied. Inspect and repair that path."
  );

  assert.equal(
    describeStrandedReservation({ kind: "scan-error", path: "/locks" }),
    "Thread reservations could not be scanned at `/locks`: unknown filesystem error. Inspect and repair that path."
  );
});

test("missing entries fall back to the generic setup guidance", () => {
  const fallback =
    "An unknown stranded thread reservation was detected. Run `/stereo:setup` again for current details.";

  assert.equal(describeStrandedReservation(null), fallback);
  assert.equal(describeStrandedReservation(undefined), fallback);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { describeStrandedReservation } from '../plugins/stereo/src/runtime/reservations.ts';

// describeStrandedReservation is pure: it renders remedies from the entry
// object alone, so these tests use synthetic entries and no CODEX_HOME.

test('unreadable pluralizes by path count and lists every affected path', () => {
  assert.equal(
    describeStrandedReservation({ kind: 'unreadable', paths: ['/locks/bad.lock'] }),
    'Thread reservation data at `/locks/bad.lock` could not be validated. ' +
      'Inspect the affected file, then delete only invalid records after confirming no live companion run owns them.',
  );

  assert.equal(
    describeStrandedReservation({
      kind: 'unreadable',
      paths: ['/locks/bad.lock', '/locks/bad.lock.cleanup'],
    }),
    'Thread reservation data at `/locks/bad.lock` and `/locks/bad.lock.cleanup` could not be validated. ' +
      'Inspect the affected files, then delete only invalid records after confirming no live companion run owns them.',
  );

  assert.equal(
    describeStrandedReservation({
      kind: 'unreadable',
      paths: ['/locks/a.lock', '/locks/b.lock', '/locks/c.lock'],
    }),
    'Thread reservation data at `/locks/a.lock`, `/locks/b.lock`, and `/locks/c.lock` could not be validated. ' +
      'Inspect the affected files, then delete only invalid records after confirming no live companion run owns them.',
  );

  // An entry without paths keeps a readable fallback instead of crashing.
  assert.equal(
    describeStrandedReservation({ kind: 'unreadable' }),
    'Thread reservation data at the affected file could not be validated. ' +
      'Inspect the affected files, then delete only invalid records after confirming no live companion run owns them.',
  );
});

test('scan-error reports the failing directory and detail', () => {
  assert.equal(
    describeStrandedReservation({
      kind: 'scan-error',
      path: '/codex-home/companion-thread-locks',
      detail: 'EACCES: permission denied',
    }),
    'Thread reservations could not be scanned at `/codex-home/companion-thread-locks`: ' +
      'EACCES: permission denied. Inspect and repair that path.',
  );

  assert.equal(
    describeStrandedReservation({ kind: 'scan-error', path: '/locks' }),
    'Thread reservations could not be scanned at `/locks`: unknown filesystem error. Inspect and repair that path.',
  );
});

test('missing entries fall back to the generic setup guidance', () => {
  const fallback =
    'An unknown stranded thread reservation was detected. Run `/stereo:setup` again for current details.';

  assert.equal(describeStrandedReservation(null), fallback);
  assert.equal(describeStrandedReservation(undefined), fallback);
});

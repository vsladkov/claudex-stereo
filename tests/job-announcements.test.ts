import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionJobAnnouncement } from '../plugins/stereo/src/jobs/job-announcements.ts';
import { renderSessionJobAnnouncement } from '../plugins/stereo/src/render/render.ts';
import type { JobRecord } from '../plugins/stereo/src/workspace/state.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const WATERMARK = '2026-08-01T11:00:00.000Z';

test('session announcement is null when a stored watermark has nothing new', () => {
  assert.equal(buildSessionJobAnnouncement([], { watermark: WATERMARK, now: NOW }), null);
});

test('missing watermark initializes without manufacturing job rows', () => {
  assert.deepEqual(buildSessionJobAnnouncement([], { now: NOW }), {
    active: [],
    finished: [],
    activeOverflow: 0,
    finishedOverflow: 0,
    nextWatermark: '2026-08-01T12:00:00.000Z',
  });
});

test('active jobs are newest first and initialize a missing watermark', () => {
  const announcement = buildSessionJobAnnouncement(
    [
      {
        id: 'task-old',
        status: 'queued',
        kind: 'task',
        createdAt: '2026-08-01T11:55:00.000Z',
        updatedAt: '2026-08-01T11:55:00.000Z',
      },
      {
        id: 'plan-new',
        status: 'running',
        kind: 'plan-review',
        startedAt: '2026-08-01T11:59:29.000Z',
        updatedAt: '2026-08-01T11:59:59.000Z',
      },
    ],
    { now: NOW },
  );

  assert.deepEqual(announcement?.active, [
    { id: 'plan-new', kind: 'plan-review', elapsed: '31s', status: 'running' },
    { id: 'task-old', kind: 'rescue', elapsed: '5m 0s', status: 'queued' },
  ]);
  assert.equal(announcement?.nextWatermark, '2026-08-01T12:00:00.000Z');
});

test('only terminal jobs strictly newer than the watermark are announced', () => {
  const announcement = buildSessionJobAnnouncement(
    [
      {
        id: 'new',
        status: 'completed',
        jobClass: 'task',
        startedAt: '2026-08-01T11:08:00.000Z',
        completedAt: '2026-08-01T11:10:03.000Z',
        updatedAt: '2026-08-01T11:10:03.000Z',
      },
      {
        id: 'equal',
        status: 'failed',
        updatedAt: WATERMARK,
      },
      {
        id: 'old',
        status: 'cancelled',
        updatedAt: '2026-08-01T10:59:59.000Z',
      },
    ],
    { watermark: WATERMARK, now: NOW },
  );

  assert.deepEqual(announcement?.finished, [
    { id: 'new', kind: 'rescue', status: 'completed', duration: '2m 3s' },
  ]);
  assert.equal(announcement?.nextWatermark, '2026-08-01T11:10:03.000Z');
});

test('session announcements cap both groups and report overflow', () => {
  const jobs: JobRecord[] = [];
  for (let index = 0; index < 6; index += 1) {
    jobs.push({
      id: `active-${index}`,
      status: 'running',
      createdAt: `2026-08-01T11:5${index}:00.000Z`,
      updatedAt: `2026-08-01T11:5${index}:00.000Z`,
    });
    jobs.push({
      id: `finished-${index}`,
      status: 'completed',
      createdAt: '2026-08-01T10:00:00.000Z',
      completedAt: `2026-08-01T11:0${index}:00.000Z`,
      updatedAt: `2026-08-01T11:0${index}:00.000Z`,
    });
  }
  const announcement = buildSessionJobAnnouncement(jobs, {
    watermark: '2026-08-01T10:30:00.000Z',
    now: NOW,
  });

  assert.equal(announcement?.active.length, 5);
  assert.equal(announcement?.finished.length, 5);
  assert.equal(announcement?.activeOverflow, 1);
  assert.equal(announcement?.finishedOverflow, 1);
});

test('unparsable watermark and malformed rows degrade without throwing', () => {
  const malformed = [
    { id: 'missing-status', updatedAt: 42 },
    { id: 'bad-terminal', status: 'completed', completedAt: 42, updatedAt: null },
  ] as unknown as JobRecord[];
  assert.deepEqual(buildSessionJobAnnouncement(malformed, { watermark: 'not-a-date', now: NOW }), {
    active: [],
    finished: [],
    activeOverflow: 0,
    finishedOverflow: 0,
    nextWatermark: '2026-08-01T12:00:00.000Z',
  });
  assert.equal(buildSessionJobAnnouncement(malformed, { watermark: WATERMARK, now: NOW }), null);
});

test('session job announcement rendering is byte exact', () => {
  assert.equal(
    renderSessionJobAnnouncement({
      workspaceRoot: '/work/repo',
      active: [
        { id: 'plan-a1b2c3', kind: 'plan-review', elapsed: '4m 12s', status: 'running' },
        { id: 'task-d4e5f6', kind: 'rescue', elapsed: '31s', status: 'queued' },
      ],
      finished: [
        {
          id: 'task-g7h8i9',
          kind: 'rescue',
          status: 'completed',
          duration: '2m 3s',
        },
      ],
      activeOverflow: 0,
      finishedOverflow: 0,
      nextWatermark: '2026-08-01T11:10:03.000Z',
    }),
    'Stereo background jobs in /work/repo:\n- Active (2): plan-a1b2c3 plan-review 4m 12s; task-d4e5f6 rescue 31s\n- Finished since your last session (1): task-g7h8i9 rescue completed in 2m 3s\nRun /stereo:status for details, /stereo:result <id> for output, /stereo:cancel <id> to stop one.\n',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTurnNotification,
  belongsToTurn,
  captureTurn,
  clearCompletionTimer,
  completeTurn,
  createTurnCaptureState,
  scheduleInferredCompletion,
  summarizeUnifiedDiff,
} from '../plugins/stereo/src/runtime/turn-capture.ts';
import type { ProgressUpdate } from '../plugins/stereo/src/runtime/turn-capture.ts';
import type { AppServerClient } from '../plugins/stereo/src/runtime/threads.ts';
import type { AppServerNotification, Turn } from '../plugins/stereo/src/protocol/app-server.ts';

// Notifications in these tests carry only the fields the capture code reads;
// the cast mirrors how untrusted wire payloads reach the dispatcher.
const notification = (value: unknown) => value as AppServerNotification;

function agentMessageItem(text: string, phase: string | null) {
  return { type: 'agentMessage', id: 'item-1', text, phase };
}

test('createTurnCaptureState seeds thread-scoped defaults', () => {
  const state = createTurnCaptureState('thread-1');

  assert.equal(state.threadId, 'thread-1');
  assert.equal(state.rootThreadId, 'thread-1');
  assert.deepEqual([...state.threadIds], ['thread-1']);
  assert.equal(state.threadTurnIds.size, 0);
  assert.equal(state.threadLabels.size, 0);
  assert.equal(state.turnId, null);
  assert.equal(state.completed, false);
  assert.equal(state.inferredCompletion, false);
  assert.equal(state.finalAnswerSeen, false);
  assert.equal(state.finalTurn, null);
  assert.equal(state.completionTimer, null);
  assert.equal(state.lastAgentMessage, '');
  assert.equal(state.reviewText, '');
  assert.equal(state.error, null);
  assert.equal(state.onProgress, null);
  assert.deepEqual(state.bufferedNotifications, []);
  assert.deepEqual(state.notificationErrors, []);
  assert.equal(state.droppedNotifications, 0);
  assert.deepEqual(state.reasoningSummary, []);
  assert.deepEqual(state.fileChanges, []);
  assert.deepEqual(state.commandExecutions, []);
  assert.equal(state.tokenUsage, null);
  assert.equal(state.jobTokenUsage, null);
  assert.equal(state.primaryThreadTokenUsage, null);
  assert.deepEqual(state.diffStats, { files: 0, additions: 0, deletions: 0 });
  assert.equal(state.planProgress, null);
  assert.equal(state.pendingCollaborations.size, 0);
  assert.equal(state.activeSubagentTurns.size, 0);
  assert.ok(state.completion instanceof Promise);
});

test('summarizeUnifiedDiff counts files and hunk churn in a multi-file diff', () => {
  const diff = [
    'diff --git a/one.ts b/one.ts',
    'index 1111111..2222222 100644',
    '--- a/one.ts',
    '+++ b/one.ts',
    '@@ -1,2 +1,3 @@',
    ' context',
    '-old one',
    '+new one',
    '+new two',
    'diff --git a/two.ts b/two.ts',
    'index 3333333..4444444 100644',
    '--- a/two.ts',
    '+++ b/two.ts',
    '@@ -4,2 +4,2 @@',
    '-old two',
    '+new three',
  ].join('\n');

  assert.deepEqual(summarizeUnifiedDiff(diff), {
    files: 2,
    additions: 3,
    deletions: 2,
  });
});

test('summarizeUnifiedDiff counts rename-only and binary entries without line churn', () => {
  const diff = [
    'diff --git a/old-name.ts b/new-name.ts',
    'similarity index 100%',
    'rename from old-name.ts',
    'rename to new-name.ts',
    'diff --git a/image.bin b/image.bin',
    'new file mode 100644',
    'index 0000000..1234567',
    'Binary files /dev/null and b/image.bin differ',
  ].join('\n');

  assert.deepEqual(summarizeUnifiedDiff(diff), {
    files: 2,
    additions: 0,
    deletions: 0,
  });
});

test('summarizeUnifiedDiff distinguishes file headers from header-looking hunk content', () => {
  const diff = [
    'diff --git a/example.txt b/example.txt',
    '--- a/example.txt',
    '+++ b/example.txt',
    '@@ -1,2 +1,3 @@',
    '---deleted content beginning with two hyphens',
    '+++added content beginning with two pluses',
    '+--- foo',
  ].join('\n');

  assert.deepEqual(summarizeUnifiedDiff(diff), {
    files: 1,
    additions: 2,
    deletions: 1,
  });
});

test('summarizeUnifiedDiff returns zeros for empty and non-diff text', () => {
  assert.deepEqual(summarizeUnifiedDiff(''), {
    files: 0,
    additions: 0,
    deletions: 0,
  });
  assert.deepEqual(summarizeUnifiedDiff('garbage\n+fake addition\n@@ not a hunk\n-still fake'), {
    files: 0,
    additions: 0,
    deletions: 0,
  });
});

const captureDiff = [
  'diff --git a/one.ts b/one.ts',
  '--- a/one.ts',
  '+++ b/one.ts',
  '@@ -1,2 +1,5 @@',
  '-old one',
  '-old two',
  '+new one',
  '+new two',
  '+new three',
  '+new four',
  '+new five',
  'diff --git a/two.ts b/two.ts',
  '--- a/two.ts',
  '+++ b/two.ts',
  '@@ -1 +1,5 @@',
  '-old three',
  '+new six',
  '+new seven',
  '+new eight',
  '+new nine',
  '+new ten',
].join('\n');

test('turn diff notifications emit only registered, changed stats including a return to zero', () => {
  const updates: Array<string | ProgressUpdate> = [];
  const state = createTurnCaptureState('thread-1', {
    onProgress: (update) => updates.push(update),
  });
  state.threadTurnIds.set('thread-1', 'turn-1');

  const sendDiff = (diff: unknown, turnId: unknown = 'turn-1') =>
    applyTurnNotification(
      state,
      notification({
        method: 'turn/diff/updated',
        params: { threadId: 'thread-1', turnId, diff },
      }),
    );

  sendDiff('');
  assert.deepEqual(updates, []);

  sendDiff(captureDiff);
  assert.deepEqual(updates, [
    {
      message: 'Diff: 2 files (+10/-3)',
      phase: 'editing',
    },
  ]);

  sendDiff(captureDiff);
  assert.equal(updates.length, 1);

  sendDiff(`${captureDiff}\n+new eleven`);
  assert.deepEqual(updates.at(-1), {
    message: 'Diff: 2 files (+11/-3)',
    phase: 'editing',
  });

  sendDiff('diff --git a/foreign.ts b/foreign.ts', 'turn-foreign');
  applyTurnNotification(
    state,
    notification({
      method: 'turn/diff/updated',
      params: {
        threadId: 'thread-1',
        diff: 'diff --git a/absent.ts b/absent.ts',
      },
    }),
  );
  assert.equal(updates.length, 2);

  sendDiff('');
  assert.deepEqual(updates.at(-1), {
    message: 'Diff: 0 files (+0/-0)',
    phase: 'editing',
  });
});

test('turn plan notifications label by array index and handle completion and reset', () => {
  const updates: Array<string | ProgressUpdate> = [];
  const state = createTurnCaptureState('thread-1', {
    onProgress: (update) => updates.push(update),
  });
  state.threadTurnIds.set('thread-1', 'turn-1');

  const sendPlan = (plan: unknown) =>
    applyTurnNotification(
      state,
      notification({
        method: 'turn/plan/updated',
        params: { threadId: 'thread-1', turnId: 'turn-1', explanation: null, plan },
      }),
    );

  const initialPlan = [
    { step: 'inspect the parser', status: 'completed' },
    { step: 'rewrite broker server ownership', status: 'inProgress' },
    { step: 'verify the changes', status: 'pending' },
  ];
  sendPlan(initialPlan);
  assert.deepEqual(updates, ['Step 2/3: rewrite broker server ownership']);

  sendPlan(initialPlan);
  assert.equal(updates.length, 1);

  sendPlan([
    { step: 'return to the first step', status: 'pending' },
    { step: 'rewrite broker server ownership', status: 'completed' },
    { step: 'verify the changes', status: 'completed' },
  ]);
  assert.equal(updates.at(-1), 'Step 1/3: return to the first step');

  const completedPlan = [
    { step: 'inspect the parser', status: 'completed' },
    { step: 'rewrite broker server ownership', status: 'completed' },
    { step: 'verify the changes', status: 'completed' },
  ];
  sendPlan(completedPlan);
  assert.equal(updates.at(-1), 'Plan complete: 3/3 steps');
  sendPlan(completedPlan);
  assert.equal(updates.length, 3);

  sendPlan([]);
  assert.equal(state.planProgress, null);
  assert.equal(updates.length, 3);
  sendPlan(completedPlan);
  assert.equal(updates.at(-1), 'Plan complete: 3/3 steps');
  assert.equal(updates.length, 4);
});

test('turn diff and plan notifications ignore malformed params without throwing', () => {
  const updates: Array<string | ProgressUpdate> = [];
  const state = createTurnCaptureState('thread-1', {
    onProgress: (update) => updates.push(update),
  });
  state.threadTurnIds.set('thread-1', 'turn-1');

  const malformed = [
    { method: 'turn/diff/updated', params: { threadId: 'thread-1', turnId: 'turn-1' } },
    {
      method: 'turn/diff/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', diff: 42 },
    },
    {
      method: 'turn/plan/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', plan: 'not-an-array' },
    },
    {
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        plan: [{ step: 42, status: 'pending' }],
      },
    },
    {
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        plan: [{ step: 'invalid status', status: 'done' }],
      },
    },
  ];

  for (const message of malformed) {
    assert.doesNotThrow(() => applyTurnNotification(state, notification(message)));
  }
  assert.deepEqual(updates, []);
});

function usageBreakdown(
  totalTokens: number,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  reasoningOutputTokens = 0,
) {
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens,
  };
}

test('token usage sums eligible completion samples across primary and subagent turns', () => {
  const state = createTurnCaptureState('thread-root');
  applyTurnNotification(
    state,
    notification({
      method: 'turn/started',
      params: { threadId: 'thread-root', turn: { id: 'turn-root' } },
    }),
  );

  applyTurnNotification(
    state,
    notification({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-root',
        turnId: 'turn-root',
        tokenUsage: {
          last: usageBreakdown(100, 80, 20, 20, 5),
          total: usageBreakdown(100, 80, 20, 20, 5),
          modelContextWindow: 258000,
        },
      },
    }),
  );
  applyTurnNotification(
    state,
    notification({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-root',
        turnId: 'turn-root',
        tokenUsage: {
          last: usageBreakdown(250, 200, 50, 100, 10),
          total: usageBreakdown(350, 280, 70, 120, 15),
          modelContextWindow: 258000,
        },
      },
    }),
  );

  applyTurnNotification(
    state,
    notification({
      method: 'thread/started',
      params: { thread: { id: 'thread-sub', name: 'challenger' } },
    }),
  );
  applyTurnNotification(
    state,
    notification({
      method: 'turn/started',
      params: { threadId: 'thread-sub', turn: { id: 'turn-sub' } },
    }),
  );
  applyTurnNotification(
    state,
    notification({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-sub',
        turnId: 'turn-sub',
        tokenUsage: {
          last: usageBreakdown(300, 240, 60, 40, 20),
          total: usageBreakdown(300, 240, 60, 40, 20),
          modelContextWindow: 128000,
        },
      },
    }),
  );

  assert.deepEqual(state.tokenUsage, {
    job: usageBreakdown(650, 520, 130, 160, 35),
    thread: usageBreakdown(350, 280, 70, 120, 15),
    modelContextWindow: 258000,
  });
});

test('token usage excludes replay, foreign-turn, and malformed samples', () => {
  const state = createTurnCaptureState('thread-root');
  applyTurnNotification(
    state,
    notification({
      method: 'turn/started',
      params: { threadId: 'thread-root', turn: { id: 'turn-current' } },
    }),
  );
  const valid = {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-root',
      turnId: 'turn-current',
      tokenUsage: {
        last: usageBreakdown(100, 80, 20),
        total: usageBreakdown(100, 80, 20),
        modelContextWindow: 258000,
      },
    },
  };
  applyTurnNotification(state, notification(valid));
  applyTurnNotification(
    state,
    notification({
      ...valid,
      params: { ...valid.params, turnId: 'turn-previous' },
    }),
  );
  applyTurnNotification(
    state,
    notification({
      ...valid,
      params: { ...valid.params, turnId: undefined },
    }),
  );
  applyTurnNotification(
    state,
    notification({
      ...valid,
      params: {
        ...valid.params,
        tokenUsage: { ...valid.params.tokenUsage, last: { inputTokens: 'bad' } },
      },
    }),
  );

  assert.deepEqual(state.tokenUsage, {
    job: usageBreakdown(100, 80, 20),
    thread: usageBreakdown(100, 80, 20),
    modelContextWindow: 258000,
  });
});

test('a final answer updates lastAgentMessage only on the completed lifecycle', (t) => {
  const state = createTurnCaptureState('thread-1');
  t.after(() => clearCompletionTimer(state));

  applyTurnNotification(
    state,
    notification({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    }),
  );
  assert.equal(state.threadTurnIds.get('thread-1'), 'turn-1');
  assert.equal(state.activeSubagentTurns.size, 0);

  applyTurnNotification(
    state,
    notification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: agentMessageItem('Draft answer.', 'final_answer'),
      },
    }),
  );

  assert.equal(state.lastAgentMessage, '');
  assert.equal(state.finalAnswerSeen, false);

  applyTurnNotification(
    state,
    notification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: agentMessageItem('Final answer.', 'final_answer'),
      },
    }),
  );

  assert.equal(state.lastAgentMessage, 'Final answer.');
  assert.equal(state.finalAnswerSeen, true);
  assert.equal(state.completed, false);
});

test('thread/started registers subagent threads for membership matching', () => {
  const state = createTurnCaptureState('thread-1');

  applyTurnNotification(
    state,
    notification({
      method: 'thread/started',
      params: {
        thread: { id: 'thread-sub', name: 'Codex Subagent', agentNickname: null, agentRole: null },
      },
    }),
  );

  assert.ok(state.threadIds.has('thread-sub'));
  assert.equal(state.threadLabels.get('thread-sub'), 'Codex Subagent');

  // With no tracked turn (null turnId case) thread membership alone matches.
  assert.equal(
    belongsToTurn(
      state,
      notification({ method: 'item/completed', params: { threadId: 'thread-sub' } }),
    ),
    true,
  );
  assert.equal(
    belongsToTurn(
      state,
      notification({ method: 'item/completed', params: { threadId: 'thread-unknown' } }),
    ),
    false,
  );
  assert.equal(belongsToTurn(state, notification({ method: 'warning', params: {} })), false);

  applyTurnNotification(
    state,
    notification({
      method: 'turn/started',
      params: { threadId: 'thread-sub', turn: { id: 'turn-sub' } },
    }),
  );
  assert.equal(state.threadTurnIds.get('thread-sub'), 'turn-sub');
  assert.ok(state.activeSubagentTurns.has('thread-sub'));

  // A tracked turn id must match when the message carries one...
  assert.equal(
    belongsToTurn(
      state,
      notification({
        method: 'item/completed',
        params: { threadId: 'thread-sub', turnId: 'turn-sub' },
      }),
    ),
    true,
  );
  assert.equal(
    belongsToTurn(
      state,
      notification({
        method: 'item/completed',
        params: { threadId: 'thread-sub', turnId: 'turn-other' },
      }),
    ),
    false,
  );
  // ...while messages without any turn id still match by thread membership.
  assert.equal(
    belongsToTurn(
      state,
      notification({ method: 'item/completed', params: { threadId: 'thread-sub' } }),
    ),
    true,
  );
});

test('completeTurn resolves the completion promise exactly once', async () => {
  const state = createTurnCaptureState('thread-1');

  const firstTurn = { id: 'turn-1', status: 'completed' } as Turn;
  completeTurn(state, firstTurn);
  completeTurn(state, { id: 'turn-2', status: 'failed' } as Turn);

  const settled = await state.completion;
  assert.equal(settled, state);
  assert.equal(state.completed, true);
  assert.equal(state.finalTurn, firstTurn);
  assert.equal(state.turnId, 'turn-1');

  const inferred = createTurnCaptureState('thread-2');
  completeTurn(inferred);
  const inferredState = await inferred.completion;
  assert.deepEqual(inferredState.finalTurn, {
    id: 'inferred-turn',
    status: 'completed',
    items: [],
    itemsView: 'notLoaded',
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  });
});

test('captureTurn records malformed notifications instead of throwing', async () => {
  const progress: Array<string | ProgressUpdate> = [];
  const handlerRef: { current: ((message: AppServerNotification) => void) | null } = {
    current: null,
  };
  const fakeClient = {
    notificationHandler: null,
    setNotificationHandler(next: ((message: AppServerNotification) => void) | null) {
      handlerRef.current = next;
    },
    exitPromise: new Promise(() => {}),
    exitError: null,
    exitResolved: false,
  } as unknown as AppServerClient;

  const capture = captureTurn(
    fakeClient,
    'thread-1',
    () => Promise.resolve({ turn: { id: 'turn-1', status: 'inProgress' } as Turn }),
    { onProgress: (update) => progress.push(update) },
  );

  // Both notifications are buffered until the start response is processed and
  // then flow through the same guarded dispatch path as live notifications.
  const handler = handlerRef.current;
  assert.ok(handler);
  handler(notification({ method: 'item/completed', params: { threadId: 'thread-1' } }));
  handler(
    notification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    }),
  );

  const state = await capture;

  assert.equal(state.turnId, 'turn-1');
  assert.equal(state.notificationErrors.length, 1);
  assert.equal(state.droppedNotifications, 1);
  assert.equal(state.notificationErrors[0]?.method, 'item/completed');
  assert.ok(state.notificationErrors[0]?.message);
  // The malformed payload must not flip the Codex-reported error slot.
  assert.equal(state.error, null);
  assert.equal(state.completed, true);
  assert.equal(state.finalTurn?.status, 'completed');
  assert.ok(
    progress.some(
      (update) =>
        typeof update === 'string' &&
        update.startsWith('Ignoring malformed item/completed notification:'),
    ),
  );
});

test('captureTurn caps malformed-notification samples while retaining the full count', async () => {
  const handlerRef: { current: ((message: AppServerNotification) => void) | null } = {
    current: null,
  };
  const fakeClient = {
    notificationHandler: null,
    setNotificationHandler(next: ((message: AppServerNotification) => void) | null) {
      handlerRef.current = next;
    },
    exitPromise: new Promise(() => {}),
    exitError: null,
    exitResolved: false,
  } as unknown as AppServerClient;

  const capture = captureTurn(fakeClient, 'thread-1', () =>
    Promise.resolve({ turn: { id: 'turn-1', status: 'inProgress' } as Turn }),
  );
  const handler = handlerRef.current;
  assert.ok(handler);
  for (let index = 0; index < 25; index += 1) {
    handler(notification({ method: 'item/completed', params: { threadId: 'thread-1' } }));
  }
  handler(
    notification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    }),
  );

  const state = await capture;
  assert.equal(state.notificationErrors.length, 20);
  assert.equal(state.droppedNotifications, 25);
  assert.equal(state.completed, true);
});

// --- Inferred-completion debounce with an injected fake clock ---

interface FakeClock {
  pending: Array<{ id: number; callback: () => void }>;
  nextId: number;
}

function installFakeClock(clock: FakeClock) {
  return {
    setTimeoutImpl: (callback: () => void, _delayMs: number) => {
      const entry = { id: clock.nextId++, callback, unref: () => {} };
      clock.pending.push(entry);
      return entry;
    },
    clearTimeoutImpl: (handle: unknown) => {
      const id = (handle as { id: number }).id;
      clock.pending = clock.pending.filter((entry) => entry.id !== id);
    },
    inferredCompletionDelayMs: 250,
  };
}

function fireAll(clock: FakeClock): number {
  const due = clock.pending.splice(0, clock.pending.length);
  for (const entry of due) {
    entry.callback();
  }
  return due.length;
}

async function flushCaptureStart(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('captureTurn rejects a started turn after its inactivity deadline', async () => {
  const clock: FakeClock = { pending: [], nextId: 1 };
  const handlerRef: { current: ((message: AppServerNotification) => void) | null } = {
    current: null,
  };
  const capturedState: { current: ReturnType<typeof createTurnCaptureState> | null } = {
    current: null,
  };
  const fakeClient = {
    notificationHandler: null,
    setNotificationHandler(next: ((message: AppServerNotification) => void) | null) {
      handlerRef.current = next;
    },
    exitPromise: new Promise(() => {}),
    exitError: null,
    exitResolved: false,
  } as unknown as AppServerClient;

  const capture = captureTurn(
    fakeClient,
    'thread-inactive',
    () => Promise.resolve({ turn: { id: 'turn-inactive', status: 'inProgress' } as Turn }),
    {
      timer: installFakeClock(clock),
      inactivityTimeoutMs: 1,
      onResponse: (_response, state) => {
        capturedState.current = state;
      },
    },
  );
  await flushCaptureStart();
  assert.equal(clock.pending.length, 1);

  assert.equal(fireAll(clock), 1);
  await assert.rejects(capture, /sent no turn activity for 1ms/);
  assert.ok(capturedState.current);
  assert.equal(capturedState.current.completed, false);
  assert.equal(handlerRef.current, null);
});

test('an applied turn notification re-arms one inactivity timer', async () => {
  const clock: FakeClock = { pending: [], nextId: 1 };
  const handlerRef: { current: ((message: AppServerNotification) => void) | null } = {
    current: null,
  };
  const fakeClient = {
    notificationHandler: null,
    setNotificationHandler(next: ((message: AppServerNotification) => void) | null) {
      handlerRef.current = next;
    },
    exitPromise: new Promise(() => {}),
    exitError: null,
    exitResolved: false,
  } as unknown as AppServerClient;

  const capture = captureTurn(
    fakeClient,
    'thread-rearm',
    () => Promise.resolve({ turn: { id: 'turn-rearm', status: 'inProgress' } as Turn }),
    { timer: installFakeClock(clock), inactivityTimeoutMs: 1 },
  );
  await flushCaptureStart();
  assert.equal(clock.pending.length, 1);
  const initialTimerId = clock.pending[0]?.id;
  const handler = handlerRef.current;
  assert.ok(handler);

  handler(
    notification({
      method: 'turn/started',
      params: { threadId: 'thread-rearm', turn: { id: 'turn-rearm', status: 'inProgress' } },
    }),
  );
  assert.equal(clock.pending.length, 1);
  assert.notEqual(clock.pending[0]?.id, initialTimerId);

  handler(
    notification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-rearm',
        turn: { id: 'turn-rearm', status: 'completed' },
      },
    }),
  );
  const state = await capture;
  assert.equal(state.completed, true);
  assert.equal(clock.pending.length, 0);
});

test('the inferred-completion timer completes the turn exactly once', async () => {
  const clock: FakeClock = { pending: [], nextId: 1 };
  const state = createTurnCaptureState('thread-timer', { timer: installFakeClock(clock) });
  state.finalAnswerSeen = true;

  scheduleInferredCompletion(state);
  assert.equal(clock.pending.length, 1);

  // Re-scheduling debounces: the earlier timer is cleared, not stacked.
  scheduleInferredCompletion(state);
  assert.equal(clock.pending.length, 1);

  assert.equal(fireAll(clock), 1);
  const finished = await state.completion;
  assert.equal(finished.completed, true);
  assert.equal(finished.inferredCompletion, true);
  assert.equal(finished.finalTurn?.status, 'completed');

  // A late duplicate fire must not double-complete.
  scheduleInferredCompletion(state);
  assert.equal(clock.pending.length, 0, 'completed turns never re-arm the timer');
});

test('a real completion cancels the pending inferred-completion timer', () => {
  const clock: FakeClock = { pending: [], nextId: 1 };
  const state = createTurnCaptureState('thread-timer-cancel', { timer: installFakeClock(clock) });
  state.finalAnswerSeen = true;

  scheduleInferredCompletion(state);
  assert.equal(clock.pending.length, 1);

  completeTurn(state, { id: 'turn-real', status: 'completed' } as Turn);
  assert.equal(clock.pending.length, 0, 'completeTurn must clear the debounce timer');
  assert.equal(state.inferredCompletion, false);
  assert.equal(state.finalTurn?.id, 'turn-real');

  // Nothing left to fire; firing is a no-op even if a stale handle leaked.
  assert.equal(fireAll(clock), 0);
});

test('pending collaborations veto the inferred-completion schedule', () => {
  const clock: FakeClock = { pending: [], nextId: 1 };
  const state = createTurnCaptureState('thread-timer-veto', { timer: installFakeClock(clock) });
  state.finalAnswerSeen = true;
  state.pendingCollaborations.add('collab-1');

  scheduleInferredCompletion(state);
  assert.equal(clock.pending.length, 0, 'an active collaboration must block the debounce');

  state.pendingCollaborations.clear();
  scheduleInferredCompletion(state);
  assert.equal(clock.pending.length, 1);
});

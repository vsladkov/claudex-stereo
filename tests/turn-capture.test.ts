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
  assert.deepEqual(state.reasoningSummary, []);
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.fileChanges, []);
  assert.deepEqual(state.commandExecutions, []);
  assert.equal(state.tokenUsage, null);
  assert.equal(state.jobTokenUsage, null);
  assert.equal(state.primaryThreadTokenUsage, null);
  assert.equal(state.pendingCollaborations.size, 0);
  assert.equal(state.activeSubagentTurns.size, 0);
  assert.ok(state.completion instanceof Promise);
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
  assert.deepEqual(state.messages, [
    { lifecycle: 'started', phase: 'final_answer', text: 'Draft answer.' },
  ]);

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

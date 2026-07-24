import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTurnNotification,
  belongsToTurn,
  captureTurn,
  clearCompletionTimer,
  completeTurn,
  createTurnCaptureState
} from "../plugins/stereo/src/runtime/turn-capture.ts";
import type { ProgressUpdate } from "../plugins/stereo/src/runtime/turn-capture.ts";
import type { AppServerClient } from "../plugins/stereo/src/runtime/threads.ts";
import type { AppServerNotification, Turn } from "../plugins/stereo/src/protocol/app-server.ts";

// Notifications in these tests carry only the fields the capture code reads;
// the cast mirrors how untrusted wire payloads reach the dispatcher.
const notification = (value: unknown) => value as AppServerNotification;

function agentMessageItem(text: string, phase: string | null) {
  return { type: "agentMessage", id: "item-1", text, phase };
}

test("createTurnCaptureState seeds thread-scoped defaults", () => {
  const state = createTurnCaptureState("thread-1");

  assert.equal(state.threadId, "thread-1");
  assert.equal(state.rootThreadId, "thread-1");
  assert.deepEqual([...state.threadIds], ["thread-1"]);
  assert.equal(state.threadTurnIds.size, 0);
  assert.equal(state.threadLabels.size, 0);
  assert.equal(state.turnId, null);
  assert.equal(state.completed, false);
  assert.equal(state.finalAnswerSeen, false);
  assert.equal(state.finalTurn, null);
  assert.equal(state.completionTimer, null);
  assert.equal(state.lastAgentMessage, "");
  assert.equal(state.reviewText, "");
  assert.equal(state.error, null);
  assert.equal(state.onProgress, null);
  assert.deepEqual(state.bufferedNotifications, []);
  assert.deepEqual(state.notificationErrors, []);
  assert.deepEqual(state.reasoningSummary, []);
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.fileChanges, []);
  assert.deepEqual(state.commandExecutions, []);
  assert.equal(state.pendingCollaborations.size, 0);
  assert.equal(state.activeSubagentTurns.size, 0);
  assert.ok(state.completion instanceof Promise);
});

test("a final answer updates lastAgentMessage only on the completed lifecycle", (t) => {
  const state = createTurnCaptureState("thread-1");
  t.after(() => clearCompletionTimer(state));

  applyTurnNotification(
    state,
    notification({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } }
    })
  );
  assert.equal(state.threadTurnIds.get("thread-1"), "turn-1");
  assert.equal(state.activeSubagentTurns.size, 0);

  applyTurnNotification(
    state,
    notification({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: agentMessageItem("Draft answer.", "final_answer") }
    })
  );

  assert.equal(state.lastAgentMessage, "");
  assert.equal(state.finalAnswerSeen, false);
  assert.deepEqual(state.messages, [{ lifecycle: "started", phase: "final_answer", text: "Draft answer." }]);

  applyTurnNotification(
    state,
    notification({
      method: "item/completed",
      params: { threadId: "thread-1", turnId: "turn-1", item: agentMessageItem("Final answer.", "final_answer") }
    })
  );

  assert.equal(state.lastAgentMessage, "Final answer.");
  assert.equal(state.finalAnswerSeen, true);
  assert.equal(state.completed, false);
});

test("thread/started registers subagent threads for membership matching", () => {
  const state = createTurnCaptureState("thread-1");

  applyTurnNotification(
    state,
    notification({
      method: "thread/started",
      params: { thread: { id: "thread-sub", name: "Codex Subagent", agentNickname: null, agentRole: null } }
    })
  );

  assert.ok(state.threadIds.has("thread-sub"));
  assert.equal(state.threadLabels.get("thread-sub"), "Codex Subagent");

  // With no tracked turn (null turnId case) thread membership alone matches.
  assert.equal(
    belongsToTurn(state, notification({ method: "item/completed", params: { threadId: "thread-sub" } })),
    true
  );
  assert.equal(
    belongsToTurn(state, notification({ method: "item/completed", params: { threadId: "thread-unknown" } })),
    false
  );
  assert.equal(belongsToTurn(state, notification({ method: "warning", params: {} })), false);

  applyTurnNotification(
    state,
    notification({
      method: "turn/started",
      params: { threadId: "thread-sub", turn: { id: "turn-sub" } }
    })
  );
  assert.equal(state.threadTurnIds.get("thread-sub"), "turn-sub");
  assert.ok(state.activeSubagentTurns.has("thread-sub"));

  // A tracked turn id must match when the message carries one...
  assert.equal(
    belongsToTurn(state, notification({ method: "item/completed", params: { threadId: "thread-sub", turnId: "turn-sub" } })),
    true
  );
  assert.equal(
    belongsToTurn(state, notification({ method: "item/completed", params: { threadId: "thread-sub", turnId: "turn-other" } })),
    false
  );
  // ...while messages without any turn id still match by thread membership.
  assert.equal(
    belongsToTurn(state, notification({ method: "item/completed", params: { threadId: "thread-sub" } })),
    true
  );
});

test("completeTurn resolves the completion promise exactly once", async () => {
  const state = createTurnCaptureState("thread-1");

  const firstTurn = { id: "turn-1", status: "completed" } as Turn;
  completeTurn(state, firstTurn);
  completeTurn(state, { id: "turn-2", status: "failed" } as Turn);

  const settled = await state.completion;
  assert.equal(settled, state);
  assert.equal(state.completed, true);
  assert.equal(state.finalTurn, firstTurn);
  assert.equal(state.turnId, "turn-1");

  const inferred = createTurnCaptureState("thread-2");
  completeTurn(inferred);
  const inferredState = await inferred.completion;
  assert.deepEqual(inferredState.finalTurn, { id: "inferred-turn", status: "completed" });
});

test("captureTurn records malformed notifications instead of throwing", async () => {
  const progress: Array<string | ProgressUpdate> = [];
  const handlerRef: { current: ((message: AppServerNotification) => void) | null } = { current: null };
  const fakeClient = {
    notificationHandler: null,
    setNotificationHandler(next: ((message: AppServerNotification) => void) | null) {
      handlerRef.current = next;
    },
    exitPromise: new Promise(() => {}),
    exitError: null,
    exitResolved: false
  } as unknown as AppServerClient;

  const capture = captureTurn(
    fakeClient,
    "thread-1",
    () => Promise.resolve({ turn: { id: "turn-1", status: "inProgress" } as Turn }),
    { onProgress: (update) => progress.push(update) }
  );

  // Both notifications are buffered until the start response is processed and
  // then flow through the same guarded dispatch path as live notifications.
  const handler = handlerRef.current;
  assert.ok(handler);
  handler(notification({ method: "item/completed", params: { threadId: "thread-1" } }));
  handler(
    notification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
    })
  );

  const state = await capture;

  assert.equal(state.turnId, "turn-1");
  assert.equal(state.notificationErrors.length, 1);
  assert.equal(state.notificationErrors[0]?.method, "item/completed");
  assert.ok(state.notificationErrors[0]?.message);
  // The malformed payload must not flip the Codex-reported error slot.
  assert.equal(state.error, null);
  assert.equal(state.completed, true);
  assert.equal(state.finalTurn?.status, "completed");
  assert.ok(
    progress.some(
      (update) => typeof update === "string" && update.startsWith("Ignoring malformed item/completed notification:")
    )
  );
});

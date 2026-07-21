/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   notificationErrors: Array<{ method: string | null, message: string }>,
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { loadBrokerSession, sendBrokerShutdownIfIdle } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const PAIR_THREAD_PREFIX = "Codex Companion Pair";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;
const THREAD_RESERVATION_DIR = "companion-thread-locks";
const THREAD_RESERVATION_DEATH_WAIT_MS = 2500;
const THREAD_RESERVATION_POLL_MS = 50;
const CODEX_SANDBOX_USAGE_ERROR =
  /unrecognized subcommand|unexpected argument|required arguments were not provided|requires a .?\[permissions\].? table|invalid value|unknown built-in profile|unknown permission profile|permission profile .* not found/i;

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only"
  };
}

/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

export function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function buildPairThreadName(plan) {
  const excerpt = shorten(plan, 56);
  return excerpt ? `${PAIR_THREAD_PREFIX}: ${excerpt}` : PAIR_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes?.length ?? 0} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    notificationErrors: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        if (lifecycle === "completed") {
          state.lastAgentMessage = item.text;
        }
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "error":
      state.error = message.params.error;
      emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, "failed");
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;

  const dispatchNotification = (message) => {
    // Applied unconditionally for the buffered replay too (deliberate): the
    // broker is single-flight, so a thread/started that is not ours cannot
    // interleave with a captured turn on this client.
    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      applyTurnNotification(state, message);
      return;
    }

    if (!belongsToTurn(state, message)) {
      if (previousHandler) {
        previousHandler(message);
      }
      return;
    }

    applyTurnNotification(state, message);
  };

  // Buffer only until the start response has been processed — keying this on
  // state.turnId would buffer forever when a start response carries no
  // turn.id (belongsToTurn then matches by thread membership alone).
  let startProcessed = false;
  const dispatchNotificationSafely = (message) => {
    try {
      dispatchNotification(message);
    } catch (error) {
      // A malformed notification must not throw through the transport's
      // line handler (an uncaught exception); record it and keep going.
      // Deliberately not state.error: that field carries Codex-reported
      // turn failures and would flip the run's status.
      const detail = error instanceof Error ? error.message : String(error);
      state.notificationErrors.push({ method: message?.method ?? null, message: detail });
      emitProgress(state.onProgress, `Ignoring malformed ${message?.method ?? "unknown"} notification: ${detail}`);
    }
  };
  client.setNotificationHandler((message) => {
    if (!startProcessed) {
      state.bufferedNotifications.push(message);
      return;
    }

    dispatchNotificationSafely(message);
  });

  const buildConnectionClosedError = () => {
    const detail = client.exitError?.message ? `: ${client.exitError.message}` : "";
    return new Error(`codex app-server connection closed before the turn completed${detail}`, {
      cause: client.exitError ?? undefined
    });
  };
  const connectionExit = client.exitPromise.then(() => {
    throw buildConnectionClosedError();
  });
  const start = Promise.resolve()
    .then(startRequest)
    .catch((error) => {
      if (client.exitResolved) {
        throw buildConnectionClosedError();
      }
      throw error;
    });

  try {
    const response = await Promise.race([start, connectionExit]);
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    startProcessed = true;
    const buffered = [...state.bufferedNotifications];
    state.bufferedNotifications.length = 0;
    for (const message of buffered) {
      dispatchNotificationSafely(message);
    }

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    return await Promise.race([state.completion, connectionExit]);
  } finally {
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function withAppServer(cwd, fn) {
  let client = null;
  let connectedOk = false;
  try {
    client = await CodexAppServerClient.connect(cwd);
    connectedOk = true;
    const result = await fn(client);
    // A teardown failure must not discard the computed result or re-enter
    // the fallback below (which could replay fn after its side effects).
    await client.close().catch(() => {});
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    // The dead-endpoint retry is safe only for connect/initialize failures
    // (connect cleans up after itself, and no request was ever sent); an
    // ENOENT/ECONNREFUSED surfacing mid-fn could follow real side effects.
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && !connectedOk && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function withDirectAppServer(cwd, fn) {
  const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function resolveCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function resolveThreadReservationDir() {
  return path.join(resolveCodexHome(), THREAD_RESERVATION_DIR);
}

function threadReservationPath(threadId) {
  const digest = crypto.createHash("sha256").update(String(threadId)).digest("hex").slice(0, 32);
  return path.join(resolveThreadReservationDir(), `${digest}.lock`);
}

function readReservationRecord(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    return { invalid: true, error };
  }
}

function isValidReservationRecord(record, kind) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.getPrototypeOf(record) !== Object.prototype ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0
  ) {
    return false;
  }

  if (kind === "lock") {
    return (
      typeof record.token === "string" &&
      record.token.length > 0 &&
      typeof record.threadId === "string" &&
      record.threadId.length > 0
    );
  }

  return Object.prototype.hasOwnProperty.call(record, "jobId");
}

function readValidatedReservationRecord(recordPath, kind) {
  try {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    if (!isValidReservationRecord(record, kind)) {
      return { state: "invalid", detail: `Invalid ${kind} reservation record.` };
    }
    return { state: "valid", record };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { state: "missing" };
    }
    return {
      state: "invalid",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function pidIsAlive(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  if (options.isProcessAlive) {
    return Boolean(options.isProcessAlive(pid));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function strandedReservationSortPath(entry) {
  return entry.lockPath ?? entry.claimPath ?? entry.path ?? entry.paths?.[0] ?? "";
}

function unreadableReservationEntry(paths) {
  const affectedPaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  return {
    kind: "unreadable",
    paths: affectedPaths
  };
}

export function listStrandedThreadReservations() {
  const lockDir = resolveThreadReservationDir();
  let entries;
  try {
    entries = fs.readdirSync(lockDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    return [
      {
        kind: "scan-error",
        path: lockDir,
        detail: error instanceof Error ? error.message : String(error)
      }
    ];
  }

  const pairs = new Map();
  for (const entry of entries) {
    let lockName;
    let kind;
    if (entry.endsWith(".lock.cleanup")) {
      lockName = entry.slice(0, -".cleanup".length);
      kind = "claim";
    } else if (entry.endsWith(".lock")) {
      lockName = entry;
      kind = "lock";
    } else {
      continue;
    }

    const lockPath = path.join(lockDir, lockName);
    const pair = pairs.get(lockPath) ?? { lockPath, claimPath: `${lockPath}.cleanup`, lock: false, claim: false };
    pair[kind] = true;
    pairs.set(lockPath, pair);
  }

  const stranded = [];
  for (const pair of pairs.values()) {
    const lock = pair.lock
      ? readValidatedReservationRecord(pair.lockPath, "lock")
      : { state: "missing" };
    const claim = pair.claim
      ? readValidatedReservationRecord(pair.claimPath, "claim")
      : { state: "missing" };

    const invalidPaths = [];
    if (lock.state === "invalid") {
      invalidPaths.push(pair.lockPath);
    }
    if (claim.state === "invalid") {
      invalidPaths.push(pair.claimPath);
    }
    if (invalidPaths.length > 0) {
      stranded.push(unreadableReservationEntry(invalidPaths));
      continue;
    }

    const owner = lock.state === "valid" ? lock.record : null;
    const claimant = claim.state === "valid" ? claim.record : null;
    const ownerAlive = owner ? pidIsAlive(owner.pid) : false;
    const claimantAlive = claimant ? pidIsAlive(claimant.pid) : false;

    if (owner && claimant) {
      if (claimantAlive) {
        continue;
      }
      if (ownerAlive) {
        stranded.push({
          kind: "orphaned-claim",
          claimPath: pair.claimPath,
          jobId: claimant.jobId ?? null,
          pid: claimant.pid
        });
        continue;
      }
      stranded.push({
        kind: "stranded-cleanup",
        lockPath: pair.lockPath,
        claimPath: pair.claimPath,
        threadId: owner.threadId,
        jobId: owner.jobId ?? null,
        pid: owner.pid
      });
      continue;
    }

    if (owner) {
      if (!ownerAlive) {
        stranded.push({
          kind: "stranded-reservation",
          lockPath: pair.lockPath,
          threadId: owner.threadId,
          jobId: owner.jobId ?? null,
          pid: owner.pid
        });
      }
      continue;
    }

    if (claimant && !claimantAlive) {
      stranded.push({
        kind: "orphaned-claim",
        claimPath: pair.claimPath,
        jobId: claimant.jobId ?? null,
        pid: claimant.pid
      });
    }
  }

  return stranded.sort((left, right) => {
    const pathOrder = strandedReservationSortPath(left).localeCompare(strandedReservationSortPath(right));
    return pathOrder || left.kind.localeCompare(right.kind);
  });
}

function displayReservationValue(value) {
  return value == null || value === "" ? "unknown" : String(value);
}

function joinCodePaths(paths) {
  const rendered = paths.map((entryPath) => `\`${entryPath}\``);
  if (rendered.length <= 1) {
    return rendered[0] ?? "the affected file";
  }
  if (rendered.length === 2) {
    return `${rendered[0]} and ${rendered[1]}`;
  }
  return `${rendered.slice(0, -1).join(", ")}, and ${rendered.at(-1)}`;
}

export function describeStrandedReservation(entry) {
  switch (entry?.kind) {
    case "stranded-reservation":
      return `A crashed Codex run (job ${displayReservationValue(entry.jobId)}, pid ${displayReservationValue(entry.pid)}) left thread ${displayReservationValue(entry.threadId)} reserved. Delete \`${entry.lockPath}\` to release it.`;
    case "stranded-cleanup":
      return `A crashed Codex run (job ${displayReservationValue(entry.jobId)}, pid ${displayReservationValue(entry.pid)}) left thread ${displayReservationValue(entry.threadId)} reserved with an abandoned cleanup claim. Delete both \`${entry.lockPath}\` and \`${entry.claimPath}\` to release it.`;
    case "orphaned-claim":
      return `A crashed reservation cleanup (job ${displayReservationValue(entry.jobId)}, pid ${displayReservationValue(entry.pid)}) left an orphaned claim. Delete only \`${entry.claimPath}\`; do not delete any accompanying live thread lock.`;
    case "unreadable":
      return `Thread reservation data at ${joinCodePaths(entry.paths ?? [])} could not be validated. Inspect the affected file${entry.paths?.length === 1 ? "" : "s"}, then delete only invalid records after confirming no live Codex run owns them.`;
    case "scan-error":
      return `Thread reservations could not be scanned at \`${entry.path}\`: ${entry.detail || "unknown filesystem error"}. Inspect and repair that path.`;
    default:
      return "An unknown stranded thread reservation was detected. Run `/stereo:setup` again for current details.";
  }
}

export function acquireThreadReservation(threadId, meta = {}) {
  const normalizedThreadId = String(threadId ?? "").trim();
  if (!normalizedThreadId) {
    throw new Error("A thread id is required to reserve a Codex thread.");
  }

  const lockDir = resolveThreadReservationDir();
  const lockPath = threadReservationPath(normalizedThreadId);
  const cleanupPath = `${lockPath}.cleanup`;
  const record = {
    token: crypto.randomUUID(),
    pid: Number.isFinite(meta.pid) ? meta.pid : process.pid,
    jobId: meta.jobId ?? null,
    threadId: normalizedThreadId,
    createdAt: new Date().toISOString()
  };
  fs.mkdirSync(lockDir, { recursive: true });

  if (fs.existsSync(cleanupPath)) {
    throw new Error(
      `Reservation cleanup is already in progress for thread ${normalizedThreadId}. Wait for it to finish; if it appears stuck, run \`/stereo:setup\` to list stranded reservations and safe remedies.`
    );
  }

  try {
    fs.writeFileSync(lockPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }

    const owner = readReservationRecord(lockPath);
    if (!owner || owner.invalid) {
      throw new Error(
        `A Codex thread reservation exists but could not be read. Delete ${lockPath} to release it, then retry.`
      );
    }
    const ownerJob = owner.jobId ?? "unknown";
    if (pidIsAlive(owner.pid)) {
      throw new Error(
        `Thread ${normalizedThreadId} is already being used by another Codex run (job ${ownerJob}). Wait for it or cancel it first.`
      );
    }
    throw new Error(
      `A previous Codex run (job ${ownerJob}, pid ${owner.pid ?? "unknown"}) appears to have crashed while reserving thread ${normalizedThreadId}. Delete ${lockPath} to release it, then retry.`
    );
  }

  return {
    ...record,
    path: lockPath,
    cleanupPath
  };
}

export function releaseThreadReservation(reservation) {
  if (!reservation?.path || !reservation.token) {
    return { released: false, status: "none" };
  }
  const current = readReservationRecord(reservation.path);
  if (!current) {
    return { released: false, status: "missing", path: reservation.path };
  }
  if (current.invalid || current.token !== reservation.token) {
    return { released: false, status: "token-mismatch", path: reservation.path };
  }
  try {
    fs.unlinkSync(reservation.path);
    return { released: true, status: "released", path: reservation.path };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { released: false, status: "missing", path: reservation.path };
    }
    throw error;
  }
}

async function waitForReservationOwnerDeath(pid, options = {}) {
  const timeoutMs = options.timeoutMs ?? THREAD_RESERVATION_DEATH_WAIT_MS;
  const pollMs = options.pollMs ?? THREAD_RESERVATION_POLL_MS;
  const startedAt = Date.now();
  let hookCalled = false;

  while (pidIsAlive(pid, options)) {
    if (!hookCalled && options.duringDeathWait) {
      hookCalled = true;
      await options.duringDeathWait();
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

function candidateReservationPaths({ threadId, requestThreadId, jobId, pid }) {
  const candidates = [];
  const sources = new Map();
  for (const [source, value] of [
    ["recorded", threadId],
    ["request", requestThreadId]
  ]) {
    if (!value) {
      continue;
    }
    const candidate = threadReservationPath(value);
    if (!sources.has(candidate)) {
      candidates.push(candidate);
      sources.set(candidate, source);
    }
  }

  const lockDir = resolveThreadReservationDir();
  if (fs.existsSync(lockDir)) {
    for (const entry of fs.readdirSync(lockDir)) {
      if (!entry.endsWith(".lock")) {
        continue;
      }
      const candidate = path.join(lockDir, entry);
      if (sources.has(candidate)) {
        continue;
      }
      const record = readReservationRecord(candidate);
      if (record && !record.invalid && record.jobId === jobId && record.pid === pid) {
        candidates.push(candidate);
        sources.set(candidate, "scan");
      }
    }
  }

  return candidates.map((lockPath) => ({ lockPath, source: sources.get(lockPath) }));
}

export async function releaseThreadReservationForCancelledJob(
  { threadId = null, requestThreadId = null, jobId, pid },
  options = {}
) {
  if (!Number.isFinite(pid)) {
    return { released: false, status: "none-found", detail: "The cancelled job had no worker pid." };
  }

  const ownerDied = await waitForReservationOwnerDeath(pid, options);
  if (!ownerDied) {
    return {
      released: false,
      status: "owner-still-running",
      detail: `Worker ${pid} did not exit before reservation cleanup timed out.`
    };
  }

  const candidates = candidateReservationPaths({ threadId, requestThreadId, jobId, pid });
  if (candidates.length === 0) {
    return { released: false, status: "none-found" };
  }

  let mismatch = null;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.lockPath)) {
      continue;
    }
    const cleanupPath = `${candidate.lockPath}.cleanup`;
    try {
      fs.writeFileSync(
        cleanupPath,
        `${JSON.stringify({ pid: process.pid, jobId, createdAt: new Date().toISOString() })}\n`,
        { encoding: "utf8", flag: "wx" }
      );
    } catch (error) {
      if (error?.code === "EEXIST") {
        return {
          released: false,
          status: "claim-skipped",
          path: candidate.lockPath,
          detail: `Reservation cleanup is already in progress for ${candidate.lockPath}.`
        };
      }
      throw error;
    }

    try {
      const current = readReservationRecord(candidate.lockPath);
      if (!current) {
        continue;
      }
      if (current.invalid || current.jobId !== jobId || current.pid !== pid) {
        mismatch = {
          released: false,
          status: "mismatch-skipped",
          path: candidate.lockPath,
          detail: `Reservation ${candidate.lockPath} belongs to a different owner.`
        };
        continue;
      }

      await options.beforeUnlink?.({
        lockPath: candidate.lockPath,
        cleanupPath,
        current
      });
      try {
        fs.unlinkSync(candidate.lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
      return {
        released: true,
        status: candidate.source === "scan" ? "scan-released" : "released",
        path: candidate.lockPath
      };
    } finally {
      try {
        fs.unlinkSync(cleanupPath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  return mismatch ?? { released: false, status: "none-found" };
}

function sourceContentSha256(sourcePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

function importedThreadIdForSource(sourcePath) {
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = readJsonFile(ledgerPath);
  const canonicalSource = fs.realpathSync(sourcePath);
  const contentSha256 = sourceContentSha256(canonicalSource);
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const match = records
    .filter(
      (record) =>
        record?.source_path === canonicalSource &&
        record?.content_sha256 === contentSha256 &&
        typeof record?.imported_thread_id === "string"
    )
    .at(-1);
  return match?.imported_thread_id ?? null;
}

function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

async function requestExternalAgentSessionImport(client, params) {
  const previousHandler = client.notificationHandler;
  let timeout = null;
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  void completed.catch(() => {});

  client.setNotificationHandler((message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      resolveCompleted();
      return;
    }
    previousHandler?.(message);
  });
  timeout = setTimeout(() => {
    rejectCompleted(new Error("Timed out waiting for Codex to finish importing the Claude session."));
  }, EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);

  try {
    await client.request("externalAgentConfig/import", params);
    await completed;
  } finally {
    clearTimeout(timeout);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  await options.onThreadStarted?.(response);
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

export function resumeSatisfiesWriteRequest(responseSandbox) {
  const type = responseSandbox?.type;
  if (type === "readOnly" || type === "read-only") {
    return false;
  }
  return true;
}

function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getCodexWriteSandboxStatus(cwd, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return { available: null, detail: "not probed on Windows" };
  }

  const probeImpl = options.probeImpl ?? binaryAvailable;
  const primary = probeImpl("codex", ["sandbox", "-P", ":workspace", "--", "true"], { cwd });
  if (primary.available) {
    return { available: true, detail: "workspace-write sandbox launches" };
  }
  if (!CODEX_SANDBOX_USAGE_ERROR.test(primary.detail ?? "")) {
    return { available: false, detail: primary.detail };
  }

  const fallback = probeImpl(
    "codex",
    ["sandbox", "-c", 'sandbox_mode="workspace-write"', "--", "true"],
    { cwd }
  );
  if (fallback.available) {
    return { available: true, detail: "workspace-write sandbox launches" };
  }
  if (!CODEX_SANDBOX_USAGE_ERROR.test(fallback.detail ?? "")) {
    return { available: false, detail: fallback.detail };
  }

  return {
    available: null,
    detail: `write-sandbox probe unsupported by this Codex version: ${fallback.detail}`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  const brokerEndpoint = process.env[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (!brokerEndpoint) {
    // With no shared runtime there is nothing that could still be executing
    // this turn for us to reach; spawning a fresh app-server here would pay
    // full startup cost only to fail the interrupt against an unknown thread.
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "no shared Codex runtime to interrupt"
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    await client.request("turn/interrupt", { threadId, turnId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/stereo:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const thread = await startThread(client, cwd, {
      model: options.model,
      sandbox: "read-only",
      ephemeral: true,
      threadName: options.threadName
    });
    const sourceThreadId = thread.thread.id;
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
      threadId: sourceThreadId
    });
    const delivery = options.delivery ?? "inline";

    const turnState = await captureTurn(
      client,
      sourceThreadId,
      () =>
        client.request("review/start", {
          threadId: sourceThreadId,
          delivery,
          target: options.target
        }),
      {
        onProgress: options.onProgress,
        onResponse(response, state) {
          if (response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
            if (delivery === "detached") {
              state.threadId = response.reviewThreadId;
            }
          }
        }
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function importExternalAgentSession(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/stereo:setup`.");
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  return withDirectAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
    try {
      await requestExternalAgentSessionImport(client, externalAgentSessionMigration(options.sourcePath, cwd));
    } catch (error) {
      if (error?.rpcCode === -32601) {
        throw new Error(
          "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
          { cause: error }
        );
      }
      throw error;
    }
    const threadId = importedThreadIdForSource(options.sourcePath);
    if (!threadId) {
      const stderr = cleanCodexStderr(client.stderr);
      throw new Error(
        `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
      );
    }
    emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
    return {
      threadId,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

class WriteEscalationRetryError extends Error {
  constructor() {
    super("Retry the write-capable resume on a private runtime.");
    this.name = "WriteEscalationRetryError";
  }
}

function writeEscalationRefusedError(threadId) {
  return new Error(
    `Codex resumed thread ${threadId} read-only despite the workspace-write request. The write run was not started.`
  );
}

async function drainMismatchingBroker(mismatch, onProgress) {
  if (!mismatch?.endpoint) {
    return;
  }
  if (mismatch.endpoint !== mismatch.ownedEndpoint) {
    emitLogEvent(onProgress, {
      message: "Skipped stale shared-runtime drain because the mismatching endpoint is not plugin-owned.",
      stderrMessage: ""
    });
    return;
  }

  try {
    const outcome = await sendBrokerShutdownIfIdle(mismatch.endpoint);
    if (outcome.accepted) {
      emitLogEvent(onProgress, {
        message: "Drained the stale shared Codex runtime after the private write retry.",
        stderrMessage: ""
      });
      return;
    }
    emitLogEvent(onProgress, {
      message: outcome.busy
        ? "Skipped stale shared-runtime drain because the broker is busy."
        : `Skipped stale shared-runtime drain${outcome.detail ? `: ${outcome.detail}` : "."}`,
      stderrMessage: ""
    });
  } catch (error) {
    emitLogEvent(onProgress, {
      message: `Skipped stale shared-runtime drain: ${error instanceof Error ? error.message : String(error)}`,
      stderrMessage: ""
    });
  }
}

export async function runAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/stereo:setup`.");
  }

  const reservationMeta = {
    jobId: options.jobId ?? null,
    pid: Number.isFinite(options.jobPid) ? options.jobPid : process.pid
  };
  let reservation = null;
  let mismatch = null;

  const attempt = async (connectOptions = {}) => {
    const runWithClient = async (client) => {
      let acquiredInThisCallback = false;
      try {
        let threadId;

        if (options.resumeThreadId) {
          emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
          const response = await resumeThread(client, options.resumeThreadId, cwd, {
            model: options.model,
            sandbox: options.sandbox,
            ephemeral: false
          });
          threadId = response.thread.id;

          if (options.sandbox === "workspace-write" && !resumeSatisfiesWriteRequest(response.sandbox)) {
            if (client.transport === "direct") {
              throw writeEscalationRefusedError(options.resumeThreadId);
            }
            const endpoint = client.endpoint ?? null;
            mismatch = {
              endpoint,
              ownedEndpoint: endpoint ? loadBrokerSession(cwd)?.endpoint ?? null : null
            };
            emitProgress(
              options.onProgress,
              "Codex resumed the thread read-only; retrying the write run on a private runtime.",
              "starting"
            );
            throw new WriteEscalationRetryError();
          }
        } else {
          emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
          const response = await startThread(client, cwd, {
            model: options.model,
            sandbox: options.sandbox,
            ephemeral: options.persistThread ? false : true,
            threadName: options.threadName ?? null,
            onThreadStarted(started) {
              if (!options.persistThread) {
                return;
              }
              reservation = acquireThreadReservation(started.thread.id, reservationMeta);
              acquiredInThisCallback = true;
            }
          });
          threadId = response.thread.id;
        }

        emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
          threadId
        });

        const prompt = options.prompt?.trim() || options.defaultPrompt || "";
        if (!prompt) {
          throw new Error("A prompt is required for this Codex run.");
        }

        const turnState = await captureTurn(
          client,
          threadId,
          () =>
            client.request("turn/start", {
              threadId,
              input: buildTurnInput(prompt),
              model: options.model ?? null,
              effort: options.effort ?? null,
              outputSchema: options.outputSchema ?? null
            }),
          { onProgress: options.onProgress }
        );

        return {
          status: buildResultStatus(turnState),
          threadId,
          turnId: turnState.turnId,
          finalMessage: turnState.lastAgentMessage,
          reasoningSummary: turnState.reasoningSummary,
          turn: turnState.finalTurn,
          error: turnState.error,
          stderr: cleanCodexStderr(client.stderr),
          fileChanges: turnState.fileChanges,
          touchedFiles: collectTouchedFiles(turnState.fileChanges),
          commandExecutions: turnState.commandExecutions
        };
      } catch (error) {
        if (acquiredInThisCallback && reservation) {
          releaseThreadReservation(reservation);
          reservation = null;
        }
        throw error;
      }
    };

    return connectOptions.disableBroker
      ? withDirectAppServer(cwd, runWithClient)
      : withAppServer(cwd, runWithClient);
  };

  try {
    if (options.resumeThreadId) {
      reservation = acquireThreadReservation(options.resumeThreadId, reservationMeta);
    }

    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof WriteEscalationRetryError)) {
        throw error;
      }
    }

    const result = await attempt({ disableBroker: true });
    await drainMismatchingBroker(mismatch, options.onProgress);
    return result;
  } finally {
    if (reservation) {
      releaseThreadReservation(reservation);
    }
  }
}

export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/stereo:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function buildPersistentPairThreadName(plan) {
  return buildPairThreadName(plan);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  // fallback supplies defaults (status, failureMessage); spread it first so
  // it can never clobber the computed parse outcome.
  if (!rawOutput) {
    return {
      ...fallback,
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? ""
    };
  }

  try {
    return {
      ...fallback,
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput
    };
  } catch (error) {
    return {
      ...fallback,
      parsed: null,
      parseError: error.message,
      rawOutput
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, PAIR_THREAD_PREFIX, TASK_THREAD_PREFIX };

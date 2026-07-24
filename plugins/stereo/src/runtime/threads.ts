import type {
  AppServerNotification,
  Thread,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  UserInput
} from "../protocol/app-server.ts";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "../transport/app-server-client.ts";
import { sendBrokerShutdownIfIdle } from "../broker/lifecycle.ts";
import { getCodexAvailability } from "./availability.ts";
import { emitLogEvent } from "./turn-capture.ts";
import type { ProgressReporter } from "./turn-capture.ts";

export type AppServerClient = Awaited<ReturnType<typeof CodexAppServerClient.connect>>;

const SERVICE_NAME = "claude_code_codex_plugin";
export const TASK_THREAD_PREFIX = "Codex Companion Task";
export const PAIR_THREAD_PREFIX = "Codex Companion Pair";
export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

export interface ThreadSessionOptions {
  model?: string | null;
  approvalPolicy?: ThreadStartParams["approvalPolicy"];
  sandbox?: ThreadStartParams["sandbox"];
  ephemeral?: boolean | null;
}

export interface StartThreadOptions extends ThreadSessionOptions {
  threadName?: string | null;
  onThreadStarted?: (response: ThreadStartResponse) => unknown | Promise<unknown>;
}

export function buildThreadParams(cwd: string, options: ThreadSessionOptions = {}): ThreadStartParams {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
}

export function buildResumeParams(threadId: string, cwd: string, options: ThreadSessionOptions = {}): ThreadResumeParams {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only"
  };
}

export function buildTurnInput(prompt: string): UserInput[] {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

export function shorten(text: unknown, limit = 72): string {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function buildTaskThreadName(prompt: string): string {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function buildPairThreadName(plan: string): string {
  const excerpt = shorten(plan, 56);
  return excerpt ? `${PAIR_THREAD_PREFIX}: ${excerpt}` : PAIR_THREAD_PREFIX;
}

export function buildPersistentTaskThreadName(prompt: string): string {
  return buildTaskThreadName(prompt);
}

export function buildPersistentPairThreadName(plan: string): string {
  return buildPairThreadName(plan);
}

// Notifications are validated only as far as each capture path needs; a
// malformed payload must degrade to "no thread/turn id" rather than throw.
interface TurnScopedNotificationParams {
  threadId?: string | null;
  turnId?: string | null;
  turn?: { id?: string | null } | null;
}

type TurnScopedNotification = { params?: TurnScopedNotificationParams | null } | null | undefined;

export function extractThreadId(message: AppServerNotification | null | undefined): string | null {
  return (message as TurnScopedNotification)?.params?.threadId ?? null;
}

export function extractTurnId(message: AppServerNotification | null | undefined): string | null {
  const params = (message as TurnScopedNotification)?.params;
  if (params?.turnId) {
    return params.turnId;
  }
  if (params?.turn?.id) {
    return params.turn.id;
  }
  return null;
}

export async function startThread(client: AppServerClient, cwd: string, options: StartThreadOptions = {}): Promise<ThreadStartResponse> {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  await options.onThreadStarted?.(response);
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String((err as Error | null | undefined)?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

export async function resumeThread(
  client: AppServerClient,
  threadId: string,
  cwd: string,
  options: ThreadSessionOptions = {}
): Promise<ThreadResumeResponse> {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

export function resumeSatisfiesWriteRequest(responseSandbox: { type?: string } | null | undefined): boolean {
  const type = responseSandbox?.type;
  if (type === "readOnly" || type === "read-only") {
    return false;
  }
  return true;
}

export async function withAppServer<T>(cwd: string, fn: (client: AppServerClient) => Promise<T>): Promise<T> {
  let client: AppServerClient | null = null;
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
    const failure = error as { rpcCode?: number; code?: string } | null | undefined;
    const shouldRetryDirect =
      (client?.transport === "broker" && failure?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && !connectedOk && (failure?.code === "ENOENT" || failure?.code === "ECONNREFUSED"));

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

export async function withDirectAppServer<T>(cwd: string, fn: (client: AppServerClient) => Promise<T>): Promise<T> {
  const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export interface BrokerMismatch {
  endpoint: string | null;
  ownedEndpoint: string | null;
}

export async function drainMismatchingBroker(
  mismatch: BrokerMismatch | null | undefined,
  onProgress: ProgressReporter | null | undefined
): Promise<void> {
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

export async function findLatestTaskThread(cwd: string): Promise<Thread | null> {
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

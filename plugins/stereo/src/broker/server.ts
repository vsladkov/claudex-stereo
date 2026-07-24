import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "../shared/args.ts";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "../transport/app-server-client.ts";
import type { AppServerMethod, AppServerNotification, AppServerRequestParams } from "../protocol/app-server.ts";
import { parseBrokerEndpoint } from "./endpoint.ts";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

// Client requests arrive as raw JSON lines; only the routing-relevant fields
// are typed, everything else passes through untouched.
interface BrokerClientMessage {
  id?: unknown;
  method?: string;
  params?: BrokerMessageParams;
}

interface BrokerMessageParams {
  threadId?: string | null;
  ifIdle?: boolean;
  [key: string]: unknown;
}

type RpcCapableError = Error & { rpcCode?: number };

function buildStreamThreadIds(method: string | undefined, params: BrokerMessageParams, result: unknown): Set<string> {
  const threadIds = new Set<string>();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  const reviewResult = result as { reviewThreadId?: string | null } | null | undefined;
  if (method === "review/start" && reviewResult?.reviewThreadId) {
    threadIds.add(reviewResult.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code: number, message: string, data?: unknown): { code: number; message: string; data?: unknown } {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket: net.Socket, message: unknown): void {
  if (socket.destroyed) {
    return;
  }
  try {
    socket.write(`${JSON.stringify(message)}\n`);
  } catch {
    // A half-closed peer can make write() throw before the error/close
    // handlers run; the shared broker must outlive any one bad client.
  }
}

function isInterruptRequest(message: BrokerClientMessage): boolean {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile: string | null): void {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

export async function runBrokerServer(fullArgv: string[]): Promise<void> {
  // The broker is shared by every session in the workspace: a throw escaping
  // an async socket handler or the notification router must not kill it.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`broker unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
  });
  process.on("uncaughtException", (error) => {
    process.stderr.write(`broker uncaught exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  });

  const [subcommand, ...argv] = fullArgv;
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.ts serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd as string) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"] as string) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket: net.Socket | null = null;
  let activeStreamSocket: net.Socket | null = null;
  let activeStreamThreadIds: Set<string> | null = null;
  // turn/started can arrive before or after the turn/start response installs
  // the stream socket, so in-flight turn identities are tracked in a map
  // keyed by thread (deleted again on turn/completed) instead of a single
  // install-ordered variable.
  const runningTurns = new Map<string, string>();
  // A client that vanishes mid-turn leaves codex running work nobody will
  // read. Remember the abandoned turn, ask codex to interrupt it, and refuse
  // new streaming work until it completes (or the grace window expires).
  const ORPHAN_GRACE_MS = 10_000;
  let orphanedTurn: { threadIds: Set<string>; at: number } | null = null;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let serverClosePromise: Promise<void> | null = null;
  const sockets = new Set<net.Socket>();

  function clearSocketOwnership(socket: net.Socket): void {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      if (activeStreamThreadIds && activeStreamThreadIds.size > 0) {
        orphanedTurn = { threadIds: new Set(activeStreamThreadIds), at: Date.now() };
        for (const threadId of activeStreamThreadIds) {
          const turnId = runningTurns.get(threadId);
          if (!turnId) {
            continue;
          }
          void appClient
            .request(
              "turn/interrupt" as AppServerMethod,
              { threadId, turnId } as AppServerRequestParams<AppServerMethod>
            )
            .catch(() => {
              // Best effort: if the interrupt fails, the grace window still
              // clears the orphan marker.
            });
        }
      }
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  const MAX_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024;
  // Completions observed while a turn-starting request is still in flight
  // (activeRequestSocket set, activeStreamSocket not yet installed). A very
  // fast turn can complete in the same stdout chunk as its start response;
  // installing the stream afterwards would wedge the broker busy.
  const pendingStreamCompletions = new Set<string>();

  function routeNotification(message: AppServerNotification): void {
    const notifParams = message.params as
      | { threadId?: string | null; turn?: { id?: string | null } | null; turnId?: string | null }
      | undefined;
    const notifThreadId = notifParams?.threadId ?? null;
    if (message.method === "turn/started" && notifThreadId) {
      const turnId = notifParams?.turnId ?? notifParams?.turn?.id ?? null;
      if (turnId) {
        runningTurns.set(notifThreadId, turnId);
      }
    }
    if (message.method === "turn/completed" && notifThreadId) {
      runningTurns.delete(notifThreadId);
      // The orphan's completion usually arrives with no connected client, so
      // this must run before the target check below.
      if (orphanedTurn?.threadIds.has(notifThreadId)) {
        orphanedTurn = null;
      }
    }
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    if (target.writableLength > MAX_CLIENT_BUFFER_BYTES) {
      // The client stopped reading; drop it rather than buffering the whole
      // stream in broker memory. Its close handler frees ownership.
      target.destroy();
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    } else if (message.method === "turn/completed" && !activeStreamSocket && activeRequestSocket === target) {
      const completedThreadId = message.params?.threadId;
      if (completedThreadId) {
        pendingStreamCompletions.add(completedThreadId);
      }
    }
  }

  function closeListener(server: net.Server): Promise<void> {
    if (!serverClosePromise) {
      serverClosePromise = new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch (error) {
          if ((error as NodeJS.ErrnoException | null)?.code === "ERR_SERVER_NOT_RUNNING") {
            resolve();
            return;
          }
          throw error;
        }
      });
    }
    return serverClosePromise;
  }

  async function shutdown(server: net.Server, options: { destroySockets?: boolean } = {}): Promise<void> {
    shuttingDown = true;
    closeListener(server);
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      for (const socket of sockets) {
        try {
          if (options.destroySockets) {
            socket.destroy();
          } else {
            socket.end();
          }
        } catch {
          // One errored socket must not abort teardown before appClient.close().
        }
      }
      await appClient.close().catch(() => {});
      await serverClosePromise;
      try {
        if (listenTarget.kind === "unix") {
          fs.unlinkSync(listenTarget.path);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
          throw error;
        }
      }
      try {
        if (pidFile) {
          fs.unlinkSync(pidFile);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
          throw error;
        }
      }
    })();
    return shutdownPromise;
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message: BrokerClientMessage;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${(error as SyntaxError).message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          if (message.params?.ifIdle) {
            const anotherClientConnected = [...sockets].some(
              (candidate) => candidate !== socket && !candidate.destroyed
            );
            if (anotherClientConnected || activeRequestSocket || activeStreamSocket) {
              send(socket, { id: message.id, result: { busy: true } });
              continue;
            }

            shuttingDown = true;
            closeListener(server);
            send(socket, { id: message.id, result: { ok: true, pid: process.pid } });
            try {
              await shutdown(server);
            } finally {
              process.exit(0);
            }
          }

          send(socket, { id: message.id, result: {} });
          try {
            await shutdown(server);
          } finally {
            process.exit(0);
          }
        }

        if (message.id === undefined) {
          continue;
        }

        if (shuttingDown) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is shutting down.")
          });
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(
              message.method as AppServerMethod,
              (message.params ?? {}) as AppServerRequestParams<AppServerMethod>
            );
            send(socket, { id: message.id, result });
          } catch (error) {
            const rpcError = error as RpcCapableError;
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(rpcError.rpcCode ?? -32000, rpcError.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method as string);
        if (orphanedTurn && Date.now() - orphanedTurn.at >= ORPHAN_GRACE_MS) {
          orphanedTurn = null;
        }
        if (isStreaming && orphanedTurn) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is finishing an abandoned turn.")
          });
          continue;
        }
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(
            message.method as AppServerMethod,
            (message.params ?? {}) as AppServerRequestParams<AppServerMethod>
          );
          send(socket, { id: message.id, result });
          if (isStreaming) {
            const streamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
            const alreadyCompleted = [...streamThreadIds].some((threadId) =>
              pendingStreamCompletions.has(threadId)
            );
            if (!alreadyCompleted) {
              activeStreamSocket = socket;
              activeStreamThreadIds = streamThreadIds;
            }
          }
          pendingStreamCompletions.clear();
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          const rpcError = error as RpcCapableError;
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(rpcError.rpcCode ?? -32000, rpcError.message)
          });
          pendingStreamCompletions.clear();
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  void appClient.exitPromise.then(async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await shutdown(server, { destroySockets: true });
    } finally {
      process.exit(1);
    }
  });

  process.on("SIGTERM", async () => {
    try {
      await shutdown(server);
    } finally {
      process.exit(0);
    }
  });

  process.on("SIGINT", async () => {
    try {
      await shutdown(server);
    } finally {
      process.exit(0);
    }
  });

  server.listen(listenTarget.path, () => {
    if (listenTarget.kind === "unix") {
      try {
        // Owner-only even if the parent temp dir's 0700 protection is weakened.
        fs.chmodSync(listenTarget.path, 0o600);
      } catch {
        // Best-effort hardening; the 0700 session dir remains the primary guard.
      }
    }
  });
}

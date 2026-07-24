#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "../src/shared/args.ts";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "../src/transport/app-server-client.ts";
import { parseBrokerEndpoint } from "../src/broker/endpoint.ts";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
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

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  // The broker is shared by every session in the workspace: a throw escaping
  // an async socket handler or the notification router must not kill it.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`broker unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
  });
  process.on("uncaughtException", (error) => {
    process.stderr.write(`broker uncaught exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  });

  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let shuttingDown = false;
  let shutdownPromise = null;
  let serverClosePromise = null;
  const sockets = new Set();

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  const MAX_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024;
  // Completions observed while a turn-starting request is still in flight
  // (activeRequestSocket set, activeStreamSocket not yet installed). A very
  // fast turn can complete in the same stdout chunk as its start response;
  // installing the stream afterwards would wedge the broker busy.
  const pendingStreamCompletions = new Set();

  function routeNotification(message) {
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

  function closeListener(server) {
    if (!serverClosePromise) {
      serverClosePromise = new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch (error) {
          if (error?.code === "ERR_SERVER_NOT_RUNNING") {
            resolve();
            return;
          }
          throw error;
        }
      });
    }
    return serverClosePromise;
  }

  async function shutdown(server, options = {}) {
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
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
      try {
        if (pidFile) {
          fs.unlinkSync(pidFile);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
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

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
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
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
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
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

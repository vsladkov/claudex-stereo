import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { parseArgs } from '../shared/args.ts';
import {
  BROKER_ABANDONED_TURN_GRACE_MS,
  BROKER_ABANDONED_TURN_MESSAGE,
  BROKER_BUSY_RPC_CODE,
  buildJsonRpcError,
} from '../protocol/broker-rpc.ts';
import type {
  AppServerMethod,
  AppServerNotification,
  AppServerRequestParams,
  AppServerResponse,
} from '../protocol/app-server.ts';
import { parseBrokerEndpoint } from './endpoint.ts';
import { loadBrokerSession } from './lifecycle.ts';
import { positiveIntEnvOr } from '../shared/env.ts';
import { errorCode } from '../shared/errors.ts';

const STREAMING_METHODS = new Set(['turn/start', 'review/start', 'thread/compact/start']);
const DEFAULT_BROKER_SELF_CHECK_MS = 60_000;
// How long shutdown lets clients answer the half-close before it destroys
// their sockets: server.close() waits for every connection, and a client that
// never ends its side would otherwise keep a SIGTERMed broker alive for good.
const SOCKET_CLOSE_GRACE_MS = 2000;

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

interface InFlightStreamRecord {
  socket: net.Socket;
  method: string;
  routingThreadIds: Set<string>;
  expectedCompletionIds: Set<string>;
  disconnected: boolean;
  observedCompletions: Set<string>;
  watchdog: ReturnType<typeof setTimeout> | null;
}

interface ActiveStreamOwnership {
  socket: net.Socket;
  routingThreadIds: Set<string>;
  expectedCompletionIds: Set<string>;
}

interface OrphanedTurn {
  threadIds: Set<string>;
  expectedCompletionIds: Set<string>;
  at: number;
}

export interface BrokerAppServerClient {
  request<M extends AppServerMethod>(
    method: M,
    params: AppServerRequestParams<M>,
  ): Promise<AppServerResponse<M>>;
  setNotificationHandler(handler: ((message: AppServerNotification) => void) | null): void;
  close(): Promise<void>;
  exitPromise: Promise<unknown>;
}

export interface RunBrokerServerDeps {
  connectAppServer: (cwd: string) => Promise<BrokerAppServerClient>;
}

function buildStreamThreadIds(
  method: string | undefined,
  params: BrokerMessageParams,
  result: unknown,
): Set<string> {
  const threadIds = new Set<string>();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  const reviewResult = result as { reviewThreadId?: string | null } | null | undefined;
  if (method === 'review/start' && reviewResult?.reviewThreadId) {
    threadIds.add(reviewResult.reviewThreadId);
  }
  return threadIds;
}

function buildParamsThreadIds(params: BrokerMessageParams): Set<string> {
  return params.threadId ? new Set([params.threadId]) : new Set();
}

function buildExpectedCompletionIds(
  method: string | undefined,
  paramsThreadIds: Set<string>,
  result: unknown,
): Set<string> {
  const reviewResult = result as { reviewThreadId?: string | null } | null | undefined;
  if (method === 'review/start' && reviewResult?.reviewThreadId) {
    return new Set([reviewResult.reviewThreadId]);
  }
  return new Set(paramsThreadIds);
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
  return message?.method === 'turn/interrupt';
}

function writePidFile(pidFile: string | null): void {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
}

export async function runBrokerServer(
  fullArgv: string[],
  deps: RunBrokerServerDeps,
): Promise<void> {
  // The broker is shared by every session in the workspace: a throw escaping
  // an async socket handler or the notification router must not kill it.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(
      `broker unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
    );
  });
  process.on('uncaughtException', (error) => {
    process.stderr.write(
      `broker uncaught exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  });

  const [subcommand, ...argv] = fullArgv;
  if (subcommand !== 'serve') {
    throw new Error(
      'Usage: node scripts/app-server-broker.ts serve --endpoint <value> [--cwd <path>] [--pid-file <path>] [--workspace-record-owned]',
    );
  }

  const { options } = parseArgs(argv, {
    valueOptions: ['cwd', 'pid-file', 'endpoint'],
    booleanOptions: ['workspace-record-owned'],
  });

  if (!options.endpoint) {
    throw new Error('Missing required --endpoint.');
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd as string) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options['pid-file'] ? path.resolve(options['pid-file'] as string) : null;
  const managedByWorkspaceRecord = Boolean(options['workspace-record-owned']);
  const brokerSelfCheckMs = managedByWorkspaceRecord
    ? positiveIntEnvOr(
        process.env.CODEX_COMPANION_BROKER_SELF_CHECK_MS,
        DEFAULT_BROKER_SELF_CHECK_MS,
      )
    : null;
  writePidFile(pidFile);

  const appClient = await deps.connectAppServer(cwd);
  let activeRequestSocket: net.Socket | null = null;
  let inFlightStream: InFlightStreamRecord | null = null;
  let activeStream: ActiveStreamOwnership | null = null;
  // turn/started can arrive before or after the turn/start response installs
  // the stream socket, so in-flight turn identities are tracked in a map
  // keyed by thread (deleted again on turn/completed) instead of a single
  // install-ordered variable.
  const runningTurns = new Map<string, string>();
  // A client that vanishes mid-turn leaves codex running work nobody will
  // read. Remember the abandoned turn, ask codex to interrupt it, and refuse
  // new streaming work until it completes (or the grace window expires).
  const ORPHAN_GRACE_MS = BROKER_ABANDONED_TURN_GRACE_MS;
  const MAX_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024;
  let orphanedTurn: OrphanedTurn | null = null;
  // Completions observed while a turn-starting request is still in flight. A
  // very fast turn can complete in the same stdout chunk as its start
  // response; installing stream ownership afterwards would wedge the broker.
  const pendingStreamCompletions = new Set<string>();

  function interruptRunningTurn(threadId: string): void {
    const turnId = runningTurns.get(threadId);
    if (!turnId) {
      return;
    }
    void appClient
      .request(
        'turn/interrupt' as AppServerMethod,
        { threadId, turnId } as AppServerRequestParams<AppServerMethod>,
      )
      .catch(() => {
        // Best effort: if the interrupt fails, the grace window still
        // clears the orphan marker.
      });
  }
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let serverClosePromise: Promise<void> | null = null;
  let brokerSelfCheckTimer: ReturnType<typeof setInterval> | null = null;
  let brokerRecordMismatchCount = 0;
  const sockets = new Set<net.Socket>();
  // Clients that sent anything but a shutdown (an `initialize` included),
  // until they disconnect: between its RPCs (initialize, thread/start or
  // thread/resume, then turn/start) a client holds nothing in flight, yet a
  // shutdown in any of those gaps would strand the turn it is about to start.
  // A connection that has sent nothing (an endpoint probe) is not activity.
  const activeClientSockets = new Set<net.Socket>();

  function armOrphanedTurn(
    routingThreadIds: Set<string>,
    expectedCompletionIds: Set<string>,
  ): void {
    if (routingThreadIds.size === 0) {
      return;
    }
    orphanedTurn = {
      threadIds: new Set(routingThreadIds),
      expectedCompletionIds: new Set(expectedCompletionIds),
      at: Date.now(),
    };
    for (const threadId of routingThreadIds) {
      interruptRunningTurn(threadId);
    }
  }

  function streamCompletionWasObserved(record: InFlightStreamRecord): boolean {
    return [...record.expectedCompletionIds].some(
      (threadId) =>
        record.observedCompletions.has(threadId) || pendingStreamCompletions.has(threadId),
    );
  }

  function discardInFlightStream(record: InFlightStreamRecord): boolean {
    if (inFlightStream !== record) {
      return false;
    }
    if (record.watchdog) {
      clearTimeout(record.watchdog);
      record.watchdog = null;
    }
    inFlightStream = null;
    pendingStreamCompletions.clear();
    return true;
  }

  function startNoResponseWatchdog(record: InFlightStreamRecord): void {
    if (record.watchdog || inFlightStream !== record) {
      return;
    }
    record.watchdog = setTimeout(() => {
      if (inFlightStream !== record || !record.disconnected) {
        return;
      }
      const alreadyCompleted = streamCompletionWasObserved(record);
      if (!discardInFlightStream(record)) {
        return;
      }
      if (!alreadyCompleted) {
        armOrphanedTurn(record.routingThreadIds, record.expectedCompletionIds);
      }
    }, ORPHAN_GRACE_MS);
    record.watchdog.unref();
  }

  function clearSocketOwnership(socket: net.Socket): void {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (inFlightStream?.socket === socket) {
      inFlightStream.disconnected = true;
      startNoResponseWatchdog(inFlightStream);
    }
    if (activeStream?.socket === socket) {
      const abandoned = activeStream;
      activeStream = null;
      if (abandoned.routingThreadIds.size > 0) {
        armOrphanedTurn(abandoned.routingThreadIds, abandoned.expectedCompletionIds);
      }
    }
  }

  function routeNotification(message: AppServerNotification): void {
    const notifParams = message.params as
      | { threadId?: string | null; turn?: { id?: string | null } | null; turnId?: string | null }
      | undefined;
    const notifThreadId = notifParams?.threadId ?? null;
    if (message.method === 'turn/completed' && notifThreadId && inFlightStream) {
      inFlightStream.observedCompletions.add(notifThreadId);
    }
    if (message.method === 'turn/started' && notifThreadId) {
      const turnId = notifParams?.turnId ?? notifParams?.turn?.id ?? null;
      if (turnId) {
        runningTurns.set(notifThreadId, turnId);
        // Late interrupt: the owner may have died before turn/started, so the
        // orphan marker exists before there is a turn id to interrupt.
        if (orphanedTurn?.threadIds.has(notifThreadId)) {
          interruptRunningTurn(notifThreadId);
        }
      }
    }
    if (message.method === 'turn/completed' && notifThreadId) {
      runningTurns.delete(notifThreadId);
      // The orphan's completion usually arrives with no connected client, so
      // this must run before the target check below - and it must NOT be
      // forwarded: any current request socket belongs to an unrelated client
      // that never started this turn.
      const orphan = orphanedTurn;
      const expectedIds = orphan?.expectedCompletionIds.size
        ? orphan.expectedCompletionIds
        : orphan?.threadIds;
      if (orphan && expectedIds?.has(notifThreadId)) {
        orphanedTurn = null;
        return;
      }
    }
    // A disconnected in-flight socket remains the routing sink until its
    // response or watchdog transition. send() drops the bytes, preventing a
    // bystander's non-streaming request from receiving the abandoned turn.
    const target = inFlightStream?.socket ?? activeRequestSocket ?? activeStream?.socket;
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
    if (message.method === 'turn/completed' && activeStream?.socket === target) {
      const threadId = message.params?.threadId ?? null;
      if (
        !threadId ||
        activeStream.expectedCompletionIds.size === 0 ||
        activeStream.expectedCompletionIds.has(threadId)
      ) {
        activeStream = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    } else if (
      message.method === 'turn/completed' &&
      !activeStream &&
      inFlightStream?.socket === target
    ) {
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
          if (errorCode(error) === 'ERR_SERVER_NOT_RUNNING') {
            resolve();
            return;
          }
          throw error;
        }
      });
    }
    return serverClosePromise;
  }

  async function shutdown(
    server: net.Server,
    options: { destroySockets?: boolean } = {},
  ): Promise<void> {
    if (brokerSelfCheckTimer) {
      clearInterval(brokerSelfCheckTimer);
      brokerSelfCheckTimer = null;
    }
    shuttingDown = true;
    closeListener(server);
    if (shutdownPromise) {
      return shutdownPromise;
    }
    if (inFlightStream) {
      discardInFlightStream(inFlightStream);
    }
    activeStream = null;
    orphanedTurn = null;
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
      const stragglers = setTimeout(() => {
        for (const socket of sockets) {
          socket.destroy();
        }
      }, SOCKET_CLOSE_GRACE_MS);
      stragglers.unref();
      await appClient.close().catch(() => {});
      // Closing the server removes the socket it bound; a listen that failed
      // (a live listener holds the path) bound nothing, and its path is left alone.
      await serverClosePromise;
      clearTimeout(stragglers);
      try {
        if (pidFile) {
          fs.unlinkSync(pidFile);
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          throw error;
        }
      }
    })();
    return shutdownPromise;
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    const lineQueue: string[] = [];
    let draining = false;

    async function handleLine(line: string): Promise<void> {
      let message: BrokerClientMessage;
      try {
        message = JSON.parse(line);
      } catch (error) {
        send(socket, {
          id: null,
          error: buildJsonRpcError(-32700, `Invalid JSON: ${(error as SyntaxError).message}`),
        });
        return;
      }

      if (message.method !== 'broker/shutdown') {
        activeClientSockets.add(socket);
      }

      if (message.id !== undefined && message.method === 'initialize') {
        send(socket, {
          id: message.id,
          result: {
            userAgent: 'codex-companion-broker',
          },
        });
        return;
      }

      if (message.method === 'initialized' && message.id === undefined) {
        return;
      }

      if (message.id !== undefined && message.method === 'broker/shutdown') {
        if (message.params?.ifIdle) {
          // Deliberately ignores orphanedTurn: SessionEnd must be able to
          // reap a broker whose own worker just died - shutdown closes the
          // codex child, which kills the abandoned turn with it. Idle means
          // nothing in flight and no other client that has spoken still
          // connected (see activeClientSockets).
          const anotherClientActive = [...activeClientSockets].some(
            (candidate) => candidate !== socket && !candidate.destroyed,
          );
          if (anotherClientActive || activeRequestSocket || inFlightStream || activeStream) {
            send(socket, { id: message.id, result: { busy: true } });
            return;
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
        return;
      }

      if (shuttingDown) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, 'Shared Codex broker is shutting down.'),
        });
        return;
      }

      const isStreaming = STREAMING_METHODS.has(message.method as string);
      const allowInterruptDuringActiveStream =
        isInterruptRequest(message) &&
        activeStream &&
        activeStream.socket !== socket &&
        !activeRequestSocket &&
        !inFlightStream;

      // A disconnected in-flight stream keeps only the streaming gate; as
      // before this state existed, unrelated non-streaming probes remain
      // usable while the response/watchdog race resolves.
      const occupiedSocket =
        (inFlightStream && !inFlightStream.disconnected
          ? inFlightStream.socket
          : activeRequestSocket) ?? activeStream?.socket;

      if (occupiedSocket && occupiedSocket !== socket && !allowInterruptDuringActiveStream) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, 'Shared Codex broker is busy.'),
        });
        return;
      }

      if (allowInterruptDuringActiveStream) {
        try {
          const result = await appClient.request(
            message.method as AppServerMethod,
            (message.params ?? {}) as AppServerRequestParams<AppServerMethod>,
          );
          send(socket, { id: message.id, result });
        } catch (error) {
          const rpcError = error as RpcCapableError;
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(rpcError.rpcCode ?? -32000, rpcError.message),
          });
        }
        return;
      }

      if (orphanedTurn && Date.now() - orphanedTurn.at >= ORPHAN_GRACE_MS) {
        // A turn that never completed holds streaming work back no longer
        // than the grace window.
        orphanedTurn = null;
      }
      if (isStreaming && (inFlightStream || activeStream)) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, 'Shared Codex broker is busy.'),
        });
        return;
      }
      if (isStreaming && orphanedTurn) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, BROKER_ABANDONED_TURN_MESSAGE),
        });
        return;
      }

      if (isStreaming) {
        const params = message.params ?? {};
        const paramsThreadIds = buildParamsThreadIds(params);
        const record: InFlightStreamRecord = {
          socket,
          method: message.method as string,
          routingThreadIds: new Set(paramsThreadIds),
          expectedCompletionIds: new Set(paramsThreadIds),
          disconnected: socket.destroyed,
          observedCompletions: new Set(),
          watchdog: null,
        };
        pendingStreamCompletions.clear();
        inFlightStream = record;
        if (record.disconnected) {
          startNoResponseWatchdog(record);
        }

        try {
          const result = await appClient.request(
            message.method as AppServerMethod,
            params as AppServerRequestParams<AppServerMethod>,
          );
          // A watchdog or shutdown may have retired this request and a new
          // request may now own the global slot. Never let the late
          // continuation mutate that successor (request-record ABA guard).
          if (inFlightStream !== record) {
            send(socket, { id: message.id, result });
            return;
          }

          record.routingThreadIds = buildStreamThreadIds(record.method, params, result);
          record.expectedCompletionIds = buildExpectedCompletionIds(
            record.method,
            paramsThreadIds,
            result,
          );
          const alreadyCompleted = streamCompletionWasObserved(record);
          const disconnected = record.disconnected || socket.destroyed;
          discardInFlightStream(record);

          if (!disconnected && !alreadyCompleted) {
            activeStream = {
              socket,
              routingThreadIds: new Set(record.routingThreadIds),
              expectedCompletionIds: new Set(record.expectedCompletionIds),
            };
          } else if (disconnected && !alreadyCompleted) {
            armOrphanedTurn(record.routingThreadIds, record.expectedCompletionIds);
          }
          send(socket, { id: message.id, result });
        } catch (error) {
          // As above, a retired request must not clear a successor's record.
          if (inFlightStream === record) {
            discardInFlightStream(record);
          }
          const rpcError = error as RpcCapableError;
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(rpcError.rpcCode ?? -32000, rpcError.message),
          });
        }
        return;
      }

      activeRequestSocket = socket;
      try {
        const result = await appClient.request(
          message.method as AppServerMethod,
          (message.params ?? {}) as AppServerRequestParams<AppServerMethod>,
        );
        send(socket, { id: message.id, result });
        if (activeRequestSocket === socket) {
          activeRequestSocket = null;
        }
      } catch (error) {
        const rpcError = error as RpcCapableError;
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(rpcError.rpcCode ?? -32000, rpcError.message),
        });
        if (activeRequestSocket === socket) {
          activeRequestSocket = null;
        }
        if (activeStream?.socket === socket) {
          activeStream = null;
        }
      }
    }

    async function drainLineQueue(): Promise<void> {
      if (draining) {
        return;
      }
      draining = true;
      try {
        while (lineQueue.length > 0) {
          const line = lineQueue.shift() as string;
          if (!line.trim()) {
            continue;
          }
          await handleLine(line);
        }
      } finally {
        draining = false;
      }
    }

    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_CLIENT_BUFFER_BYTES) {
        // A client streaming an unterminated line must not grow broker memory.
        socket.destroy();
        return;
      }
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        lineQueue.push(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }
      void drainLineQueue();
    });

    socket.on('close', () => {
      sockets.delete(socket);
      activeClientSockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on('error', () => {
      sockets.delete(socket);
      activeClientSockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  // A listen that fails (EADDRINUSE: a live listener already holds a pinned
  // endpoint's path) bound nothing: tear the app-server down and leave,
  // without touching the path, rather than linger unreachable.
  server.on('error', (error) => {
    process.stderr.write(`broker server error: ${error.message}\n`);
    if (server.listening || shuttingDown) {
      return;
    }
    shuttingDown = true;
    void (async () => {
      try {
        await shutdown(server);
      } finally {
        process.exit(1);
      }
    })();
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

  process.on('SIGTERM', async () => {
    try {
      await shutdown(server);
    } finally {
      process.exit(0);
    }
  });

  process.on('SIGINT', async () => {
    try {
      await shutdown(server);
    } finally {
      process.exit(0);
    }
  });

  server.listen(listenTarget.path, () => {
    if (listenTarget.kind === 'unix') {
      try {
        // Owner-only even if the parent temp dir's 0700 protection is weakened.
        fs.chmodSync(listenTarget.path, 0o600);
      } catch {
        // Best-effort hardening; the 0700 session dir remains the primary guard.
      }
    }

    if (brokerSelfCheckMs != null) {
      brokerSelfCheckTimer = setInterval(() => {
        if (shuttingDown) {
          return;
        }
        if (
          sockets.size > 0 ||
          activeRequestSocket ||
          inFlightStream ||
          activeStream ||
          orphanedTurn
        ) {
          return;
        }

        if (loadBrokerSession(cwd)?.endpoint === endpoint) {
          brokerRecordMismatchCount = 0;
          return;
        }
        brokerRecordMismatchCount += 1;
        if (brokerRecordMismatchCount < 2) {
          return;
        }

        process.stderr.write(
          `broker self-check: workspace record no longer points here; exiting idle broker ${process.pid}\n`,
        );
        void (async () => {
          try {
            await shutdown(server);
          } finally {
            process.exit(0);
          }
        })();
      }, brokerSelfCheckMs);
      brokerSelfCheckTimer.unref();
    }
  });
}

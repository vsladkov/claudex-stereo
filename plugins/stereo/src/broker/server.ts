import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { parseArgs } from '../shared/args.ts';
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from '../transport/app-server-client.ts';
import type {
  AppServerMethod,
  AppServerNotification,
  AppServerRequestParams,
} from '../protocol/app-server.ts';
import {
  claimAndDeleteThreadLock,
  readReservationRecord,
  threadReservationPath,
} from '../workspace/thread-lock-io.ts';
import { parseBrokerEndpoint } from './endpoint.ts';
import { loadBrokerSession } from './lifecycle.ts';

const STREAMING_METHODS = new Set(['turn/start', 'review/start', 'thread/compact/start']);
const DEFAULT_BROKER_SELF_CHECK_MS = 60_000;

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

export interface CapturedThreadLockIdentity {
  pid: number;
  token: string;
}

interface InFlightStreamRecord {
  socket: net.Socket;
  method: string;
  routingThreadIds: Set<string>;
  expectedCompletionIds: Set<string>;
  identities: Map<string, CapturedThreadLockIdentity | null>;
  disconnected: boolean;
  observedCompletions: Set<string>;
  watchdog: ReturnType<typeof setTimeout> | null;
}

interface ActiveStreamOwnership {
  socket: net.Socket;
  routingThreadIds: Set<string>;
  expectedCompletionIds: Set<string>;
  identities: Map<string, CapturedThreadLockIdentity | null>;
}

interface OrphanedTurn {
  threadIds: Set<string>;
  expectedCompletionIds: Set<string>;
  identities: Map<string, CapturedThreadLockIdentity | null>;
  at: number;
}

export interface DeadOwnerReleaseOptions {
  timeoutMs?: number;
  pollMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface DeadOwnerReleaseResult {
  released: boolean;
  reason: string;
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

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null | undefined)?.code !== 'ESRCH';
  }
}

export async function releaseLockForDeadOwner(
  threadId: string,
  identity: CapturedThreadLockIdentity,
  options: DeadOwnerReleaseOptions = {},
): Promise<DeadOwnerReleaseResult> {
  const timeoutMs = options.timeoutMs ?? 6_000;
  const pollMs = options.pollMs ?? 400;
  const isProcessAlive = options.isProcessAlive ?? defaultProcessIsAlive;
  const startedAt = Date.now();

  while (isProcessAlive(identity.pid)) {
    if (Date.now() - startedAt >= timeoutMs) {
      return {
        released: false,
        reason: `Owner pid ${identity.pid} remained alive through the cleanup timeout.`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const outcome = await claimAndDeleteThreadLock(threadId, {
    verify: (record) => ({
      ok:
        !record.invalid &&
        record.threadId === threadId &&
        record.pid === identity.pid &&
        record.token === identity.token,
      reason: `Reservation for thread ${threadId} no longer matches the abandoned owner.`,
    }),
  });
  return {
    released: outcome.released,
    reason: outcome.reason,
  };
}

function buildJsonRpcError(
  code: number,
  message: string,
  data?: unknown,
): { code: number; message: string; data?: unknown } {
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
  return message?.method === 'turn/interrupt';
}

function writePidFile(pidFile: string | null): void {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
}

export async function runBrokerServer(fullArgv: string[]): Promise<void> {
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
  let brokerSelfCheckMs: number | null = null;
  if (managedByWorkspaceRecord) {
    const configuredInterval = Number(process.env.CODEX_COMPANION_BROKER_SELF_CHECK_MS);
    brokerSelfCheckMs =
      Number.isFinite(configuredInterval) && configuredInterval > 0
        ? configuredInterval
        : DEFAULT_BROKER_SELF_CHECK_MS;
  }
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
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
  const ORPHAN_GRACE_MS = 10_000;
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

  function captureThreadLockIdentities(
    threadIds: Set<string>,
  ): Map<string, CapturedThreadLockIdentity | null> {
    const identities = new Map<string, CapturedThreadLockIdentity | null>();
    for (const threadId of threadIds) {
      const record = readReservationRecord(threadReservationPath(threadId));
      if (
        record &&
        !record.invalid &&
        record.threadId === threadId &&
        Number.isInteger(record.pid) &&
        (record.pid as number) > 0 &&
        typeof record.token === 'string' &&
        record.token.length > 0
      ) {
        identities.set(threadId, { pid: record.pid as number, token: record.token });
      } else {
        identities.set(threadId, null);
      }
    }
    return identities;
  }

  function releaseCapturedIdentities(
    identities: Map<string, CapturedThreadLockIdentity | null>,
  ): void {
    for (const [threadId, identity] of identities) {
      if (!identity) {
        continue;
      }
      void releaseLockForDeadOwner(threadId, identity)
        .then((outcome) => {
          process.stderr.write(
            `broker orphan reservation ${threadId}: ${outcome.released ? 'released' : 'retained'} (${outcome.reason})\n`,
          );
        })
        .catch((error) => {
          process.stderr.write(
            `broker orphan reservation ${threadId}: retained (${error instanceof Error ? error.message : String(error)})\n`,
          );
        });
    }
  }

  function armOrphanedTurn(
    routingThreadIds: Set<string>,
    expectedCompletionIds: Set<string>,
    identities: Map<string, CapturedThreadLockIdentity | null>,
  ): void {
    if (routingThreadIds.size === 0) {
      return;
    }
    orphanedTurn = {
      threadIds: new Set(routingThreadIds),
      expectedCompletionIds: new Set(expectedCompletionIds),
      identities: new Map(identities),
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
      if (alreadyCompleted) {
        releaseCapturedIdentities(record.identities);
        return;
      }
      armOrphanedTurn(record.routingThreadIds, record.expectedCompletionIds, record.identities);
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
        armOrphanedTurn(
          abandoned.routingThreadIds,
          abandoned.expectedCompletionIds,
          abandoned.identities,
        );
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
        releaseCapturedIdentities(orphan.identities);
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
          if ((error as NodeJS.ErrnoException | null)?.code === 'ERR_SERVER_NOT_RUNNING') {
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
      await appClient.close().catch(() => {});
      await serverClosePromise;
      try {
        if (listenTarget.kind === 'unix') {
          fs.unlinkSync(listenTarget.path);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
          throw error;
        }
      }
      try {
        if (pidFile) {
          fs.unlinkSync(pidFile);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
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

    socket.on('data', async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');

        if (!line.trim()) {
          continue;
        }

        let message: BrokerClientMessage;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${(error as SyntaxError).message}`),
          });
          continue;
        }

        if (message.id !== undefined && message.method === 'initialize') {
          send(socket, {
            id: message.id,
            result: {
              userAgent: 'codex-companion-broker',
            },
          });
          continue;
        }

        if (message.method === 'initialized' && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === 'broker/shutdown') {
          if (message.params?.ifIdle) {
            // Deliberately ignores orphanedTurn: SessionEnd must be able to
            // reap a broker whose own worker just died - shutdown closes the
            // codex child, which kills the abandoned turn with it.
            const anotherClientConnected = [...sockets].some(
              (candidate) => candidate !== socket && !candidate.destroyed,
            );
            if (anotherClientConnected || activeRequestSocket || inFlightStream || activeStream) {
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
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, 'Shared Codex broker is shutting down.'),
          });
          continue;
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
          continue;
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
          continue;
        }

        if (orphanedTurn && Date.now() - orphanedTurn.at >= ORPHAN_GRACE_MS) {
          // A turn that never completed keeps its reservation for the existing
          // stranded-lock scan and manual remedy.
          orphanedTurn = null;
        }
        if (isStreaming && (inFlightStream || activeStream)) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, 'Shared Codex broker is busy.'),
          });
          continue;
        }
        if (isStreaming && orphanedTurn) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(
              BROKER_BUSY_RPC_CODE,
              'Shared Codex broker is finishing an abandoned turn.',
            ),
          });
          continue;
        }

        if (isStreaming) {
          const params = message.params ?? {};
          const paramsThreadIds = buildParamsThreadIds(params);
          const record: InFlightStreamRecord = {
            socket,
            method: message.method as string,
            routingThreadIds: new Set(paramsThreadIds),
            expectedCompletionIds: new Set(paramsThreadIds),
            identities: captureThreadLockIdentities(paramsThreadIds),
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
              continue;
            }

            record.routingThreadIds = buildStreamThreadIds(record.method, params, result);
            record.expectedCompletionIds = buildExpectedCompletionIds(
              record.method,
              paramsThreadIds,
              result,
            );
            for (const threadId of record.routingThreadIds) {
              if (!record.identities.has(threadId)) {
                record.identities.set(threadId, null);
              }
            }
            const alreadyCompleted = streamCompletionWasObserved(record);
            const disconnected = record.disconnected || socket.destroyed;
            discardInFlightStream(record);

            if (!disconnected && !alreadyCompleted) {
              activeStream = {
                socket,
                routingThreadIds: new Set(record.routingThreadIds),
                expectedCompletionIds: new Set(record.expectedCompletionIds),
                identities: new Map(record.identities),
              };
            } else if (disconnected && alreadyCompleted) {
              releaseCapturedIdentities(record.identities);
            } else if (disconnected) {
              armOrphanedTurn(
                record.routingThreadIds,
                record.expectedCompletionIds,
                record.identities,
              );
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
          continue;
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
    });

    socket.on('close', () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on('error', () => {
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

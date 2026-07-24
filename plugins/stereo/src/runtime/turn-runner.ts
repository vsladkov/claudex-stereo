import { WriteEscalationRetryError } from '../shared/errors.ts';
import type {
  ReviewDelivery,
  ReviewTarget,
  ThreadStartParams,
  Turn,
  TurnStartParams,
} from '../protocol/app-server.ts';
import { modelProviderFor } from '../models/registry.ts';
import { BROKER_ENDPOINT_ENV, CodexAppServerClient } from '../transport/app-server-client.ts';
import { loadBrokerSession } from '../broker/lifecycle.ts';
import { getCodexAvailability } from './availability.ts';
import { acquireThreadReservation, releaseThreadReservation } from './reservations.ts';
import type { ThreadReservation } from './reservations.ts';
import { buildResultStatus } from './structured-output.ts';
import {
  buildTurnInput,
  drainMismatchingBroker,
  resumeSatisfiesWriteRequest,
  resumeThread,
  startThread,
  withAppServer,
  withDirectAppServer,
} from './threads.ts';
import type { AppServerClient, BrokerMismatch } from './threads.ts';
import { captureTurn, emitProgress } from './turn-capture.ts';
import type { CommandExecutionItem, FileChangeItem, ProgressReporter } from './turn-capture.ts';

export function cleanCodexStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        line && !line.startsWith('WARNING: proceeding, even though we could not update PATH:'),
    )
    .join('\n');
}

function collectTouchedFiles(fileChanges: FileChangeItem[]): string[] {
  const paths = new Set<string>();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function writeEscalationRefusedError(threadId: string): Error {
  return new Error(
    `Codex resumed thread ${threadId} read-only despite the workspace-write request. The write run was not started.`,
  );
}

export interface InterruptTurnTarget {
  threadId?: string | null;
  turnId?: string | null;
}

export interface InterruptTurnResult {
  attempted: boolean;
  interrupted: boolean;
  transport: string | null;
  detail: string;
}

export async function interruptAppServerTurn(
  cwd: string,
  { threadId, turnId }: InterruptTurnTarget,
): Promise<InterruptTurnResult> {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: 'missing threadId or turnId',
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail,
    };
  }

  const brokerEndpoint =
    process.env[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (!brokerEndpoint) {
    // With no shared runtime there is nothing that could still be executing
    // this turn for us to reach; spawning a fresh app-server here would pay
    // full startup cost only to fail the interrupt against an unknown thread.
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: 'no shared Codex runtime to interrupt',
    };
  }

  let client: AppServerClient | null = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    await client.request('turn/interrupt', { threadId, turnId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`,
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export interface RunAppServerReviewOptions {
  model?: string | null;
  threadName?: string | null;
  delivery?: ReviewDelivery | null;
  target?: ReviewTarget;
  onProgress?: ProgressReporter | null;
}

export interface AppServerReviewResult {
  status: number;
  threadId: string;
  sourceThreadId: string;
  turnId: string | null;
  reviewText: string;
  reasoningSummary: string[];
  turn: Turn | null;
  error: unknown;
  stderr: string;
}

export async function runAppServerReview(
  cwd: string,
  options: RunAppServerReviewOptions = {},
): Promise<AppServerReviewResult> {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      'Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/stereo:setup`.',
    );
  }
  const modelProvider = options.model ? modelProviderFor(options.model) : null;

  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, 'Starting Codex review thread.', 'starting');
    const thread = await startThread(client, cwd, {
      model: options.model,
      modelProvider,
      sandbox: 'read-only',
      ephemeral: true,
      threadName: options.threadName,
    });
    const sourceThreadId = thread.thread.id;
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, 'starting', {
      threadId: sourceThreadId,
    });
    const delivery = options.delivery ?? 'inline';

    const turnState = await captureTurn(
      client,
      sourceThreadId,
      () =>
        client.request('review/start', {
          threadId: sourceThreadId,
          delivery,
          target: options.target as ReviewTarget,
        }),
      {
        onProgress: options.onProgress,
        onResponse(response, state) {
          if (response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
            if (delivery === 'detached') {
              state.threadId = response.reviewThreadId;
            }
          }
        },
      },
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
      stderr: cleanCodexStderr(client.stderr),
    };
  });
}

export interface RunAppServerTurnOptions {
  model?: string | null;
  effort?: string | null;
  sandbox?: ThreadStartParams['sandbox'];
  prompt?: string | null;
  defaultPrompt?: string | null;
  resumeThreadId?: string | null;
  persistThread?: boolean;
  threadName?: string | null;
  outputSchema?: unknown;
  jobId?: string | null;
  jobPid?: number | null;
  onProgress?: ProgressReporter | null;
}

export interface AppServerTurnResult {
  status: number;
  threadId: string;
  turnId: string | null;
  finalMessage: string;
  reasoningSummary: string[];
  turn: Turn | null;
  error: unknown;
  stderr: string;
  fileChanges: FileChangeItem[];
  touchedFiles: string[];
  commandExecutions: CommandExecutionItem[];
}

export async function runAppServerTurn(
  cwd: string,
  options: RunAppServerTurnOptions = {},
): Promise<AppServerTurnResult> {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      'Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/stereo:setup`.',
    );
  }
  const modelProvider = options.model ? modelProviderFor(options.model) : null;

  const reservationMeta = {
    jobId: options.jobId ?? null,
    pid: Number.isFinite(options.jobPid) ? (options.jobPid as number) : process.pid,
  };
  let reservation: ThreadReservation | null = null;
  let mismatch: BrokerMismatch | null = null;

  const attempt = async (
    connectOptions: { disableBroker?: boolean } = {},
  ): Promise<AppServerTurnResult> => {
    const runWithClient = async (client: AppServerClient): Promise<AppServerTurnResult> => {
      let acquiredInThisCallback = false;
      try {
        let threadId: string;

        if (options.resumeThreadId) {
          emitProgress(
            options.onProgress,
            `Resuming thread ${options.resumeThreadId}.`,
            'starting',
          );
          const response = await resumeThread(client, options.resumeThreadId, cwd, {
            model: options.model,
            modelProvider,
            sandbox: options.sandbox,
            ephemeral: false,
          });
          threadId = response.thread.id;

          if (
            options.sandbox === 'workspace-write' &&
            !resumeSatisfiesWriteRequest(response.sandbox)
          ) {
            if (client.transport === 'direct') {
              throw writeEscalationRefusedError(options.resumeThreadId);
            }
            const endpoint = (client as { endpoint?: string | null }).endpoint ?? null;
            mismatch = {
              endpoint,
              ownedEndpoint: endpoint ? (loadBrokerSession(cwd)?.endpoint ?? null) : null,
            };
            emitProgress(
              options.onProgress,
              'Codex resumed the thread read-only; retrying the write run on a private runtime.',
              'starting',
            );
            throw new WriteEscalationRetryError();
          }
        } else {
          emitProgress(options.onProgress, 'Starting Codex task thread.', 'starting');
          const response = await startThread(client, cwd, {
            model: options.model,
            modelProvider,
            sandbox: options.sandbox,
            ephemeral: options.persistThread ? false : true,
            threadName: options.threadName ?? null,
            onThreadStarted(started) {
              if (!options.persistThread) {
                return;
              }
              reservation = acquireThreadReservation(started.thread.id, reservationMeta);
              acquiredInThisCallback = true;
            },
          });
          threadId = response.thread.id;
        }

        emitProgress(options.onProgress, `Thread ready (${threadId}).`, 'starting', {
          threadId,
        });

        const prompt = options.prompt?.trim() || options.defaultPrompt || '';
        if (!prompt) {
          throw new Error('A prompt is required for this Codex run.');
        }

        const turnState = await captureTurn(
          client,
          threadId,
          () =>
            client.request('turn/start', {
              threadId,
              input: buildTurnInput(prompt),
              model: options.model ?? null,
              effort: options.effort ?? null,
              outputSchema: (options.outputSchema ?? null) as TurnStartParams['outputSchema'],
            }),
          { onProgress: options.onProgress },
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
          commandExecutions: turnState.commandExecutions,
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

import process from 'node:process';

import { parsePositiveIntEnv } from '../shared/env.ts';

// These values are the broker wire contract, shared by the broker server
// (below transport) and its clients (above it); they must not live in transport/.
export const BROKER_BUSY_RPC_CODE = -32001;
// What a streaming request gets while the broker winds down a turn whose
// client vanished, and how long the broker waits for that turn at most.
export const BROKER_ABANDONED_TURN_MESSAGE = 'Shared Codex broker is finishing an abandoned turn.';
export const BROKER_ABANDONED_TURN_GRACE_MS = 10_000;
export const BROKER_ENDPOINT_ENV = 'CODEX_COMPANION_APP_SERVER_ENDPOINT';
export const APP_SERVER_REQUEST_TIMEOUT_ENV = 'CODEX_APP_SERVER_REQUEST_TIMEOUT_MS';
const APP_SERVER_CONNECT_TIMEOUT_ENV = 'CODEX_APP_SERVER_CONNECT_TIMEOUT_MS';

const DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_APP_SERVER_CONNECT_TIMEOUT_MS = 5_000;

export function buildJsonRpcError(
  code: number,
  message: string,
  data?: unknown,
): { code: number; message: string; data?: unknown } {
  return data === undefined ? { code, message } : { code, message, data };
}

export function resolveAppServerRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntEnv(
    env[APP_SERVER_REQUEST_TIMEOUT_ENV],
    DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS,
  );
}

export function resolveAppServerConnectTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntEnv(
    env[APP_SERVER_CONNECT_TIMEOUT_ENV],
    DEFAULT_APP_SERVER_CONNECT_TIMEOUT_MS,
  );
}

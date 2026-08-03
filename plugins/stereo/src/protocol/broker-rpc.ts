import process from 'node:process';

// These values are the broker wire contract, shared by the broker server
// (below transport) and its clients (above it); they must not live in transport/.
export const BROKER_BUSY_RPC_CODE = -32001;
export const BROKER_ENDPOINT_ENV = 'CODEX_COMPANION_APP_SERVER_ENDPOINT';
export const APP_SERVER_REQUEST_TIMEOUT_ENV = 'CODEX_APP_SERVER_REQUEST_TIMEOUT_MS';
export const APP_SERVER_CONNECT_TIMEOUT_ENV = 'CODEX_APP_SERVER_CONNECT_TIMEOUT_MS';

const DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_APP_SERVER_CONNECT_TIMEOUT_MS = 5_000;

export function buildJsonRpcError(
  code: number,
  message: string,
  data?: unknown,
): { code: number; message: string; data?: unknown } {
  return data === undefined ? { code, message } : { code, message, data };
}

function resolveDeadlineMs(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw == null || raw.trim() === '') {
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return parsed > 0 ? parsed : 0;
}

export function resolveAppServerRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveDeadlineMs(
    env,
    APP_SERVER_REQUEST_TIMEOUT_ENV,
    DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS,
  );
}

export function resolveAppServerConnectTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveDeadlineMs(
    env,
    APP_SERVER_CONNECT_TIMEOUT_ENV,
    DEFAULT_APP_SERVER_CONNECT_TIMEOUT_MS,
  );
}

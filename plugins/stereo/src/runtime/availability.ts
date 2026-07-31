import { BROKER_ENDPOINT_ENV } from '../protocol/broker-rpc.ts';
import { loadBrokerSession } from '../broker/lifecycle.ts';
import { binaryAvailable } from '../platform/process.ts';
import type { BinaryAvailability } from '../platform/process.ts';

export interface SessionRuntimeStatus {
  mode: 'shared' | 'direct';
  label: string;
  detail: string;
  endpoint: string | null;
}

export interface CodexAvailabilityOptions {
  probeImpl?: typeof binaryAvailable;
}

const availabilityCache = new Map<string, BinaryAvailability>();

function probeCodexAvailability(cwd: string, probe: typeof binaryAvailable): BinaryAvailability {
  const versionStatus = probe('codex', ['--version'], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = probe('codex', ['app-server', '--help'], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`,
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`,
  };
}

// Cleared only by tests: a CLI process is short-lived, and the one long-lived
// process (the broker) never calls this.
export function resetCodexAvailabilityCache(): void {
  availabilityCache.clear();
}

export function getCodexAvailability(
  cwd: string,
  options: CodexAvailabilityOptions = {},
): BinaryAvailability {
  // An injected probe always runs: memoizing it would hide a test's intent.
  if (options.probeImpl) {
    return probeCodexAvailability(cwd, options.probeImpl);
  }
  const cached = availabilityCache.get(cwd);
  if (cached) {
    return cached;
  }
  const status = probeCodexAvailability(cwd, binaryAvailable);
  availabilityCache.set(cwd, status);
  return status;
}

export function getSessionRuntimeStatus(
  env: NodeJS.ProcessEnv | null = process.env,
  cwd: string = process.cwd(),
): SessionRuntimeStatus {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: 'shared',
      label: 'shared session',
      detail: 'This Claude session is configured to reuse one shared Codex runtime.',
      endpoint,
    };
  }

  return {
    mode: 'direct',
    label: 'direct startup',
    detail:
      'No shared Codex runtime is active yet. The first review or task command will start one on demand.',
    endpoint: null,
  };
}

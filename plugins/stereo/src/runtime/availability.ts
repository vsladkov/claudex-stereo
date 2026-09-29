import { BROKER_ENDPOINT_ENV } from '../protocol/broker-rpc.ts';
import { loadBrokerSession } from '../broker/lifecycle.ts';
import { PROBE_TIMEOUT_MS, binaryAvailable, processHasExited } from '../platform/process.ts';
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

// Each probe is bounded: a `codex` that hangs reads as unavailable ("codex
// --version timed out after 15000 ms") instead of hanging a launch or setup.
function probeCodexAvailability(cwd: string, probe: typeof binaryAvailable): BinaryAvailability {
  const versionStatus = probe('codex', ['--version'], { cwd, timeout: PROBE_TIMEOUT_MS });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = probe('codex', ['app-server', '--help'], {
    cwd,
    timeout: PROBE_TIMEOUT_MS,
  });
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

export const CODEX_CLI_MISSING_ERROR =
  'Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/stereo:setup`.';

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
  // A live workspace broker is running `codex app-server` right now, which
  // proves the runtime works without paying the two ~100-300ms probe spawns
  // this one-shot process would otherwise repeat. A dead or recordless
  // broker falls through to the real probe and its friendly install error.
  const brokerSession = loadBrokerSession(cwd);
  if (
    brokerSession?.endpoint &&
    typeof brokerSession.pid === 'number' &&
    brokerSession.pid > 0 &&
    !processHasExited(brokerSession.pid)
  ) {
    const status: BinaryAvailability = {
      available: true,
      detail: 'Live workspace broker; advanced runtime available',
    };
    availabilityCache.set(cwd, status);
    return status;
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

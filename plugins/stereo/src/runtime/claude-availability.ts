import process from 'node:process';

import { availabilityOf, PROBE_TIMEOUT_MS, runCommand } from '../platform/process.ts';
import type { BinaryAvailability, RunCommandFn } from '../platform/process.ts';
import { compareModelVersions } from '../models/model-table.ts';
import { recordLike } from '../shared/json.ts';
import { probeClaudeBinary } from '../transport/claude-cli.ts';

// `--agents <file>` with -p (the way each run receives its role definition)
// arrived in this release.
export const CLAUDE_MIN_VERSION = '2.1.281';

export interface ClaudeAvailability extends BinaryAvailability {
  version: string | null;
  binary: string;
}

export interface ClaudeProbeOptions {
  runCommandImpl?: RunCommandFn;
  env?: NodeJS.ProcessEnv;
}

const availabilityCache = new Map<string, ClaudeAvailability>();

// A probe that never answers is killed once the probe timeout passes and
// reads as a failure that says so.
function timedOut(result: { error: NodeJS.ErrnoException | null }): boolean {
  return result.error?.code === 'ETIMEDOUT';
}

export function resetClaudeAvailabilityCache(): void {
  availabilityCache.clear();
}

export function parseClaudeVersion(text: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

// The binary's one `--version` answer decides: the binary a launch runs, and
// whether it is a Claude Code new enough for the roles.
function probeClaudeAvailability(cwd: string, options: ClaudeProbeOptions): ClaudeAvailability {
  const { binary, version: result } = probeClaudeBinary({
    cwd,
    env: options.env,
    run: options.runCommandImpl,
  });
  const answer: BinaryAvailability = timedOut(result)
    ? { available: false, detail: `claude --version timed out after ${PROBE_TIMEOUT_MS} ms` }
    : availabilityOf(result);
  if (!answer.available) {
    return { ...answer, version: null, binary };
  }
  const version = parseClaudeVersion(answer.detail);
  if (!version) {
    return {
      available: false,
      detail: `${answer.detail}; version could not be parsed`,
      version: null,
      binary,
    };
  }
  if (compareModelVersions(version, CLAUDE_MIN_VERSION) < 0) {
    return {
      available: false,
      detail: `${answer.detail}; Claude roles need Claude Code ${CLAUDE_MIN_VERSION} or newer (run \`claude update\`)`,
      version,
      binary,
    };
  }
  return { available: true, detail: answer.detail, version, binary };
}

// Cached per cwd like the Codex probe: a CLI process is short-lived. An
// injected command runner always runs so a test's intent is never hidden.
export function getClaudeAvailability(
  cwd: string,
  options: ClaudeProbeOptions = {},
): ClaudeAvailability {
  if (options.runCommandImpl) {
    return probeClaudeAvailability(cwd, options);
  }
  const cached = availabilityCache.get(cwd);
  if (cached) {
    return cached;
  }
  const status = probeClaudeAvailability(cwd, options);
  availabilityCache.set(cwd, status);
  return status;
}

export interface ClaudeAuthStatus {
  available: boolean;
  loggedIn: boolean;
  detail: string;
}

// Credentials Claude Code takes from the environment (an API key or token, or
// a cloud provider), which `claude auth status` need not report as a login.
const CLAUDE_ENV_AUTH_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
];

// The environment credential a role would run on, by name; null for none.
export function claudeEnvCredential(env: NodeJS.ProcessEnv = process.env): string | null {
  return CLAUDE_ENV_AUTH_KEYS.find((key) => env[key]?.trim()) ?? null;
}

// `claude auth status --json` starts no session and spends no tokens: exit 0
// means logged in, and the JSON names the account when readable. Without a
// login, credentials in the environment still let a role run.
export function getClaudeAuthStatus(
  cwd: string,
  options: ClaudeProbeOptions = {},
): ClaudeAuthStatus {
  const availability = getClaudeAvailability(cwd, options);
  if (!availability.available) {
    return { available: false, loggedIn: false, detail: availability.detail };
  }
  const env = options.env ?? process.env;
  const run = options.runCommandImpl ?? runCommand;
  const result = run(availability.binary, ['auth', 'status', '--json'], {
    cwd,
    env,
    timeout: PROBE_TIMEOUT_MS,
  });
  const envAuth = claudeEnvCredential(env);
  if (timedOut(result) && !envAuth) {
    return {
      available: true,
      loggedIn: false,
      detail: `claude auth status timed out after ${PROBE_TIMEOUT_MS} ms; login unknown`,
    };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = recordLike(JSON.parse(result.stdout));
  } catch {
    parsed = null;
  }
  const loggedIn = !result.error && result.status === 0 && parsed?.loggedIn !== false;
  const email = typeof parsed?.email === 'string' ? parsed.email : null;
  const subscriptionType =
    typeof parsed?.subscriptionType === 'string' ? parsed.subscriptionType : null;
  if (loggedIn) {
    const account = email ? ` for ${email}` : '';
    const plan = subscriptionType ? ` (${subscriptionType})` : '';
    return { available: true, loggedIn: true, detail: `Claude login active${account}${plan}` };
  }
  if (envAuth) {
    return {
      available: true,
      loggedIn: true,
      detail: `no Claude login; using ${envAuth} from the environment`,
    };
  }
  const failure = result.error
    ? result.error.message
    : result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
  return {
    available: true,
    loggedIn: false,
    detail: `not logged in (${failure}); run \`claude auth login\``,
  };
}

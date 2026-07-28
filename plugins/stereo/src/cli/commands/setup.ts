import process from 'node:process';

import {
  describeStrandedReservation,
  getCodexAuthStatus,
  getCodexAvailability,
  getAccountRateLimits,
  getCodexWriteSandboxStatus,
  getSessionRuntimeStatus,
  listStrandedThreadReservations,
} from '../../runtime/index.ts';
import { binaryAvailable } from '../../platform/process.ts';
import { MODEL_REGISTRY } from '../../models/registry.ts';
import { getConfig, setConfig } from '../../workspace/state.ts';
import { resolveWorkspaceRoot } from '../../workspace/workspace.ts';
import { renderSetupReport } from '../../render/render.ts';
import { parseCommandInput, resolveCommandCwd, resolveCommandWorkspace } from '../io.ts';
import { outputResult } from '../../shared/text.ts';

export interface SetupDeps {
  binaryAvailable: typeof binaryAvailable;
  getCodexAvailability: typeof getCodexAvailability;
  getCodexWriteSandboxStatus: typeof getCodexWriteSandboxStatus;
  getCodexAuthStatus: typeof getCodexAuthStatus;
  getAccountRateLimits: typeof getAccountRateLimits;
  listStrandedThreadReservations: typeof listStrandedThreadReservations;
  env?: NodeJS.ProcessEnv;
}

export const defaultSetupDeps: SetupDeps = {
  binaryAvailable,
  getCodexAvailability,
  getCodexWriteSandboxStatus,
  getCodexAuthStatus,
  getAccountRateLimits,
  listStrandedThreadReservations,
};

export async function buildSetupReport(
  cwd: string,
  actionsTaken: string[] = [],
  deps: SetupDeps = defaultSetupDeps,
) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const env = deps.env ?? process.env;
  const nodeStatus = deps.binaryAvailable('node', ['--version'], { cwd });
  const npmStatus = deps.binaryAvailable('npm', ['--version'], { cwd });
  const codexStatus = deps.getCodexAvailability(cwd);
  const writeSandbox = codexStatus.available ? deps.getCodexWriteSandboxStatus(cwd) : null;
  const authStatus = await deps.getCodexAuthStatus(cwd);
  const rateLimits = codexStatus.available ? await deps.getAccountRateLimits(cwd) : null;
  const config = getConfig(workspaceRoot);
  const strandedReservations = deps.listStrandedThreadReservations();
  const configuredProviders = authStatus.configuredProviders.map((provider) => ({
    ...provider,
    keySet: provider.envKey ? Boolean(env[provider.envKey]) : null,
  }));
  const configuredById = new Map(configuredProviders.map((provider) => [provider.id, provider]));
  const aliases = Object.entries(MODEL_REGISTRY).flatMap(([alias, entry]) => {
    if (!('modelProvider' in entry) || !entry.modelProvider) {
      return [];
    }
    const configuredProvider = configuredById.get(entry.modelProvider) ?? null;
    return [
      {
        alias,
        model: entry.model,
        providerId: entry.modelProvider,
        configured: Boolean(configuredProvider),
        envKey: configuredProvider?.envKey ?? null,
        keySet: configuredProvider?.keySet ?? null,
      },
    ];
  });

  const nextSteps: string[] = [];
  if (!codexStatus.available) {
    nextSteps.push('Install Codex with `npm install -g @openai/codex`.');
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push('Run `!codex login`.');
    nextSteps.push(
      'If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.',
    );
  }
  if (writeSandbox?.available === false) {
    nextSteps.push(
      `Write-capable runs (\`/stereo:implement\` and \`task --write\`) will fail because the Codex write sandbox could not start: ${writeSandbox.detail}. On Ubuntu 24.04, this may be caused by the common \`kernel.apparmor_restrict_unprivileged_userns=1\` setting.`,
    );
  }
  for (const reservation of strandedReservations) {
    nextSteps.push(describeStrandedReservation(reservation));
  }
  const unconfiguredAliases = aliases.filter((entry) => !entry.configured);
  if (unconfiguredAliases.length > 0) {
    nextSteps.push(
      `Optional: third-party aliases without a configured provider: ${unconfiguredAliases
        .map((entry) => `codex:${entry.alias} (${entry.providerId})`)
        .join(', ')} — see README "Other model providers" and npm run provider-probe.`,
    );
  }
  for (const provider of configuredProviders) {
    if (provider.envKey && !provider.keySet) {
      nextSteps.push(
        `Set ${provider.envKey} for configured provider ${provider.id}; setup checks only whether the variable is set.`,
      );
    }
  }
  if (!config.stopReviewGate) {
    nextSteps.push(
      'Optional: run `/stereo:setup --enable-review-gate` to require a fresh review before stop.',
    );
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    writeSandbox,
    auth: authStatus,
    rateLimits,
    providers: {
      active: authStatus.provider,
      configured: configuredProviders,
      aliases,
    },
    sessionRuntime: getSessionRuntimeStatus(env, workspaceRoot),
    strandedReservations,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps,
  };
}

export async function handleSetup(argv: string[]): Promise<void> {
  const { options } = parseCommandInput(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json', 'enable-review-gate', 'disable-review-gate'],
  });

  if (options['enable-review-gate'] && options['disable-review-gate']) {
    throw new Error('Choose either --enable-review-gate or --disable-review-gate.');
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken: string[] = [];

  if (options['enable-review-gate']) {
    setConfig(workspaceRoot, 'stopReviewGate', true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options['disable-review-gate']) {
    setConfig(workspaceRoot, 'stopReviewGate', false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

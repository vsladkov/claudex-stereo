import process from 'node:process';

import {
  CLAUDE_MIN_VERSION,
  describeStrandedReservation,
  getClaudeAuthStatus,
  getClaudeAvailability,
  getCodexAuthStatus,
  getCodexAvailability,
  getAccountRateLimits,
  getCodexWriteSandboxStatus,
  getSessionRuntimeStatus,
  listStrandedThreadReservations,
} from '../../runtime/index.ts';
import { binaryAvailable } from '../../platform/process.ts';
import { describeCodexCatalogSource, loadCodexCatalog } from '../../models/catalog.ts';
import { describeModels, MODEL_REGISTRY } from '../../models/registry.ts';
import { getConfig, setConfig } from '../../workspace/state.ts';
import { resolveWorkspaceRoot } from '../../workspace/workspace.ts';
import { renderSetupReport } from '../../render/render.ts';
import type { ModelListing } from '../../render/render.ts';
import { describeRoleDefaults } from '../launch.ts';
import { outputReportResult, parseCommandInput, resolveCommandCwd } from '../io.ts';

export interface SetupDeps {
  binaryAvailable: typeof binaryAvailable;
  getCodexAvailability: typeof getCodexAvailability;
  getCodexWriteSandboxStatus: typeof getCodexWriteSandboxStatus;
  getCodexAuthStatus: typeof getCodexAuthStatus;
  getAccountRateLimits: typeof getAccountRateLimits;
  listStrandedThreadReservations: typeof listStrandedThreadReservations;
  getClaudeAvailability: typeof getClaudeAvailability;
  getClaudeAuthStatus: typeof getClaudeAuthStatus;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
}

export const MINIMUM_NODE_MAJOR = 24;

export const defaultSetupDeps: SetupDeps = {
  binaryAvailable,
  getCodexAvailability,
  getCodexWriteSandboxStatus,
  getCodexAuthStatus,
  getAccountRateLimits,
  listStrandedThreadReservations,
  getClaudeAvailability,
  getClaudeAuthStatus,
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
  // Claude roles run through the Claude Code CLI itself; both probes are local
  // commands, so setup can always report them.
  const claudeStatus = deps.getClaudeAvailability(cwd);
  const claudeAuth = claudeStatus.available ? deps.getClaudeAuthStatus(cwd) : null;
  const writeSandbox = codexStatus.available ? deps.getCodexWriteSandboxStatus(cwd) : null;
  const authStatus = await deps.getCodexAuthStatus(cwd, { forceCatalogRefresh: true });
  const rateLimits = codexStatus.available ? await deps.getAccountRateLimits(cwd) : null;
  const config = getConfig(workspaceRoot);
  const strandedReservations = deps.listStrandedThreadReservations();
  // Read after the auth check above, which refreshes the catalog: a failed
  // fetch or an unusable cache is named among the next steps.
  const catalogProblems = codexStatus.available ? loadCodexCatalog().problems : [];
  // A role default the account cannot run is warned about here, judged by
  // the launch resolver against the catalog just refreshed.
  const describedRoles = await describeRoleDefaults(config.roleDefaults);
  const configuredProviders = authStatus.configuredProviders.map((provider) => ({
    ...provider,
    keySet: provider.envKey ? Boolean(env[provider.envKey]) : null,
  }));
  const configuredById = new Map(configuredProviders.map((provider) => [provider.id, provider]));
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const version = String(nodeVersion).replace(/^v/, '');
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  const supported = Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR;
  const nodeEngine = {
    version,
    major: Number.isInteger(major) ? major : null,
    supported,
    detail: Number.isInteger(major)
      ? `v${version} (>= ${MINIMUM_NODE_MAJOR} required)`
      : `v${version} (major version could not be parsed; >= ${MINIMUM_NODE_MAJOR} required)`,
  };
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
  if (!nodeEngine.supported) {
    nextSteps.push(
      `Upgrade Node from v${nodeEngine.version} to Node ${MINIMUM_NODE_MAJOR} or newer. The plugin runs its TypeScript sources through Node type stripping, so older Node majors cannot load them.`,
    );
  }
  if (!codexStatus.available) {
    nextSteps.push('Install Codex with `npm install -g @openai/codex`.');
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push('Run `!codex login`.');
    nextSteps.push(
      'If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.',
    );
  }
  if (!claudeStatus.available) {
    nextSteps.push(
      `Claude roles (claude:<family>[-<version>]) are unavailable: ${claudeStatus.detail}. Install or update Claude Code to ${CLAUDE_MIN_VERSION} or newer; Codex roles are unaffected.`,
    );
  } else if (claudeAuth && !claudeAuth.loggedIn) {
    nextSteps.push('Run `claude auth login` so Claude roles can launch.');
  }
  if (writeSandbox?.available === false) {
    nextSteps.push(
      `Write-capable runs (\`/stereo:implement\` and \`task --write\`) will fail because the Codex write sandbox could not start: ${writeSandbox.detail}. On Ubuntu 24.04, this may be caused by the common \`kernel.apparmor_restrict_unprivileged_userns=1\` setting.`,
    );
  }
  for (const reservation of strandedReservations) {
    nextSteps.push(describeStrandedReservation(reservation));
  }
  nextSteps.push(...catalogProblems, ...describedRoles.warnings);
  const unconfiguredAliases = aliases.filter((entry) => !entry.configured);
  if (unconfiguredAliases.length > 0) {
    nextSteps.push(
      `Optional: third-party aliases without a configured provider: ${unconfiguredAliases
        .map((entry) => `codex:${entry.alias} (${entry.providerId})`)
        .join(
          ', ',
        )} — see "Other model providers" in the project README at github.com/vsladkov/claudex-stereo.`,
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
    // The built-in planner and implementer are Claude roles, so a missing,
    // too-old, or logged-out Claude CLI is as blocking as a Codex problem.
    ready:
      nodeStatus.available &&
      nodeEngine.supported &&
      codexStatus.available &&
      authStatus.loggedIn &&
      claudeStatus.available &&
      claudeAuth?.loggedIn === true,
    node: nodeStatus,
    nodeEngine,
    npm: npmStatus,
    codex: codexStatus,
    writeSandbox,
    auth: authStatus,
    claude: {
      available: claudeStatus.available,
      detail: claudeStatus.detail,
      version: claudeStatus.version,
    },
    claudeAuth: claudeAuth ? { loggedIn: claudeAuth.loggedIn, detail: claudeAuth.detail } : null,
    rateLimits,
    providers: {
      active: authStatus.provider,
      configured: configuredProviders,
      aliases,
    },
    sessionRuntime: getSessionRuntimeStatus(env, workspaceRoot),
    strandedReservations,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    roleDefaults: describedRoles.entries,
    actionsTaken,
    nextSteps,
  };
}

// The model listing setup renders beside its report (never a JSON field): the
// Claude table, and the Codex catalog with its source when Codex is installed.
export function describeSetupModels(codexAvailable: boolean): ModelListing {
  const catalog = codexAvailable ? loadCodexCatalog() : null;
  return {
    ...describeModels(catalog),
    catalogSource: catalog
      ? `${describeCodexCatalogSource(catalog)}${catalog.path ? ` at ${catalog.path}` : ''}`
      : null,
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
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const actionsTaken: string[] = [];

  if (options['enable-review-gate']) {
    setConfig(workspaceRoot, 'stopReviewGate', true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options['disable-review-gate']) {
    setConfig(workspaceRoot, 'stopReviewGate', false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputReportResult(
    finalReport,
    renderSetupReport(finalReport, describeSetupModels(finalReport.codex.available)),
    options.json,
  );
}

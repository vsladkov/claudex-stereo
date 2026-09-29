import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { TestContext } from 'node:test';

import {
  buildSetupReport,
  describeSetupModels,
  MINIMUM_NODE_MAJOR,
} from '../plugins/stereo/src/cli/commands/setup.ts';
import type { SetupDeps } from '../plugins/stereo/src/cli/commands/setup.ts';
import { buildAppServerAuthStatus } from '../plugins/stereo/src/runtime/auth.ts';
import type { CodexAuthStatus, ConfiguredProvider } from '../plugins/stereo/src/runtime/auth.ts';
import type {
  ConfigReadResponse,
  GetAccountResponse,
} from '../plugins/stereo/src/protocol/app-server.ts';
import {
  recordCatalogFetchFailure,
  writeCodexCatalogCache,
} from '../plugins/stereo/src/models/catalog.ts';
import type { CodexCatalogModel } from '../plugins/stereo/src/models/catalog.ts';
import { claudeModelId } from '../plugins/stereo/src/models/claude-models.ts';
import { latestModelVersion } from '../plugins/stereo/src/models/model-table.ts';
import type { ModelVersionRow } from '../plugins/stereo/src/models/model-table.ts';
import { ROLE_DEFINITIONS } from '../plugins/stereo/src/models/role-defaults.ts';
import { renderSetupReport } from '../plugins/stereo/src/render/render.ts';
import { setConfig } from '../plugins/stereo/src/workspace/state.ts';
import {
  accountCatalogModels,
  claudeProbeFixture,
  makeTempDir,
  useTempCodexHome,
} from './helpers.ts';

// Setup reads the catalog its auth check refreshed: seed the test CODEX_HOME
// the way that check does. A test that needs another catalog takes a
// CODEX_HOME of its own.
writeCodexCatalogCache(accountCatalogModels(), { fetchedAt: '2026-09-24T00:00:00.000Z' });

function withCatalog(t: TestContext, models: CodexCatalogModel[] | null): void {
  useTempCodexHome(t);
  if (models) {
    writeCodexCatalogCache(models, { fetchedAt: '2026-09-24T10:00:00.000Z' });
  }
}

const AVAILABLE = { available: true, detail: 'ok' };
const PROVIDERS: ConfiguredProvider[] = [
  { id: 'moonshot', envKey: 'MOONSHOT_API_KEY' },
  { id: 'dashscope', envKey: 'DASHSCOPE_API_KEY' },
  { id: 'deepseek', envKey: 'DEEPSEEK_API_KEY' },
  { id: 'zhipu', envKey: 'ZAI_API_KEY' },
];

function authStatus(overrides: Partial<CodexAuthStatus> = {}): CodexAuthStatus {
  return {
    available: true,
    loggedIn: true,
    detail: 'ChatGPT login active',
    source: 'app-server',
    authMethod: 'chatgpt',
    verified: true,
    requiresOpenaiAuth: true,
    provider: 'openai',
    configuredProviders: [],
    ...overrides,
  };
}

function setupDeps(
  auth: CodexAuthStatus,
  env: NodeJS.ProcessEnv = {},
  rateLimits: Awaited<ReturnType<SetupDeps['getAccountRateLimits']>> = null,
): SetupDeps {
  return {
    binaryAvailable: () => AVAILABLE,
    getCodexAvailability: () => AVAILABLE,
    getCodexWriteSandboxStatus: () => ({
      available: true,
      detail: 'workspace-write sandbox launches',
    }),
    getCodexAuthStatus: async () => auth,
    getAccountRateLimits: async () => rateLimits,
    listStrandedThreadReservations: () => [],
    getClaudeAvailability: () => CLAUDE_AVAILABLE,
    getClaudeAuthStatus: () => CLAUDE_LOGGED_IN,
    env,
  };
}

const { availability: CLAUDE_AVAILABLE, auth: CLAUDE_LOGGED_IN } = claudeProbeFixture();

test('fresh setup reports four unset workspace role defaults', async () => {
  const report = await buildSetupReport(makeTempDir(), [], setupDeps(authStatus()));
  assert.equal(report.roleDefaults.length, 4);
  assert.ok(report.roleDefaults.every((entry) => entry.model === null && entry.effort === null));
  assert.match(renderSetupReport(report), /- role defaults: none configured/);
});

test('setup includes available account rate limits and omits unavailable snapshots', async () => {
  const snapshot = {
    limitId: 'codex',
    limitName: 'Codex',
    normalModelSlug: null,
    primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1785000000 },
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: false,
    planType: 'plus' as const,
    rateLimitReachedType: null,
  };
  const report = await buildSetupReport(makeTempDir(), [], setupDeps(authStatus(), {}, snapshot));
  assert.deepEqual(report.rateLimits, snapshot);
  assert.match(renderSetupReport(report), /\nRate limits:\n/);

  const unavailable = await buildSetupReport(makeTempDir(), [], setupDeps(authStatus()));
  assert.equal(unavailable.rateLimits, null);
  assert.doesNotMatch(renderSetupReport(unavailable), /\nRate limits:\n/);
});

test('OpenAI-only setup reports the default provider with one optional alias summary', async () => {
  const report = await buildSetupReport(makeTempDir(), [], setupDeps(authStatus()));
  const rendered = renderSetupReport(report);
  const providerSteps = report.nextSteps.filter((step) => step.includes('third-party aliases'));

  assert.match(rendered, /Model provider: openai \(default\)/);
  assert.doesNotMatch(rendered, /Custom provider/);
  assert.equal(providerSteps.length, 1);
  assert.match(providerSteps[0]!, /codex:kimi \(moonshot\)/);
  assert.match(providerSteps[0]!, /codex:glm \(zhipu\)/);
});

test('configured providers report ready aliases without provider next steps when all keys are set', async () => {
  const env = Object.fromEntries(PROVIDERS.map((provider) => [provider.envKey, 'test-key']));
  const report = await buildSetupReport(
    makeTempDir(),
    [],
    setupDeps(authStatus({ configuredProviders: PROVIDERS }), env),
  );
  const kimi = report.providers.aliases.find((entry) => entry.alias === 'kimi');
  const rendered = renderSetupReport(report);

  assert.deepEqual(kimi, {
    alias: 'kimi',
    model: 'kimi-k3',
    providerId: 'moonshot',
    configured: true,
    envKey: 'MOONSHOT_API_KEY',
    keySet: true,
  });
  assert.match(rendered, /Custom provider moonshot \(codex:kimi → kimi-k3\): MOONSHOT_API_KEY set/);
  assert.equal(
    report.nextSteps.some((step) => /third-party aliases|configured provider/.test(step)),
    false,
  );
});

test('configured providers name an exact missing environment key', async () => {
  const env = Object.fromEntries(
    PROVIDERS.filter((provider) => provider.id !== 'moonshot').map((provider) => [
      provider.envKey,
      'test-key',
    ]),
  );
  const report = await buildSetupReport(
    makeTempDir(),
    [],
    setupDeps(authStatus({ configuredProviders: PROVIDERS }), env),
  );

  assert.equal(
    report.nextSteps.some((step) =>
      step.includes('Set MOONSHOT_API_KEY for configured provider moonshot'),
    ),
    true,
  );
  assert.equal(
    report.nextSteps.some((step) => step.includes('Set DASHSCOPE_API_KEY')),
    false,
  );
});

test('an unconfigured provider is represented once in the optional aliases summary', async () => {
  const configuredProviders = PROVIDERS.filter((provider) => provider.id !== 'dashscope');
  const env = Object.fromEntries(
    configuredProviders.map((provider) => [provider.envKey, 'test-key']),
  );
  const report = await buildSetupReport(
    makeTempDir(),
    [],
    setupDeps(authStatus({ configuredProviders }), env),
  );
  const providerSteps = report.nextSteps.filter((step) => step.includes('third-party aliases'));

  assert.equal(providerSteps.length, 1);
  assert.match(providerSteps[0]!, /codex:qwen \(dashscope\)/);
  assert.doesNotMatch(providerSteps[0]!, /codex:kimi \(moonshot\)/);
});

test('an auth read failure leaves configured providers empty and still renders', async () => {
  const report = await buildSetupReport(
    makeTempDir(),
    [],
    setupDeps(
      authStatus({
        loggedIn: false,
        detail: 'config/read failed',
        source: 'app-server',
        authMethod: null,
        verified: null,
        provider: null,
        configuredProviders: [],
      }),
    ),
  );

  assert.equal(report.ready, false);
  assert.deepEqual(report.providers.configured, []);
  assert.match(renderSetupReport(report), /Model provider: unknown \(default\)/);
});

test('logged-out auth parsing preserves configured providers for setup', async () => {
  const accountResponse = {
    account: null,
    requiresOpenaiAuth: true,
  } as GetAccountResponse;
  const configResponse = {
    config: {
      model_provider: 'openai',
      model_providers: {
        moonshot: {
          name: 'Moonshot',
          env_key: 'MOONSHOT_API_KEY',
        },
      },
    },
    origins: {},
    layers: null,
  } as unknown as ConfigReadResponse;
  const auth = buildAppServerAuthStatus(accountResponse, configResponse);
  const report = await buildSetupReport(
    makeTempDir(),
    [],
    setupDeps(auth, { MOONSHOT_API_KEY: 'test-key' }),
  );

  assert.equal(auth.loggedIn, false);
  assert.deepEqual(auth.configuredProviders, [{ id: 'moonshot', envKey: 'MOONSHOT_API_KEY' }]);
  assert.equal(report.providers.aliases.find((entry) => entry.alias === 'kimi')?.configured, true);
});

test('malformed provider tables are ignored by the auth parser', () => {
  const status = buildAppServerAuthStatus(
    { account: null, requiresOpenaiAuth: true } as GetAccountResponse,
    {
      config: {
        model_provider: 'openai',
        model_providers: ['not', 'a', 'table'],
      },
      origins: {},
      layers: null,
    } as unknown as ConfigReadResponse,
  );

  assert.deepEqual(status.configuredProviders, []);
});

test('setup rejects an old Node major and puts the exact upgrade first', async () => {
  const deps = setupDeps(authStatus());
  deps.nodeVersion = '22.14.0';
  const report = await buildSetupReport(makeTempDir(), [], deps);

  assert.equal(report.ready, false);
  assert.deepEqual(report.nodeEngine, {
    version: '22.14.0',
    major: 22,
    supported: false,
    detail: 'v22.14.0 (>= 24 required)',
  });
  assert.match(report.nextSteps[0]!, /v22\.14\.0/);
  assert.match(report.nextSteps[0]!, /Node 24 or newer/);
  assert.match(report.nextSteps[0]!, /TypeScript sources through Node type stripping/);
  assert.match(renderSetupReport(report), /Status: needs attention/);
  assert.match(renderSetupReport(report), /- node engine: v22\.14\.0 \(>= 24 required\)/);
});

test('setup accepts the minimum Node major without adding an upgrade step', async () => {
  const deps = setupDeps(authStatus());
  deps.nodeVersion = `${MINIMUM_NODE_MAJOR}.0.0`;
  const report = await buildSetupReport(makeTempDir(), [], deps);

  assert.equal(report.ready, true);
  assert.equal(report.nodeEngine.supported, true);
  assert.equal(
    report.nextSteps.some((step) => step.startsWith('Upgrade Node from')),
    false,
  );
});

test('the setup Node minimum matches the root package engine', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { engines?: { node?: string } };
  assert.equal(packageJson.engines?.node, `>=${MINIMUM_NODE_MAJOR}`);
});

test('setup renders one model listing with the catalog it came from, outside the JSON fields', async () => {
  const report = await buildSetupReport(makeTempDir(), [], setupDeps(authStatus()));
  assert.equal('models' in report, false);
  assert.equal('claudeModels' in report, false);
  const rendered = renderSetupReport(report, describeSetupModels(true));
  // Claude: the newest opus row and its effort; Codex: the fake account catalog.
  const opus = latestModelVersion('claude', 'opus') as ModelVersionRow;
  assert.match(
    rendered,
    new RegExp(
      String.raw`\nModels \(efforts are role-launch defaults; a Codex task without a role runs at Codex's own\):\n- Codex catalog: live Codex catalog fetched 2026-09-24T00:00:00\.000Z at \S+codex-models\.json\n- claude:opus → ${claudeModelId('opus', opus.version)} \(effort ${opus.effort}; also [^)]+\)\n[\s\S]*- codex:astra → gpt-6-astra \(effort xhigh\)\n- codex:luna → gpt-6-luna \(effort xhigh; also 5\.6 xhigh\)\n- codex:sol → gpt-6-sol \(effort xhigh; also 5\.6 xhigh\)\n- codex:terra → gpt-5\.6-terra \(effort xhigh\)\n`,
    ),
  );
  assert.doesNotMatch(
    renderSetupReport(report),
    /\nModels/,
    'the listing is passed beside the report',
  );
  assert.equal(
    report.nextSteps.some((step) => step.includes('Codex catalog')),
    false,
  );
});

test('setup shows the one-model built-in floor until a catalog has been fetched', async (t) => {
  withCatalog(t, null);
  const report = await buildSetupReport(makeTempDir(), [], setupDeps(authStatus()));
  const rendered = renderSetupReport(report, describeSetupModels(true));
  assert.match(
    rendered,
    /- Codex catalog: built-in snapshot \(no catalog fetched yet; \/stereo:setup refreshes it\)\n/,
  );
  assert.match(rendered, /\n- codex:astra → gpt-6-astra \(effort xhigh\)\n/);
  assert.doesNotMatch(rendered, /codex:sol/);
});

test('setup warns for each role whose built-in default the fetched catalog lacks', async (t) => {
  withCatalog(
    t,
    accountCatalogModels().filter((model) => model.family !== 'astra'),
  );
  const report = await buildSetupReport(makeTempDir(), [], setupDeps(authStatus()));
  const reviewer = ROLE_DEFINITIONS.find(
    (definition) => definition.flag === 'plan-reviewer',
  )?.builtInSelection;
  const missing = (label: string) =>
    `The ${label}'s built-in default ${reviewer} cannot run: Cannot resolve "${reviewer}": the Codex model catalog lists no astra family, only codex:luna, codex:sol, codex:terra. Use a listed codex:<family>[-<version>], or <id>@<provider> for another provider's model. Pass --model, or store another default with /stereo:config.`;
  assert.deepEqual(
    report.nextSteps.filter((step) => step.includes(`${reviewer} cannot run`)),
    [missing('plan reviewer'), missing('implementation reviewer')],
  );

  // A stored model covers its role: only the role still on the built-in warns.
  const workspace = makeTempDir();
  setConfig(workspace, 'roleDefaults', { planReviewer: { model: 'codex:sol', effort: null } });
  const covered = await buildSetupReport(workspace, [], setupDeps(authStatus()));
  assert.deepEqual(
    covered.nextSteps.filter((step) => step.includes(`${reviewer} cannot run`)),
    [missing('implementation reviewer')],
  );
});

test('setup surfaces catalog problems and stored role-default warnings as next steps', async (t) => {
  withCatalog(t, accountCatalogModels());
  recordCatalogFetchFailure('timed out after 3000ms');
  const workspace = makeTempDir();
  setConfig(workspace, 'roleDefaults', {
    planner: { model: 'claude:session', effort: 'high' },
    planReviewer: { model: 'codex:sol-9', effort: null },
    implementer: { model: 'claude:fabel', effort: null },
  });
  const report = await buildSetupReport(workspace, [], setupDeps(authStatus()));

  assert.ok(
    report.nextSteps.includes(
      'Codex model/list failed (timed out after 3000ms); showing the catalog fetched 2026-09-24T10:00:00.000Z.',
    ),
  );
  assert.match(
    report.nextSteps.find((step) => step.startsWith('implementer stored model')) ?? '',
    /^implementer stored model "claude:fabel" is invalid: Unsupported model "claude:fabel" .* The built-in default will be used\.$/,
  );
  assert.equal(
    report.roleDefaults.find((entry) => entry.role === 'implementer')?.invalidReason === null,
    false,
  );
  assert.match(
    report.nextSteps.find((step) => step.includes('codex:sol-9 cannot run')) ?? '',
    /^The plan reviewer's workspace default codex:sol-9 cannot run: Cannot resolve "codex:sol-9": the Codex model catalog lists sol versions 6 \(gpt-6-sol\), 5\.6 \(gpt-5\.6-sol\)/,
  );
  // An effort beside claude:session is inert, never a warning.
  assert.equal(
    report.nextSteps.some((step) => step.startsWith('planner')),
    false,
  );
});

test('setup omits the Codex catalog when Codex is not installed', async () => {
  const deps = setupDeps(
    authStatus({ available: false, loggedIn: false, detail: 'not found', source: 'availability' }),
  );
  deps.getCodexAvailability = () => ({ available: false, detail: 'not found' });
  const report = await buildSetupReport(makeTempDir(), [], deps);
  const rendered = renderSetupReport(report, describeSetupModels(false));
  assert.doesNotMatch(rendered, /- Codex catalog:|- codex:astra/);
  assert.match(rendered, /\n- claude:opus → /);
  assert.equal(
    report.nextSteps.some((step) => step.includes('Codex catalog')),
    false,
  );
});

test('setup reports the Claude CLI, its login, and the Claude version table', async () => {
  const report = await buildSetupReport(makeTempDir(), [], setupDeps(authStatus()));
  const rendered = renderSetupReport(report);
  assert.match(rendered, /- claude: 2\.1\.281 \(Claude Code\)\n/);
  assert.match(rendered, /- claude auth: Claude login active for fake@example\.com \(team\)\n/);
  assert.equal(
    report.nextSteps.some((step) => step.includes('Claude roles')),
    false,
  );

  const old = setupDeps(authStatus());
  old.getClaudeAvailability = () => ({
    available: false,
    detail:
      '2.1.200 (Claude Code); Claude roles need Claude Code 2.1.281 or newer (run `claude update`)',
    version: '2.1.200',
    binary: 'claude',
  });
  const oldReport = await buildSetupReport(makeTempDir(), [], old);
  assert.equal(oldReport.claudeAuth, null);
  assert.match(
    oldReport.nextSteps.find((step) => step.startsWith('Claude roles')) ?? '',
    /Claude roles \(claude:<family>\[-<version>\]\) are unavailable: 2\.1\.200 .* Install or update Claude Code to 2\.1\.281 or newer; Codex roles are unaffected\./,
  );
  assert.equal(oldReport.ready, false, 'the built-in planner and implementer are Claude roles');
  assert.match(renderSetupReport(oldReport), /Status: needs attention/);

  const loggedOut = setupDeps(authStatus());
  loggedOut.getClaudeAuthStatus = () => ({
    ...CLAUDE_LOGGED_IN,
    loggedIn: false,
    detail: 'not logged in (exit 1); run `claude auth login`',
  });
  const loggedOutReport = await buildSetupReport(makeTempDir(), [], loggedOut);
  assert.match(renderSetupReport(loggedOutReport), /- claude auth: not logged in \(exit 1\)/);
  assert.ok(
    loggedOutReport.nextSteps.includes('Run `claude auth login` so Claude roles can launch.'),
  );
  assert.equal(loggedOutReport.ready, false);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { buildSetupReport, MINIMUM_NODE_MAJOR } from '../plugins/stereo/src/cli/commands/setup.ts';
import type { SetupDeps } from '../plugins/stereo/src/cli/commands/setup.ts';
import { buildAppServerAuthStatus } from '../plugins/stereo/src/runtime/auth.ts';
import type { CodexAuthStatus, ConfiguredProvider } from '../plugins/stereo/src/runtime/auth.ts';
import type {
  ConfigReadResponse,
  GetAccountResponse,
} from '../plugins/stereo/src/protocol/app-server.ts';
import { renderSetupReport } from '../plugins/stereo/src/render/render.ts';
import { makeTempDir } from './helpers.ts';

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
    env,
  };
}

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

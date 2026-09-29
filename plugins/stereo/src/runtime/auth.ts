import type {
  ConfigReadResponse,
  GetAccountResponse,
  Model,
  ModelListResponse,
} from '../protocol/app-server.ts';
import {
  CODEX_CATALOG_TTL_MS,
  fromLiveModel,
  isCodexCatalogFresh,
  loadCodexCatalog,
  recordCatalogFetchFailure,
  writeCodexCatalogCache,
} from '../models/catalog.ts';
import { optionalString, recordLike } from '../shared/json.ts';
import { CodexAppServerClient } from '../transport/app-server-client.ts';
import { getCodexAvailability } from './availability.ts';
import type { AppServerClient } from './threads.ts';
import { errorMessage } from '../shared/errors.ts';

export interface CodexAuthStatus {
  available: boolean;
  loggedIn: boolean;
  detail: string;
  source: string;
  authMethod: string | null;
  verified: boolean | null;
  requiresOpenaiAuth: boolean | null;
  provider: string | null;
  configuredProviders: ConfiguredProvider[];
}

export interface CodexAuthStatusOptions {
  env?: NodeJS.ProcessEnv;
  /** Re-fetch the model catalog even when the cached copy is younger than the TTL. */
  forceCatalogRefresh?: boolean;
  /** Test seam: replaces the app-server connection. */
  connectImpl?: (cwd: string, env: NodeJS.ProcessEnv | undefined) => Promise<AppServerClient>;
}

// Launches are the hot path: a catalog fetched within the catalog TTL is
// reused instead of paying a model/list round trip and a cache rewrite per
// command (the same window config's staleness rule reads). Setup and doctor
// force a refresh because they exist to show current state.
function catalogNeedsRefresh(force: boolean): boolean {
  return force || !isCodexCatalogFresh(loadCodexCatalog(), CODEX_CATALOG_TTL_MS);
}

export interface ConfiguredProvider {
  id: string;
  envKey: string | null;
}

// The provider table lives in user-editable config, so its shape is read
// defensively rather than trusted from the protocol types.
interface ProviderConfigLike {
  name?: unknown;
  env_key?: unknown;
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ['openai', 'OpenAI'],
  ['ollama', 'Ollama'],
  ['lmstudio', 'LM Studio'],
]);

function formatProviderLabel(
  providerId: string | null,
  providerConfig: ProviderConfigLike | null = null,
): string {
  const configuredName = optionalString(providerConfig?.name);
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return 'The active provider';
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields: Partial<CodexAuthStatus> = {}): CodexAuthStatus {
  return {
    available: true,
    loggedIn: false,
    detail: 'not authenticated',
    source: 'unknown',
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    configuredProviders: [],
    ...fields,
  };
}

function resolveProviderConfig(configResponse: ConfigReadResponse | null | undefined): {
  providerId: string | null;
  providerConfig: ProviderConfigLike | null;
  configuredProviders: ConfiguredProvider[];
} {
  const config = configResponse?.config;
  if (!config || typeof config !== 'object') {
    return {
      providerId: null,
      providerConfig: null,
      configuredProviders: [],
    };
  }

  const providerId = optionalString(config.model_provider);
  // `model_providers` (the custom provider table) is not part of the generated
  // Config type, so it is read structurally.
  const providers = recordLike((config as { model_providers?: unknown }).model_providers);
  const providerConfig: ProviderConfigLike | null = providerId
    ? recordLike(providers?.[providerId])
    : null;
  const configuredProviders = Object.entries(providers ?? {}).flatMap(([id, value]) => {
    const provider: ProviderConfigLike | null = recordLike(value);
    return provider
      ? [{ id, envKey: typeof provider.env_key === 'string' ? provider.env_key : null }]
      : [];
  });

  return {
    providerId,
    providerConfig,
    configuredProviders,
  };
}

export function buildAppServerAuthStatus(
  accountResponse: GetAccountResponse | null | undefined,
  configResponse: ConfigReadResponse | null | undefined,
): CodexAuthStatus {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === 'boolean'
      ? accountResponse.requiresOpenaiAuth
      : null;
  const { providerId, providerConfig, configuredProviders } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === 'chatgpt') {
    const email = optionalString(account.email);
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : 'ChatGPT login active',
      source: 'app-server',
      authMethod: 'chatgpt',
      verified: true,
      requiresOpenaiAuth,
      provider: providerId,
      configuredProviders,
    });
  }

  if (account?.type === 'apiKey') {
    return buildAuthStatus({
      loggedIn: true,
      detail: 'API key configured (unverified)',
      source: 'app-server',
      authMethod: 'apiKey',
      verified: false,
      requiresOpenaiAuth,
      provider: providerId,
      configuredProviders,
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: 'app-server',
      requiresOpenaiAuth,
      provider: providerId,
      configuredProviders,
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: 'app-server',
    requiresOpenaiAuth,
    provider: providerId,
    configuredProviders,
  });
}

// The catalog fetch rides on the connection every launch already opens: one
// model/list request for the visible models, bounded by the client's request
// timeout. Older CLIs without model/list, transport errors, a timeout, and an
// empty list keep the previously loaded catalog: availability is advisory,
// never blocking. The failure is recorded on that catalog so setup, doctor,
// and a launch that cannot resolve a family can say why.
async function fetchCodexModels(client: AppServerClient): Promise<Model[] | null> {
  let response: ModelListResponse;
  try {
    response = await client.request('model/list', {
      includeHidden: false,
      limit: 200,
      cursor: null,
    });
  } catch (error) {
    recordCatalogFetchFailure(errorMessage(error));
    return null;
  }
  const models = Array.isArray(response?.data) ? response.data : [];
  if (models.length === 0) {
    recordCatalogFetchFailure('it returned no models');
    return null;
  }
  return models;
}

function refreshCodexCatalog(models: Model[] | null): void {
  if (!models) {
    return;
  }
  const entries = models
    .map((model) => fromLiveModel(model))
    .filter((model): model is NonNullable<typeof model> => model !== null);
  if (entries.length === 0) {
    recordCatalogFetchFailure('no listed model carried an id');
    return;
  }
  // The writer records its own failure and serves the live list in-process.
  writeCodexCatalogCache(entries, { fetchedAt: new Date().toISOString() });
}

async function getCodexAuthStatusFromClient(
  client: AppServerClient,
  cwd: string,
  refreshCatalog: boolean,
): Promise<CodexAuthStatus> {
  try {
    // Settled, not raced: an auth failure must not abandon the in-flight
    // model/list, whose rejection on client close would then be recorded as
    // a spurious catalog fetch failure.
    const [accountResult, configResult, modelsResult] = await Promise.allSettled([
      client.request('account/read', { refreshToken: false }),
      client.request('config/read', {
        includeLayers: false,
        cwd,
      }),
      refreshCatalog ? fetchCodexModels(client) : Promise.resolve(null),
    ]);
    refreshCodexCatalog(modelsResult.status === 'fulfilled' ? modelsResult.value : null);
    if (accountResult.status === 'rejected') {
      throw accountResult.reason;
    }
    if (configResult.status === 'rejected') {
      throw configResult.reason;
    }

    return buildAppServerAuthStatus(accountResult.value, configResult.value);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: errorMessage(error),
      source: 'app-server',
    });
  }
}

export async function getCodexAuthStatus(
  cwd: string,
  options: CodexAuthStatusOptions = {},
): Promise<CodexAuthStatus> {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return buildAuthStatus({
      available: false,
      detail: availability.detail,
      source: 'availability',
    });
  }

  const refreshCatalog = catalogNeedsRefresh(options.forceCatalogRefresh === true);
  const connect =
    options.connectImpl ??
    ((connectCwd: string, env: NodeJS.ProcessEnv | undefined) =>
      CodexAppServerClient.connect(connectCwd, { env, reuseExistingBroker: true }));
  let client: AppServerClient | null = null;
  try {
    client = await connect(cwd, options.env);
    return await getCodexAuthStatusFromClient(client, cwd, refreshCatalog);
  } catch (error) {
    const message = errorMessage(error);
    if (refreshCatalog) {
      // Setup would otherwise say "no catalog fetched yet; /stereo:setup
      // refreshes it" right after setup failed to reach the runtime.
      recordCatalogFetchFailure(`connection failed: ${message}`);
    }
    return buildAuthStatus({
      loggedIn: false,
      detail: message,
      source: 'app-server',
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

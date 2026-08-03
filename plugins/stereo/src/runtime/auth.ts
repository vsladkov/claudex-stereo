import type { ConfigReadResponse, GetAccountResponse } from '../protocol/app-server.ts';
import { optionalString } from '../shared/json.ts';
import { CodexAppServerClient } from '../transport/app-server-client.ts';
import { getCodexAvailability } from './availability.ts';
import type { AppServerClient } from './threads.ts';

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
  const configuredName = typeof providerConfig?.name === 'string' ? providerConfig.name.trim() : '';
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
  const providersValue = (config as { model_providers?: unknown }).model_providers;
  const providers =
    providersValue && typeof providersValue === 'object' && !Array.isArray(providersValue)
      ? (providersValue as Record<string, unknown>)
      : null;
  const providerConfig =
    providerId &&
    providers?.[providerId] &&
    typeof providers[providerId] === 'object' &&
    !Array.isArray(providers[providerId])
      ? (providers[providerId] as ProviderConfigLike)
      : null;
  const configuredProviders = providers
    ? Object.entries(providers).flatMap(([id, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return [];
        }
        const provider = value as ProviderConfigLike;
        return [
          {
            id,
            envKey: typeof provider.env_key === 'string' ? provider.env_key : null,
          },
        ];
      })
    : [];

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
    const email =
      typeof account.email === 'string' && account.email.trim() ? account.email.trim() : null;
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

async function getCodexAuthStatusFromClient(
  client: AppServerClient,
  cwd: string,
): Promise<CodexAuthStatus> {
  try {
    const accountResponse = await client.request('account/read', { refreshToken: false });
    const configResponse = await client.request('config/read', {
      includeLayers: false,
      cwd,
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
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
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: 'availability',
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null,
      configuredProviders: [],
    };
  }

  let client: AppServerClient | null = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true,
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: 'app-server',
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

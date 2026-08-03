import fs from 'node:fs';
import path from 'node:path';

import { resolveCodexHome } from '../workspace/thread-lock-io.ts';
import { MODEL_REGISTRY } from './registry.ts';

export interface CatalogDriftEntry {
  alias: string;
  model: string;
  present: boolean;
  supportedInApi: boolean | null;
}

export interface CatalogDriftReport {
  available: boolean;
  path: string;
  reason: string | null;
  fetchedAt: string | null;
  clientVersion: string | null;
  entries: CatalogDriftEntry[];
  warnings: string[];
}

function unavailableReport(filePath: string, reason: string): CatalogDriftReport {
  return {
    available: false,
    path: filePath,
    reason,
    fetchedAt: null,
    clientVersion: null,
    entries: [],
    warnings: [],
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readModelCatalogDrift(codexHome = resolveCodexHome()): CatalogDriftReport {
  const filePath = path.join(codexHome, 'models_cache.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT'
        ? `Model catalog cache not found at ${filePath}.`
        : `Could not read model catalog cache at ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
    return unavailableReport(filePath, reason);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return unavailableReport(filePath, `Model catalog cache at ${filePath} is not a JSON object.`);
  }
  const cache = parsed as Record<string, unknown>;
  if (!Array.isArray(cache.models)) {
    return unavailableReport(filePath, `Model catalog cache at ${filePath} has no models array.`);
  }

  const cachedBySlug = new Map<string, Record<string, unknown>>();
  for (const value of cache.models) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const model = value as Record<string, unknown>;
    if (typeof model.slug === 'string' && model.slug.trim()) {
      cachedBySlug.set(model.slug.trim(), model);
    }
  }

  const entries: CatalogDriftEntry[] = [];
  const warnings: string[] = [];
  for (const [alias, registryEntry] of Object.entries(MODEL_REGISTRY)) {
    if (
      ('modelProvider' in registryEntry && registryEntry.modelProvider) ||
      !registryEntry.model.startsWith('gpt-')
    ) {
      continue;
    }
    const cached = cachedBySlug.get(registryEntry.model);
    const supportedInApi = cached
      ? typeof cached.supported_in_api === 'boolean'
        ? cached.supported_in_api
        : null
      : null;
    entries.push({
      alias,
      model: registryEntry.model,
      present: Boolean(cached),
      supportedInApi,
    });
    if (!cached) {
      warnings.push(
        `Registry alias codex:${alias} names ${registryEntry.model}, which is absent from the Codex model catalog.`,
      );
    } else if (supportedInApi !== true) {
      warnings.push(
        `Registry alias codex:${alias} names ${registryEntry.model}, but the Codex model catalog does not mark it supported_in_api: true.`,
      );
    }
  }

  return {
    available: true,
    path: filePath,
    reason: null,
    fetchedAt: optionalString(cache.fetched_at),
    clientVersion: optionalString(cache.client_version),
    entries,
    warnings,
  };
}

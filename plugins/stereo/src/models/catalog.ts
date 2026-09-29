import fs from 'node:fs';
import path from 'node:path';

import { compareModelVersions, FALLBACK_EFFORT } from './model-table.ts';
import type { Model } from '../protocol/app-server.ts';
import { readJsonFileTolerant, writeJsonAtomic } from '../shared/fs.ts';
import { optionalString, recordLike } from '../shared/json.ts';
import { COMPANION_STATE_DIR } from '../workspace/state.ts';
import { resolveCodexHome } from '../workspace/thread-lock-io.ts';
import { errorMessage } from '../shared/errors.ts';

// Reasoning tiers in ascending order. `ultra` sits above `max` on the models
// that advertise it and is never a default.
export const EFFORT_LADDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export type CatalogEffort = (typeof EFFORT_LADDER)[number];
const EFFORT_SET: ReadonlySet<string> = new Set(EFFORT_LADDER);

export type CodexCatalogSource = 'companion' | 'builtin';

export interface CodexCatalogModel {
  id: string;
  family: string | null;
  version: string | null;
  efforts: CatalogEffort[];
}

export interface CodexCatalog {
  source: CodexCatalogSource;
  /** The cache file this catalog was read from or written to; null when nothing on disk backs it. */
  path: string | null;
  fetchedAt: string | null;
  models: CodexCatalogModel[];
  /** Diagnostics: unusable cache files, failed fetches, failed writes. */
  problems: string[];
  /** Why the last model/list fetch in this process failed; absent when none failed. */
  fetchFailure?: string;
}

const COMPANION_CATALOG_FILE = 'codex-models.json';
const COMPANION_CATALOG_VERSION = 1;
// OpenAI catalog ids that belong to a family: gpt-<version>-<family>. Plain
// ids such as gpt-5.5 have no family and stay raw-id-only selections.
const OPENAI_FAMILY_ID = /^gpt-(\d+(?:\.\d+)*)-([a-z][a-z0-9]*)$/;

export function parseOpenAiModelId(id: string): { version: string; family: string } | null {
  const match = OPENAI_FAMILY_ID.exec(id);
  return match ? { version: match[1] as string, family: match[2] as string } : null;
}

function effortRank(effort: string): number {
  return EFFORT_LADDER.indexOf(effort as CatalogEffort);
}

function normalizeEfforts(values: unknown): CatalogEffort[] {
  const efforts: CatalogEffort[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const record = recordLike(value);
    const effort =
      typeof value === 'string' ? value : (record?.reasoningEffort ?? record?.effort ?? null);
    if (
      typeof effort === 'string' &&
      EFFORT_SET.has(effort) &&
      !efforts.includes(effort as CatalogEffort)
    ) {
      efforts.push(effort as CatalogEffort);
    }
  }
  return efforts.sort((left, right) => effortRank(left) - effortRank(right));
}

function catalogModel(id: string, efforts: CatalogEffort[]): CodexCatalogModel {
  const parsed = parseOpenAiModelId(id);
  return { id, family: parsed?.family ?? null, version: parsed?.version ?? null, efforts };
}

// The offline floor holds exactly the model the built-in Codex role defaults
// name, so `codex:astra-6` resolves before the first fetch; every other
// family comes from the live catalog, which the first launch-ready check writes.
export const BUILTIN_CATALOG_SNAPSHOT: readonly CodexCatalogModel[] = [
  catalogModel('gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
];

export function builtinCatalog(): CodexCatalog {
  return {
    source: 'builtin',
    path: null,
    fetchedAt: null,
    models: [...BUILTIN_CATALOG_SNAPSHOT],
    problems: [],
  };
}

// `model` is the slug thread/start accepts; `id` is the picker id, which a
// tiered or aliased preset may spell differently. The catalog keys on the slug
// so a family selection always resolves to something the runtime will run.
export function fromLiveModel(model: Model): CodexCatalogModel | null {
  const record = recordLike(model);
  const id = optionalString(record?.model) ?? optionalString(record?.id);
  if (!record || !id) {
    return null;
  }
  return catalogModel(id, normalizeEfforts(record.supportedReasoningEfforts));
}

export function resolveCompanionCatalogFile(codexHome = resolveCodexHome()): string {
  return path.join(codexHome, COMPANION_STATE_DIR, COMPANION_CATALOG_FILE);
}

// The cache this plugin writes. A missing file is silent; a present one that
// yields no model (unreadable, another format, an empty list) is named in
// `problems` so diagnostics can say why the snapshot is in effect. Family and
// version are re-derived from the id.
function readCompanionCatalog(filePath: string, problems: string[]): CodexCatalog | null {
  const read = readJsonFileTolerant(filePath);
  if (read.missing) {
    return null;
  }
  const record = recordLike(read.record);
  const listed =
    record?.version === COMPANION_CATALOG_VERSION && Array.isArray(record.models)
      ? record.models
      : [];
  const models: CodexCatalogModel[] = [];
  for (const value of listed) {
    const entry = recordLike(value);
    const id = optionalString(entry?.id);
    if (entry && id) {
      models.push(catalogModel(id, normalizeEfforts(entry.efforts)));
    }
  }
  if (models.length === 0) {
    problems.push(`Ignored ${filePath}: not a usable catalog cache; /stereo:setup rewrites it.`);
    return null;
  }
  return {
    source: 'companion',
    path: filePath,
    fetchedAt: optionalString(record?.fetchedAt),
    models,
    problems: [],
  };
}

// One catalog per CODEX_HOME per process: the CLI is short-lived, and the
// writer below replaces the entry after a live fetch.
const catalogMemo = new Map<string, CodexCatalog>();

export interface LoadCodexCatalogOptions {
  codexHome?: string;
}

export function loadCodexCatalog(options: LoadCodexCatalogOptions = {}): CodexCatalog {
  const codexHome = options.codexHome ?? resolveCodexHome();
  const cached = catalogMemo.get(codexHome);
  if (cached) {
    return cached;
  }
  const problems: string[] = [];
  const catalog =
    readCompanionCatalog(resolveCompanionCatalogFile(codexHome), problems) ?? builtinCatalog();
  catalog.problems = problems;
  catalogMemo.set(codexHome, catalog);
  return catalog;
}

function fetchedAtMs(catalog: CodexCatalog): number {
  return Date.parse(catalog.fetchedAt ?? '');
}

// Only a fetch this plugin made, younger than maxAgeMs, counts as fresh. A
// stamp from the future (clock skew, a copied file) is not fresh either.
export function isCodexCatalogFresh(catalog: CodexCatalog, maxAgeMs: number): boolean {
  if (catalog.source !== 'companion') {
    return false;
  }
  const age = Date.now() - fetchedAtMs(catalog);
  return Number.isFinite(age) && age >= 0 && age < maxAgeMs;
}

// How long a fetched catalog counts as current: the launch-ready check skips
// its model/list refresh while the cache is younger than this.
export const CODEX_CATALOG_TTL_MS = 10 * 60 * 1000;

export interface WriteCodexCatalogOptions {
  codexHome?: string;
  fetchedAt?: string;
}

// Publishes a live model/list result. The memo takes the list before the
// write, so a read-only or full CODEX_HOME degrades to "not persisted" (named
// in `problems`), never to "resolved against stale data".
export function writeCodexCatalogCache(
  models: readonly CodexCatalogModel[],
  options: WriteCodexCatalogOptions = {},
): CodexCatalog {
  const codexHome = options.codexHome ?? resolveCodexHome();
  const filePath = resolveCompanionCatalogFile(codexHome);
  const catalog: CodexCatalog = {
    source: 'companion',
    path: filePath,
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    models: [...models],
    problems: [],
  };
  catalogMemo.set(codexHome, catalog);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeJsonAtomic(filePath, {
      version: COMPANION_CATALOG_VERSION,
      fetchedAt: catalog.fetchedAt,
      models: catalog.models.map(
        ({ family: _family, version: _version, ...persisted }) => persisted,
      ),
    });
  } catch (error) {
    catalog.path = null;
    catalog.problems.push(
      `Could not write the Codex catalog cache ${filePath}: ${errorMessage(error)}. The live list applies to this command only.`,
    );
  }
  return catalog;
}

// A failed model/list fetch keeps whatever catalog is loaded, but must not be
// silent: setup and doctor list the reason among their next steps, and a
// launch that cannot resolve a family names it.
export function recordCatalogFetchFailure(reason: string, codexHome?: string): void {
  const catalog = loadCodexCatalog({ codexHome });
  catalog.fetchFailure = reason;
  catalog.problems.push(
    `Codex model/list failed (${reason}); showing ${
      catalog.source === 'companion'
        ? `the catalog fetched ${catalog.fetchedAt ?? 'earlier'}`
        : 'the built-in snapshot'
    }.`,
  );
}

export function describeCodexCatalogSource(
  catalog: Pick<CodexCatalog, 'source' | 'fetchedAt' | 'path'>,
): string {
  if (catalog.source === 'companion') {
    return `live Codex catalog fetched ${catalog.fetchedAt ?? 'at an unknown time'}${
      catalog.path ? '' : ' (not persisted)'
    }`;
  }
  return 'built-in snapshot (no catalog fetched yet; /stereo:setup refreshes it)';
}

// A family's versions, newest first.
export function catalogFamilyVersions(catalog: CodexCatalog, family: string): CodexCatalogModel[] {
  return catalog.models
    .filter((model) => model.family === family && model.version !== null)
    .sort((left, right) => compareModelVersions(right.version as string, left.version as string));
}

// Every family the catalog lists, alphabetically.
export function listCodexCatalogFamilies(catalog: CodexCatalog): string[] {
  return [
    ...new Set(
      catalog.models
        .map((model) => model.family)
        .filter((family): family is string => typeof family === 'string'),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

// The catalog entry for an id: exact first, then case-insensitively, so
// `GPT-6-Astra` finds the slug the catalog spells `gpt-6-astra`.
export function findCatalogModel(catalog: CodexCatalog, id: string): CodexCatalogModel | null {
  const exact = catalog.models.find((model) => model.id === id);
  if (exact) {
    return exact;
  }
  const key = id.toLowerCase();
  return catalog.models.find((model) => model.id.toLowerCase() === key) ?? null;
}

// The fallback effort (xhigh) when the catalog lists it for the model,
// otherwise the model's highest listed tier below it. A model that lists only
// tiers above the fallback gets no override (its own default applies), so no
// default ever reaches `max` or `ultra`. A `gpt-*` id the catalog does not
// know gets the fallback unchecked; any other unknown id gets no override.
export function defaultCatalogEffort(
  bareModel: string,
  catalog: CodexCatalog,
): CatalogEffort | null {
  const entry = findCatalogModel(catalog, bareModel);
  if (entry && entry.efforts.length > 0) {
    if (entry.efforts.includes(FALLBACK_EFFORT)) {
      return FALLBACK_EFFORT;
    }
    const below = entry.efforts.filter(
      (effort) => effortRank(effort) < effortRank(FALLBACK_EFFORT),
    );
    return below.at(-1) ?? null;
  }
  return bareModel.toLowerCase().startsWith('gpt-') ? FALLBACK_EFFORT : null;
}

export interface CodexEffortSource {
  /** Names the effort in the refusal, capitalized: `Effort` by default. */
  source?: string;
  /** Appended to the refusal: what to do instead. */
  remedy?: string;
}

// An effort the resolved model does not list would fail inside Codex after
// the job record exists; refuse it here. `none` switches reasoning off rather
// than naming a tier, a model that lists no tiers (or that the catalog does
// not know) cannot be checked, and a provider-qualified id runs outside the
// catalog, which describes only the OpenAI models.
export function assertCodexEffortListed(
  resolvedModel: string,
  effort: string | null | undefined,
  catalog: CodexCatalog,
  { source = 'Effort', remedy = '' }: CodexEffortSource = {},
): void {
  if (!effort || effort === 'none' || resolvedModel.includes('@')) {
    return;
  }
  const entry = findCatalogModel(catalog, resolvedModel);
  if (!entry || entry.efforts.length === 0 || entry.efforts.includes(effort as CatalogEffort)) {
    return;
  }
  const parsed = parseOpenAiModelId(entry.id);
  const label = parsed ? `codex:${parsed.family} (${entry.id})` : entry.id;
  throw new Error(
    `${source} ${effort} is not a tier ${label} lists; the catalog lists ${entry.efforts.join(', ')}.${remedy}`,
  );
}

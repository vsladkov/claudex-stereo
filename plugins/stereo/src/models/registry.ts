import {
  catalogFamilyVersions,
  defaultCatalogEffort,
  EFFORT_LADDER,
  findCatalogModel,
  listCodexCatalogFamilies,
  loadCodexCatalog,
  parseOpenAiModelId,
} from './catalog.ts';
import {
  compareModelVersions,
  familyModels,
  findModelVersion,
  parseFamilySelection,
} from './model-table.ts';
import type { FamilyModels } from './model-table.ts';
import type { CatalogEffort, CodexCatalog, CodexCatalogModel } from './catalog.ts';
import {
  defaultClaudeEffort,
  describeClaudeModels,
  isClaudeSelection,
  normalizeClaudeEffort,
  parseClaudeSelection,
} from './claude-models.ts';
import type { ClaudeSelection } from './claude-models.ts';
import type { CompanionRuntime } from '../shared/runtime.ts';

export type ReasoningEffort = CatalogEffort;
// The runtime a selection addresses: the Codex app-server or a headless
// `claude -p` process. `claude:session` belongs to neither (it runs inline).
export type ModelRuntime = CompanionRuntime;

export interface ModelEntry {
  model: string;
  /** The effort a launch applies by default; absent means none. */
  defaultModelEffort?: ReasoningEffort;
  modelProvider?: string;
}

const VALID_REASONING_EFFORTS: ReadonlySet<string> = new Set(EFFORT_LADDER);

// OpenAI models are not rows here: `codex:<family>[-<version>]` resolves
// against the Codex model catalog (see catalog.ts), so a new version or family
// needs no code change. Third-party provider models stay as aliases because
// they cannot be enumerated: each row selects a model id plus a
// `[model_providers.<id>]` table, and adding one is a one-row change.
export const MODEL_REGISTRY = {
  kimi: { model: 'kimi-k3', modelProvider: 'moonshot' },
  qwen: { model: 'qwen3.7-plus', modelProvider: 'dashscope' },
  deepseek: { model: 'deepseek-v4-pro', modelProvider: 'deepseek' },
  glm: { model: 'glm-5.2', modelProvider: 'zhipu' },
} satisfies Record<string, ModelEntry>;

// Alias lookup stays a Map keyed by the lowercased alias so exotic inputs
// (e.g. "constructor") can never hit Object.prototype members.
const MODEL_ALIASES = new Map<string, string>(
  Object.entries(MODEL_REGISTRY).map(([alias, entry]) => [alias, entry.model]),
);

// Keyed by the lowercased model id, so a registry id in any case (the
// `glm-5.2` a `codex:glm` job records) finds its row.
const ENTRIES_BY_MODEL = new Map<string, ModelEntry>(
  Object.values(MODEL_REGISTRY).map((entry) => [entry.model.toLowerCase(), entry]),
);

const CODEX_PREFIX = 'codex:';

export interface ModelResolutionOptions {
  /** Catalog to resolve against; defaults to the loaded one. Commands pass the refreshed catalog. */
  catalog?: CodexCatalog;
  /** The runtime the model belongs to; Claude models take the Claude effort table. */
  runtime?: ModelRuntime;
}

// `claude:` selections take the Claude transport and never reach this
// runtime. `codex:` is the symmetric optional way to name the
// runtime that executes everything else, including the third-party provider
// aliases. It is addressing sugar, so it is stripped exactly once before
// alias, provider, and effort resolution; a single strip also leaves
// `codex:codex:<id>` as the escape hatch for a literal `codex:`-prefixed id.
function stripCodexPrefix(model: string): string {
  if (!model.toLowerCase().startsWith(CODEX_PREFIX)) {
    return model;
  }
  const remainder = model.slice(CODEX_PREFIX.length).trim();
  if (!remainder) {
    throw new Error(`Unsupported model "${model}". Use codex:<model> or a bare Codex model id.`);
  }
  if (remainder.toLowerCase().startsWith('claude:')) {
    throw new Error(
      `Unsupported model "${model}". The codex: prefix addresses Codex runtime models; claude: selections are not Codex models.`,
    );
  }
  return remainder;
}

export function registryEntryForModel(resolvedModel: string): ModelEntry | null {
  return ENTRIES_BY_MODEL.get(resolvedModel.toLowerCase()) ?? null;
}

export function parseQualifiedModel(model: string): {
  model: string;
  modelProvider: string | null;
} {
  const separator = model.indexOf('@');
  if (separator === -1) {
    return { model, modelProvider: null };
  }

  const bareModel = model.slice(0, separator);
  const modelProvider = model.slice(separator + 1);
  if (!bareModel || !modelProvider || /[@\s]/.test(modelProvider)) {
    throw new Error(`Unsupported model "${model}". Use <model> or <model>@<provider>.`);
  }
  return { model: bareModel, modelProvider };
}

export interface CodexSelection {
  /** The trimmed text as the user wrote it, for messages. */
  normalized: string;
  /** Lowercased bare model or family token, the lookup key. */
  key: string;
  bareModel: string;
  modelProvider: string | null;
}

// Everything about a selection that needs no catalog: the codex: prefix and
// the @provider split. Commands parse before any runtime probe and resolve
// after the probe refreshed the catalog; a `claude:` selection never gets
// here (parseModelSelection and parseRoleSelection route it by prefix).
export function parseCodexSelection(model: unknown): CodexSelection | null {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  const qualified = parseQualifiedModel(stripCodexPrefix(normalized));
  return {
    normalized,
    key: qualified.model.toLowerCase(),
    bareModel: qualified.model,
    modelProvider: qualified.modelProvider,
  };
}

// Why a family-shaped selection does not resolve, in one message: a catalog
// that is only the built-in snapshot says why (the failed or missing fetch),
// then the family's versions or, for an unknown family, the families.
function unresolvedFamilyMessage(
  selection: CodexSelection,
  family: string,
  versions: readonly CodexCatalogModel[],
  catalog: CodexCatalog,
): string {
  const source =
    catalog.source !== 'builtin'
      ? 'the Codex model catalog'
      : `${
          catalog.fetchFailure
            ? `fetching the Codex model catalog failed (${catalog.fetchFailure})`
            : 'no Codex model catalog has been fetched yet (/stereo:setup fetches it)'
        }, and the built-in snapshot`;
  const listed =
    versions.length > 0
      ? `${family} versions ${versions.map((model) => `${model.version} (${model.id})`).join(', ')}`
      : `no ${family} family, only ${
          listCodexCatalogFamilies(catalog)
            .map((name) => `codex:${name}`)
            .join(', ') || 'none'
        }`;
  return `Cannot resolve "${selection.normalized}": ${source} lists ${listed}. Use a listed codex:<family>[-<version>], or <id>@<provider> for another provider's model.`;
}

// Third-party alias or registry model id, then `<family>[-<version>]` against
// the catalog (the newest version, or the pinned one), then the catalog's own
// spelling of a raw id, then raw passthrough. A family-shaped selection the
// catalog cannot resolve is refused, whatever the catalog's source, rather
// than sent to Codex to fail after the job record exists, when its family is
// one the catalog lists or a purely alphabetic word (a typo such as `atsra`);
// a word with a digit the catalog does not list (`llama3`, `qwen3`) is a
// provider's raw id and passes through. A provider-qualified id runs outside
// the catalog, which describes only the OpenAI models.
export function resolveCodexSelection(selection: CodexSelection, catalog: CodexCatalog): string {
  const { key, bareModel, modelProvider } = selection;
  // A registry id (`glm-5.2`, what a `codex:glm` job records and a resume
  // passes back) is family-shaped, so it must match before the family grammar.
  let resolvedModel = MODEL_ALIASES.get(key) ?? ENTRIES_BY_MODEL.get(key)?.model ?? null;
  const family = resolvedModel ? null : parseFamilySelection(key);
  if (family) {
    const versions = catalogFamilyVersions(catalog, family.family);
    const version = family.version;
    resolvedModel =
      (version === null
        ? versions[0]
        : versions.find((model) => compareModelVersions(model.version as string, version) === 0)
      )?.id ?? null;
    const familyWord = versions.length > 0 || /^[a-z]+$/.test(family.family);
    if (!resolvedModel && !modelProvider && familyWord && !findCatalogModel(catalog, key)) {
      throw new Error(unresolvedFamilyMessage(selection, family.family, versions, catalog));
    }
  }
  // A raw OpenAI id in another case (`GPT-6-Astra`) runs as the slug the
  // catalog lists, so its effort default and tier check find it too. A
  // provider-qualified id runs outside the catalog and keeps its spelling.
  if (!resolvedModel && !modelProvider) {
    resolvedModel = findCatalogModel(catalog, bareModel)?.id ?? null;
  }
  resolvedModel ??= bareModel;
  return modelProvider ? `${resolvedModel}@${modelProvider}` : resolvedModel;
}

export type ModelSelection =
  { runtime: 'claude'; claude: ClaudeSelection } | { runtime: 'codex'; codex: CodexSelection };

// The runtime-aware entry point for every companion command: a `claude:`
// selection is parsed by the Claude grammar (which rejects `claude:session`
// and the removed `claude:inherit`), everything else by the Codex grammar.
export function parseModelSelection(model: unknown): ModelSelection | null {
  if (model == null || !String(model).trim()) {
    return null;
  }
  if (isClaudeSelection(model)) {
    return { runtime: 'claude', claude: parseClaudeSelection(String(model)) };
  }
  const codex = parseCodexSelection(model);
  return codex ? { runtime: 'codex', codex } : null;
}

// The default effort a launch of `resolvedModel` applies when nothing
// overrides it: Claude ids ask the version table; third-party Codex rows take
// none; an OpenAI model takes its version row when the table has one, else
// xhigh stepped down to a tier the catalog lists.
export function defaultModelEffort(
  resolvedModel: string,
  options: ModelResolutionOptions = {},
): ReasoningEffort | null {
  if (options.runtime === 'claude') {
    return defaultClaudeEffort(resolvedModel);
  }
  const { model } = parseQualifiedModel(resolvedModel);
  const entry = registryEntryForModel(model);
  if (entry) {
    return entry.defaultModelEffort ?? null;
  }
  const parsed = parseOpenAiModelId(model);
  const row = parsed ? findModelVersion('codex', parsed.family, parsed.version) : null;
  if (row) {
    return row.effort;
  }
  return defaultCatalogEffort(model, options.catalog ?? loadCodexCatalog());
}

// The model listing setup and config render: every Claude version the table
// knows and every Codex family the catalog lists (none without a catalog),
// each version with the default effort a role launch applies to it; a Codex
// task without a role sends none and runs at Codex's own default.
export function describeModels(catalog: CodexCatalog | null): {
  claude: Record<string, FamilyModels>;
  codex: Record<string, FamilyModels>;
} {
  const codex: Record<string, FamilyModels> = {};
  for (const family of catalog ? listCodexCatalogFamilies(catalog) : []) {
    codex[family] = familyModels(
      catalogFamilyVersions(catalog as CodexCatalog, family).map((model) => ({
        version: model.version as string,
        id: model.id,
        effort: defaultModelEffort(model.id, { catalog: catalog as CodexCatalog }),
      })),
    );
  }
  return { claude: describeClaudeModels(), codex };
}

export function modelProviderFor(resolvedModel: string): string | null {
  return registryEntryForModel(resolvedModel)?.modelProvider ?? null;
}

// Each runtime validates its own ladder: Claude Code accepts low..max, the
// Codex app-server none..ultra. A null runtime means the Codex ladder, which
// is the superset; callers that know the role pass its route instead.
// `source` names the effort in the Claude message (`--effort` by default).
export function normalizeReasoningEffort(
  effort: unknown,
  runtime: ModelRuntime | null = 'codex',
  source?: string,
): ReasoningEffort | null {
  if (runtime === 'claude') {
    return normalizeClaudeEffort(effort, source);
  }
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh, max, ultra.`,
    );
  }
  return normalized as ReasoningEffort;
}

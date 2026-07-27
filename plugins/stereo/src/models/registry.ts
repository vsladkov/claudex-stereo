export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelEntry {
  model: string;
  defaultPairEffort: ReasoningEffort | null;
  modelProvider?: string;
}

export const VALID_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export const PAIR_DEFAULT_MODEL = 'sol';
export const PAIR_DEFAULT_EFFORT: ReasoningEffort = 'max'; // every OpenAI `gpt-*` pair role

export const MODEL_REGISTRY = {
  spark: { model: 'gpt-5.3-codex-spark', defaultPairEffort: PAIR_DEFAULT_EFFORT },
  sol: { model: 'gpt-5.6-sol', defaultPairEffort: PAIR_DEFAULT_EFFORT },
  terra: { model: 'gpt-5.6-terra', defaultPairEffort: PAIR_DEFAULT_EFFORT },
  luna: { model: 'gpt-5.6-luna', defaultPairEffort: PAIR_DEFAULT_EFFORT },
  kimi: { model: 'kimi-k3', modelProvider: 'moonshot', defaultPairEffort: null },
  qwen: { model: 'qwen3.7-plus', modelProvider: 'dashscope', defaultPairEffort: null },
  deepseek: { model: 'deepseek-v4-pro', modelProvider: 'deepseek', defaultPairEffort: null },
  glm: { model: 'glm-5.1', modelProvider: 'zhipu', defaultPairEffort: null },
} satisfies Record<string, ModelEntry>;

// Alias lookup stays a Map keyed by the lowercased alias so exotic inputs
// (e.g. "constructor") can never hit Object.prototype members.
const MODEL_ALIASES = new Map<string, string>(
  Object.entries(MODEL_REGISTRY).map(([alias, entry]) => [alias, entry.model]),
);

const ENTRIES_BY_MODEL = new Map<string, ModelEntry>(
  Object.values(MODEL_REGISTRY).map((entry) => [entry.model, entry]),
);

export function registryEntryForModel(resolvedModel: string): ModelEntry | null {
  return ENTRIES_BY_MODEL.get(resolvedModel) ?? null;
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

export function defaultPairEffort(resolvedModel: string): ReasoningEffort | null {
  const { model } = parseQualifiedModel(resolvedModel);
  // Registry rows are authoritative: adding a provider model (kimi, qwen,
  // deepseek, glm, ...) with its own default effort is a one-row change.
  const entry = registryEntryForModel(model);
  if (entry) {
    return entry.defaultPairEffort;
  }
  // Raw OpenAI model strings fall back to the gpt-* rule. Unknown
  // third-party models omit effort because their accepted knobs vary.
  return model.startsWith('gpt-') ? PAIR_DEFAULT_EFFORT : null;
}

export function modelProviderFor(resolvedModel: string): string | null {
  return registryEntryForModel(resolvedModel)?.modelProvider ?? null;
}

export function normalizeRequestedModel(model: unknown): string | null {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  const qualified = parseQualifiedModel(normalized);
  const resolvedModel = MODEL_ALIASES.get(qualified.model.toLowerCase()) ?? qualified.model;
  return qualified.modelProvider ? `${resolvedModel}@${qualified.modelProvider}` : resolvedModel;
}

export function normalizeReasoningEffort(effort: unknown): ReasoningEffort | null {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh, max.`,
    );
  }
  return normalized as ReasoningEffort;
}

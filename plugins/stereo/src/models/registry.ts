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

// Bare because it feeds normalizeRequestedModel; documentation writes it as `codex:sol`.
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

const CODEX_PREFIX = 'codex:';

// `claude:` names a closed set of Claude Code execution surfaces and never
// reaches this runtime. `codex:` is the symmetric optional way to name the
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
  // The routing skill's invariant ("never pass a claude:* selection to the
  // companion") enforced at the boundary, symmetric with the codex:claude:*
  // rejection below. Without it, `--model claude:opus` reaches Codex as a
  // literal model id and fails late, after a job record already exists.
  if (normalized.toLowerCase().startsWith('claude:')) {
    throw new Error(
      `Unsupported model "${normalized}". claude: selections are Claude Code routes, not Codex models; --model accepts Codex selections only.`,
    );
  }
  const qualified = parseQualifiedModel(stripCodexPrefix(normalized));
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

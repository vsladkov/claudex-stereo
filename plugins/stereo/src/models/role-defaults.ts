import { assertCodexEffortListed, loadCodexCatalog } from './catalog.ts';
import type { CodexCatalog } from './catalog.ts';
import {
  assertClaudeEffortAllowed,
  CLAUDE_SESSION_SELECTION,
  isClaudeSelection,
  parseClaudeSelection,
} from './claude-models.ts';
import {
  defaultModelEffort,
  normalizeReasoningEffort,
  parseCodexSelection,
  parseModelSelection,
  resolveCodexSelection,
} from './registry.ts';
import type { CodexSelection, ModelRuntime, ReasoningEffort } from './registry.ts';
import { optionalString } from '../shared/json.ts';
import { errorMessage } from '../shared/errors.ts';
import type { StereoRoleDefaults, StereoRoleKey } from '../workspace/state.ts';

export interface RoleDefinition {
  key: StereoRoleKey;
  flag: 'planner' | 'plan-reviewer' | 'implementer' | 'implementation-reviewer';
  effortFlag:
    | 'planner-effort'
    | 'plan-reviewer-effort'
    | 'implementer-effort'
    | 'implementation-reviewer-effort';
  label: string;
  allowsClaudeSession: boolean;
  /**
   * The role's built-in default: a model with its version pinned. It also
   * decides the ladder for an effort stored without a model.
   */
  builtInSelection: string;
  /**
   * The effort the role runs its default model at, when the role should
   * differ from the model; null (every built-in today) means the version's
   * own default effort from the model table. An extension point: set it to
   * give a role its own tier without a version row.
   */
  builtInEffort: ReasoningEffort | null;
}

export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    key: 'planner',
    flag: 'planner',
    effortFlag: 'planner-effort',
    label: 'planner',
    allowsClaudeSession: true,
    builtInSelection: 'claude:fable-5.1',
    builtInEffort: null,
  },
  {
    key: 'planReviewer',
    flag: 'plan-reviewer',
    effortFlag: 'plan-reviewer-effort',
    label: 'plan reviewer',
    allowsClaudeSession: true,
    builtInSelection: 'codex:astra-6',
    builtInEffort: null,
  },
  {
    key: 'implementer',
    flag: 'implementer',
    effortFlag: 'implementer-effort',
    label: 'implementer',
    allowsClaudeSession: false,
    builtInSelection: 'claude:opus-5.5',
    builtInEffort: null,
  },
  {
    key: 'implementationReviewer',
    flag: 'implementation-reviewer',
    effortFlag: 'implementation-reviewer-effort',
    label: 'implementation reviewer',
    allowsClaudeSession: true,
    builtInSelection: 'codex:astra-6',
    builtInEffort: null,
  },
];

export type RoleDefaultConfigKey = RoleDefinition['flag'] | RoleDefinition['effortFlag'];
export type RoleDefaultClearKey = RoleDefaultConfigKey | 'roles';

function definitionForFlag(flag: string): RoleDefinition {
  const definition = ROLE_DEFINITIONS.find((candidate) => candidate.flag === flag);
  if (!definition) {
    throw new Error(`Unsupported Stereo role --${flag}.`);
  }
  return definition;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export interface ParsedRoleSelection {
  selection: string;
  /** Which side runs the role: `claude` covers the inline session and the Claude transport. */
  route: ModelRuntime;
  /** True only for `claude:session`, which the main session applies inline; it takes no effort. */
  inline: boolean;
}

// Checks a selection's grammar, which needs no catalog: a Claude selection
// must name a version-table row, and a Codex selection is resolved against
// the catalog only when a command launches (config warns ahead of time).
export function parseRoleSelection(flag: string, value: unknown): ParsedRoleSelection {
  const selection = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!selection) {
    throw new Error(`Provide a model selection for --${flag}.`);
  }
  if (selection.toLowerCase() === CLAUDE_SESSION_SELECTION) {
    if (!definitionForFlag(flag).allowsClaudeSession) {
      throw new Error(
        'claude:session is not a valid --implementer default. Claude writes must stay inside the contained implementer role.',
      );
    }
    return { selection, route: 'claude', inline: true };
  }
  if (isClaudeSelection(selection)) {
    parseClaudeSelection(selection, { flag });
    return { selection, route: 'claude', inline: false };
  }
  if (!parseCodexSelection(selection)) {
    throw new Error(`Provide a model selection for --${flag}.`);
  }
  return { selection, route: 'codex', inline: false };
}

// Validated against the route's ladder when the route is known, else the
// Codex ladder (the superset). `source` names the effort in the Claude-ladder
// message; it defaults to the flag.
export function parseRoleEffort(
  effortFlag: string,
  value: unknown,
  route: ModelRuntime | null = null,
  source = `--${effortFlag}`,
): ReasoningEffort {
  const normalized = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`Provide a reasoning effort for --${effortFlag}.`);
  }
  return normalizeReasoningEffort(normalized, route, source) as ReasoningEffort;
}

// The four roles a companion `--role` takes a default from: each pair role
// its own, and the standalone reviewer roles the implementation reviewer's,
// as /stereo:review and /stereo:adversarial-review do.
export function roleDefaultFlagFor(role: string | null | undefined): RoleDefinition['flag'] | null {
  if (role === 'reviewer' || role === 'adversarial-reviewer') {
    return 'implementation-reviewer';
  }
  return ROLE_DEFINITIONS.find((candidate) => candidate.flag === role)?.flag ?? null;
}

export interface ResolveRoleDefaultOptions {
  /**
   * Names a stored effort in messages; config passes the flag when the effort
   * was set in the same call. Defaults to `the stored workspace effort`.
   */
  effortSource?: string;
}

// Everything one role's default means, judged once per launch without a
// catalog: whether the workspace's stored entry is valid, which selection a
// model-less launch runs, and the role effort paired with it. The launch
// resolves the selection to an id against the catalog it refreshed.
export interface ResolvedRoleDefault {
  /** The stored values as written; null when absent. */
  storedModel: string | null;
  storedEffort: string | null;
  /** The stored model parsed; null when absent or when it does not parse. */
  parsed: ParsedRoleSelection | null;
  /** Why the stored entry is ignored as a whole; null when it is absent or valid. */
  invalidReason: string | null;
  /** The warning config and a model-less launch give for an ignored entry. */
  invalidWarning: string | null;
  /** The selection a model-less launch runs: the valid stored model when it runs through the companion, else the built-in. */
  selection: string;
  source: 'stored' | 'built-in';
  /** Names the default in messages, e.g. `the plan reviewer's built-in default codex:astra-6`. */
  description: string;
  /** The role effort paired with `selection`: the stored effort that applies to it, else the built-in effort; null means the version default. */
  effort: ReasoningEffort | null;
  /** Names `effort` in messages, e.g. `the implementer's workspace default effort`. */
  effortSource: string;
}

export function resolveRoleDefault(
  flag: RoleDefinition['flag'],
  stored: StereoRoleDefaults | undefined,
  options: ResolveRoleDefaultOptions = {},
): ResolvedRoleDefault {
  const definition = definitionForFlag(flag);
  const entry = stored?.[definition.key];
  const storedModel = optionalString(entry?.model);
  const storedEffort = optionalString(entry?.effort);
  const problems: string[] = [];

  let parsed: ParsedRoleSelection | null = null;
  if (storedModel) {
    try {
      parsed = parseRoleSelection(flag, storedModel);
    } catch (error) {
      problems.push(errorMessage(error));
    }
  }
  // A stored effort belongs to the stored model's ladder; alone, it rides the
  // built-in. Beside an inline selection it is inert, so it only has to be a
  // tier some ladder names (the Codex ladder is the superset). Beside a Claude
  // version that takes no effort (Haiku) it would refuse every launch.
  if (storedEffort) {
    const effortSource = options.effortSource ?? 'the stored workspace effort';
    const route: ModelRuntime =
      parsed?.route ?? (isClaudeSelection(definition.builtInSelection) ? 'claude' : 'codex');
    try {
      const effort = parseRoleEffort(
        definition.effortFlag,
        storedEffort,
        parsed?.inline ? null : route,
        effortSource,
      );
      if (parsed?.route === 'claude' && !parsed.inline) {
        assertClaudeEffortAllowed(
          parseClaudeSelection(parsed.selection).modelArg,
          effort,
          effortSource,
        );
      }
    } catch (error) {
      problems.push(errorMessage(error));
    }
  }
  const invalidReason = problems.length > 0 ? problems.join(' ') : null;
  const storedValues = [
    storedModel ? `model "${storedModel}"` : '',
    storedEffort ? `effort "${storedEffort}"` : '',
  ]
    .filter(Boolean)
    .join(' and ');

  // The stored model runs when the entry is valid and goes through the
  // companion: `claude:session` runs inline in the pair workflow, so a
  // companion command runs the built-in, and an effort stored beside it is
  // inert. A stored effort alone rides the built-in model.
  const runsStored = invalidReason === null && parsed !== null && !parsed.inline;
  const effortApplies =
    invalidReason === null && storedEffort !== null && (runsStored || storedModel === null);
  const selection = runsStored
    ? (parsed as ParsedRoleSelection).selection
    : definition.builtInSelection;
  return {
    storedModel,
    storedEffort,
    parsed,
    invalidReason,
    invalidWarning: invalidReason
      ? `${flag} stored ${storedValues} is invalid: ${invalidReason} The built-in default will be used.`
      : null,
    selection,
    source: runsStored ? 'stored' : 'built-in',
    description: runsStored
      ? `the ${definition.label}'s workspace default ${selection}`
      : `the ${definition.label}'s built-in default ${selection}`,
    effort: (effortApplies
      ? storedEffort
      : runsStored
        ? null
        : definition.builtInEffort) as ReasoningEffort | null,
    effortSource: effortApplies
      ? `the ${definition.label}'s workspace default effort`
      : `the ${definition.label}'s built-in effort`,
  };
}

// Resolves a Codex selection against the catalog a launch refreshed. When the
// selection came from a role default, a failure names that default so the fix
// is obvious.
export function resolveRoleCodexModel(
  selection: CodexSelection,
  catalog: CodexCatalog,
  roleDefault: Pick<ResolvedRoleDefault, 'description'> | null,
): string {
  try {
    return resolveCodexSelection(selection, catalog);
  } catch (error) {
    if (!roleDefault) {
      throw error;
    }
    throw new Error(
      `${capitalize(roleDefault.description)} cannot run: ${errorMessage(error)} Pass --model, or store another default with /stereo:config.`,
    );
  }
}

// The id a role default's selection launches as, against the catalog the
// launch resolved its own model against; null when it does not resolve.
function roleDefaultModel(
  roleDefault: ResolvedRoleDefault,
  catalog: CodexCatalog | undefined,
): string | null {
  try {
    const selection = parseModelSelection(roleDefault.selection);
    if (selection?.runtime === 'claude') {
      return selection.claude.modelArg;
    }
    return selection && catalog ? resolveCodexSelection(selection.codex, catalog) : null;
  } catch {
    return null;
  }
}

export interface LaunchEffortOptions {
  runtime: ModelRuntime;
  /** The id the launch passes: a Codex slug or a Claude full id. */
  model: string;
  /** The effort flag's value, already normalized for the runtime; null when absent. */
  requested: ReasoningEffort | null;
  /** The launch's role default, resolved once for the launch; null for a launch without a role. */
  roleDefault: ResolvedRoleDefault | null;
  /** The catalog a Codex launch resolved its model against; the loaded one by default. */
  catalog?: CodexCatalog;
}

// The effort a launch runs at, checked against what the model takes before
// any job record exists: an explicit --effort must be one the model takes,
// and so must a role default's effort, whose refusal names the default it
// came from. With no effort flag, a role run takes the role default's effort
// when it runs that default's model, compared by resolved id (so
// `claude:opus` matches a default of `claude:opus-5.5` while Opus 5.5 is the
// newest opus), otherwise the model version's own default. A run without a
// role (a Codex task; every Claude run has one) keeps the runtime's own
// default effort.
export function resolveLaunchEffort(options: LaunchEffortOptions): ReasoningEffort | null {
  const { runtime, model, roleDefault } = options;
  const catalog = runtime === 'codex' ? (options.catalog ?? loadCodexCatalog()) : undefined;
  if (options.requested) {
    if (runtime === 'claude') {
      assertClaudeEffortAllowed(model, options.requested);
    } else {
      assertCodexEffortListed(model, options.requested, catalog as CodexCatalog);
    }
    return options.requested;
  }
  if (!roleDefault) {
    return null;
  }
  const effort = roleDefault.effort;
  if (!effort || roleDefaultModel(roleDefault, catalog) !== model) {
    return defaultModelEffort(model, { runtime, catalog });
  }
  if (runtime === 'claude') {
    assertClaudeEffortAllowed(model, effort, roleDefault.effortSource);
  } else {
    assertCodexEffortListed(model, effort, catalog as CodexCatalog, {
      source: capitalize(roleDefault.effortSource),
      remedy: ' Pass --effort, or store another effort with /stereo:config.',
    });
  }
  return effort;
}

// One role's stored default as config and setup report it (the JSON entry).
export interface RoleDefaultEntry {
  role: StereoRoleKey;
  flag: string;
  /** The stored values as written; null when unset. */
  model: string | null;
  effort: string | null;
  route: ModelRuntime | null;
  inline: boolean;
  /** Why the stored entry is ignored as a whole; null when it is absent or valid. */
  invalidReason: string | null;
}

// What a model-less launch of a role runs, as the launch resolver judges it.
export interface RoleDefaultLaunch {
  flag: string;
  /** The selection a model-less launch of the role runs, and where it came from. */
  selection: string;
  source: 'stored' | 'built-in';
  /** What that launch passes; null when it would be refused. */
  model: string | null;
  effort: ReasoningEffort | null;
  /** Why the launch would be refused; null when it would run. */
  error: string | null;
}

function cloneRoleDefaults(current: StereoRoleDefaults | undefined): StereoRoleDefaults {
  const next: StereoRoleDefaults = {};
  for (const definition of ROLE_DEFINITIONS) {
    const entry = current?.[definition.key];
    if (!entry) {
      continue;
    }
    const model = optionalString(entry.model);
    const effort = optionalString(entry.effort);
    if (model || effort) {
      next[definition.key] = { model, effort };
    }
  }
  return next;
}

export function applyRoleDefaultChanges(
  current: StereoRoleDefaults | undefined,
  changes: Partial<Record<RoleDefaultConfigKey, string | null | undefined>>,
  clears: Iterable<RoleDefaultClearKey>,
): StereoRoleDefaults {
  const clearSet = new Set(clears);
  const next = clearSet.has('roles') ? {} : cloneRoleDefaults(current);

  for (const definition of ROLE_DEFINITIONS) {
    const previous = next[definition.key] ?? {};
    let model = optionalString(previous.model);
    let effort = optionalString(previous.effort);
    if (clearSet.has(definition.flag)) {
      model = null;
    }
    if (clearSet.has(definition.effortFlag)) {
      effort = null;
    }
    if (Object.hasOwn(changes, definition.flag)) {
      model = optionalString(changes[definition.flag]);
    }
    if (Object.hasOwn(changes, definition.effortFlag)) {
      effort = optionalString(changes[definition.effortFlag]);
    }

    if (model || effort) {
      next[definition.key] = { model, effort };
    } else {
      delete next[definition.key];
    }
  }

  return next;
}

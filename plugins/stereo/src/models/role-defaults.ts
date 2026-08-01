import { normalizeReasoningEffort, normalizeRequestedModel } from './registry.ts';
import type { ReasoningEffort } from './registry.ts';
import type { StereoRoleDefault, StereoRoleDefaults, StereoRoleKey } from '../workspace/state.ts';

export const CLAUDE_SELECTIONS = [
  'claude:session',
  'claude:inherit',
  'claude:sonnet',
  'claude:opus',
  'claude:haiku',
  'claude:fable',
] as const;

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
}

export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    key: 'planner',
    flag: 'planner',
    effortFlag: 'planner-effort',
    label: 'planner',
    allowsClaudeSession: true,
  },
  {
    key: 'planReviewer',
    flag: 'plan-reviewer',
    effortFlag: 'plan-reviewer-effort',
    label: 'plan reviewer',
    allowsClaudeSession: true,
  },
  {
    key: 'implementer',
    flag: 'implementer',
    effortFlag: 'implementer-effort',
    label: 'implementer',
    allowsClaudeSession: false,
  },
  {
    key: 'implementationReviewer',
    flag: 'implementation-reviewer',
    effortFlag: 'implementation-reviewer-effort',
    label: 'implementation reviewer',
    allowsClaudeSession: true,
  },
];

export type RoleDefaultConfigKey = RoleDefinition['flag'] | RoleDefinition['effortFlag'];
export type RoleDefaultClearKey = RoleDefaultConfigKey | 'roles';

const CLAUDE_SELECTION_SET = new Set<string>(CLAUDE_SELECTIONS);

function definitionForFlag(flag: string): RoleDefinition {
  const definition = ROLE_DEFINITIONS.find((candidate) => candidate.flag === flag);
  if (!definition) {
    throw new Error(`Unsupported Stereo role --${flag}.`);
  }
  return definition;
}

export function parseRoleSelection(
  flag: string,
  value: unknown,
): { selection: string; route: 'claude' | 'codex'; model: string | null } {
  const selection = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!selection) {
    throw new Error(`Provide a model selection for --${flag}.`);
  }

  const normalizedSelection = selection.toLowerCase();
  if (normalizedSelection.startsWith('claude:')) {
    if (!CLAUDE_SELECTION_SET.has(normalizedSelection)) {
      throw new Error(
        `Unsupported model "${selection}" for --${flag}. Use one of: claude:session, claude:inherit, claude:sonnet, claude:opus, claude:haiku, claude:fable, or a Codex selection.`,
      );
    }
    const definition = definitionForFlag(flag);
    if (normalizedSelection === 'claude:session' && !definition.allowsClaudeSession) {
      throw new Error(
        'claude:session is not a valid --implementer default. Claude writes must stay inside the contained stereo:implementer agent.',
      );
    }
    return { selection, route: 'claude', model: null };
  }

  const model = normalizeRequestedModel(selection);
  return { selection, route: 'codex', model };
}

export function parseRoleEffort(effortFlag: string, value: unknown): ReasoningEffort {
  const normalized = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`Provide a reasoning effort for --${effortFlag}.`);
  }
  return normalizeReasoningEffort(normalized) as ReasoningEffort;
}

export interface RoleDefaultEntry {
  role: StereoRoleKey;
  flag: string;
  model: string | null;
  effort: string | null;
  route: 'claude' | 'codex' | null;
  resolvedModel: string | null;
  invalidReason: string | null;
}

function storedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function describeRoleDefaults(defaults: StereoRoleDefaults | undefined): {
  entries: RoleDefaultEntry[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const entries = ROLE_DEFINITIONS.map((definition): RoleDefaultEntry => {
    const stored = defaults?.[definition.key] as StereoRoleDefault | undefined;
    const model = storedString(stored?.model);
    const effort = storedString(stored?.effort);
    let route: 'claude' | 'codex' | null = null;
    let resolvedModel: string | null = null;
    const invalidParts: string[] = [];

    if (model) {
      try {
        const parsed = parseRoleSelection(definition.flag, model);
        route = parsed.route;
        resolvedModel = parsed.model;
      } catch (error) {
        invalidParts.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (effort) {
      try {
        parseRoleEffort(definition.effortFlag, effort);
      } catch (error) {
        invalidParts.push(error instanceof Error ? error.message : String(error));
      }
    }

    const invalidReason = invalidParts.length > 0 ? invalidParts.join(' ') : null;
    if (invalidReason) {
      const storedValues = [model ? `model "${model}"` : '', effort ? `effort "${effort}"` : '']
        .filter(Boolean)
        .join(' and ');
      warnings.push(
        `${definition.flag} stored ${storedValues} is invalid: ${invalidReason} The built-in default will be used.`,
      );
    } else if (model && effort && route === 'claude') {
      warnings.push(`${definition.flag} effort ${effort} is inert: ${model} is Claude-routed.`);
    }

    return {
      role: definition.key,
      flag: definition.flag,
      model,
      effort,
      route,
      resolvedModel,
      invalidReason,
    };
  });

  return { entries, warnings };
}

function cloneRoleDefaults(current: StereoRoleDefaults | undefined): StereoRoleDefaults {
  const next: StereoRoleDefaults = {};
  for (const definition of ROLE_DEFINITIONS) {
    const entry = current?.[definition.key];
    if (!entry) {
      continue;
    }
    const model = storedString(entry.model);
    const effort = storedString(entry.effort);
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
    let model = storedString(previous.model);
    let effort = storedString(previous.effort);
    if (clearSet.has(definition.flag)) {
      model = null;
    }
    if (clearSet.has(definition.effortFlag)) {
      effort = null;
    }
    if (Object.hasOwn(changes, definition.flag)) {
      model = storedString(changes[definition.flag]);
    }
    if (Object.hasOwn(changes, definition.effortFlag)) {
      effort = storedString(changes[definition.effortFlag]);
    }

    if (model || effort) {
      next[definition.key] = { model, effort };
    } else {
      delete next[definition.key];
    }
  }

  return next;
}

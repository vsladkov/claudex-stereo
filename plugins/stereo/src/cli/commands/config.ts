import {
  applyRoleDefaultChanges,
  describeRoleDefaults,
  parseRoleEffort,
  parseRoleSelection,
  ROLE_DEFINITIONS,
} from '../../models/role-defaults.ts';
import type { RoleDefaultClearKey, RoleDefaultConfigKey } from '../../models/role-defaults.ts';
import { renderConfigReport } from '../../render/render.ts';
import { loadState, updateState } from '../../workspace/state.ts';
import { outputCommandResult, parseCommandInput, resolveCommandWorkspace } from '../io.ts';

const ROLE_DEFAULT_KEYS = ROLE_DEFINITIONS.flatMap((definition) => [
  definition.flag,
  definition.effortFlag,
]) as RoleDefaultConfigKey[];
const ROLE_DEFAULT_CLEAR_KEYS = new Set<RoleDefaultClearKey>([...ROLE_DEFAULT_KEYS, 'roles']);

function optionWasProvided(options: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(options, key);
}

export async function handleConfig(argv: string[]): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      'cwd',
      'planner',
      'planner-effort',
      'plan-reviewer',
      'plan-reviewer-effort',
      'implementer',
      'implementer-effort',
      'implementation-reviewer',
      'implementation-reviewer-effort',
    ],
    arrayOptions: ['clear'],
    booleanOptions: ['json'],
  });

  if (positionals.length > 0) {
    throw new Error('config takes only flags; unexpected positional arguments.');
  }

  const clearValues = Array.isArray(options.clear) ? options.clear : [];
  for (const key of clearValues) {
    if (!ROLE_DEFAULT_CLEAR_KEYS.has(key as RoleDefaultClearKey)) {
      throw new Error(
        `Unsupported --clear key "${key}". Use planner, planner-effort, plan-reviewer, plan-reviewer-effort, implementer, implementer-effort, implementation-reviewer, implementation-reviewer-effort, or roles.`,
      );
    }
  }
  const clears = new Set(clearValues as RoleDefaultClearKey[]);

  const changes: Partial<Record<RoleDefaultConfigKey, string>> = {};
  for (const definition of ROLE_DEFINITIONS) {
    for (const key of [definition.flag, definition.effortFlag] as const) {
      if (optionWasProvided(options, key) && (clears.has(key) || clears.has('roles'))) {
        throw new Error(`Choose either --${key} or --clear ${key}.`);
      }
    }

    let parsedSelection: ReturnType<typeof parseRoleSelection> | null = null;
    if (optionWasProvided(options, definition.flag)) {
      parsedSelection = parseRoleSelection(definition.flag, options[definition.flag]);
      changes[definition.flag] = parsedSelection.selection;
    }
    if (optionWasProvided(options, definition.effortFlag)) {
      changes[definition.effortFlag] = parseRoleEffort(
        definition.effortFlag,
        options[definition.effortFlag],
      );
    }
    if (parsedSelection?.route === 'claude' && optionWasProvided(options, definition.effortFlag)) {
      throw new Error(
        `--${definition.effortFlag} applies only to a Codex-routed ${definition.label}; ${parsedSelection.selection} is Claude-routed.`,
      );
    }
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken: string[] = [];
  for (const definition of ROLE_DEFINITIONS) {
    if (optionWasProvided(changes, definition.flag)) {
      actionsTaken.push(
        `Set ${definition.flag} to ${changes[definition.flag]} for ${workspaceRoot}.`,
      );
    }
    if (optionWasProvided(changes, definition.effortFlag)) {
      actionsTaken.push(
        `Set ${definition.effortFlag} to ${changes[definition.effortFlag]} for ${workspaceRoot}.`,
      );
    }
  }
  if (clears.has('roles')) {
    actionsTaken.push(`Cleared all role defaults for ${workspaceRoot}.`);
  } else {
    for (const key of ROLE_DEFAULT_KEYS) {
      if (clears.has(key)) {
        actionsTaken.push(`Cleared ${key} for ${workspaceRoot}.`);
      }
    }
  }

  const hasChanges = Object.keys(changes).length > 0 || clears.size > 0;
  const state = hasChanges
    ? updateState(workspaceRoot, (current) => {
        current.config.roleDefaults = applyRoleDefaultChanges(
          current.config.roleDefaults,
          changes,
          clears,
        );
      })
    : loadState(workspaceRoot);
  const described = describeRoleDefaults(state.config.roleDefaults);
  const payload = {
    workspaceRoot,
    roleDefaults: described.entries,
    warnings: described.warnings,
    actionsTaken,
  };
  outputCommandResult(payload, renderConfigReport(payload), options.json);
}

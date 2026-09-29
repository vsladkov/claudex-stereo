import {
  applyRoleDefaultChanges,
  parseRoleEffort,
  parseRoleSelection,
  resolveRoleDefault,
  ROLE_DEFINITIONS,
} from '../../models/role-defaults.ts';
import type { RoleDefaultClearKey, RoleDefaultConfigKey } from '../../models/role-defaults.ts';
import { describeModels } from '../../models/registry.ts';
import { loadCodexCatalog } from '../../models/catalog.ts';
import { renderConfigReport } from '../../render/render.ts';
import { loadState, updateState } from '../../workspace/state.ts';
import { describeRoleDefaults } from '../launch.ts';
import { outputReportResult, parseCommandInput, resolveCommandWorkspace } from '../io.ts';

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
      'claude-sandbox',
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
  const workspaceRoot = resolveCommandWorkspace(options);
  const current = loadState(workspaceRoot);
  const storedDefaults = current.config.roleDefaults;

  // Each value is parsed on its own first (typos, unknown versions, unknown
  // tiers fail with their own message); whether the values fit together is
  // judged below on the entry the change would store (an effort on a Claude
  // version that takes none is refused there). Whether a Codex selection
  // resolves, and whether a Codex tier fits its model, is judged when a
  // command launches against the live catalog: config only warns about it.
  const changes: Partial<Record<RoleDefaultConfigKey, string>> = {};
  for (const definition of ROLE_DEFINITIONS) {
    for (const key of [definition.flag, definition.effortFlag] as const) {
      if (optionWasProvided(options, key) && (clears.has(key) || clears.has('roles'))) {
        throw new Error(`Choose either --${key} or --clear ${clears.has(key) ? key : 'roles'}.`);
      }
    }
    if (optionWasProvided(options, definition.flag)) {
      const parsed = parseRoleSelection(definition.flag, options[definition.flag]);
      changes[definition.flag] = parsed.selection;
      // The inline session takes no effort, so a stored one would only sit
      // there inert; an effort named in this same call is refused below.
      if (
        parsed.inline &&
        !optionWasProvided(options, definition.effortFlag) &&
        storedDefaults?.[definition.key]?.effort
      ) {
        clears.add(definition.effortFlag);
      }
    }
    if (optionWasProvided(options, definition.effortFlag)) {
      changes[definition.effortFlag] = parseRoleEffort(
        definition.effortFlag,
        options[definition.effortFlag],
      );
    }
  }

  // Apply the change and resolve every role it touches: an entry the result
  // would ignore as invalid is refused before it is stored. An effort named
  // in this call beside an inline selection is refused as well, since it
  // could never apply.
  const next = applyRoleDefaultChanges(storedDefaults, changes, clears);
  for (const definition of ROLE_DEFINITIONS) {
    const setsModel = optionWasProvided(changes, definition.flag);
    const setsEffort = optionWasProvided(changes, definition.effortFlag);
    const touched =
      setsModel ||
      setsEffort ||
      clears.has('roles') ||
      clears.has(definition.flag) ||
      clears.has(definition.effortFlag);
    if (!touched) {
      continue;
    }
    const resolved = resolveRoleDefault(
      definition.flag,
      next,
      setsEffort ? { effortSource: `--${definition.effortFlag}` } : {},
    );
    if (setsEffort && resolved.parsed?.inline) {
      throw new Error(
        `--${definition.effortFlag} does not apply to ${resolved.parsed.selection}: an inline session role takes no effort.`,
      );
    }
    if (resolved.invalidReason) {
      throw new Error(resolved.invalidReason);
    }
  }

  const actionsTaken: string[] = [];
  let claudeSandbox: boolean | null = null;
  if (optionWasProvided(options, 'claude-sandbox')) {
    const raw = String(options['claude-sandbox'] ?? '')
      .trim()
      .toLowerCase();
    if (raw !== 'on' && raw !== 'off') {
      throw new Error('--claude-sandbox takes on or off.');
    }
    claudeSandbox = raw === 'on';
  }
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

  const hasChanges = Object.keys(changes).length > 0 || clears.size > 0 || claudeSandbox !== null;
  // A read-only call reports the state it already read.
  const state = hasChanges
    ? updateState(workspaceRoot, (latest) => {
        latest.config.roleDefaults = applyRoleDefaultChanges(
          latest.config.roleDefaults,
          changes,
          clears,
        );
        if (claudeSandbox !== null) {
          latest.config.claudeSandbox = claudeSandbox;
        }
      })
    : current;
  if (claudeSandbox !== null) {
    actionsTaken.push(
      `${claudeSandbox ? 'Enabled' : 'Disabled'} the Claude Bash sandbox for headless implementers in ${workspaceRoot}.`,
    );
  }
  // What a model-less launch of each role runs is judged against the cached
  // catalog (config never fetches).
  const described = await describeRoleDefaults(state.config.roleDefaults);
  const payload = {
    workspaceRoot,
    roleDefaults: described.entries,
    // Whether a headless Claude implementer runs under Claude Code's own
    // Bash sandbox (writes confined to the working directory); off unless set.
    claudeSandbox: state.config.claudeSandbox === true,
    // Whether the stop-time review gate is on (set by /stereo:setup).
    reviewGateEnabled: state.config.stopReviewGate === true,
    warnings: described.warnings,
    actionsTaken,
  };
  outputReportResult(
    payload,
    renderConfigReport(payload, described.launches, describeModels(loadCodexCatalog())),
    options.json,
  );
}

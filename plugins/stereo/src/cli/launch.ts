// The launch block every command that runs a model shares (task,
// plan-review, review): choose the selection (the --model flag, else the
// role's default), check the runtime is ready, resolve the model against the
// catalog that check refreshed, then the effort the model runs at. The role
// default is resolved once per launch and passed through, so the selection
// and the effort judge the same default.

import process from 'node:process';

import { loadCodexCatalog } from '../models/catalog.ts';
import { parseModelSelection } from '../models/registry.ts';
import type { ModelRuntime, ModelSelection, ReasoningEffort } from '../models/registry.ts';
import {
  resolveLaunchEffort,
  resolveRoleCodexModel,
  resolveRoleDefault,
  roleDefaultFlagFor,
  ROLE_DEFINITIONS,
} from '../models/role-defaults.ts';
import type {
  ResolvedRoleDefault,
  RoleDefaultEntry,
  RoleDefaultLaunch,
} from '../models/role-defaults.ts';
import { runtimeLabel } from '../shared/runtime.ts';
import type { StereoRoleDefaults } from '../workspace/state.ts';
import { ensureClaudeLaunchReady, ensureCodexLaunchReady } from '../workflows/companion-jobs.ts';
import { errorMessage } from '../shared/errors.ts';
import { outputCommandResult } from './io.ts';

export interface LaunchSelectionInput {
  /** The --model selection, parsed; null when absent. */
  explicit: ModelSelection | null;
  /** The role the launch runs as: its default fills a missing selection and its effort. */
  role: string | null;
  /** Whether a launch with no selection runs the role default (else the runtime's own model). */
  takeDefault: boolean;
  stored: StereoRoleDefaults | undefined;
}

export interface LaunchSelection {
  selection: ModelSelection | null;
  /** The role's default, resolved once for the launch; null for a launch without a role. */
  roleDefault: ResolvedRoleDefault | null;
  /** True when the selection is the role default's, so a refusal names that default. */
  runsDefault: boolean;
}

export function chooseLaunchSelection(input: LaunchSelectionInput): LaunchSelection {
  const flag = roleDefaultFlagFor(input.role);
  const roleDefault = flag ? resolveRoleDefault(flag, input.stored) : null;
  if (input.explicit || !input.takeDefault || !roleDefault) {
    return { selection: input.explicit, roleDefault, runsDefault: false };
  }
  // A role default is a selection its parser accepted (a stored one) or a built-in.
  const selection = parseModelSelection(roleDefault.selection) as ModelSelection;
  // A model-less launch ignores an invalid stored entry; say so, as config does.
  if (roleDefault.invalidWarning) {
    process.stderr.write(`${roleDefault.invalidWarning}\n`);
  }
  return { selection, roleDefault, runsDefault: true };
}

export interface ResolveLaunchInput {
  /**
   * Where the readiness probes run (they spawn the runtime); null skips them
   * and resolves against the cached catalog, as a dry run does.
   */
  probeCwd: string | null;
  launch: LaunchSelection;
  requestedEffort: ReasoningEffort | null;
}

export interface ResolvedLaunch {
  /** The id the launch passes: a Codex slug or a Claude full id; null for Codex's own model. */
  model: string | null;
  effort: ReasoningEffort | null;
}

// Validates availability and auth before any job record exists, so a launch
// failure never appears as a failed job. The Codex check also refreshes the
// model catalog, so a family selection (`sol`, `sol-5.6`) resolves against the
// live list. An explicit or role-default effort the model does not take is
// refused.
export async function resolveLaunch(input: ResolveLaunchInput): Promise<ResolvedLaunch> {
  const { selection, roleDefault, runsDefault } = input.launch;
  const { probeCwd, requestedEffort: requested } = input;
  if (selection?.runtime === 'claude') {
    if (probeCwd !== null) {
      ensureClaudeLaunchReady(probeCwd);
    }
    const model = selection.claude.modelArg;
    return {
      model,
      effort: resolveLaunchEffort({ runtime: 'claude', model, requested, roleDefault }),
    };
  }
  const catalog = probeCwd === null ? loadCodexCatalog() : await ensureCodexLaunchReady(probeCwd);
  if (!selection) {
    return { model: null, effort: requested };
  }
  const model = resolveRoleCodexModel(selection.codex, catalog, runsDefault ? roleDefault : null);
  return {
    model,
    effort: resolveLaunchEffort({ runtime: 'codex', model, requested, roleDefault, catalog }),
  };
}

export interface RoleDefaultsReport {
  /** One entry per role: the stored default as written, and whether it is valid. */
  entries: RoleDefaultEntry[];
  /** What a model-less launch of each role runs; config renders it. */
  launches: RoleDefaultLaunch[];
  /** An ignored stored entry, then a default a launch would refuse. */
  warnings: string[];
}

// Config's and setup's one pass over the roles: each role's stored default,
// and what a model-less launch of it runs, judged by the launch resolver
// itself as a dry run against the cached catalog, so a default that cannot
// run is a warning here and a refusal at launch.
export async function describeRoleDefaults(
  stored: StereoRoleDefaults | undefined,
): Promise<RoleDefaultsReport> {
  const entries: RoleDefaultEntry[] = [];
  const launches: RoleDefaultLaunch[] = [];
  const invalid: string[] = [];
  const refused: string[] = [];
  for (const definition of ROLE_DEFINITIONS) {
    const roleDefault = resolveRoleDefault(definition.flag, stored);
    entries.push({
      role: definition.key,
      flag: definition.flag,
      model: roleDefault.storedModel,
      effort: roleDefault.storedEffort,
      route: roleDefault.parsed?.route ?? null,
      inline: roleDefault.parsed?.inline ?? false,
      invalidReason: roleDefault.invalidReason,
    });
    if (roleDefault.invalidWarning) {
      invalid.push(roleDefault.invalidWarning);
    }
    const launch = {
      flag: definition.flag,
      selection: roleDefault.selection,
      source: roleDefault.source,
    };
    try {
      const resolved = await resolveLaunch({
        probeCwd: null,
        launch: {
          selection: parseModelSelection(roleDefault.selection),
          roleDefault,
          runsDefault: true,
        },
        requestedEffort: null,
      });
      launches.push({ ...launch, model: resolved.model, effort: resolved.effort, error: null });
    } catch (error) {
      refused.push(errorMessage(error));
      launches.push({ ...launch, model: null, effort: null, error: errorMessage(error) });
    }
  }
  return { entries, launches, warnings: [...invalid, ...refused] };
}

export interface DryRunLaunch {
  runtime: ModelRuntime;
  model: string | null;
  effort: ReasoningEffort | null;
  role: string | null;
}

// The selection a dry run pins: the exact id it resolved, with its runtime
// prefix, so a replay runs the same model on the same runtime (a provider
// model keeps its `@provider`, once).
export function pinnedSelection(runtime: ModelRuntime, model: string | null): string | null {
  return model ? `${runtime}:${model}` : null;
}

// A dry run passed every launch check: say what a launch would run, with the
// selection to pin (null for Codex's own model), and create nothing. `extra`
// adds the command's own fields after the shared ones.
export function outputDryRun(
  { runtime, model, effort, role }: DryRunLaunch,
  json: unknown,
  extra: Record<string, unknown> = {},
): void {
  const payload = {
    ok: true as const,
    runtime,
    selection: pinnedSelection(runtime, model),
    model,
    effort,
    role,
    ...extra,
  };
  outputCommandResult(
    payload,
    `Dry run: ${runtimeLabel(runtime)} ${model ?? '(Codex default model)'}, effort ${effort ?? 'default'}, role ${role ?? 'none'}.\n`,
    json,
  );
}

// One table of model versions for both runtimes: the versions this plugin
// knows and the default effort each takes. Claude rows are the only source of
// Claude versions (a subscription session has no model catalog), so an alias
// such as `claude:opus` means the newest opus row here and a pin must name a
// row. Codex versions come from the live catalog; a Codex row only pins a
// version's default effort, so none needs to exist.

import type { CatalogEffort } from './catalog.ts';
import type { CompanionRuntime } from '../shared/runtime.ts';

export interface ModelVersionRow {
  runtime: CompanionRuntime;
  family: string;
  version: string;
  /** The default effort this version takes; null means the model takes none. */
  effort: CatalogEffort | null;
}

// The Codex default effort for a version without a row: the catalog steps it
// down to a tier the model lists.
export const FALLBACK_EFFORT: CatalogEffort = 'xhigh';

// Add a row to teach the plugin a version: a new Claude generation reaches
// `claude:<family>` the moment its row is the newest one, and a new Claude
// family is one row too. Haiku takes no effort at all (the model rejects the
// parameter). Codex rows are an extension point: none ships, and a
// `runtime: 'codex'` row would pin that catalog version's default effort.
export const MODEL_VERSIONS: readonly ModelVersionRow[] = [
  { runtime: 'claude', family: 'opus', version: '5.5', effort: 'xhigh' },
  { runtime: 'claude', family: 'opus', version: '4.8', effort: 'xhigh' },
  { runtime: 'claude', family: 'fable', version: '5.1', effort: 'xhigh' },
  { runtime: 'claude', family: 'sonnet', version: '5', effort: 'xhigh' },
  { runtime: 'claude', family: 'haiku', version: '4.5', effort: null },
];

// `<family>[-<version>]`, the selection grammar of both runtimes; the version
// takes `.` or `-` between its segments (`opus-5-5` is `opus-5.5`) and must be
// numeric, so a third-party id such as `kimi-k3` is no family selection.
const FAMILY_SELECTION = /^([a-z][a-z0-9]*)(?:-(\d+(?:[.-]\d+)*))?$/;

// The family form of a lowercased selection, its version `.`-separated, or
// null for anything else. `gpt-5.5` is a plain OpenAI id (family-less in the
// catalog), never a family selection.
export function parseFamilySelection(
  key: string,
): { family: string; version: string | null } | null {
  const match = FAMILY_SELECTION.exec(key);
  if (!match || match[1] === 'gpt') {
    return null;
  }
  return { family: match[1] as string, version: match[2]?.replace(/-/g, '.') ?? null };
}

// Numeric per-segment comparison: 6 > 5.6 > 5.5, and 5.10 > 5.9.
export function compareModelVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

// A family's rows, newest version first.
export function modelVersionRows(runtime: CompanionRuntime, family: string): ModelVersionRow[] {
  const key = family.trim().toLowerCase();
  return MODEL_VERSIONS.filter((row) => row.runtime === runtime && row.family === key).sort(
    (left, right) => compareModelVersions(right.version, left.version),
  );
}

export function latestModelVersion(
  runtime: CompanionRuntime,
  family: string,
): ModelVersionRow | null {
  return modelVersionRows(runtime, family)[0] ?? null;
}

// One family as setup and config list it, for either runtime.
export interface FamilyModels {
  /** The version `<runtime>:<family>` resolves to. */
  latest: string;
  /** Keyed by version, in no order: the id a launch passes and its default effort. */
  versions: Record<string, { id: string; effort: CatalogEffort | null }>;
}

export function familyModels(
  versions: ReadonlyArray<{ version: string; id: string; effort: CatalogEffort | null }>,
): FamilyModels {
  return {
    latest: versions[0]?.version as string,
    versions: Object.fromEntries(
      versions.map(({ version, id, effort }) => [version, { id, effort }]),
    ),
  };
}

// The row for an exact version (`5.5` and `5.5.0` are the same version).
export function findModelVersion(
  runtime: CompanionRuntime,
  family: string,
  version: string,
): ModelVersionRow | null {
  return (
    modelVersionRows(runtime, family).find(
      (row) => compareModelVersions(row.version, version) === 0,
    ) ?? null
  );
}

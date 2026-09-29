// Claude-side model selections for the headless `claude -p` transport.
//
// Claude Code has no command that lists its models, so the version table
// (model-table.ts) supplies what a catalog would:
// `claude:<family>` means the newest version the table knows for that family,
// `claude:<family>-<version>` pins a row, and a full
// `claude-<family>-<version>` id (what a dry run pins, so a launch passes it
// back) names a row too. The plugin never hands Claude Code a bare family
// alias: every launch names the exact id it runs, so the effort always matches
// a known version.

import {
  familyModels,
  findModelVersion,
  latestModelVersion,
  MODEL_VERSIONS,
  modelVersionRows,
  parseFamilySelection,
} from './model-table.ts';
import type { FamilyModels, ModelVersionRow } from './model-table.ts';

const CLAUDE_PREFIX = 'claude:';
export const CLAUDE_SESSION_SELECTION = 'claude:session';
// Every family the version table has a Claude row for, in first-row order:
// the grammar and the hint follow the table, so a new family is one row there.
const CLAUDE_FAMILIES: readonly string[] = [
  ...new Set(MODEL_VERSIONS.filter((row) => row.runtime === 'claude').map((row) => row.family)),
];
const CLAUDE_FAMILY_SET: ReadonlySet<string> = new Set(CLAUDE_FAMILIES);

export const CLAUDE_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_LADDER)[number];
const CLAUDE_EFFORT_SET: ReadonlySet<string> = new Set(CLAUDE_EFFORT_LADDER);

// `claude:opus or claude:opus-5.5`: the first family and its newest version.
const FIRST_FAMILY = CLAUDE_FAMILIES[0] as string;
const CLAUDE_EXAMPLE = `claude:${FIRST_FAMILY} or claude:${FIRST_FAMILY}-${
  (latestModelVersion('claude', FIRST_FAMILY) as ModelVersionRow).version
}`;

export const CLAUDE_SELECTION_HINT = `Use claude:<family>[-<version>] (families: ${CLAUDE_FAMILIES.join(', ')}; for example ${CLAUDE_EXAMPLE}) or claude:session.`;

export interface ClaudeSelection {
  /** What `claude --model` receives: the row's full id (an alias names the newest row). */
  modelArg: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A full id as a launch passes it: the family and the version segments.
const FULL_ID = /^claude-([a-z][a-z0-9]*)-(\d+(?:-\d+)*)$/;
// A family anywhere in a served id, for the transport's served-model pick.
const FAMILY_IN_ID = new RegExp(
  `(?:^|-)(${CLAUDE_FAMILIES.map(escapeRegExp).join('|')})(?=$|-|\\[)`,
);

// The family and version a full id names (`claude-opus-5-5` → opus, 5.5), or null.
function parseFullId(id: string): { family: string; version: string } | null {
  const match = FULL_ID.exec(id.trim().toLowerCase());
  return match
    ? { family: match[1] as string, version: (match[2] as string).replace(/-/g, '.') }
    : null;
}

export function isClaudeSelection(model: unknown): boolean {
  return typeof model === 'string' && model.trim().toLowerCase().startsWith(CLAUDE_PREFIX);
}

// The family a served or launched model id belongs to; unknown ids have none.
export function detectClaudeFamily(modelArg: string): string | null {
  const match = FAMILY_IN_ID.exec(modelArg.trim().toLowerCase());
  return match ? (match[1] as string) : null;
}

export function claudeModelId(family: string, version: string): string {
  return `claude-${family}-${version.replace(/\./g, '-')}`;
}

export interface ParseClaudeSelectionOptions {
  /** Names the flag in messages, e.g. `--planner`. */
  flag?: string;
}

export function parseClaudeSelection(
  model: string,
  options: ParseClaudeSelectionOptions = {},
): ClaudeSelection {
  const normalized = String(model).trim();
  const where = options.flag ? ` for --${options.flag}` : '';
  if (!normalized.toLowerCase().startsWith(CLAUDE_PREFIX)) {
    throw new Error(`Unsupported model "${normalized}"${where}. ${CLAUDE_SELECTION_HINT}`);
  }
  const lower = normalized.slice(CLAUDE_PREFIX.length).trim().toLowerCase();
  if (lower === 'session') {
    throw new Error(
      'claude:session runs inline in the Claude session and never reaches the companion; pass claude:<family>[-<version>] for a companion-run Claude role.',
    );
  }
  if (lower === 'inherit') {
    throw new Error(
      `claude:inherit was removed: select the Claude family or version explicitly, for example ${CLAUDE_EXAMPLE}.`,
    );
  }
  const selection = parseFullId(lower) ?? parseFamilySelection(lower);
  const family = selection?.family;
  if (!family || !CLAUDE_FAMILY_SET.has(family)) {
    throw new Error(`Unsupported model "${normalized}"${where}. ${CLAUDE_SELECTION_HINT}`);
  }
  const pinned = selection?.version ?? null;
  const row = pinned
    ? findModelVersion('claude', family, pinned)
    : latestModelVersion('claude', family);
  if (!row) {
    const known = modelVersionRows('claude', family).map((entry) => entry.version);
    throw new Error(
      `Unsupported model "${normalized}"${where}: the plugin knows ${family} versions ${known.join(', ')}; use claude:${family} for the newest.`,
    );
  }
  return { modelArg: claudeModelId(family, row.version) };
}

// The version row a Claude model argument names, or null.
function rowForModelArg(modelArg: string): ModelVersionRow | null {
  const parsed = parseFullId(modelArg);
  return parsed ? findModelVersion('claude', parsed.family, parsed.version) : null;
}

// The default effort for a Claude model argument: its version row's; null for
// a model that takes none or an id no row matches.
export function defaultClaudeEffort(modelArg: string): ClaudeEffort | null {
  return (rowForModelArg(modelArg)?.effort ?? null) as ClaudeEffort | null;
}

// `source` names where the effort came from, for messages: `--effort` (the
// default), a config flag such as `--planner-effort`, or a phrase such as
// `the stored workspace effort`.
export function normalizeClaudeEffort(effort: unknown, source = '--effort'): ClaudeEffort | null {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!CLAUDE_EFFORT_SET.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}" for a Claude-routed role (${source}). Use one of: low, medium, high, xhigh, max.`,
    );
  }
  return normalized as ClaudeEffort;
}

// A dated snapshot (`claude-haiku-4-5-20251001`) is the same model as the
// rule-built pin `claude-haiku-4-5`: a served id is recorded without the date.
export function normalizeServedModelId(servedModel: string): string {
  return servedModel.trim().replace(/-\d{8}(?=$|\[)/, '');
}

// A version the table gives no effort (Haiku: the model rejects the
// parameter), or an effort a version lacks (the 4.6 generation has no xhigh),
// would fail inside the CLI after the job record exists; refuse it here.
// `source` names the effort as normalizeClaudeEffort does.
export function assertClaudeEffortAllowed(
  modelArg: string,
  effort: string | null | undefined,
  source = '--effort',
): void {
  const row = rowForModelArg(modelArg);
  if (!effort || !row) {
    return;
  }
  if (row.effort === null) {
    throw new Error(
      `claude:${row.family} takes no effort (the model rejects the parameter); drop ${source} ${effort} for ${modelArg}.`,
    );
  }
  if (row.efforts && !row.efforts.includes(effort as ClaudeEffort)) {
    throw new Error(
      `${modelArg} does not take ${source} ${effort}; it takes ${row.efforts.join(', ')}.`,
    );
  }
}

// Every known Claude version per family with its default effort, the Claude
// half of the model listing setup and config render.
export function describeClaudeModels(): Record<string, FamilyModels> {
  return Object.fromEntries(
    CLAUDE_FAMILIES.map((family) => [
      family,
      familyModels(
        modelVersionRows('claude', family).map((row) => ({
          version: row.version,
          id: claudeModelId(family, row.version),
          effort: row.effort,
        })),
      ),
    ]),
  );
}

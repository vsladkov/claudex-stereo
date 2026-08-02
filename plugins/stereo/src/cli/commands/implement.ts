import path from 'node:path';

import { renderImplementState } from '../../render/render.ts';
import {
  clearImplementState,
  fingerprintPlanText,
  loadPairPlanState,
  nowIso,
  planSlotOrDefault,
  readImplementStateFile,
  resolveImplementStateFile,
  saveImplementState,
} from '../../workspace/state.ts';
import {
  outputCommandResult,
  parseCommandInput,
  readUserFile,
  resolveCommandCwd,
  resolveCommandWorkspace,
  resolvePlanSlotOption,
} from '../io.ts';

const MAX_IMPLEMENT_STATE_BYTES = 512 * 1024;

type JsonRecord = Record<string, unknown>;

function recordLike(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function assertIsolationShape(record: JsonRecord): void {
  if (!record.isolated) {
    return;
  }
  const worktreePath = recordLike(record.worktree)?.path;
  if (typeof worktreePath !== 'string' || !worktreePath.trim()) {
    throw new Error('Provide worktree.path in --state-file when isolated is true.');
  }
  if (!path.isAbsolute(worktreePath)) {
    throw new Error('worktree.path must be an absolute path.');
  }
}

function readStatePayload(cwd: string, value: unknown): JsonRecord {
  const contents = readUserFile(cwd, '--state-file', String(value));
  if (Buffer.byteLength(contents, 'utf8') > MAX_IMPLEMENT_STATE_BYTES) {
    throw new Error(
      '--state-file is larger than 512 KiB. Store bounded round summaries instead of verbatim reports.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('Could not parse --state-file as JSON.');
  }
  const payload = recordLike(parsed);
  if (!payload) {
    throw new Error('Provide --state-file containing a JSON object.');
  }
  return payload;
}

function normalizeImplementationRound(value: unknown): number {
  if (value == null) {
    return 0;
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Unsupported implementation round "${value}". Use a non-negative integer.`);
  }
  return value as number;
}

function currentPlanSummary(
  workspaceRoot: string,
  slot: string,
): {
  available: boolean;
  slot: string;
  fingerprint: string | null;
  updatedAt: unknown;
  verdict: unknown;
  round: unknown;
} {
  const storedPlan = recordLike(loadPairPlanState(workspaceRoot, slot));
  return {
    available: Boolean(storedPlan),
    slot,
    fingerprint: fingerprintPlanText(storedPlan?.plan),
    updatedAt: storedPlan?.updatedAt ?? null,
    verdict: storedPlan?.verdict ?? null,
    round: storedPlan?.round ?? null,
  };
}

function recordedPlanSlot(record: JsonRecord | null): string {
  return planSlotOrDefault(recordLike(record?.plan)?.slot);
}

function recordedPlanFingerprint(record: JsonRecord | null): string | null {
  const plan = recordLike(record?.plan);
  return typeof plan?.fingerprint === 'string' && plan.fingerprint.trim()
    ? plan.fingerprint.trim()
    : null;
}

function buildReadPayload(workspaceRoot: string, record: JsonRecord | null): JsonRecord {
  const plan = currentPlanSummary(workspaceRoot, recordedPlanSlot(record));
  const recordedFingerprint = recordedPlanFingerprint(record);
  return {
    available: Boolean(record),
    record,
    plan,
    planMatches:
      recordedFingerprint && plan.fingerprint ? recordedFingerprint === plan.fingerprint : null,
  };
}

function roundNumber(value: unknown): number | null {
  const entry = recordLike(value);
  return Number.isInteger(entry?.round) && (entry?.round as number) >= 0
    ? (entry?.round as number)
    : null;
}

function mergeRounds(existing: unknown, patch: unknown): unknown[] {
  const merged = Array.isArray(existing) ? [...existing] : [];
  if (!Array.isArray(patch)) {
    return merged;
  }

  for (const entry of patch) {
    const number = roundNumber(entry);
    const existingIndex =
      number === null ? -1 : merged.findIndex((item) => roundNumber(item) === number);
    if (existingIndex === -1) {
      merged.push(entry);
    } else {
      merged[existingIndex] = entry;
    }
  }

  return merged.sort((left, right) => {
    const leftRound = roundNumber(left);
    const rightRound = roundNumber(right);
    if (leftRound === null) {
      return rightRound === null ? 0 : 1;
    }
    return rightRound === null ? -1 : leftRound - rightRound;
  });
}

function applyStatePatch(existing: JsonRecord, patch: JsonRecord, timestamp: string): JsonRecord {
  const updated = {
    ...existing,
    ...patch,
    ...(Array.isArray(patch.rounds) ? { rounds: mergeRounds(existing.rounds, patch.rounds) } : {}),
    createdAt: existing.createdAt,
    plan: existing.plan,
    updatedAt: timestamp,
  };
  return updated;
}

function loadExistingRecord(workspaceRoot: string): JsonRecord {
  const state = readImplementStateFile(workspaceRoot);
  const record = recordLike(state.record);
  if (!record) {
    throw new Error('No implementation state to update. Run /stereo:implement first.');
  }
  return record;
}

export function handleImplementState(argv: string[]): void {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd', 'state-file', 'slot'],
    booleanOptions: ['json', 'record', 'update', 'complete', 'clear'],
  });

  if (positionals.length > 0) {
    throw new Error('implement-state takes only flags; unexpected positional arguments.');
  }

  const actions = ['record', 'update', 'complete', 'clear'].filter((key) => options[key]);
  if (actions.length > 1) {
    throw new Error('Choose one of --record, --update, --complete, or --clear.');
  }
  const action = actions[0] ?? null;
  const hasSlot = Object.hasOwn(options, 'slot');
  if (action !== 'record' && hasSlot) {
    throw new Error('--slot applies only to --record.');
  }
  const hasStateFile = Object.hasOwn(options, 'state-file');
  if ((!action || action === 'clear') && hasStateFile) {
    throw new Error('--state-file applies only to --record, --update, or --complete.');
  }
  if ((action === 'record' || action === 'update') && !hasStateFile) {
    throw new Error(`Provide --state-file for --${action}.`);
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);

  if (action === 'clear') {
    const previous = recordLike(readImplementStateFile(workspaceRoot).record);
    const previousWorktree = recordLike(previous?.worktree);
    const worktreePath =
      previous?.isolated &&
      typeof previousWorktree?.path === 'string' &&
      previousWorktree.path.trim()
        ? previousWorktree.path.trim()
        : null;
    const removed = clearImplementState(workspaceRoot);
    const payload = {
      cleared: removed.length > 0,
      removed,
      ...(worktreePath ? { worktreePath } : {}),
    };
    const clearRendered =
      removed.length > 0
        ? `Cleared the implementation state for this repository.\n${removed.map((filePath) => `- ${filePath}`).join('\n')}\n`
        : 'No implementation state for this repository. Nothing to clear.\n';
    const worktreeRendered = worktreePath
      ? `Isolated worktree ${worktreePath}; remove it with git -C "${workspaceRoot}" worktree remove --force "${worktreePath}".\n`
      : '';
    const rendered = `${clearRendered}${worktreeRendered}`;
    outputCommandResult(payload, rendered, options.json);
    return;
  }

  if (!action) {
    const state = readImplementStateFile(workspaceRoot);
    if (state.parseError) {
      const payload = {
        available: false,
        unreadable: true,
        path: resolveImplementStateFile(workspaceRoot),
        parseError: state.parseError,
      };
      outputCommandResult(payload, renderImplementState(null), options.json);
      return;
    }
    const record = recordLike(state.record);
    outputCommandResult(
      buildReadPayload(workspaceRoot, record),
      renderImplementState(record),
      options.json,
    );
    return;
  }

  const timestamp = nowIso();
  let record: JsonRecord;
  if (action === 'record') {
    const slot = resolvePlanSlotOption(options);
    const input = readStatePayload(cwd, options['state-file']);
    const baselineCommit =
      typeof input.baselineCommit === 'string' ? input.baselineCommit.trim() : '';
    if (!baselineCommit) {
      throw new Error('Provide baselineCommit in --state-file.');
    }
    const plan = currentPlanSummary(workspaceRoot, slot);
    record = {
      ...input,
      version: 1,
      status: 'in-progress',
      baselineCommit,
      round: normalizeImplementationRound(input.round),
      rounds: Array.isArray(input.rounds) ? input.rounds : [],
      plan: {
        slot: plan.slot,
        fingerprint: plan.fingerprint,
        updatedAt: plan.updatedAt,
        verdict: plan.verdict,
        round: plan.round,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  } else {
    const existing = loadExistingRecord(workspaceRoot);
    const patch = hasStateFile ? readStatePayload(cwd, options['state-file']) : {};
    record = applyStatePatch(existing, patch, timestamp);
    if (action === 'complete') {
      record = {
        ...record,
        status: 'complete',
        completedAt: timestamp,
        updatedAt: timestamp,
      };
    }
  }

  assertIsolationShape(record);
  saveImplementState(workspaceRoot, record);
  outputCommandResult(
    buildReadPayload(workspaceRoot, record),
    renderImplementState(record),
    options.json,
  );
}

import path from 'node:path';

import { renderImplementState } from '../../render/render.ts';
import { recordLike } from '../../shared/json.ts';
import {
  currentPlanSummary,
  readStatePayload,
  recordedPlanFingerprint,
  recordedPlanSlot,
} from './state-helpers.ts';
import {
  clearImplementState,
  nowIso,
  readImplementStateFile,
  resolveImplementStateFile,
  saveImplementState,
} from '../../workspace/state.ts';
import {
  outputCommandResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
  resolvePlanSlotOption,
} from '../io.ts';

type JsonRecord = Record<string, unknown>;

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

function normalizeImplementationRound(value: unknown): number {
  if (value == null) {
    return 0;
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Unsupported implementation round "${value}". Use a non-negative integer.`);
  }
  return value as number;
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

function roundEntryNumber(value: unknown): number | null {
  const entry = recordLike(value);
  for (const key of ['review', 'round'] as const) {
    const candidate = entry?.[key];
    if (Number.isInteger(candidate) && (candidate as number) >= 0) {
      return candidate as number;
    }
  }
  return null;
}

function mergeRounds(existing: unknown, patch: unknown): unknown[] {
  const merged: unknown[] = [];
  const numberedIndexes = new Map<number, number>();
  const absorb = (entries: unknown[]): void => {
    for (const entry of entries) {
      const number = roundEntryNumber(entry);
      if (number === null) {
        merged.push(entry);
        continue;
      }
      const existingIndex = numberedIndexes.get(number);
      if (existingIndex === undefined) {
        numberedIndexes.set(number, merged.length);
        merged.push(entry);
      } else {
        merged[existingIndex] = entry;
      }
    }
  };

  absorb(Array.isArray(existing) ? existing : []);
  absorb(Array.isArray(patch) ? patch : []);

  return merged.sort((left, right) => {
    const leftRound = roundEntryNumber(left);
    const rightRound = roundEntryNumber(right);
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
      const statePath = resolveImplementStateFile(workspaceRoot);
      const payload = {
        available: false,
        unreadable: true,
        path: statePath,
        parseError: state.parseError,
      };
      const rendered = `Implementation state exists but is unreadable at ${statePath}: ${state.parseError}\nA new /stereo:implement run replaces it; /stereo:implement --resume cannot use it.\n`;
      outputCommandResult(payload, rendered, options.json);
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
    const input = readStatePayload(
      cwd,
      options['state-file'],
      'Store bounded round summaries instead of verbatim reports.',
    );
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
    const patch = hasStateFile
      ? readStatePayload(
          cwd,
          options['state-file'],
          'Store bounded round summaries instead of verbatim reports.',
        )
      : {};
    record = applyStatePatch(existing, patch, timestamp);
    // A patch must not weaken what --record validated: re-normalize the
    // merged fields instead of persisting whatever the patch carried.
    const mergedBaseline =
      typeof record.baselineCommit === 'string' ? record.baselineCommit.trim() : '';
    if (!mergedBaseline) {
      throw new Error('The merged record must keep a non-empty baselineCommit.');
    }
    record.baselineCommit = mergedBaseline;
    record.round = normalizeImplementationRound(record.round);
    record.rounds = Array.isArray(record.rounds) ? record.rounds : [];
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

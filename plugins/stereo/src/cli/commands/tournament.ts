import path from 'node:path';

import { renderTournamentState } from '../../render/render.ts';
import { optionalString, recordLike } from '../../shared/json.ts';
import {
  clearTournamentState,
  fingerprintPlanText,
  loadPairPlanState,
  nowIso,
  planSlotOrDefault,
  readTournamentStateFile,
  resolveTournamentStateFile,
  saveTournamentState,
} from '../../workspace/state.ts';
import {
  outputCommandResult,
  parseCommandInput,
  readUserFile,
  resolveCommandCwd,
  resolveCommandWorkspace,
  resolvePlanSlotOption,
} from '../io.ts';

const MAX_TOURNAMENT_STATE_BYTES = 512 * 1024;

type JsonRecord = Record<string, unknown>;

function assertContestantShape(record: JsonRecord): void {
  if (!Array.isArray(record.contestants)) {
    throw new Error('Provide contestants in --state-file as a JSON array.');
  }
  for (const value of record.contestants) {
    const contestant = recordLike(value);
    if (typeof contestant?.label !== 'string' || !contestant.label.trim()) {
      throw new Error('Provide a label in every contestants entry in --state-file.');
    }
    if (contestant.worktreePath !== undefined) {
      const worktreePath = contestant.worktreePath;
      if (
        typeof worktreePath !== 'string' ||
        !worktreePath.trim() ||
        !path.isAbsolute(worktreePath)
      ) {
        throw new Error('Contestant worktreePath must be an absolute path.');
      }
    }
  }
}

function readStatePayload(cwd: string, value: unknown): JsonRecord {
  const contents = readUserFile(cwd, '--state-file', String(value));
  if (Buffer.byteLength(contents, 'utf8') > MAX_TOURNAMENT_STATE_BYTES) {
    throw new Error(
      '--state-file is larger than 512 KiB. Store bounded contestant summaries instead of verbatim reports.',
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

function contestantLabel(value: unknown): string | null {
  return optionalString(recordLike(value)?.label);
}

function mergeContestants(existing: unknown, patch: unknown): unknown[] {
  const merged: unknown[] = [];
  const labeledIndexes = new Map<string, number>();
  const absorb = (entries: unknown[]): void => {
    for (const entry of entries) {
      const label = contestantLabel(entry);
      if (label === null) {
        merged.push(entry);
        continue;
      }
      const existingIndex = labeledIndexes.get(label);
      if (existingIndex === undefined) {
        labeledIndexes.set(label, merged.length);
        merged.push(entry);
      } else {
        merged[existingIndex] = entry;
      }
    }
  };

  absorb(Array.isArray(existing) ? existing : []);
  absorb(Array.isArray(patch) ? patch : []);
  return merged;
}

function applyStatePatch(existing: JsonRecord, patch: JsonRecord, timestamp: string): JsonRecord {
  return {
    ...existing,
    ...patch,
    ...(Array.isArray(patch.contestants)
      ? { contestants: mergeContestants(existing.contestants, patch.contestants) }
      : {}),
    createdAt: existing.createdAt,
    plan: existing.plan,
    updatedAt: timestamp,
  };
}

function loadExistingRecord(workspaceRoot: string): JsonRecord {
  const state = readTournamentStateFile(workspaceRoot);
  const record = recordLike(state.record);
  if (!record) {
    throw new Error('No tournament state to update. Run /stereo:tournament first.');
  }
  return record;
}

export function handleTournamentState(argv: string[]): void {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd', 'state-file', 'slot'],
    booleanOptions: ['json', 'record', 'update', 'complete', 'clear'],
  });

  if (positionals.length > 0) {
    throw new Error('tournament-state takes only flags; unexpected positional arguments.');
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
    const previous = recordLike(readTournamentStateFile(workspaceRoot).record);
    const worktreePaths = (Array.isArray(previous?.contestants) ? previous.contestants : [])
      .map((value) => recordLike(value)?.worktreePath)
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      .map((value) => value.trim());
    const removed = clearTournamentState(workspaceRoot);
    const payload = {
      cleared: removed.length > 0,
      removed,
      ...(worktreePaths.length > 0 ? { worktreePaths } : {}),
    };
    const clearRendered =
      removed.length > 0
        ? `Cleared the tournament state for this repository.\n${removed.map((filePath) => `- ${filePath}`).join('\n')}\n`
        : 'No tournament state for this repository. Nothing to clear.\n';
    const worktreesRendered = worktreePaths
      .map(
        (worktreePath) =>
          `Retained worktree ${worktreePath}; remove it with git -C "${workspaceRoot}" worktree remove --force "${worktreePath}".`,
      )
      .join('\n');
    outputCommandResult(
      payload,
      `${clearRendered}${worktreesRendered ? `${worktreesRendered}\n` : ''}`,
      options.json,
    );
    return;
  }

  if (!action) {
    const state = readTournamentStateFile(workspaceRoot);
    if (state.parseError) {
      const payload = {
        available: false,
        unreadable: true,
        path: resolveTournamentStateFile(workspaceRoot),
        parseError: state.parseError,
      };
      outputCommandResult(payload, renderTournamentState(null), options.json);
      return;
    }
    const record = recordLike(state.record);
    outputCommandResult(
      buildReadPayload(workspaceRoot, record),
      renderTournamentState(record),
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
    if (!Array.isArray(input.contestants) || input.contestants.length === 0) {
      throw new Error('Provide a non-empty contestants array in --state-file.');
    }
    const plan = currentPlanSummary(workspaceRoot, slot);
    record = {
      ...input,
      version: 1,
      status: 'in-progress',
      baselineCommit,
      contestants: input.contestants,
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

  assertContestantShape(record);
  saveTournamentState(workspaceRoot, record);
  outputCommandResult(
    buildReadPayload(workspaceRoot, record),
    renderTournamentState(record),
    options.json,
  );
}

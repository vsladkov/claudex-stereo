import { recordLike } from '../../shared/json.ts';
import {
  fingerprintPlanText,
  loadPairPlanState,
  planSlotOrDefault,
} from '../../workspace/state.ts';
import { readUserFile } from '../io.ts';

// Shared helpers for the implement-state and tournament-state subcommands.
// These two commands grew as siblings and their common logic drifts when
// fixes land in only one file; anything byte-identical between them lives
// here instead.

export type JsonRecord = Record<string, unknown>;

export const MAX_STATE_FILE_BYTES = 512 * 1024;

export function readStatePayload(cwd: string, value: unknown, oversizeHint: string): JsonRecord {
  const contents = readUserFile(cwd, '--state-file', String(value));
  if (Buffer.byteLength(contents, 'utf8') > MAX_STATE_FILE_BYTES) {
    throw new Error(`--state-file is larger than 512 KiB. ${oversizeHint}`);
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

export function currentPlanSummary(
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

export function recordedPlanSlot(record: JsonRecord | null): string {
  return planSlotOrDefault(recordLike(record?.plan)?.slot);
}

export function recordedPlanFingerprint(record: JsonRecord | null): string | null {
  const plan = recordLike(record?.plan);
  return typeof plan?.fingerprint === 'string' && plan.fingerprint.trim()
    ? plan.fingerprint.trim()
    : null;
}

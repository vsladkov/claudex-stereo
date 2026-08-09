import path from 'node:path';
import process from 'node:process';

import {
  buildPersistentPairThreadName,
  parseStructuredOutput,
  readOutputSchema,
  runAppServerTurn,
} from '../runtime/index.ts';
import type { ProgressReporter } from '../runtime/index.ts';
import { listRepositoryFiles } from '../platform/git.ts';
import { loadPromptTemplate, interpolateTemplate } from '../shared/prompts.ts';
import { PROMPTS_ROOT, SCHEMAS_DIR } from '../shared/paths.ts';
import { serializeRepositoryMap } from '../workspace/repo-map.ts';
import { nowIso, planSlotOrDefault, savePairPlanState } from '../workspace/state.ts';
import { resolveWorkspaceRoot } from '../workspace/workspace.ts';
import { renderPlanReviewResult } from '../render/render.ts';
import { firstMeaningfulLine } from '../shared/text.ts';
import type { CompanionExecution } from './companion-jobs.ts';

const PLAN_REVIEW_SCHEMA = path.join(SCHEMAS_DIR, 'plan-review-output.schema.json');
const PLAN_REVIEW_REVISION_CONTEXT =
  'This plan is a revision that responds to your earlier findings in this thread. Verify that each earlier finding was addressed, explicitly rebutted, or explicitly descoped into `## Out of scope` with a documented residual. Then review the revised sections and their interactions with the rest of the plan; do not re-audit unchanged, previously accepted sections for new concerns unless a revision changed their assumptions.';

export function normalizePlanReviewRound(round: unknown): number {
  if (round == null || String(round).trim() === '') {
    return 1;
  }
  const parsed = Number.parseInt(String(round).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Unsupported plan-review round "${round}". Use a positive integer.`);
  }
  return parsed;
}

export function buildPlanReviewTitle(round: number): string {
  return round > 1 ? `Codex Plan Review (round ${round})` : 'Codex Plan Review';
}

// The structured reviewer verdict as far as the plan-state store reads it.
interface ParsedPlanReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  body: string;
  section: string;
  confidence: number;
  recommendation: string;
}

interface ParsedPlanReviewResult {
  verdict?: string | null;
  summary?: string | null;
  findings?: ParsedPlanReviewFinding[] | null;
  open_questions?: unknown[] | null;
  residual_risks?: unknown[] | null;
}

export interface PlanReviewRunRequest {
  cwd: string;
  model?: string | null;
  effort?: string | null;
  plan: string;
  slot?: string | null;
  threadId?: string | null;
  round?: number;
  jobId?: string | null;
  onProgress?: ProgressReporter | null;
}

function isPersistablePlanReview(value: unknown): value is ParsedPlanReviewResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const verdict = (value as { verdict?: unknown }).verdict;
  return typeof verdict === 'string' && verdict.trim().length > 0;
}

function readObjectSummary(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const summary = (value as { summary?: unknown }).summary;
  return typeof summary === 'string' && summary.trim().length > 0 ? summary : null;
}

export async function executePlanReviewRun(
  request: PlanReviewRunRequest,
): Promise<CompanionExecution> {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);

  const round = request.round ?? 1;
  if (round > 1 && !request.threadId) {
    // Round >1 injects "responds to your earlier findings in this thread"
    // revision framing; without a thread there are no earlier findings and
    // the prompt would contradict itself.
    throw new Error(
      'plan-review rounds above 1 require --thread <id> (the thread holding the earlier rounds).',
    );
  }
  const template = loadPromptTemplate(PROMPTS_ROOT, 'plan-review');
  const prompt = interpolateTemplate(template, {
    PLAN_INPUT: request.plan,
    REPO_MAP: request.threadId ? '' : serializeRepositoryMap(listRepositoryFiles(workspaceRoot)),
    ROUND_NUMBER: String(round),
    REVISION_CONTEXT: round > 1 ? PLAN_REVIEW_REVISION_CONTEXT : '',
  });

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId: request.threadId ?? null,
    prompt,
    model: request.model,
    effort: request.effort,
    sandbox: 'read-only',
    outputSchema: readOutputSchema(PLAN_REVIEW_SCHEMA),
    persistThread: true,
    threadName: request.threadId ? null : buildPersistentPairThreadName(request.plan),
    onProgress: request.onProgress,
    jobId: request.jobId ?? null,
    jobPid: process.pid,
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage:
      (result.error as { message?: string } | null | undefined)?.message ?? result.stderr,
  });
  // A parseable answer without a verdict is still reported by the renderer,
  // but must not replace the last good durable pair-plan state.
  const parsedPlanReview = isPersistablePlanReview(parsed.parsed) ? parsed.parsed : null;
  const threadId = result.threadId ?? request.threadId ?? null;
  const payload = {
    review: 'Plan Review',
    round,
    threadId,
    model: request.model ?? null,
    effort: request.effort ?? null,
    // rawOutput and reasoningSummary below are the canonical copies; the
    // codex envelope repeating them cost thousands of duplicated output
    // tokens per --json read.
    codex: {
      status: result.status,
      stderr: result.stderr,
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary,
    ...(result.droppedNotifications > 0
      ? { droppedNotifications: result.droppedNotifications }
      : {}),
  };

  if (parsedPlanReview) {
    savePairPlanState(
      workspaceRoot,
      {
        plan: request.plan,
        threadId,
        model: request.model ?? null,
        effort: request.effort ?? null,
        round,
        verdict: parsedPlanReview.verdict ?? null,
        summary: parsedPlanReview.summary ?? null,
        findings: parsedPlanReview.findings ?? [],
        openQuestions: parsedPlanReview.open_questions ?? [],
        // Stored camelCase deliberately (pair-plan state is a companion-internal
        // record); the reviewer-facing schema field is snake_case residual_risks.
        residualRisks: parsedPlanReview.residual_risks ?? [],
        updatedAt: nowIso(),
      },
      planSlotOrDefault(request.slot),
    );
  }

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
    payload,
    rendered: renderPlanReviewResult(parsed, { round, reasoningSummary: result.reasoningSummary }),
    summary:
      readObjectSummary(parsed.parsed) ??
      parsed.parseError ??
      firstMeaningfulLine(result.finalMessage, 'Plan review finished.'),
    jobTitle: buildPlanReviewTitle(round),
    jobClass: 'review',
  };
}

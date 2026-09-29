import path from 'node:path';

import { readOutputSchema, runAppServerReview } from '../runtime/index.ts';
import type { ProgressReporter } from '../runtime/index.ts';
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from '../platform/git.ts';
import type { ReviewContext, ReviewTarget } from '../platform/git.ts';
import type { ReviewTarget as NativeReviewTarget } from '../protocol/app-server.ts';
import { loadPromptTemplate, interpolateTemplate } from '../shared/prompts.ts';
import { PROMPTS_ROOT, SCHEMAS_DIR } from '../shared/paths.ts';
import { renderNativeReviewResult, renderReviewResult } from '../render/render.ts';
import { jobRuntime, runtimeLabel } from '../shared/runtime.ts';
import type { CompanionRuntime } from '../shared/runtime.ts';
import { firstMeaningfulLine } from '../shared/text.ts';
import {
  droppedNotificationsField,
  parseTurnOutput,
  runRoleTurn,
  turnEnvelope,
  turnExecutionFields,
} from './companion-jobs.ts';
import type { CompanionExecution } from './companion-jobs.ts';

const REVIEW_SCHEMA = path.join(SCHEMAS_DIR, 'review-output.schema.json');

export const NATIVE_REVIEW_EFFORT_ERROR =
  "`/stereo:review --native` runs Codex's built-in reviewer, which has no reasoning-effort control. Drop `--native` for an effort-controlled review.";
export const NATIVE_REVIEW_RUNTIME_ERROR =
  "`--native` runs Codex's built-in reviewer; pass a Codex selection or drop `--native` for the Claude reviewer role.";
export const NATIVE_REVIEW_COMMAND_ERROR =
  '`--native` applies to `/stereo:review` only; `/stereo:adversarial-review` always runs the adversarial reviewer role.';

// Only Codex's built-in reviewer lacks an effort control; the reviewer role
// is an ordinary turn on either runtime.
export function assertReviewEffortSupported(native: boolean, effortProvided: boolean): void {
  if (native && effortProvided) {
    throw new Error(NATIVE_REVIEW_EFFORT_ERROR);
  }
}

export function buildReviewPrompt(
  context: ReviewContext,
  focusText: string,
  template: 'review' | 'adversarial-review' = 'adversarial-review',
): string {
  return interpolateTemplate(loadPromptTemplate(PROMPTS_ROOT, template), {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || 'No extra focus provided.',
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
  });
}

export function buildNativeReviewTarget(target: ReviewTarget): NativeReviewTarget | null {
  if (target.mode === 'working-tree') {
    return { type: 'uncommittedChanges' };
  }

  if (target.mode === 'branch') {
    return { type: 'baseBranch', branch: target.baseRef };
  }

  return null;
}

export function validateNativeReviewRequest(
  target: ReviewTarget,
  focusText: string,
): NativeReviewTarget {
  if (focusText.trim()) {
    throw new Error(
      `\`/stereo:review --native\` runs Codex's built-in reviewer, which does not support custom focus text. Drop \`--native\` for \`/stereo:review ${focusText.trim()}\` on the reviewer role.`,
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error(
      'This `/stereo:review --native` target is not supported by the built-in reviewer. Drop `--native` for custom targeting.',
    );
  }

  return nativeTarget;
}

export type ReviewRole = 'reviewer' | 'adversarial-reviewer';

export interface ReviewRunRequest {
  cwd: string;
  /** Keys the shared broker; absent means the review cwd (pre-workspace requests). */
  workspaceRoot?: string | null;
  base?: string | null;
  scope?: string;
  target?: ReviewTarget;
  /** Absent means Codex (requests written before Claude jobs existed). */
  runtime?: CompanionRuntime;
  model?: string | null;
  effort?: string | null;
  focusText?: string;
  reviewName?: string;
  /** The role the review runs as; absent means the reviewer. */
  role?: ReviewRole;
  /** `/stereo:review --native`: Codex's built-in reviewer instead of the reviewer role. */
  native?: boolean;
  jobId?: string | null;
  onProgress?: ProgressReporter | null;
}

export async function executeReviewRun(request: ReviewRunRequest): Promise<CompanionExecution> {
  // The CLI checked the runtime's availability before the job existed.
  const runtime = jobRuntime(request);
  ensureGitRepository(request.cwd);

  // The handler resolves the target up front (git subprocesses); reuse it
  // instead of re-running the same git commands here.
  const target =
    request.target ??
    resolveReviewTarget(request.cwd, {
      base: request.base,
      scope: request.scope,
    });
  const focusText = request.focusText?.trim() ?? '';
  const reviewName = request.reviewName ?? 'Review';
  const role = request.role ?? 'reviewer';
  // Codex's built-in reviewer, opted into with --native; the default review
  // is the reviewer role on either runtime.
  if (role === 'reviewer' && runtime === 'codex' && request.native) {
    assertReviewEffortSupported(true, Boolean(request.effort));
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress,
      brokerCwd: request.workspaceRoot ?? null,
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary,
      },
      ...droppedNotificationsField(result),
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr,
      },
      {
        reviewLabel: reviewName,
        targetLabel: target.label,
        reasoningSummary: result.reasoningSummary,
      },
    );

    return {
      ...turnExecutionFields(result),
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: 'review',
      targetLabel: target.label,
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPrompt(
    context,
    focusText,
    role === 'adversarial-reviewer' ? 'adversarial-review' : 'review',
  );
  const result = await runRoleTurn(runtime, {
    cwd: context.repoRoot,
    model: request.model,
    effort: request.effort,
    role,
    prompt,
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress,
    jobId: request.jobId,
    codex: { sandbox: 'read-only', brokerCwd: request.workspaceRoot ?? null },
  });
  const parsed = parseTurnOutput(result);
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary,
    },
    ...turnEnvelope(result),
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary,
    ...droppedNotificationsField(result),
  };

  return {
    ...turnExecutionFields(result),
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary,
      runtime,
    }),
    summary:
      (parsed.parsed as { summary?: string | null } | null)?.summary ??
      parsed.parseError ??
      firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `${runtimeLabel(runtime)} ${reviewName}`,
    jobClass: 'review',
    targetLabel: context.target.label,
  };
}

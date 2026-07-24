import path from "node:path";

import {
  parseStructuredOutput,
  readOutputSchema,
  runAppServerReview,
  runAppServerTurn
} from "../runtime/index.ts";
import type { ProgressReporter } from "../runtime/index.ts";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "../platform/git.ts";
import type { ReviewContext, ReviewTarget } from "../platform/git.ts";
import type { ReviewTarget as NativeReviewTarget } from "../protocol/app-server.ts";
import { loadPromptTemplate, interpolateTemplate } from "../shared/prompts.ts";
import { PROMPTS_ROOT, SCHEMAS_DIR } from "../shared/paths.ts";
import { renderNativeReviewResult, renderReviewResult } from "../render/render.ts";
import { firstMeaningfulLine } from "../shared/text.ts";
import { ensureCodexAvailable } from "./companion-jobs.ts";
import type { CompanionExecution } from "./companion-jobs.ts";

const REVIEW_SCHEMA = path.join(SCHEMAS_DIR, "review-output.schema.json");

export function buildAdversarialReviewPrompt(context: ReviewContext, focusText: string): string {
  const template = loadPromptTemplate(PROMPTS_ROOT, "adversarial-review");
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

export function buildNativeReviewTarget(target: ReviewTarget): NativeReviewTarget | null {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

export function validateNativeReviewRequest(target: ReviewTarget, focusText: string): NativeReviewTarget {
  if (focusText.trim()) {
    throw new Error(
      `\`/stereo:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/stereo:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/stereo:review` target is not supported by the built-in reviewer. Retry with `/stereo:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

export interface ReviewRunRequest {
  cwd: string;
  base?: string | null;
  scope?: string;
  target?: ReviewTarget;
  model?: string | null;
  focusText?: string;
  reviewName?: string;
  onProgress?: ProgressReporter | null;
}

export async function executeReviewRun(request: ReviewRunRequest): Promise<CompanionExecution> {
  // Fail before collectReviewContext does potentially heavy git work.
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  // The handler resolves the target up front (git subprocesses); reuse it
  // instead of re-running the same git commands here.
  const target =
    request.target ??
    resolveReviewTarget(request.cwd, {
      base: request.base,
      scope: request.scope
    });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
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
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: (result.error as { message?: string } | null | undefined)?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary:
      (parsed.parsed as { summary?: string | null } | null)?.summary ??
      parsed.parseError ??
      firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}

import { resolveReviewTarget } from "../../platform/git.ts";
import type { ReviewTarget } from "../../platform/git.ts";
import { normalizeRequestedModel } from "../../models/registry.ts";
import {
  buildReviewJobMetadata,
  createCompanionJob,
  runForegroundCommand
} from "../../workflows/companion-jobs.ts";
import { executeReviewRun, validateNativeReviewRequest } from "../../workflows/review.ts";
import { parseCommandInput, resolveCommandCwd, resolveCommandWorkspace } from "../io.ts";

export interface ReviewCommandConfig {
  reviewName: string;
  validateRequest?: (target: ReviewTarget, focusText: string) => unknown;
}

export async function handleReviewCommand(argv: string[], config: ReviewCommandConfig): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base as string | undefined,
    scope: options.scope as string | undefined
  });

  config.validateRequest?.(target, focusText);
  const model = normalizeRequestedModel(options.model);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary,
    model
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base as string | undefined,
        scope: options.scope as string | undefined,
        target,
        model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

export async function handleReview(argv: string[]): Promise<void> {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

export async function handleAdversarialReview(argv: string[]): Promise<void> {
  return handleReviewCommand(argv, {
    reviewName: "Adversarial Review"
  });
}

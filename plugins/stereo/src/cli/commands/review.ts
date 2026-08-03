import { resolveReviewTarget } from '../../platform/git.ts';
import type { ReviewTarget } from '../../platform/git.ts';
import {
  defaultPairEffort,
  normalizeReasoningEffort,
  normalizeRequestedModel,
} from '../../models/registry.ts';
import {
  buildReviewJobMetadata,
  createCompanionJob,
  ensureCodexLaunchReady,
  enqueueBackgroundTask,
  renderQueuedTaskLaunch,
  runForegroundCommand,
} from '../../workflows/companion-jobs.ts';
import {
  assertReviewEffortSupported,
  executeReviewRun,
  validateNativeReviewRequest,
} from '../../workflows/review.ts';
import {
  outputCommandResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
} from '../io.ts';

export interface ReviewCommandConfig {
  reviewName: string;
  supportsEffort: boolean;
  validateRequest?: (target: ReviewTarget, focusText: string) => unknown;
}

export async function handleReviewCommand(
  argv: string[],
  config: ReviewCommandConfig,
): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['base', 'scope', 'model', 'effort', 'pr', 'cwd'],
    booleanOptions: ['json', 'background', 'wait'],
    aliasMap: {
      m: 'model',
    },
  });

  if (Object.hasOwn(options, 'pr')) {
    throw new Error(
      '--pr is resolved by /stereo:review and /stereo:adversarial-review, not by the companion CLI. Check out the pull request branch and pass --base <ref>.',
    );
  }
  assertReviewEffortSupported(config.reviewName, Object.hasOwn(options, 'effort'));

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(' ').trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base as string | undefined,
    scope: options.scope as string | undefined,
  });

  config.validateRequest?.(target, focusText);
  if (options.background && options.wait) {
    throw new Error('Choose either --background or --wait.');
  }
  const model = normalizeRequestedModel(options.model);
  const effortRequest = config.supportsEffort
    ? {
        effort:
          normalizeReasoningEffort(options.effort) ?? (model ? defaultPairEffort(model) : null),
      }
    : {};
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  // Validate availability and auth before creating either a foreground or a
  // detached job record, so launch failures never appear as failed jobs.
  await ensureCodexLaunchReady(cwd);
  const job = createCompanionJob({
    prefix: 'review',
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: 'review',
    summary: metadata.summary,
    model,
  });
  if (options.background) {
    const request = {
      kind: 'review',
      cwd,
      base: options.base as string | undefined,
      scope: options.scope as string | undefined,
      target,
      model,
      ...effortRequest,
      focusText,
      reviewName: config.reviewName,
    };
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base as string | undefined,
        scope: options.scope as string | undefined,
        target,
        model,
        ...effortRequest,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress,
      }),
    { json: options.json },
  );
}

export async function handleReview(argv: string[]): Promise<void> {
  return handleReviewCommand(argv, {
    reviewName: 'Review',
    supportsEffort: false,
    validateRequest: validateNativeReviewRequest,
  });
}

export async function handleAdversarialReview(argv: string[]): Promise<void> {
  return handleReviewCommand(argv, {
    reviewName: 'Adversarial Review',
    supportsEffort: true,
  });
}

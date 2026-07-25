import {
  defaultPairEffort,
  normalizeReasoningEffort,
  normalizeRequestedModel,
  PAIR_DEFAULT_MODEL,
} from '../../models/registry.ts';
import { loadPairPlanState } from '../../workspace/state.ts';
import {
  createCompanionJob,
  ensureCodexAvailable,
  enqueueBackgroundTask,
  renderQueuedTaskLaunch,
  runForegroundCommand,
} from '../../workflows/companion-jobs.ts';
import {
  buildPlanReviewTitle,
  executePlanReviewRun,
  normalizePlanReviewRound,
} from '../../workflows/plan-review.ts';
import { renderStoredPlanState } from '../../render/render.ts';
import type { StoredPairPlanState } from '../../render/render.ts';
import {
  outputCommandResult,
  parseCommandInput,
  readPlanInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
} from '../io.ts';
import { shorten } from '../../shared/text.ts';

export async function handlePlanReview(argv: string[]): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['model', 'effort', 'cwd', 'plan-file', 'thread', 'round'],
    booleanOptions: ['json', 'background'],
    aliasMap: {
      m: 'model',
    },
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model =
    normalizeRequestedModel(options.model) ?? normalizeRequestedModel(PAIR_DEFAULT_MODEL);
  const effort = normalizeReasoningEffort(options.effort ?? defaultPairEffort(model as string));
  const round = normalizePlanReviewRound(options.round);
  const threadId =
    typeof options.thread === 'string' && options.thread.trim() ? options.thread.trim() : null;
  const plan = readPlanInput(cwd, options, positionals);
  if (!plan.trim()) {
    throw new Error('Provide the plan via --plan-file, piped stdin, or positional text.');
  }

  const job = createCompanionJob({
    prefix: 'plan',
    kind: 'plan-review',
    title: buildPlanReviewTitle(round),
    workspaceRoot,
    jobClass: 'review',
    summary: shorten(plan),
    model,
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    const request = {
      kind: 'plan-review',
      cwd,
      model,
      effort,
      plan,
      threadId,
      round,
      jobId: job.id,
    };
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) =>
      executePlanReviewRun({
        cwd,
        model,
        effort,
        plan,
        threadId,
        round,
        jobId: job.id,
        onProgress: progress,
      }),
    { json: options.json },
  );
}

export function handlePlanState(argv: string[]): void {
  const { options } = parseCommandInput(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json'],
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const record = loadPairPlanState(workspaceRoot) as StoredPairPlanState | null;
  const payload = record ? { available: true, ...record } : { available: false };
  outputCommandResult(payload, renderStoredPlanState(record), options.json);
}

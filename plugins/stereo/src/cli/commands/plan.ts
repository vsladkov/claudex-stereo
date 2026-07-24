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

// The stored pair-plan record as far as the plan-state summary reads it.
interface StoredPairPlanState {
  round?: number | null;
  verdict?: string | null;
  threadId?: string | null;
  openQuestions?: unknown[] | null;
  residualRisks?: unknown[] | null;
  [key: string]: unknown;
}

export function handlePlanState(argv: string[]): void {
  const { options } = parseCommandInput(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json'],
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const record = loadPairPlanState(workspaceRoot) as StoredPairPlanState | null;
  const payload = record ? { available: true, ...record } : { available: false };
  const rendered = record
    ? `Stored plan found (round ${record.round ?? '?'}, verdict: ${record.verdict ?? 'unknown'}, thread: ${record.threadId ?? 'unknown'}, open questions: ${record.openQuestions?.length ?? 0}, residual risks: ${record.residualRisks?.length ?? 0}).\n`
    : 'No stored plan for this repository. Run /stereo:plan first.\n';
  outputCommandResult(payload, rendered, options.json);
}

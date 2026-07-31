import { spawn } from 'node:child_process';

import {
  defaultPairEffort,
  normalizeReasoningEffort,
  normalizeRequestedModel,
  PAIR_DEFAULT_MODEL,
} from '../../models/registry.ts';
import { readStdinIfPiped } from '../../shared/fs.ts';
import {
  ensureStateDir,
  loadPairPlanState,
  nowIso,
  resolvePairPlanMarkdownFile,
  savePairPlanState,
  writeTextAtomic,
} from '../../workspace/state.ts';
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
  readUserFile,
  resolveCommandCwd,
  resolveCommandWorkspace,
} from '../io.ts';
import { shorten } from '../../shared/text.ts';

export interface PlanStateDeps {
  openInEditor: (filePath: string) => Promise<boolean>;
}

async function openInVsCode(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('code', [filePath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }

    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
    child.once('error', () => {
      resolve(false);
    });
  });
}

export const defaultPlanStateDeps: PlanStateDeps = {
  openInEditor: openInVsCode,
};

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    : [];
}

function readFindingsFile(cwd: string, value: unknown): unknown[] {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }
  const contents = readUserFile(cwd, '--findings-file', value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('Could not parse --findings-file as JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Provide --findings-file containing a JSON array.');
  }
  return parsed;
}

function normalizeStoredPlanRound(round: unknown): number {
  if (round == null || String(round).trim() === '') {
    return 1;
  }
  const parsed = Number(String(round).trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Unsupported stored-plan round "${round}". Use a non-negative integer.`);
  }
  return parsed;
}

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

export async function handlePlanState(
  argv: string[],
  deps: PlanStateDeps = defaultPlanStateDeps,
): Promise<void> {
  const { options } = parseCommandInput(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json', 'open'],
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const record = loadPairPlanState(workspaceRoot) as StoredPairPlanState | null;
  const payload = record ? { available: true, ...record } : { available: false };
  const rendered = renderStoredPlanState(record);
  if (!options.open || !record) {
    outputCommandResult(payload, rendered, options.json);
    return;
  }

  const exportedPath = resolvePairPlanMarkdownFile(workspaceRoot);
  ensureStateDir(workspaceRoot);
  writeTextAtomic(exportedPath, rendered);
  const openedInEditor = await deps.openInEditor(exportedPath);
  const openMessage = openedInEditor
    ? 'Opened in VS Code.'
    : "VS Code CLI ('code') not found - open the file manually.";
  outputCommandResult(
    { ...payload, exportedPath, openedInEditor },
    `${rendered}\nExported: ${exportedPath}\n${openMessage}\n`,
    options.json,
  );
}

export function handlePlanStore(argv: string[]): void {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd', 'verdict', 'round', 'reviewed-by', 'summary', 'findings-file', 'thread'],
    arrayOptions: ['open-question', 'residual-risk'],
    booleanOptions: ['json', 'no-thread'],
  });

  if (positionals.length > 0) {
    throw new Error('plan-store reads the plan from stdin; unexpected positional arguments.');
  }
  if (options.thread && options['no-thread']) {
    throw new Error('Choose either --thread <id> or --no-thread.');
  }

  const verdict = optionalString(options.verdict);
  if (!verdict) {
    throw new Error('Provide --verdict <value>.');
  }

  const plan = readStdinIfPiped();
  if (!plan.trim()) {
    throw new Error('Provide the plan via piped stdin.');
  }

  const cwd = resolveCommandCwd(options);
  const findings = readFindingsFile(cwd, options['findings-file']);
  const workspaceRoot = resolveCommandWorkspace(options);
  const previous = loadPairPlanState(workspaceRoot) as StoredPairPlanState | null;
  // Nulling these on a Claude-side persist destroyed a resumable review thread
  // and the implementer's stored model/effort defaults. Command call sites
  // always pass --thread or --no-thread, so preservation cannot inherit a
  // thread from an unrelated plan.
  const threadId = options['no-thread']
    ? null
    : (optionalString(options.thread) ?? optionalString(previous?.threadId));
  const model = optionalString(previous?.model);
  const effort = optionalString(previous?.effort);
  const record = savePairPlanState(workspaceRoot, {
    plan,
    threadId,
    model,
    effort,
    round: normalizeStoredPlanRound(options.round),
    verdict,
    summary: optionalString(options.summary),
    findings,
    openQuestions: stringArray(options['open-question']),
    residualRisks: stringArray(options['residual-risk']),
    reviewedBy: optionalString(options['reviewed-by']),
    updatedAt: nowIso(),
  });

  outputCommandResult(record, renderStoredPlanState(record), options.json);
}

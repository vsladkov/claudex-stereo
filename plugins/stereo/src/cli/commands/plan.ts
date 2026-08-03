import { spawn } from 'node:child_process';

import {
  defaultPairEffort,
  normalizeReasoningEffort,
  normalizeRequestedModel,
  PAIR_DEFAULT_MODEL,
} from '../../models/registry.ts';
import { readStdinTextIfPiped } from '../../shared/fs.ts';
import { optionalString, recordLike } from '../../shared/json.ts';
import {
  clearImplementState,
  clearPairPlanState,
  DEFAULT_PLAN_SLOT,
  ensureStateDir,
  listPairPlanSlots,
  loadPairPlanState,
  nowIso,
  planSlotOrDefault,
  readImplementStateFile,
  resolvePairPlanMarkdownFile,
  savePairPlanState,
  writeTextAtomic,
} from '../../workspace/state.ts';
import {
  createCompanionJob,
  ensureCodexLaunchReady,
  enqueueBackgroundTask,
  renderQueuedTaskLaunch,
  runForegroundCommand,
} from '../../workflows/companion-jobs.ts';
import {
  buildPlanReviewTitle,
  executePlanReviewRun,
  normalizePlanReviewRound,
} from '../../workflows/plan-review.ts';
import { renderPlanSlotList, renderStoredPlanState } from '../../render/render.ts';
import type { PlanSlotSummary, StoredPairPlanState } from '../../render/render.ts';
import {
  outputCommandResult,
  parseCommandInput,
  readPlanInput,
  readUserFile,
  resolveCommandCwd,
  resolveCommandWorkspace,
  resolvePlanSlotOption,
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    : [];
}

function readJsonArrayFile(cwd: string, flagName: string, value: unknown): unknown[] {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }
  const contents = readUserFile(cwd, flagName, value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Could not parse ${flagName} as JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Provide ${flagName} containing a JSON array.`);
  }
  return parsed;
}

function readFindingsFile(cwd: string, value: unknown): unknown[] {
  return readJsonArrayFile(cwd, '--findings-file', value);
}

function readStringListFile(cwd: string, flagName: string, value: unknown): string[] {
  const entries = readJsonArrayFile(cwd, flagName, value);
  if (entries.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Provide ${flagName} containing a JSON array of strings.`);
  }
  return stringArray(entries);
}

function readSummaryFile(cwd: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const summary = readUserFile(cwd, '--summary-file', String(value)).trim();
  return summary || null;
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
    valueOptions: ['model', 'effort', 'cwd', 'plan-file', 'thread', 'round', 'slot'],
    booleanOptions: ['json', 'background'],
    aliasMap: {
      m: 'model',
    },
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const slot = resolvePlanSlotOption(options);
  const model =
    normalizeRequestedModel(options.model) ?? normalizeRequestedModel(PAIR_DEFAULT_MODEL);
  const effort = normalizeReasoningEffort(options.effort ?? defaultPairEffort(model as string));
  const round = normalizePlanReviewRound(options.round);
  const threadId =
    typeof options.thread === 'string' && options.thread.trim() ? options.thread.trim() : null;
  const plan = await readPlanInput(cwd, options, positionals);
  if (!plan.trim()) {
    throw new Error('Provide the plan via --plan-file, piped stdin, or positional text.');
  }

  // Validate availability and auth before creating either a foreground or a
  // detached job record, so launch failures never appear as failed jobs.
  await ensureCodexLaunchReady(cwd);
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
    const request = {
      kind: 'plan-review',
      cwd,
      model,
      effort,
      plan,
      slot,
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
        slot,
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
    valueOptions: ['cwd', 'slot'],
    booleanOptions: ['json', 'list', 'open', 'clear', 'mark-implemented'],
  });

  const actions = ['list', 'open', 'clear', 'mark-implemented'].filter((key) => options[key]);
  if (actions.length > 1) {
    throw new Error('Choose one of --list, --open, --clear, or --mark-implemented.');
  }
  if (options.list && Object.hasOwn(options, 'slot')) {
    throw new Error('--list covers every slot; drop --slot.');
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const slot = resolvePlanSlotOption(options);
  if (options.list) {
    const slots: PlanSlotSummary[] = listPairPlanSlots(workspaceRoot).map((entrySlot) => {
      const record = loadPairPlanState(workspaceRoot, entrySlot) as StoredPairPlanState | null;
      if (!record) {
        return { slot: entrySlot, available: false, unreadable: true };
      }
      return {
        slot: entrySlot,
        available: true,
        verdict: record.verdict,
        round: record.round,
        summary: record.summary,
        updatedAt: record.updatedAt,
        implementedAt: record.implementedAt,
      };
    });
    const implementState = readImplementStateFile(workspaceRoot);
    const implementStateRecord = recordLike(implementState.record);
    const implementStatePlan = recordLike(implementStateRecord?.plan);
    const implementStateSlot = implementStateRecord
      ? planSlotOrDefault(implementStatePlan?.slot)
      : null;
    outputCommandResult(
      { slots, implementStateSlot },
      renderPlanSlotList(slots, implementStateSlot),
      options.json,
    );
    return;
  }

  if (options.clear) {
    const removed = clearPairPlanState(workspaceRoot, slot);
    const implementState = readImplementStateFile(workspaceRoot);
    const implementStateRecord = recordLike(implementState.record);
    const implementStateWorktreeRecord = recordLike(implementStateRecord?.worktree);
    const implementStateWorktree =
      implementStateRecord?.isolated &&
      typeof implementStateWorktreeRecord?.path === 'string' &&
      implementStateWorktreeRecord.path.trim()
        ? implementStateWorktreeRecord.path.trim()
        : null;
    const implementStateStatus = implementState.missing
      ? null
      : implementState.parseError
        ? 'unreadable'
        : (optionalString((implementState.record as { status?: unknown } | null)?.status) ??
          'unreadable');
    const implementStatePlan = recordLike(implementStateRecord?.plan);
    const recordedSlot = planSlotOrDefault(implementStatePlan?.slot);
    const implementStateBelongsToSlot = recordedSlot === slot;
    const clearedImplementState = implementStateBelongsToSlot
      ? clearImplementState(workspaceRoot)
      : [];
    const keptDifferentImplementState = !implementState.missing && !implementStateBelongsToSlot;
    const payload = {
      cleared: removed.length > 0,
      removed,
      clearedImplementState: clearedImplementState.length > 0,
      implementStateStatus,
      ...(implementStateWorktree ? { implementStateWorktree } : {}),
      ...(keptDifferentImplementState ? { implementStateSlot: recordedSlot } : {}),
      slot,
    };
    const planRendered =
      removed.length > 0
        ? `Cleared the stored plan for this repository.\n${removed.map((filePath) => `- ${filePath}`).join('\n')}\n`
        : 'No stored plan for this repository. Nothing to clear.\n';
    const implementClearRendered =
      clearedImplementState.length > 0
        ? `Also cleared the implementation record (status: ${implementStateStatus ?? 'unreadable'}).\n${clearedImplementState.map((filePath) => `- ${filePath}`).join('\n')}\n`
        : '';
    const keptImplementRendered = keptDifferentImplementState
      ? `Kept the implementation record for slot ${recordedSlot} (status: ${implementStateStatus ?? 'unreadable'}).\n`
      : '';
    const implementWorktreeRendered =
      implementStateWorktree && clearedImplementState.length > 0
        ? `Isolated worktree ${implementStateWorktree}; remove it with git -C "${workspaceRoot}" worktree remove --force "${implementStateWorktree}".\n`
        : '';
    const implementRendered = `${implementClearRendered}${keptImplementRendered}${implementWorktreeRendered}`;
    const rendered = `${planRendered}${implementRendered}`;
    outputCommandResult(payload, rendered, options.json);
    return;
  }

  const record = loadPairPlanState(workspaceRoot, slot) as StoredPairPlanState | null;
  if (options['mark-implemented']) {
    if (!record) {
      if (slot === DEFAULT_PLAN_SLOT) {
        throw new Error('No stored plan to mark implemented. Run /stereo:plan first.');
      }
      throw new Error(
        `No stored plan in slot "${slot}" to mark implemented. Run /stereo:plan --slot ${slot} first.`,
      );
    }
    const updated = savePairPlanState(
      workspaceRoot,
      {
        ...record,
        implementedAt: nowIso(),
      },
      slot,
    );
    outputCommandResult(
      { available: true, ...updated, slot },
      renderStoredPlanState(updated),
      options.json,
    );
    return;
  }

  const payload = record ? { available: true, ...record, slot } : { available: false, slot };
  const slotLabel = slot === DEFAULT_PLAN_SLOT ? null : slot;
  const rendered = renderStoredPlanState(record, slotLabel);
  if (!options.open || !record) {
    outputCommandResult(payload, rendered, options.json);
    return;
  }

  const exportedPath = resolvePairPlanMarkdownFile(workspaceRoot, slot);
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

export async function handlePlanStore(argv: string[]): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      'cwd',
      'verdict',
      'round',
      'reviewed-by',
      'summary',
      'summary-file',
      'findings-file',
      'open-questions-file',
      'residual-risks-file',
      'thread',
      'slot',
    ],
    arrayOptions: ['open-question', 'residual-risk'],
    booleanOptions: ['json', 'no-thread'],
  });

  if (positionals.length > 0) {
    throw new Error('plan-store reads the plan from stdin; unexpected positional arguments.');
  }
  if (options.thread && options['no-thread']) {
    throw new Error('Choose either --thread <id> or --no-thread.');
  }
  const hasSummaryFile = Object.hasOwn(options, 'summary-file');
  if (Object.hasOwn(options, 'summary') && hasSummaryFile) {
    throw new Error('Choose either --summary <text> or --summary-file <path>.');
  }
  const hasOpenQuestionsFile = Object.hasOwn(options, 'open-questions-file');
  if (Object.hasOwn(options, 'open-question') && hasOpenQuestionsFile) {
    throw new Error('Choose either --open-question <text> or --open-questions-file <path>.');
  }
  const hasResidualRisksFile = Object.hasOwn(options, 'residual-risks-file');
  if (Object.hasOwn(options, 'residual-risk') && hasResidualRisksFile) {
    throw new Error('Choose either --residual-risk <text> or --residual-risks-file <path>.');
  }

  const verdict = optionalString(options.verdict);
  if (!verdict) {
    throw new Error('Provide --verdict <value>.');
  }

  const plan = await readStdinTextIfPiped({ label: 'plan-store', onTimeout: 'error' });
  if (!plan.trim()) {
    throw new Error('Provide the plan via piped stdin.');
  }

  const cwd = resolveCommandCwd(options);
  const summaryFromFile = readSummaryFile(cwd, options['summary-file']);
  const findings = readFindingsFile(cwd, options['findings-file']);
  const questionsFromFile = readStringListFile(
    cwd,
    '--open-questions-file',
    options['open-questions-file'],
  );
  const risksFromFile = readStringListFile(
    cwd,
    '--residual-risks-file',
    options['residual-risks-file'],
  );
  const workspaceRoot = resolveCommandWorkspace(options);
  const slot = resolvePlanSlotOption(options);
  const previous = loadPairPlanState(workspaceRoot, slot) as StoredPairPlanState | null;
  // Nulling these on a Claude-side persist destroyed a resumable review thread
  // and the implementer's stored model/effort defaults. Command call sites
  // always pass --thread or --no-thread, so preservation cannot inherit a
  // thread from an unrelated plan.
  const threadId = options['no-thread']
    ? null
    : (optionalString(options.thread) ?? optionalString(previous?.threadId));
  const model = optionalString(previous?.model);
  const effort = optionalString(previous?.effort);
  // This fresh record intentionally does not preserve implementedAt: a newly
  // stored plan or revision has not completed a full implementation phase.
  const record = savePairPlanState(
    workspaceRoot,
    {
      plan,
      threadId,
      model,
      effort,
      round: normalizeStoredPlanRound(options.round),
      verdict,
      summary: hasSummaryFile ? summaryFromFile : optionalString(options.summary),
      findings,
      openQuestions: hasOpenQuestionsFile
        ? questionsFromFile
        : stringArray(options['open-question']),
      residualRisks: hasResidualRisksFile ? risksFromFile : stringArray(options['residual-risk']),
      reviewedBy: optionalString(options['reviewed-by']),
      updatedAt: nowIso(),
    },
    slot,
  );

  outputCommandResult({ ...record, slot }, renderStoredPlanState(record), options.json);
}

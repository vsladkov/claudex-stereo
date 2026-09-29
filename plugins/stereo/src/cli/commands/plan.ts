import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

import { normalizeReasoningEffort, parseModelSelection } from '../../models/registry.ts';
import { resolveCommandLaunch } from '../../platform/process.ts';
import { diffPlanTexts } from '../../shared/diff.ts';
import { readStdinTextIfPiped, writeTextAtomic } from '../../shared/fs.ts';
import { optionalString, recordLike } from '../../shared/json.ts';
import {
  clearImplementState,
  clearPairPlanState,
  DEFAULT_PLAN_SLOT,
  ensureStateDir,
  listPairPlanSlots,
  loadPairPlanState,
  loadState,
  normalizePlanSlot,
  nowIso,
  planSlotOrDefault,
  readImplementStateFile,
  resolvePairPlanMarkdownFile,
  savePairPlanState,
} from '../../workspace/state.ts';
import {
  createCompanionJob,
  enqueueBackgroundTask,
  renderQueuedTaskLaunch,
  runForegroundCommand,
} from '../../workflows/companion-jobs.ts';
import {
  buildPlanReviewTitle,
  executePlanReviewRun,
  normalizePlanReviewRound,
  PLAN_REVIEWER_ROLE,
} from '../../workflows/plan-review.ts';
import { assertResumeFits } from '../../workflows/task.ts';
import { resolveWorkspaceRoot } from '../../workspace/workspace.ts';
import {
  renderPlanSlotComparison,
  renderPlanSlotList,
  renderStoredPlanMetadata,
  renderStoredPlanState,
} from '../../render/render.ts';
import type { PlanSlotSummary, StoredPairPlanState } from '../../render/render.ts';
import {
  outputCommandResult,
  outputReportResult,
  parseCommandInput,
  readPlanInput,
  readUserFile,
  resolveCommandCwd,
  resolveCommandWorkspace,
  resolvePlanSlotOption,
} from '../io.ts';
import { shorten } from '../../shared/text.ts';
import { chooseLaunchSelection, outputDryRun, resolveLaunch } from '../launch.ts';
import { worktreeRemoveCommand } from './worktree.ts';

export interface PlanStateDeps {
  openInEditor: (filePath: string) => Promise<boolean>;
}

export interface EditorChild {
  once(event: 'spawn' | 'error', listener: () => void): unknown;
  unref(): void;
}

export interface OpenInVsCodeOptions {
  /** Test seam: the platform to launch for (the host's by default). */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Test seam: whether a PATH candidate exists as a file (see resolveCommandLaunch). */
  fileExists?: (file: string) => boolean;
  /** Test seam: starts the editor process in place of child_process.spawn. */
  spawnImpl?: (file: string, args: string[], options: SpawnOptions) => EditorChild;
}

// `code` is a `.cmd` shim on Windows, which only cmd.exe runs: the launch
// hands cmd one command line with the path quoted in it, never a bare path
// beside the shell. Elsewhere the path is a plain argument and no shell runs.
export function openInVsCode(
  filePath: string,
  options: OpenInVsCodeOptions = {},
): Promise<boolean> {
  const launch = resolveCommandLaunch('code', [filePath], {
    platform: options.platform,
    env: options.env,
    fileExists: options.fileExists,
  });
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    let child: EditorChild;
    try {
      child = spawnImpl(launch.file, launch.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: launch.shell,
        ...(options.env ? { env: options.env } : {}),
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
  openInEditor: (filePath) => openInVsCode(filePath),
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
    valueOptions: ['model', 'effort', 'cwd', 'workspace', 'plan-file', 'thread', 'round', 'slot'],
    booleanOptions: ['json', 'background', 'dry-run'],
    aliasMap: {
      m: 'model',
    },
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const dryRun = Boolean(options['dry-run']);
  const slot = resolvePlanSlotOption(options);
  const threadId = optionalString(options.thread);
  // Malformed selections and efforts fail before any runtime probe. Without
  // --model the plan reviewer's role default runs (the workspace's stored
  // model, else the built-in), a later round on --thread included; the
  // thread's record must have run the plan reviewer on that runtime.
  const state = loadState(workspaceRoot);
  const launch = chooseLaunchSelection({
    explicit: parseModelSelection(options.model),
    role: PLAN_REVIEWER_ROLE,
    takeDefault: true,
    stored: state.config.roleDefaults,
  });
  // The plan reviewer always has a default, so a selection is always chosen.
  const runtime = launch.selection?.runtime ?? 'codex';
  // The directory the review runs in, recorded on the job: a Claude session
  // resumes only from there, as a task session does.
  const runCwd = resolveWorkspaceRoot(cwd);
  assertResumeFits({ jobs: state.jobs, threadId, role: PLAN_REVIEWER_ROLE, runtime, runCwd });
  const requestedEffort = normalizeReasoningEffort(options.effort, runtime);
  const round = normalizePlanReviewRound(options.round);
  // A dry run checks a --plan-file but never waits on stdin for the plan.
  const plan =
    dryRun && !options['plan-file']
      ? positionals.join(' ')
      : await readPlanInput(cwd, options, positionals);
  if (!plan.trim() && !dryRun) {
    throw new Error('Provide the plan via --plan-file, piped stdin, or positional text.');
  }

  // Validate availability and auth before creating either a foreground or a
  // detached job record, so launch failures never appear as failed jobs.
  // The Codex check also refreshes the model catalog that the selection and
  // its effort default resolve against.
  const resolved = await resolveLaunch({
    probeCwd: dryRun ? null : cwd,
    launch,
    requestedEffort,
  });
  const model = resolved.model as string;
  const effort = resolved.effort;
  if (dryRun) {
    // Every launch check passed: say what a launch would run, create nothing.
    outputDryRun({ runtime, model, effort, role: PLAN_REVIEWER_ROLE }, options.json);
    return;
  }
  const job = {
    ...createCompanionJob({
      prefix: 'plan',
      kind: 'plan-review',
      title: buildPlanReviewTitle(round, runtime),
      workspaceRoot,
      jobClass: 'review',
      summary: shorten(plan),
      model,
      runtime,
      role: PLAN_REVIEWER_ROLE,
    }),
    cwd: runCwd,
  };
  const request = {
    cwd,
    workspaceRoot,
    runtime,
    model,
    effort,
    role: PLAN_REVIEWER_ROLE,
    plan,
    slot,
    threadId,
    round,
    jobId: job.id,
  };

  if (options.background) {
    const { payload } = enqueueBackgroundTask(cwd, job, { kind: 'plan-review', ...request });
    outputReportResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) => executePlanReviewRun({ ...request, onProgress: progress }),
    { json: options.json },
  );
}

export async function handlePlanState(
  argv: string[],
  deps: PlanStateDeps = defaultPlanStateDeps,
): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd', 'slot'],
    booleanOptions: ['json', 'list', 'open', 'clear', 'mark-implemented', 'compare', 'metadata'],
  });

  const actions = ['list', 'open', 'clear', 'mark-implemented', 'compare', 'metadata'].filter(
    (key) => options[key],
  );
  if (actions.length > 1) {
    throw new Error(
      'Choose one of --list, --open, --clear, --mark-implemented, --compare, or --metadata.',
    );
  }
  if (options.list && Object.hasOwn(options, 'slot')) {
    throw new Error('--list covers every slot; drop --slot.');
  }
  if (options.compare && Object.hasOwn(options, 'slot')) {
    throw new Error('--compare names both slots; drop --slot.');
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

  if (options.compare) {
    if (positionals.length !== 2) {
      throw new Error('Provide exactly two slot names: --compare <slotA> <slotB>.');
    }
    const slotA = normalizePlanSlot(positionals[0]);
    const slotB = normalizePlanSlot(positionals[1]);
    if (slotA === slotB) {
      throw new Error('Provide two different slot names to compare.');
    }

    const recordA = loadPairPlanState(workspaceRoot, slotA) as StoredPairPlanState | null;
    const recordB = loadPairPlanState(workspaceRoot, slotB) as StoredPairPlanState | null;
    if (!recordA || !recordB) {
      if (!recordA && !recordB) {
        throw new Error(
          `No stored plans in slots "${slotA}" and "${slotB}" to compare. Run /stereo:plan --slot <name> first.`,
        );
      }
      const missing = recordA ? slotB : slotA;
      throw new Error(
        `No stored plan in slot "${missing}" to compare. Run /stereo:plan --slot ${missing} first.`,
      );
    }

    const planA = typeof recordA.plan === 'string' ? recordA.plan : '(plan text missing)';
    const planB = typeof recordB.plan === 'string' ? recordB.plan : '(plan text missing)';
    const planDiff = diffPlanTexts(planA, planB);
    // Metadata only: shipping both plan bodies alongside the diff would put two
    // 32 MiB-bounded texts in one document, including when the diff is
    // suppressed. Each full plan stays reachable via --json --slot <name>.
    const { plan: _planA, ...metadataA } = recordA;
    const { plan: _planB, ...metadataB } = recordB;
    outputCommandResult(
      {
        slots: [slotA, slotB],
        a: { ...metadataA, slot: slotA },
        b: { ...metadataB, slot: slotB },
        planIdentical: planDiff.identical,
        planDiffSuppressed: planDiff.suppressed,
        planDiff: planDiff.diff,
      },
      renderPlanSlotComparison(
        { slot: slotA, record: recordA },
        { slot: slotB, record: recordB },
        planDiff,
      ),
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
        ? `Isolated worktree ${implementStateWorktree}; remove it with ${worktreeRemoveCommand(workspaceRoot, implementStateWorktree)}.\n`
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
      {
        available: true,
        ...updated,
        plan: undefined,
        planChars: typeof updated.plan === 'string' ? updated.plan.length : 0,
        slot,
      },
      renderStoredPlanMetadata(updated, slot === DEFAULT_PLAN_SLOT ? null : slot),
      options.json,
    );
    return;
  }

  const slotLabel = slot === DEFAULT_PLAN_SLOT ? null : slot;
  if (options.metadata) {
    const metadataPayload = record
      ? {
          available: true,
          ...record,
          plan: undefined,
          planChars: typeof record.plan === 'string' ? record.plan.length : 0,
          slot,
        }
      : { available: false, slot };
    outputCommandResult(metadataPayload, renderStoredPlanMetadata(record, slotLabel), options.json);
    return;
  }
  const payload = record ? { available: true, ...record, slot } : { available: false, slot };
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
      'slot',
    ],
    arrayOptions: ['open-question', 'residual-risk'],
    booleanOptions: ['json'],
  });

  if (positionals.length > 0) {
    throw new Error('plan-store reads the plan from stdin; unexpected positional arguments.');
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
  // This fresh record intentionally does not preserve implementedAt: a newly
  // stored plan or revision has not completed a full implementation phase.
  const record = savePairPlanState(
    workspaceRoot,
    {
      plan,
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

  // The caller piped the plan in on stdin one command earlier; echoing the
  // full text back costs thousands of tokens per store for pure repetition.
  outputCommandResult(
    {
      ...record,
      plan: undefined,
      planChars: typeof record.plan === 'string' ? record.plan.length : 0,
      slot,
    },
    renderStoredPlanMetadata(record, slot === DEFAULT_PLAN_SLOT ? null : slot),
    options.json,
  );
}

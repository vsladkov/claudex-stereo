import { resolveReviewTarget } from '../../platform/git.ts';
import { normalizeReasoningEffort, parseModelSelection } from '../../models/registry.ts';
import { loadState } from '../../workspace/state.ts';
import {
  buildReviewJobMetadata,
  createCompanionJob,
  enqueueBackgroundTask,
  renderQueuedTaskLaunch,
  runForegroundCommand,
} from '../../workflows/companion-jobs.ts';
import {
  assertReviewEffortSupported,
  executeReviewRun,
  NATIVE_REVIEW_COMMAND_ERROR,
  NATIVE_REVIEW_RUNTIME_ERROR,
  validateNativeReviewRequest,
} from '../../workflows/review.ts';
import type { ReviewRole } from '../../workflows/review.ts';
import { chooseLaunchSelection, resolveLaunch } from '../launch.ts';
import {
  outputReportResult,
  parseCommandInput,
  readUserFile,
  resolveCommandCwd,
  resolveCommandWorkspace,
} from '../io.ts';

// The role whose default a review runs without --model and whose effort it
// takes: the implementation reviewer's, for both review commands.
const REVIEW_EFFORT_ROLE = 'implementation-reviewer';

export interface ReviewCommandConfig {
  reviewName: string;
  /** The role the review runs as, recorded on its job and request. */
  role: ReviewRole;
  /** Whether --native (Codex's built-in reviewer) is an option for this command. */
  supportsNative: boolean;
}

export async function handleReviewCommand(
  argv: string[],
  config: ReviewCommandConfig,
): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['base', 'scope', 'model', 'effort', 'pr', 'cwd', 'workspace', 'focus-file'],
    booleanOptions: ['json', 'background', 'wait', 'native'],
    aliasMap: {
      m: 'model',
    },
  });

  if (Object.hasOwn(options, 'pr')) {
    throw new Error(
      '--pr is resolved by /stereo:review and /stereo:adversarial-review, not by the companion CLI. Check out the pull request branch and pass --base <ref>.',
    );
  }
  // Malformed selections and efforts fail before any runtime probe. Without
  // --model the reviewer runs the implementation reviewer's role default (the
  // workspace's stored model, else the built-in); only the native reviewer
  // runs on Codex's own configured model.
  const workspaceRoot = resolveCommandWorkspace(options);
  const native = Boolean(options.native);
  const storedRoles = loadState(workspaceRoot).config.roleDefaults;
  // The native reviewer takes no effort, so no role default applies to it.
  const launch = chooseLaunchSelection({
    explicit: parseModelSelection(options.model),
    role: native ? null : REVIEW_EFFORT_ROLE,
    takeDefault: !native,
    stored: storedRoles,
  });
  const runtime = launch.selection?.runtime ?? 'codex';
  if (native && !config.supportsNative) {
    throw new Error(NATIVE_REVIEW_COMMAND_ERROR);
  }
  if (native && runtime !== 'codex') {
    throw new Error(NATIVE_REVIEW_RUNTIME_ERROR);
  }
  assertReviewEffortSupported(native, Object.hasOwn(options, 'effort'));

  const cwd = resolveCommandCwd(options);
  // The focus text comes from --focus-file (read like --prompt-file) or from
  // the positional words, never both.
  const positionalFocus = positionals.join(' ').trim();
  const focusFile = typeof options['focus-file'] === 'string' ? options['focus-file'] : null;
  if (focusFile !== null && positionalFocus) {
    throw new Error('Choose either --focus-file <path> or positional focus text.');
  }
  const focusText =
    focusFile !== null ? readUserFile(cwd, '--focus-file', focusFile).trim() : positionalFocus;
  const target = resolveReviewTarget(cwd, {
    base: options.base as string | undefined,
    scope: options.scope as string | undefined,
  });

  // The native-reviewer constraints (no focus text, supported targets) do not
  // apply to the reviewer role, which takes the full review prompt.
  if (native) {
    validateNativeReviewRequest(target, focusText);
  }
  if (options.background && options.wait) {
    throw new Error('Choose either --background or --wait.');
  }
  // Validate availability and auth before creating either a foreground or a
  // detached job record, so launch failures never appear as failed jobs. The
  // Codex check also refreshes the model catalog that family selections and
  // their effort defaults resolve against. The native reviewer runs Codex's
  // own model and takes no effort at all.
  const resolved = await resolveLaunch({
    probeCwd: cwd,
    launch,
    requestedEffort: normalizeReasoningEffort(options.effort, runtime),
  });
  const model = resolved.model;
  const metadata = buildReviewJobMetadata(config.reviewName, config.role, target, runtime);
  const job = createCompanionJob({
    prefix: 'review',
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: 'review',
    summary: metadata.summary,
    model,
    runtime,
    role: config.role,
  });
  const request = {
    cwd,
    workspaceRoot,
    base: options.base as string | undefined,
    scope: options.scope as string | undefined,
    target,
    runtime,
    model,
    effort: resolved.effort,
    focusText,
    reviewName: config.reviewName,
    role: config.role,
    ...(native ? { native } : {}),
    jobId: job.id,
  };
  if (options.background) {
    const { payload } = enqueueBackgroundTask(cwd, job, { kind: 'review', ...request });
    outputReportResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }
  await runForegroundCommand(
    job,
    (progress) => executeReviewRun({ ...request, onProgress: progress }),
    { json: options.json },
  );
}

export async function handleReview(argv: string[]): Promise<void> {
  return handleReviewCommand(argv, {
    reviewName: 'Review',
    role: 'reviewer',
    supportsNative: true,
  });
}

export async function handleAdversarialReview(argv: string[]): Promise<void> {
  return handleReviewCommand(argv, {
    reviewName: 'Adversarial Review',
    role: 'adversarial-reviewer',
    supportsNative: false,
  });
}

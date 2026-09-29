import { normalizeReasoningEffort, parseModelSelection } from '../../models/registry.ts';
import { CLAUDE_ROLE_HINT } from '../../runtime/role-agents.ts';
import { errorMessage } from '../../shared/errors.ts';
import { optionalString } from '../../shared/json.ts';
import type { CompanionRuntime } from '../../shared/runtime.ts';
import { normalizeClaudeRole, roleWrites } from '../../runtime/index.ts';
import { assertAllowRule } from '../allow-rules.ts';
import { chooseLaunchSelection, outputDryRun, pinnedSelection, resolveLaunch } from '../launch.ts';
import {
  filterJobsForCurrentSession,
  readStoredJob,
  sortJobsNewestFirst,
} from '../../jobs/job-control.ts';
import { settleJob } from '../../jobs/job-lifecycle.ts';
import { runTrackedJob } from '../../jobs/tracked-jobs.ts';
import { readOutputSchema } from '../../runtime/index.ts';
import { assertSafeJobId, listJobs, loadState, STOP_GATE_ORIGIN } from '../../workspace/state.ts';
import type { JobRecord } from '../../workspace/state.ts';
import {
  createCompanionJob,
  createTrackedProgress,
  enqueueBackgroundTask,
  installSignalCleanup,
  renderQueuedTaskLaunch,
  runForegroundCommand,
} from '../../workflows/companion-jobs.ts';
import type { CompanionJob } from '../../workflows/companion-jobs.ts';
import { executePlanReviewRun } from '../../workflows/plan-review.ts';
import type { PlanReviewRunRequest } from '../../workflows/plan-review.ts';
import { executeReviewRun } from '../../workflows/review.ts';
import type { ReviewRunRequest } from '../../workflows/review.ts';
import {
  assertResumeFits,
  buildTaskRunMetadata,
  executeTaskRun,
  findLatestResumableTaskJob,
  getCurrentClaudeSessionId,
  requireTaskRequest,
} from '../../workflows/task.ts';
import type { TaskRunMetadata, TaskRunRequest } from '../../workflows/task.ts';
import { resolveWorkspaceRoot } from '../../workspace/workspace.ts';
import {
  outputCommandResult,
  outputReportResult,
  parseCommandInput,
  readJsonObjectFile,
  readTaskPrompt,
  readUserFile,
  resolveCommandCwd,
  resolveCommandWorkspace,
} from '../io.ts';
import type { CommandOptions } from '../io.ts';

// The request payload persisted for the detached task worker: a task or a
// plan-review/review request distinguished by its optional kind marker.
type PersistedWorkerRequest = TaskRunRequest &
  PlanReviewRunRequest &
  ReviewRunRequest & { kind?: string };

export interface TaskWorkerDeps {
  runTrackedJob: typeof runTrackedJob;
  executeTaskRun: typeof executeTaskRun;
  executePlanReviewRun: typeof executePlanReviewRun;
  executeReviewRun: typeof executeReviewRun;
}

export const defaultTaskWorkerDeps: TaskWorkerDeps = {
  runTrackedJob,
  executeTaskRun,
  executePlanReviewRun,
  executeReviewRun,
};

// `task --launch-args-file`: a recorded launch replayed (a tournament
// contestant's, an interrupted implementer's), with flags on the command line
// taking precedence. Keys are checked strictly, so a misspelled key never
// silently drops part of the launch. Where the run works (--cwd, --workspace)
// is no part of it: a replay passes those flags like any other launch.
const LAUNCH_ARGS_KEYS = ['selection', 'effort', 'role', 'allowRules', 'sandbox'];

interface LaunchArgs {
  selection: string | null;
  effort: string | null;
  role: string | null;
  allowRules: string[] | null;
  sandbox: boolean | null;
}

function launchArgsString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`--launch-args-file "${key}" must be a string or null.`);
  }
  return value.trim() || null;
}

function readLaunchArgs(options: CommandOptions): LaunchArgs | null {
  if (!Object.hasOwn(options, 'launch-args-file')) {
    return null;
  }
  const file = String(options['launch-args-file'] ?? '').trim();
  if (!file) {
    throw new Error('Provide a path for --launch-args-file.');
  }
  const record = readJsonObjectFile(resolveCommandCwd(options), '--launch-args-file', file);
  const unknownKey = Object.keys(record).find((key) => !LAUNCH_ARGS_KEYS.includes(key));
  if (unknownKey !== undefined) {
    throw new Error(
      `Unsupported key "${unknownKey}" in --launch-args-file; use ${LAUNCH_ARGS_KEYS.join(', ')}.`,
    );
  }
  const allowRules = record.allowRules;
  if (
    allowRules != null &&
    (!Array.isArray(allowRules) || allowRules.some((rule) => typeof rule !== 'string'))
  ) {
    throw new Error('--launch-args-file "allowRules" must be an array of strings.');
  }
  const sandbox = record.sandbox;
  if (sandbox != null && typeof sandbox !== 'boolean') {
    throw new Error('--launch-args-file "sandbox" must be true or false.');
  }
  return {
    selection: launchArgsString(record, 'selection'),
    effort: launchArgsString(record, 'effort'),
    role: launchArgsString(record, 'role'),
    allowRules: Array.isArray(allowRules) ? (allowRules as string[]) : null,
    sandbox: typeof sandbox === 'boolean' ? sandbox : null,
  };
}

// The launch as flags: each recorded value fills the flag it stands for,
// unless the command line gave that flag itself.
function applyLaunchArgs(options: CommandOptions, args: LaunchArgs | null): CommandOptions {
  if (!args) {
    return options;
  }
  const merged: CommandOptions = { ...options };
  const fill = (key: string, value: string | string[] | null) => {
    if (value !== null && !Object.hasOwn(options, key)) {
      merged[key] = value;
    }
  };
  fill('model', args.selection);
  fill('effort', args.effort);
  fill('role', args.role);
  fill('allow', args.allowRules);
  if (
    args.sandbox !== null &&
    !Object.hasOwn(options, 'sandbox') &&
    !Object.hasOwn(options, 'no-sandbox')
  ) {
    merged[args.sandbox ? 'sandbox' : 'no-sandbox'] = true;
  }
  return merged;
}

// Claude Code's Bash sandbox for a headless Claude run: --sandbox or
// --no-sandbox for this run, else the workspace default, which applies to
// the implementer (the only Claude role that writes).
function resolveSandbox(
  options: CommandOptions,
  runtime: CompanionRuntime,
  role: string | null,
  workspaceDefault: boolean,
): boolean {
  const on = options.sandbox === true;
  const off = options['no-sandbox'] === true || options.sandbox === false;
  if (on && off) {
    throw new Error('Choose either --sandbox or --no-sandbox.');
  }
  if (on && runtime !== 'claude') {
    throw new Error(
      "--sandbox enables Claude Code's Bash sandbox in a headless Claude run; Codex runs in its own sandbox.",
    );
  }
  if (on || off) {
    return on;
  }
  return runtime === 'claude' && role === 'implementer' && workspaceDefault;
}

// `cwd` is the directory the run works in, so a later resume of its Claude
// session can be held to it.
function buildTaskJob(
  workspaceRoot: string,
  cwd: string,
  taskMetadata: TaskRunMetadata,
  model: string | null,
  write: boolean,
  runtime: CompanionRuntime,
  role: string | null,
  origin: string | null,
): CompanionJob {
  const job = createCompanionJob({
    prefix: 'task',
    kind: 'task',
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: 'task',
    summary: taskMetadata.summary,
    model,
    runtime,
    write,
    role,
    origin,
  });
  return { ...job, cwd };
}

// The request a task runs, in the foreground or persisted for its worker:
// the Claude-only fields go to a Claude run only.
function buildTaskRequest({ role, allow, sandbox, ...request }: TaskRunRequest): TaskRunRequest {
  return {
    ...request,
    ...(request.runtime === 'claude'
      ? { role: role ?? null, allow: allow ?? [], sandbox: Boolean(sandbox) }
      : {}),
  };
}

export async function handleTask(argv: string[]): Promise<void> {
  const parsed = parseCommandInput(argv, {
    valueOptions: [
      'model',
      'effort',
      'cwd',
      'workspace',
      'prompt-file',
      'thread',
      'output-schema',
      'role',
      'launch-args-file',
      'origin',
    ],
    arrayOptions: ['allow'],
    booleanOptions: [
      'json',
      'write',
      'resume-last',
      'resume',
      'fresh',
      'background',
      'sandbox',
      'no-sandbox',
      'dry-run',
    ],
    aliasMap: {
      m: 'model',
    },
  });
  const { positionals } = parsed;
  const options = applyLaunchArgs(parsed.options, readLaunchArgs(parsed.options));

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const dryRun = Boolean(options['dry-run']);
  const resumeLast = Boolean(options['resume-last'] || options.resume);
  const fresh = Boolean(options.fresh);
  const threadId = optionalString(options.thread);
  // What launched the task when no user command did: only the Stop hook's
  // review names itself.
  const origin = optionalString(options.origin);
  if (origin !== null && origin !== STOP_GATE_ORIGIN) {
    throw new Error(`Unsupported --origin "${origin}"; the only origin is ${STOP_GATE_ORIGIN}.`);
  }
  if (resumeLast && fresh) {
    throw new Error('Choose either --resume/--resume-last or --fresh.');
  }
  if (threadId && (resumeLast || fresh)) {
    throw new Error('Choose either --thread <id> or --resume/--resume-last/--fresh.');
  }
  // Malformed selections fail before any runtime probe; Codex family
  // resolution waits for the launch-ready check below. A resume runs the
  // --model and --role it is given: --thread only names the thread, whose
  // record must have run the same role on the same runtime.
  const explicitSelection = parseModelSelection(options.model);
  const role = normalizeClaudeRole(options.role);
  // --resume-last continues the last rescue run (Codex, no role); a role's
  // thread or a Claude session is resumed by id.
  if (resumeLast && (role || explicitSelection?.runtime === 'claude')) {
    throw new Error(
      '--resume-last takes no --role or claude: selection; resume a known session with --thread <id>.',
    );
  }
  const state = loadState(workspaceRoot);
  const workspaceConfig = state.config;
  // On Claude the role selects the agent definition; on Codex it only marks
  // a role run, which takes the role's effort default. A fresh role run with
  // no model runs the role's default: the workspace's stored model, else the
  // built-in (the reviewer roles take the implementation reviewer's). A
  // resume without --model, and a task with neither a role nor a model, run
  // Codex's own model.
  const launch = chooseLaunchSelection({
    explicit: explicitSelection,
    role,
    takeDefault: !threadId,
    stored: workspaceConfig.roleDefaults,
  });
  const runtime = launch.selection?.runtime ?? 'codex';
  // The directory the run works in (the task runner's thread cwd).
  const runCwd = resolveWorkspaceRoot(cwd);
  assertResumeFits({ jobs: state.jobs, threadId, role, runtime, runCwd });
  const allow = Array.isArray(options.allow)
    ? options.allow.map((rule) => String(rule).trim())
    : [];
  if (runtime === 'claude' && !role) {
    throw new Error(`A Claude selection needs --role. ${CLAUDE_ROLE_HINT}`);
  }
  if (allow.length > 0 && runtime !== 'claude') {
    throw new Error(
      '--allow grants permission rules to a Claude role; Codex runs in its own sandbox.',
    );
  }
  for (const rule of allow) {
    assertAllowRule(rule, role);
  }
  // A role decides whether its run writes, on either runtime; a task without
  // a role writes when it is told to.
  if (role && Boolean(options.write) !== roleWrites(role)) {
    throw new Error(
      role === 'implementer'
        ? '--role implementer needs --write: it is the only role that edits files.'
        : `--write applies only to --role implementer; ${role} runs read-only.`,
    );
  }
  const sandbox = resolveSandbox(options, runtime, role, workspaceConfig.claudeSandbox === true);
  const effort = normalizeReasoningEffort(options.effort, runtime);
  const outputSchema =
    typeof options['output-schema'] === 'string'
      ? readUserFile(cwd, '--output-schema', options['output-schema'], readOutputSchema)
      : undefined;
  // A dry run checks a --prompt-file but never waits on stdin for a prompt.
  const prompt =
    dryRun && !options['prompt-file']
      ? positionals.join(' ')
      : await readTaskPrompt(cwd, options, positionals);
  const write = Boolean(options.write);
  const resuming = resumeLast || Boolean(threadId);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast,
    runtime,
    origin,
  });

  // A role run takes its role default's effort when it runs that default's
  // model, else the version's default effort; an explicit or stored effort
  // the model does not take is refused here. A dry run skips the readiness
  // probes (they spawn the runtime) and resolves against the cached catalog.
  const { model, effort: effectiveEffort } = await resolveLaunch({
    probeCwd: dryRun ? null : cwd,
    launch,
    requestedEffort: effort,
  });
  if (dryRun) {
    // Every launch check passed: say what a launch would run, create nothing.
    // `launchArgs` is this launch as --launch-args-file takes it.
    outputDryRun({ runtime, model, effort: effectiveEffort, role }, options.json, {
      sandbox,
      launchArgs: {
        selection: pinnedSelection(runtime, model),
        effort: effectiveEffort,
        role,
        allowRules: allow,
        sandbox,
      },
    });
    return;
  }
  requireTaskRequest(prompt, resuming);

  const job = buildTaskJob(
    workspaceRoot,
    runCwd,
    taskMetadata,
    model,
    write,
    runtime,
    role,
    origin,
  );
  const request = buildTaskRequest({
    cwd,
    workspaceRoot,
    runtime,
    model,
    effort: effectiveEffort,
    role,
    allow,
    sandbox,
    outputSchema,
    prompt,
    write,
    resumeLast,
    threadId,
    ...(origin ? { origin } : {}),
    jobId: job.id,
  });
  if (options.background) {
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputReportResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }
  await runForegroundCommand(
    job,
    (progress) => executeTaskRun({ ...request, onProgress: progress }),
    { json: options.json },
  );
}

export async function handleTaskWorker(
  argv: string[],
  deps: TaskWorkerDeps = defaultTaskWorkerDeps,
): Promise<void> {
  const { options } = parseCommandInput(argv, {
    valueOptions: ['cwd', 'workspace', 'job-id'],
  });

  if (!options['job-id']) {
    throw new Error('Missing required --job-id for task-worker.');
  }

  const jobId = assertSafeJobId(options['job-id'] as string);
  // Keep a cwd-derived fallback so a malformed --workspace still gets a
  // best-effort failed record instead of leaving a detached worker queued.
  let workspaceRoot = resolveCommandWorkspace(options.cwd ? { cwd: options.cwd } : {});
  let storedJob: JobRecord | null = null;
  let request: PersistedWorkerRequest | null = null;
  try {
    workspaceRoot = resolveCommandWorkspace(options);
    storedJob = readStoredJob(workspaceRoot, jobId);
    if (!storedJob) {
      throw new Error(`No stored job found for ${jobId}.`);
    }
    // A job cancelled (or otherwise settled) while it sat queued is not run:
    // runTrackedJob's running write refuses it under the index lock.
    request = storedJob.request as PersistedWorkerRequest | null;
    if (!request || typeof request !== 'object') {
      throw new Error(`Stored job ${jobId} is missing its task request payload.`);
    }
  } catch (error) {
    // The worker runs detached with stdio ignored: an unrecorded bootstrap
    // failure would leave the job queued forever with no visible cause. A
    // job settled meanwhile, or swept away entirely, is left as it is.
    try {
      settleJob(workspaceRoot, jobId, {
        terminal: { status: 'failed', phase: 'failed', errorMessage: errorMessage(error) },
        fallback: storedJob,
        skipUnknown: true,
      });
    } catch {
      // Nothing else to do from a detached worker.
    }
    throw error;
  }

  // The catch above always rethrows, so both bootstrap values are set here.
  const workerJob = storedJob as JobRecord;
  const workerRequest = Object.hasOwn(options, 'workspace')
    ? ({ ...(request as PersistedWorkerRequest), workspaceRoot } as PersistedWorkerRequest)
    : (request as PersistedWorkerRequest);

  const disposeSignalCleanup = installSignalCleanup({ jobId, workspaceRoot });
  try {
    const { logFile, progress } = createTrackedProgress(
      {
        ...workerJob,
        workspaceRoot,
      },
      {
        logFile: workerJob.logFile ?? null,
      },
    );
    const runner =
      workerRequest.kind === 'plan-review'
        ? deps.executePlanReviewRun
        : workerRequest.kind === 'review'
          ? deps.executeReviewRun
          : deps.executeTaskRun;
    await deps.runTrackedJob(
      {
        ...workerJob,
        workspaceRoot,
        logFile,
      },
      () =>
        runner({
          ...workerRequest,
          onProgress: progress,
        }),
      { logFile },
    );
  } finally {
    disposeSignalCleanup();
  }
}

export function handleTaskResumeCandidate(argv: string[]): void {
  const { options } = parseCommandInput(argv, {
    valueOptions: ['cwd', 'workspace'],
    booleanOptions: ['json'],
  });

  // --workspace keys the job index exactly as it does for `task`, so a
  // rescue launched from an isolated or foreign cwd finds its own jobs.
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  // The rescue command resumes Codex threads; a Claude session is never a candidate.
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null,
          },
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : 'No resumable task found for this session.\n';
  outputCommandResult(payload, rendered, options.json);
}

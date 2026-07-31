import type {
  AppServerNotification,
  ThreadItem,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  Turn,
} from '../protocol/app-server.ts';
import { shorten } from '../shared/text.ts';
import { extractThreadId, extractTurnId } from './threads.ts';
import type { AppServerClient } from './threads.ts';

export const TURN_INACTIVITY_TIMEOUT_ENV = 'CODEX_TURN_INACTIVITY_TIMEOUT_MS';
const DEFAULT_TURN_INACTIVITY_TIMEOUT_MS = 1_800_000;
const MAX_NOTIFICATION_ERROR_SAMPLES = 20;

export function resolveTurnInactivityTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TURN_INACTIVITY_TIMEOUT_ENV];
  if (raw == null || raw.trim() === '') {
    return DEFAULT_TURN_INACTIVITY_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TURN_INACTIVITY_TIMEOUT_MS;
  }
  return parsed > 0 ? parsed : 0;
}

export type FileChangeItem = Extract<ThreadItem, { type: 'fileChange' }>;
export type CommandExecutionItem = Extract<ThreadItem, { type: 'commandExecution' }>;

export interface ProgressUpdate {
  message: string;
  phase: string | null;
  threadId?: string | null;
  turnId?: string | null;
  stderrMessage?: string | null;
  logTitle?: string | null;
  logBody?: string | null;
}

export type ProgressReporter = (update: string | ProgressUpdate) => void;

export interface CapturedTokenUsage {
  job: TokenUsageBreakdown;
  thread: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface UnifiedDiffSummary {
  files: number;
  additions: number;
  deletions: number;
}

interface PlanProgressSnapshot {
  done: number;
  total: number;
  currentIndex: number | null;
  currentText: string | null;
}

export interface TurnCaptureState {
  threadId: string;
  rootThreadId: string;
  threadIds: Set<string>;
  threadTurnIds: Map<string, string>;
  threadLabels: Map<string, string>;
  turnId: string | null;
  bufferedNotifications: AppServerNotification[];
  // Bounded diagnostic sample; droppedNotifications is the total truth.
  notificationErrors: Array<{ method: string | null; message: string }>;
  droppedNotifications: number;
  completion: Promise<TurnCaptureState>;
  resolveCompletion: (state: TurnCaptureState) => void;
  rejectCompletion: (error: unknown) => void;
  finalTurn: Turn | null;
  completed: boolean;
  inferredCompletion: boolean;
  finalAnswerSeen: boolean;
  pendingCollaborations: Set<string>;
  activeSubagentTurns: Set<string>;
  completionTimer: unknown | null;
  timer: TurnCaptureTimer;
  lastAgentMessage: string;
  reviewText: string;
  reasoningSummary: string[];
  error: unknown;
  fileChanges: FileChangeItem[];
  commandExecutions: CommandExecutionItem[];
  tokenUsage: CapturedTokenUsage | null;
  jobTokenUsage: TokenUsageBreakdown | null;
  primaryThreadTokenUsage: ThreadTokenUsage | null;
  // Fixed-size dedupe snapshot consumed by sameDiffStats.
  diffStats: UnifiedDiffSummary;
  // Fixed-size dedupe snapshot consumed by samePlanProgress.
  planProgress: PlanProgressSnapshot | null;
  onProgress: ProgressReporter | null;
}

export interface TurnCaptureTimer {
  setTimeoutImpl: (callback: () => void, delayMs: number) => { unref?: () => void };
  clearTimeoutImpl: (handle: unknown) => void;
  inferredCompletionDelayMs: number;
}

export interface TurnCaptureStateOptions {
  onProgress?: ProgressReporter | null;
  /**
   * Injectable clock for the inferred-completion debounce (tests only).
   * All three fields or none: a fake setTimeout with the real clearTimeout
   * cannot cancel its handles.
   */
  timer?: TurnCaptureTimer;
}

const DEFAULT_TIMER: TurnCaptureTimer = {
  setTimeoutImpl: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeoutImpl: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  inferredCompletionDelayMs: 250,
};

export function looksLikeVerificationCommand(command: string): boolean {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command,
  );
}

function normalizeReasoningText(text: unknown): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractReasoningSections(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (typeof value === 'string') {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === 'object') {
    const source = value as {
      text?: unknown;
      summary?: unknown;
      content?: unknown;
      parts?: unknown;
    };
    if (typeof source.text === 'string') {
      return extractReasoningSections(source.text);
    }
    if ('summary' in source) {
      return extractReasoningSections(source.summary);
    }
    if ('content' in source) {
      return extractReasoningSections(source.content);
    }
    if ('parts' in source) {
      return extractReasoningSections(source.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections: string[], nextSections: string[]): string[] {
  const merged: string[] = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

export function emitProgress(
  onProgress: ProgressReporter | null | undefined,
  message: string | null | undefined,
  phase: string | null = null,
  extra: { threadId?: string | null; turnId?: string | null } = {},
): void {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

export interface LogEventOptions {
  message?: string | null;
  phase?: string | null;
  stderrMessage?: string | null;
  logTitle?: string | null;
  logBody?: string | null;
}

export function emitLogEvent(
  onProgress: ProgressReporter | null | undefined,
  options: LogEventOptions = {},
): void {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? '',
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null,
  });
}

export function labelForThread(
  state: TurnCaptureState,
  threadId: string | null | undefined,
): string | null {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

export interface RegisterThreadOptions {
  threadName?: string | null;
  name?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
}

export function registerThread(
  state: TurnCaptureState,
  threadId: string | null | undefined,
  options: RegisterThreadOptions = {},
): void {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

interface ItemProgressUpdate {
  message: string;
  phase: string;
}

function describeStartedItem(state: TurnCaptureState, item: ThreadItem): ItemProgressUpdate | null {
  switch (item.type) {
    case 'enteredReviewMode':
      return { message: `Reviewer started: ${item.review}`, phase: 'reviewing' };
    case 'commandExecution':
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? 'verifying' : 'running',
      };
    case 'fileChange':
      return { message: `Applying ${item.changes?.length ?? 0} file change(s).`, phase: 'editing' };
    case 'mcpToolCall':
      return { message: `Calling ${item.server}/${item.tool}.`, phase: 'investigating' };
    case 'dynamicToolCall':
      return { message: `Running tool: ${item.tool}.`, phase: 'investigating' };
    case 'collabAgentToolCall': {
      const subagents = (item.receiverThreadIds ?? []).map(
        (threadId) => labelForThread(state, threadId) ?? threadId,
      );
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(', ')} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: 'investigating' };
    }
    case 'webSearch':
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: 'investigating' };
    default:
      return null;
  }
}

function describeCompletedItem(
  state: TurnCaptureState,
  item: ThreadItem,
): ItemProgressUpdate | null {
  switch (item.type) {
    case 'commandExecution': {
      const exitCode = item.exitCode ?? '?';
      const statusLabel = item.status === 'completed' ? 'completed' : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? 'verifying' : 'running',
      };
    }
    case 'fileChange':
      return { message: `File changes ${item.status}.`, phase: 'editing' };
    case 'mcpToolCall':
      return {
        message: `Tool ${item.server}/${item.tool} ${item.status}.`,
        phase: 'investigating',
      };
    case 'dynamicToolCall':
      return { message: `Tool ${item.tool} ${item.status}.`, phase: 'investigating' };
    case 'collabAgentToolCall': {
      const subagents = (item.receiverThreadIds ?? []).map(
        (threadId) => labelForThread(state, threadId) ?? threadId,
      );
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(', ')} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: 'investigating' };
    }
    case 'exitedReviewMode':
      return { message: 'Reviewer finished.', phase: 'finalizing' };
    default:
      return null;
  }
}

export function createTurnCaptureState(
  threadId: string,
  options: TurnCaptureStateOptions = {},
): TurnCaptureState {
  let resolveCompletion!: (state: TurnCaptureState) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<TurnCaptureState>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    notificationErrors: [],
    droppedNotifications: 0,
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    inferredCompletion: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    timer: options.timer ?? DEFAULT_TIMER,
    lastAgentMessage: '',
    reviewText: '',
    reasoningSummary: [],
    error: null,
    fileChanges: [],
    commandExecutions: [],
    tokenUsage: null,
    jobTokenUsage: null,
    primaryThreadTokenUsage: null,
    diffStats: { files: 0, additions: 0, deletions: 0 },
    planProgress: null,
    onProgress: options.onProgress ?? null,
  };
}

const TOKEN_USAGE_FIELDS = [
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
] as const satisfies readonly (keyof TokenUsageBreakdown)[];

function isTokenUsageBreakdown(value: unknown): value is TokenUsageBreakdown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return TOKEN_USAGE_FIELDS.every(
    (field) =>
      typeof record[field] === 'number' &&
      Number.isFinite(record[field]) &&
      (record[field] as number) >= 0,
  );
}

function addTokenUsage(
  current: TokenUsageBreakdown | null,
  sample: TokenUsageBreakdown,
): TokenUsageBreakdown {
  return {
    totalTokens: (current?.totalTokens ?? 0) + sample.totalTokens,
    inputTokens: (current?.inputTokens ?? 0) + sample.inputTokens,
    cachedInputTokens: (current?.cachedInputTokens ?? 0) + sample.cachedInputTokens,
    cacheWriteInputTokens: (current?.cacheWriteInputTokens ?? 0) + sample.cacheWriteInputTokens,
    outputTokens: (current?.outputTokens ?? 0) + sample.outputTokens,
    reasoningOutputTokens: (current?.reasoningOutputTokens ?? 0) + sample.reasoningOutputTokens,
  };
}

function recordTokenUsage(state: TurnCaptureState, params: unknown): void {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return;
  }
  const notification = params as {
    threadId?: unknown;
    turnId?: unknown;
    tokenUsage?: unknown;
  };
  if (
    typeof notification.threadId !== 'string' ||
    typeof notification.turnId !== 'string' ||
    state.threadTurnIds.get(notification.threadId) !== notification.turnId
  ) {
    return;
  }
  const usage = notification.tokenUsage as Partial<ThreadTokenUsage> | null | undefined;
  if (
    !usage ||
    !isTokenUsageBreakdown(usage.last) ||
    !isTokenUsageBreakdown(usage.total) ||
    (usage.modelContextWindow !== null &&
      (typeof usage.modelContextWindow !== 'number' ||
        !Number.isFinite(usage.modelContextWindow) ||
        usage.modelContextWindow < 0))
  ) {
    return;
  }

  state.jobTokenUsage = addTokenUsage(state.jobTokenUsage, usage.last);
  if (notification.threadId === state.threadId) {
    state.primaryThreadTokenUsage = {
      total: usage.total,
      last: usage.last,
      modelContextWindow: usage.modelContextWindow,
    };
  }
  if (state.jobTokenUsage && state.primaryThreadTokenUsage) {
    state.tokenUsage = {
      job: state.jobTokenUsage,
      thread: state.primaryThreadTokenUsage.total,
      modelContextWindow: state.primaryThreadTokenUsage.modelContextWindow,
    };
  }
}

export function summarizeUnifiedDiff(diff: string): UnifiedDiffSummary {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  let lineStart = 0;

  while (lineStart <= diff.length) {
    const newlineIndex = diff.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? diff.length : newlineIndex;

    if (diff.startsWith('diff --git ', lineStart)) {
      files += 1;
      inHunk = false;
    } else if (files > 0 && diff.startsWith('@@', lineStart)) {
      inHunk = true;
    } else if (inHunk && lineStart < lineEnd) {
      const firstCharacter = diff.charCodeAt(lineStart);
      if (firstCharacter === 43) {
        additions += 1;
      } else if (firstCharacter === 45) {
        deletions += 1;
      }
    }

    if (newlineIndex === -1) {
      break;
    }
    lineStart = newlineIndex + 1;
  }

  return { files, additions, deletions };
}

function sameDiffStats(left: UnifiedDiffSummary, right: UnifiedDiffSummary): boolean {
  return (
    left.files === right.files &&
    left.additions === right.additions &&
    left.deletions === right.deletions
  );
}

function recordTurnDiff(state: TurnCaptureState, params: unknown): void {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return;
  }
  const notification = params as {
    threadId?: unknown;
    turnId?: unknown;
    diff?: unknown;
  };
  if (
    typeof notification.threadId !== 'string' ||
    typeof notification.turnId !== 'string' ||
    state.threadTurnIds.get(notification.threadId) !== notification.turnId ||
    typeof notification.diff !== 'string'
  ) {
    return;
  }

  const nextStats = summarizeUnifiedDiff(notification.diff);
  if (sameDiffStats(state.diffStats, nextStats)) {
    return;
  }

  state.diffStats = nextStats;
  emitProgress(
    state.onProgress,
    `Diff: ${nextStats.files} files (+${nextStats.additions}/-${nextStats.deletions})`,
    'editing',
  );
}

function isPlanStepStatus(value: unknown): value is 'pending' | 'inProgress' | 'completed' {
  return value === 'pending' || value === 'inProgress' || value === 'completed';
}

function samePlanProgress(left: PlanProgressSnapshot | null, right: PlanProgressSnapshot): boolean {
  return (
    left !== null &&
    left.done === right.done &&
    left.total === right.total &&
    left.currentIndex === right.currentIndex &&
    left.currentText === right.currentText
  );
}

function recordTurnPlan(state: TurnCaptureState, params: unknown): void {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return;
  }
  const notification = params as {
    threadId?: unknown;
    turnId?: unknown;
    plan?: unknown;
  };
  if (
    typeof notification.threadId !== 'string' ||
    typeof notification.turnId !== 'string' ||
    state.threadTurnIds.get(notification.threadId) !== notification.turnId ||
    !Array.isArray(notification.plan)
  ) {
    return;
  }

  if (notification.plan.length === 0) {
    state.planProgress = null;
    return;
  }

  let done = 0;
  let inProgressIndex: number | null = null;
  let inProgressText: string | null = null;
  let pendingIndex: number | null = null;
  let pendingText: string | null = null;

  for (let index = 0; index < notification.plan.length; index += 1) {
    const value = notification.plan[index];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return;
    }
    const step = value as { step?: unknown; status?: unknown };
    if (typeof step.step !== 'string' || !isPlanStepStatus(step.status)) {
      return;
    }

    if (step.status === 'completed') {
      done += 1;
    } else if (step.status === 'inProgress' && inProgressIndex === null) {
      inProgressIndex = index;
      inProgressText = step.step;
    } else if (step.status === 'pending' && pendingIndex === null) {
      pendingIndex = index;
      pendingText = step.step;
    }
  }

  const total = notification.plan.length;
  const currentIndex = inProgressIndex ?? pendingIndex;
  const currentText = inProgressIndex !== null ? inProgressText : pendingText;
  const nextProgress: PlanProgressSnapshot = {
    done,
    total,
    currentIndex,
    currentText,
  };
  if (samePlanProgress(state.planProgress, nextProgress)) {
    return;
  }

  state.planProgress = nextProgress;
  if (currentIndex !== null && currentText !== null) {
    emitProgress(
      state.onProgress,
      `Step ${currentIndex + 1}/${total}: ${shorten(currentText, 96)}`,
    );
    return;
  }

  if (done === total) {
    emitProgress(state.onProgress, `Plan complete: ${total}/${total} steps`);
  }
}

export function clearCompletionTimer(state: TurnCaptureState): void {
  if (state.completionTimer) {
    state.timer.clearTimeoutImpl(state.completionTimer);
    state.completionTimer = null;
  }
}

export function completeTurn(
  state: TurnCaptureState,
  turn: Turn | null = null,
  options: { inferred?: boolean } = {},
): void {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    // Complete synthetic (no cast): a consumer reading items/error/timestamps
    // on an inferred completion gets honest empty values, not undefined.
    state.finalTurn = {
      id: state.turnId ?? 'inferred-turn',
      status: 'completed',
      items: [],
      itemsView: 'notLoaded',
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    };
  }

  if (options.inferred) {
    emitProgress(
      state.onProgress,
      'Turn completion inferred after the main thread finished and subagent work drained.',
      'finalizing',
    );
  }

  state.resolveCompletion(state);
}

export function scheduleInferredCompletion(state: TurnCaptureState): void {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  const handle = state.timer.setTimeoutImpl(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    state.inferredCompletion = true;
    completeTurn(state, null, { inferred: true });
  }, state.timer.inferredCompletionDelayMs);
  handle.unref?.();
  state.completionTimer = handle;
}

export function belongsToTurn(state: TurnCaptureState, message: AppServerNotification): boolean {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(
  state: TurnCaptureState,
  item: ThreadItem,
  lifecycle: string,
  threadId: string | null = null,
): void {
  if (item.type === 'collabAgentToolCall') {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === 'started' || item.status === 'inProgress') {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === 'completed') {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === 'agentMessage') {
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        if (lifecycle === 'completed') {
          state.lastAgentMessage = item.text;
        }
        if (lifecycle === 'completed' && item.phase === 'final_answer') {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === 'completed') {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel
            ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}`
            : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === 'final_answer' ? 'finalizing' : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : 'Assistant message',
          logBody: item.text,
        });
      }
    }
    return;
  }

  if (item.type === 'exitedReviewMode') {
    state.reviewText = item.review ?? '';
    if (lifecycle === 'completed' && item.review) {
      emitLogEvent(state.onProgress, {
        message: 'Review output captured.',
        stderrMessage: null,
        phase: 'finalizing',
        logTitle: 'Review output',
        logBody: item.review,
      });
    }
    return;
  }

  if (item.type === 'reasoning' && lifecycle === 'completed') {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : 'Reasoning summary',
        logBody: nextSections.map((section) => `- ${section}`).join('\n'),
      });
    }
    return;
  }

  if (item.type === 'fileChange' && lifecycle === 'completed') {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === 'commandExecution' && lifecycle === 'completed') {
    state.commandExecutions.push(item);
  }
}

export function applyTurnNotification(
  state: TurnCaptureState,
  message: AppServerNotification,
): void {
  switch (message.method) {
    case 'thread/started':
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole,
      });
      break;
    case 'thread/name/updated':
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null,
      });
      break;
    case 'turn/started':
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        'starting',
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null,
            }
          : {},
      );
      break;
    case 'thread/tokenUsage/updated':
      recordTokenUsage(state, message.params);
      break;
    case 'turn/diff/updated':
      recordTurnDiff(state, message.params);
      break;
    case 'turn/plan/updated':
      recordTurnPlan(state, message.params);
      break;
    case 'item/started':
      recordItem(state, message.params.item, 'started', message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case 'item/completed':
      recordItem(state, message.params.item, 'completed', message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case 'error':
      state.error = message.params.error;
      emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, 'failed');
      break;
    case 'turn/completed':
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === 'completed' ? 'completed' : message.params.turn.status}.`,
        'finalizing',
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

export interface CaptureTurnOptions<R> extends TurnCaptureStateOptions {
  onResponse?: (response: R, state: TurnCaptureState) => void;
  inactivityTimeoutMs?: number;
}

export async function captureTurn<R extends { turn?: Turn | null }>(
  client: AppServerClient,
  threadId: string,
  startRequest: () => Promise<R>,
  options: CaptureTurnOptions<R> = {},
): Promise<TurnCaptureState> {
  const state = createTurnCaptureState(threadId, options);
  void state.completion.catch(() => {});
  const previousHandler = client.notificationHandler;
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? resolveTurnInactivityTimeoutMs();
  let inactivityTimer: unknown | null = null;

  const clearInactivityTimer = (): void => {
    if (inactivityTimer) {
      state.timer.clearTimeoutImpl(inactivityTimer);
      inactivityTimer = null;
    }
  };
  const armInactivityTimer = (): void => {
    clearInactivityTimer();
    if (inactivityTimeoutMs <= 0 || state.completed) {
      return;
    }
    inactivityTimer = state.timer.setTimeoutImpl(() => {
      inactivityTimer = null;
      // This rejection follows the existing runAppServerTurn/runTrackedJob
      // failure path, which releases reservations and persists a failed job.
      state.rejectCompletion(
        new Error(
          `codex app-server sent no turn activity for ${inactivityTimeoutMs}ms; the turn was abandoned. Check /stereo:status and rerun.`,
        ),
      );
    }, inactivityTimeoutMs);
    (inactivityTimer as { unref?: () => void }).unref?.();
  };

  const dispatchNotification = (message: AppServerNotification): void => {
    // Applied unconditionally for the buffered replay too (deliberate): the
    // broker is single-flight, so a thread/started that is not ours cannot
    // interleave with a captured turn on this client.
    if (message.method === 'thread/started' || message.method === 'thread/name/updated') {
      applyTurnNotification(state, message);
      armInactivityTimer();
      return;
    }

    if (!belongsToTurn(state, message)) {
      if (previousHandler) {
        previousHandler(message);
      }
      return;
    }

    applyTurnNotification(state, message);
    armInactivityTimer();
  };

  // Buffer only until the start response has been processed — keying this on
  // state.turnId would buffer forever when a start response carries no
  // turn.id (belongsToTurn then matches by thread membership alone).
  let startProcessed = false;
  const dispatchNotificationSafely = (message: AppServerNotification): void => {
    try {
      dispatchNotification(message);
    } catch (error) {
      // A malformed notification must not throw through the transport's
      // line handler (an uncaught exception); record it and keep going.
      // Deliberately not state.error: that field carries Codex-reported
      // turn failures and would flip the run's status.
      const detail = error instanceof Error ? error.message : String(error);
      state.droppedNotifications += 1;
      if (state.notificationErrors.length < MAX_NOTIFICATION_ERROR_SAMPLES) {
        state.notificationErrors.push({ method: message?.method ?? null, message: detail });
      }
      emitProgress(
        state.onProgress,
        `Ignoring malformed ${message?.method ?? 'unknown'} notification: ${detail}`,
      );
    }
  };
  client.setNotificationHandler((message) => {
    if (!startProcessed) {
      state.bufferedNotifications.push(message);
      return;
    }

    dispatchNotificationSafely(message);
  });

  const buildConnectionClosedError = (): Error => {
    const detail = client.exitError?.message ? `: ${client.exitError.message}` : '';
    return new Error(`codex app-server connection closed before the turn completed${detail}`, {
      cause: client.exitError ?? undefined,
    });
  };
  const connectionExit: Promise<never> = client.exitPromise.then(() => {
    throw buildConnectionClosedError();
  });
  const start = Promise.resolve()
    .then(startRequest)
    .catch((error) => {
      if (client.exitResolved) {
        throw buildConnectionClosedError();
      }
      throw error;
    });

  try {
    const response = await Promise.race([start, connectionExit]);
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    startProcessed = true;
    const buffered = [...state.bufferedNotifications];
    state.bufferedNotifications.length = 0;
    for (const message of buffered) {
      dispatchNotificationSafely(message);
    }
    armInactivityTimer();

    if (response.turn?.status && response.turn.status !== 'inProgress') {
      completeTurn(state, response.turn);
    }

    return await Promise.race([state.completion, connectionExit]);
  } finally {
    clearCompletionTimer(state);
    clearInactivityTimer();
    client.setNotificationHandler(previousHandler ?? null);
  }
}

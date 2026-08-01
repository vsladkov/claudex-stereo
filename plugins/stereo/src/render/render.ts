import { describeStrandedReservation } from '../runtime/reservations.ts';
import type { StrandedReservationEntry } from '../runtime/reservations.ts';
import { formatJobModel, resolveJobModel } from '../jobs/job-control.ts';
import type { SessionJobAnnouncement } from '../jobs/job-announcements.ts';
import type { RoleDefaultEntry } from '../models/role-defaults.ts';

// Renderer inputs are typed from usage: jobs and stored payloads come from
// state files written across plugin versions, so every field beyond the id is
// treated as optional and read defensively.
export interface RenderableJob {
  id: string;
  status?: string | null;
  kindLabel?: string | null;
  title?: string | null;
  summary?: string | null;
  phase?: string | null;
  elapsed?: string | null;
  duration?: string | null;
  threadId?: string | null;
  logFile?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  jobClass?: string | null;
  write?: boolean | null;
  errorMessage?: string | null;
  progressPreview?: string[] | null;
  model?: string | null;
  modelDisplay?: string | null;
  tokenUsage?: unknown;
}

export interface ParsedResultLike {
  parsed?: unknown;
  parseError?: string | null;
  rawOutput?: string | null;
  reasoningSummary?: string[] | null;
}

export interface ReviewRenderMeta {
  reviewLabel: string;
  targetLabel: string;
  reasoningSummary?: string[] | null;
}

export interface PlanReviewRenderMeta {
  round?: number;
  reasoningSummary?: string[] | null;
}

export interface StoredPairPlanState {
  plan?: unknown;
  threadId?: unknown;
  model?: unknown;
  effort?: unknown;
  round?: unknown;
  verdict?: unknown;
  updatedAt?: unknown;
  implementedAt?: unknown;
  findings?: unknown;
  openQuestions?: unknown;
  residualRisks?: unknown;
  [key: string]: unknown;
}

export interface NativeReviewRenderResult {
  status?: number | null;
  stdout: string;
  stderr: string;
}

export interface TaskRenderMeta {
  write?: boolean | null;
  touchedFiles?: unknown;
  // Accepted from the task workflow for parity with its payloads; the task
  // rendering itself does not use them.
  title?: string | null;
  jobId?: string | null;
}

export interface StoredJobResultLike {
  rawOutput?: unknown;
  parseError?: unknown;
  result?: unknown;
  codex?: { stdout?: unknown; [key: string]: unknown } | null;
  [key: string]: unknown;
}

export interface StoredJobLike {
  threadId?: string | null;
  jobClass?: string | null;
  rendered?: string | null;
  errorMessage?: string | null;
  model?: unknown;
  request?: unknown;
  result?: StoredJobResultLike | null;
  tokenUsage?: unknown;
}

export interface SetupProviderAlias {
  alias: string;
  model: string;
  providerId: string;
  configured: boolean;
  envKey: string | null;
  keySet: boolean | null;
}

export interface SetupConfiguredProvider {
  id: string;
  envKey: string | null;
  keySet: boolean | null;
}

export interface SetupRenderReport {
  ready: boolean;
  node: { detail: string };
  nodeEngine?: { supported: boolean; detail: string } | null;
  npm: { detail: string };
  codex: { detail: string };
  writeSandbox?: { available: boolean | null; detail: string } | null;
  auth: { detail: string };
  rateLimits?: unknown;
  providers: {
    active: string | null;
    configured: SetupConfiguredProvider[];
    aliases: SetupProviderAlias[];
  };
  sessionRuntime: { label: string };
  strandedReservations?: StrandedReservationEntry[] | null;
  reviewGateEnabled?: boolean | null;
  roleDefaults?: RoleDefaultEntry[] | null;
  actionsTaken: string[];
  nextSteps: string[];
}

export interface ConfigRenderReport {
  roleDefaults: RoleDefaultEntry[];
  actionsTaken: string[];
  warnings: string[];
}

interface RateLimitWindowLike {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface RateLimitSnapshotLike {
  limitId?: unknown;
  limitName?: unknown;
  primary?: unknown;
  secondary?: unknown;
  planType?: unknown;
  spendControlReached?: unknown;
  rateLimitReachedType?: unknown;
}

export interface StatusRenderReport {
  sessionRuntime: { label: string };
  config: { stopReviewGate?: unknown };
  strandedReservations?: StrandedReservationEntry[] | null;
  running: RenderableJob[];
  latestFinished?: RenderableJob | null;
  recent: RenderableJob[];
  needsReview?: boolean | null;
}

export interface StatusRenderOptions {
  verbose?: boolean;
}

export interface JobStatusRenderOptions {
  verbose?: boolean;
  waitTimedOut?: boolean;
  timeoutMs?: number | null;
  strandedReservations?: StrandedReservationEntry[] | null;
}

interface JobDetailOptions {
  showElapsed?: boolean;
  showDuration?: boolean;
  showTimestamps?: boolean;
  showLog?: boolean;
  showCancelHint?: boolean;
  showResultHint?: boolean;
  showReviewHint?: boolean;
  showProgress?: boolean;
}

interface NormalizedReviewFinding {
  severity: string;
  title: string;
  body: string;
  file: string;
  line_start: number | null;
  line_end: number | null;
  confidence: number | null;
  recommendation: string;
}

interface ReviewResultShape {
  verdict: string;
  summary: string;
  findings: unknown[];
  next_steps: unknown[];
}

interface NormalizedPlanReviewFinding {
  severity: string;
  title: string;
  body: string;
  section: string;
  confidence: number | null;
  recommendation: string;
}

interface PlanReviewResultShape {
  verdict: string;
  summary: string;
  findings: unknown[];
  revision_instructions: unknown[];
  open_questions: unknown[];
  residual_risks?: unknown;
}

function severityRank(severity: string): number {
  switch (severity) {
    case 'critical':
      return 0;
    case 'high':
      return 1;
    case 'medium':
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding: NormalizedReviewFinding): string {
  if (!finding.line_start) {
    return '';
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function validateReviewResultShape(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'Expected a top-level JSON object.';
  }
  const shape = data as Record<string, unknown>;
  if (typeof shape.verdict !== 'string' || !shape.verdict.trim()) {
    return 'Missing string `verdict`.';
  }
  if (typeof shape.summary !== 'string' || !shape.summary.trim()) {
    return 'Missing string `summary`.';
  }
  if (!Array.isArray(shape.findings)) {
    return 'Missing array `findings`.';
  }
  if (!Array.isArray(shape.next_steps)) {
    return 'Missing array `next_steps`.';
  }
  return null;
}

function normalizeReviewFinding(finding: unknown, index: number): NormalizedReviewFinding {
  const source = (
    finding && typeof finding === 'object' && !Array.isArray(finding) ? finding : {}
  ) as Record<string, unknown>;
  const lineStart =
    Number.isInteger(source.line_start) && (source.line_start as number) > 0
      ? (source.line_start as number)
      : null;
  const lineEnd =
    Number.isInteger(source.line_end) &&
    (source.line_end as number) > 0 &&
    (!lineStart || (source.line_end as number) >= lineStart)
      ? (source.line_end as number)
      : lineStart;

  return {
    severity:
      typeof source.severity === 'string' && source.severity.trim()
        ? source.severity.trim()
        : 'low',
    title:
      typeof source.title === 'string' && source.title.trim()
        ? source.title.trim()
        : `Finding ${index + 1}`,
    body:
      typeof source.body === 'string' && source.body.trim()
        ? source.body.trim()
        : 'No details provided.',
    file: typeof source.file === 'string' && source.file.trim() ? source.file.trim() : 'unknown',
    line_start: lineStart,
    line_end: lineEnd,
    confidence: Number.isFinite(source.confidence)
      ? Math.min(1, Math.max(0, source.confidence as number))
      : null,
    recommendation: typeof source.recommendation === 'string' ? source.recommendation.trim() : '',
  };
}

function normalizeReviewResultData(data: ReviewResultShape): {
  verdict: string;
  summary: string;
  findings: NormalizedReviewFinding[];
  next_steps: string[];
} {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step): step is string => typeof step === 'string' && Boolean(step.trim()))
      .map((step) => step.trim()),
  };
}

// Tolerant-reader policy: the JSON schema sent to Codex marks residual_risks
// as required (so the model always emits it), but this validator deliberately
// does not — stored results from before the field existed must keep rendering.
function validatePlanReviewResultShape(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'Expected a top-level JSON object.';
  }
  const shape = data as Record<string, unknown>;
  if (typeof shape.verdict !== 'string' || !shape.verdict.trim()) {
    return 'Missing string `verdict`.';
  }
  if (typeof shape.summary !== 'string' || !shape.summary.trim()) {
    return 'Missing string `summary`.';
  }
  if (!Array.isArray(shape.findings)) {
    return 'Missing array `findings`.';
  }
  if (!Array.isArray(shape.revision_instructions)) {
    return 'Missing array `revision_instructions`.';
  }
  if (!Array.isArray(shape.open_questions)) {
    return 'Missing array `open_questions`.';
  }
  return null;
}

function normalizePlanReviewFinding(finding: unknown, index: number): NormalizedPlanReviewFinding {
  const source = (
    finding && typeof finding === 'object' && !Array.isArray(finding) ? finding : {}
  ) as Record<string, unknown>;
  return {
    severity:
      typeof source.severity === 'string' && source.severity.trim()
        ? source.severity.trim()
        : 'low',
    title:
      typeof source.title === 'string' && source.title.trim()
        ? source.title.trim()
        : `Finding ${index + 1}`,
    body:
      typeof source.body === 'string' && source.body.trim()
        ? source.body.trim()
        : 'No details provided.',
    section:
      typeof source.section === 'string' && source.section.trim()
        ? source.section.trim()
        : 'general',
    confidence: Number.isFinite(source.confidence)
      ? Math.min(1, Math.max(0, source.confidence as number))
      : null,
    recommendation: typeof source.recommendation === 'string' ? source.recommendation.trim() : '',
  };
}

function normalizePlanReviewResultData(data: PlanReviewResultShape): {
  verdict: string;
  summary: string;
  findings: NormalizedPlanReviewFinding[];
  revision_instructions: string[];
  open_questions: string[];
  residual_risks: string[];
} {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizePlanReviewFinding(finding, index)),
    revision_instructions: data.revision_instructions
      .filter(
        (instruction): instruction is string =>
          typeof instruction === 'string' && Boolean(instruction.trim()),
      )
      .map((instruction) => instruction.trim()),
    open_questions: data.open_questions
      .filter(
        (question): question is string => typeof question === 'string' && Boolean(question.trim()),
      )
      .map((question) => question.trim()),
    residual_risks: (Array.isArray(data.residual_risks) ? data.residual_risks : [])
      .filter((risk): risk is string => typeof risk === 'string' && Boolean(risk.trim()))
      .map((risk) => risk.trim()),
  };
}

function isStructuredReviewStoredResult(storedJob: StoredJobLike | null | undefined): boolean {
  const result = storedJob?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, 'result') ||
    Object.prototype.hasOwnProperty.call(result, 'parseError')
  );
}

function formatJobLine(job: RenderableJob): string {
  const parts = [job.id, `${job.status || 'unknown'}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(' | ');
}

function escapeMarkdownCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function formatCodexResumeCommand(job: RenderableJob | null | undefined): string | null {
  if (!job?.threadId) {
    return null;
  }
  return `codex resume ${job.threadId}`;
}

function finiteNonnegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function formatCompactTokenCount(value: number): string {
  const units = [
    { threshold: 1_000_000_000, suffix: 'G' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'K' },
  ];
  for (const unit of units) {
    if (value < unit.threshold) {
      continue;
    }
    const scaled = value / unit.threshold;
    const precision = scaled >= 10 ? 0 : 1;
    return `${scaled.toFixed(precision).replace(/\.0$/, '')}${unit.suffix}`;
  }
  return String(Math.round(value));
}

function formatUsageBreakdown(value: unknown, includeCache = false): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const usage = value as Record<string, unknown>;
  const input = finiteNonnegativeNumber(usage.inputTokens);
  const cachedInput = finiteNonnegativeNumber(usage.cachedInputTokens);
  const output = finiteNonnegativeNumber(usage.outputTokens);
  const reasoning = finiteNonnegativeNumber(usage.reasoningOutputTokens);
  const total = finiteNonnegativeNumber(usage.totalTokens);
  const parts: string[] = [];
  if (input !== null) {
    let inputText = `${formatCompactTokenCount(input)} in`;
    if (includeCache && cachedInput !== null && input > 0) {
      inputText += ` (${Math.round((cachedInput / input) * 100)}% cached)`;
    }
    parts.push(inputText);
  }
  if (output !== null) {
    let outputText = `${formatCompactTokenCount(output)} out`;
    if (reasoning !== null && reasoning > 0) {
      outputText += ` (${formatCompactTokenCount(reasoning)} reasoning)`;
    }
    parts.push(outputText);
  }
  if (parts.length === 0 && total !== null) {
    parts.push(`${formatCompactTokenCount(total)} total`);
  }
  return parts.length > 0 ? parts.join(' / ') : null;
}

export function formatTokenUsage(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const usage = value as Record<string, unknown>;
  const job = formatUsageBreakdown(usage.job, true);
  const thread = formatUsageBreakdown(usage.thread);
  const context = finiteNonnegativeNumber(usage.modelContextWindow);
  const segments: string[] = [];
  if (job) {
    segments.push(`job ${job}`);
  }
  if (thread) {
    segments.push(`thread ${thread}`);
  }
  if (context !== null) {
    segments.push(`context ${formatCompactTokenCount(context)}`);
  }
  return segments.length > 0 ? `Tokens: ${segments.join(' · ')}` : null;
}

function appendActiveJobsTable(lines: string[], jobs: RenderableJob[]): void {
  lines.push('Active jobs:');
  lines.push(
    '| Job | Kind | Model | Status | Phase | Elapsed | Codex Session ID | Summary | Actions |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const job of jobs) {
    const actions = [`/stereo:status ${job.id}`];
    if (job.status === 'queued' || job.status === 'running') {
      actions.push(`/stereo:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.modelDisplay ?? '-')} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? '')} | ${escapeMarkdownCell(job.elapsed ?? '')} | ${escapeMarkdownCell(job.threadId ?? '')} | ${escapeMarkdownCell(job.summary ?? '')} | ${actions.map((action) => `\`${action}\``).join('<br>')} |`,
    );
  }
}

function pushJobDetails(lines: string[], job: RenderableJob, options: JobDetailOptions = {}): void {
  lines.push(`- ${formatJobLine(job)}`);
  lines.push(`  Model: ${job.modelDisplay ?? '-'}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (options.showTimestamps) {
    if (typeof job.createdAt === 'string' && job.createdAt) {
      lines.push(`  Created: ${job.createdAt}`);
    }
    if (typeof job.startedAt === 'string' && job.startedAt) {
      lines.push(`  Started: ${job.startedAt}`);
    }
    if (typeof job.completedAt === 'string' && job.completedAt) {
      lines.push(`  Completed: ${job.completedAt}`);
    }
  }
  if (job.threadId) {
    lines.push(`  Codex session ID: ${job.threadId}`);
  }
  const tokenUsage = formatTokenUsage(job.tokenUsage);
  if (tokenUsage) {
    lines.push(`  ${tokenUsage}`);
  }
  const resumeCommand = formatCodexResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Codex: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === 'queued' || job.status === 'running') && options.showCancelHint) {
    lines.push(`  Cancel: /stereo:cancel ${job.id}`);
  }
  if (job.status !== 'queued' && job.status !== 'running' && options.showResultHint) {
    lines.push(`  Result: /stereo:result ${job.id}`);
  }
  if (
    job.status !== 'queued' &&
    job.status !== 'running' &&
    job.jobClass === 'task' &&
    job.write &&
    options.showReviewHint
  ) {
    lines.push('  Review changes: /stereo:review --wait');
    lines.push('  Stricter review: /stereo:adversarial-review --wait');
  }
  if ((options.showProgress ?? true) && job.progressPreview?.length) {
    lines.push('  Progress:');
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

function appendReasoningSection(
  lines: string[],
  reasoningSummary: string[] | null | undefined,
): void {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push('', 'Reasoning:');
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

function storedPlanMetadataValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() || null;
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

function storedPlanList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    .map((entry) => entry.trim());
}

function storedPlanFindings(value: unknown): NormalizedPlanReviewFinding[] {
  return Array.isArray(value)
    ? value.map((finding, index) => normalizePlanReviewFinding(finding, index))
    : [];
}

export function renderStoredPlanState(record: StoredPairPlanState | null): string {
  if (!record) {
    return 'No stored plan for this repository. Run /stereo:plan first.\n';
  }

  const verdict = storedPlanMetadataValue(record.verdict) ?? 'unknown';
  const round = storedPlanMetadataValue(record.round);
  const updatedAt = storedPlanMetadataValue(record.updatedAt);
  const headerParts = [`verdict: ${verdict}`];
  if (round) {
    headerParts.push(`round ${round}`);
  }
  if (updatedAt) {
    headerParts.push(`updated ${updatedAt}`);
  }

  const lines = [`Stored plan (${headerParts.join(', ')})`];
  const model = storedPlanMetadataValue(record.model);
  const effort = storedPlanMetadataValue(record.effort);
  const threadId = storedPlanMetadataValue(record.threadId);
  const runtimeParts: string[] = [];
  if (model) {
    runtimeParts.push(`Model: ${model}${effort ? `@${effort}` : ''}`);
  } else if (effort) {
    runtimeParts.push(`Effort: ${effort}`);
  }
  if (threadId) {
    runtimeParts.push(`Thread: ${threadId}`);
  }
  if (runtimeParts.length > 0) {
    lines.push(runtimeParts.join(' · '));
  }
  const implementedAt = storedPlanMetadataValue(record.implementedAt);
  if (implementedAt) {
    lines.push(`Implemented: ${implementedAt}`);
  }

  const findings = storedPlanFindings(record.findings);
  if (findings.length > 0) {
    lines.push(
      `Findings (${findings.length}):`,
      ...findings.map((finding) => `- ${finding.severity}: ${finding.title}`),
    );
  }

  const openQuestions = storedPlanList(record.openQuestions);
  if (openQuestions.length === 0) {
    lines.push('Open questions: none');
  } else {
    lines.push('Open questions:', ...openQuestions.map((question) => `- ${question}`));
  }

  const residualRisks = storedPlanList(record.residualRisks);
  if (residualRisks.length === 0) {
    lines.push('Residual risks: none');
  } else {
    lines.push('Residual risks:', ...residualRisks.map((risk) => `- ${risk}`));
  }

  const plan = typeof record.plan === 'string' ? record.plan : '(plan text missing)';
  const output = `${lines.join('\n')}\n\n---\n\n${plan}`;
  return output.endsWith('\n') ? output : `${output}\n`;
}

export function renderConfigReport(report: ConfigRenderReport): string {
  const lines = ['# Stereo Config', '', 'Role defaults:'];
  for (const entry of report.roleDefaults) {
    const effort = entry.effort ? ` (effort ${entry.effort})` : '';
    const invalid = entry.invalidReason ? ' [invalid]' : '';
    lines.push(`- ${entry.flag}: ${entry.model ?? 'not set'}${effort}${invalid}`);
  }

  if (report.actionsTaken.length > 0) {
    lines.push('', 'Actions taken:', ...report.actionsTaken.map((action) => `- ${action}`));
  }
  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:', ...report.warnings.map((warning) => `- ${warning}`));
  }
  lines.push('', 'Use `/stereo:config --clear roles` to clear all workspace role defaults.');
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderSessionJobAnnouncement(announcement: SessionJobAnnouncement): string {
  const workspaceRoot = announcement.workspaceRoot ?? 'this workspace';
  const lines = [`Stereo background jobs in ${workspaceRoot}:`];
  if (announcement.active.length > 0) {
    const activeCount = announcement.active.length + announcement.activeOverflow;
    const activeJobs = announcement.active
      .map((job) => `${job.id} ${job.kind} ${job.elapsed ?? 'elapsed unknown'}`)
      .join('; ');
    const overflow =
      announcement.activeOverflow > 0 ? ` (+${announcement.activeOverflow} more)` : '';
    lines.push(`- Active (${activeCount}): ${activeJobs}${overflow}`);
  }
  if (announcement.finished.length > 0) {
    const finishedCount = announcement.finished.length + announcement.finishedOverflow;
    const finishedJobs = announcement.finished
      .map((job) =>
        job.duration
          ? `${job.id} ${job.kind} ${job.status} in ${job.duration}`
          : `${job.id} ${job.kind} ${job.status} elapsed unknown`,
      )
      .join('; ');
    const overflow =
      announcement.finishedOverflow > 0 ? ` (+${announcement.finishedOverflow} more)` : '';
    lines.push(`- Finished since your last session (${finishedCount}): ${finishedJobs}${overflow}`);
  }
  lines.push(
    'Run /stereo:status for details, /stereo:result <id> for output, /stereo:cancel <id> to stop one.',
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

function appendStrandedReservationWarnings(
  lines: string[],
  entries: StrandedReservationEntry[] | null | undefined,
): void {
  if (!Array.isArray(entries) || entries.length === 0) {
    return;
  }
  if (lines.at(-1) !== '') {
    lines.push('');
  }
  lines.push('Warnings:');
  for (const entry of entries) {
    lines.push(`- ${describeStrandedReservation(entry)}`);
  }
  lines.push('');
}

function formatRateLimitDuration(minutesValue: unknown): string | null {
  const minutes = finiteNonnegativeNumber(minutesValue);
  if (minutes === null) {
    return null;
  }
  if (minutes >= 1440 && minutes % 1440 === 0) {
    return `${minutes / 1440}d`;
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${minutes}m`;
}

function formatRateLimitReset(value: unknown): string | null {
  const epochSeconds = finiteNonnegativeNumber(value);
  if (epochSeconds === null) {
    return null;
  }
  const date = new Date(epochSeconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function formatRateLimitWindow(label: string, value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const window = value as RateLimitWindowLike;
  const usedPercent = finiteNonnegativeNumber(window.usedPercent);
  if (usedPercent === null) {
    return null;
  }
  const hints: string[] = [];
  const duration = formatRateLimitDuration(window.windowDurationMins);
  const reset = formatRateLimitReset(window.resetsAt);
  if (duration) {
    hints.push(`${duration} window`);
  }
  if (reset) {
    hints.push(`resets ${reset}`);
  }
  return `- ${label}: ${usedPercent}% used${hints.length > 0 ? ` (${hints.join(', ')})` : ''}`;
}

function rateLimitSnapshotLabel(value: RateLimitSnapshotLike, fallback: string): string {
  const limitName = typeof value.limitName === 'string' ? value.limitName.trim() : '';
  const limitId = typeof value.limitId === 'string' ? value.limitId.trim() : '';
  return limitName || limitId || fallback;
}

function appendRateLimitSnapshot(
  lines: string[],
  value: unknown,
  fallbackLabel: string,
  showPlan: boolean,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }
  const snapshot = value as RateLimitSnapshotLike;
  const label = rateLimitSnapshotLabel(snapshot, fallbackLabel);
  if (showPlan && typeof snapshot.planType === 'string' && snapshot.planType) {
    lines.push(`- Plan: ${snapshot.planType}`);
  }
  const primary = formatRateLimitWindow(`${label} primary`, snapshot.primary);
  const secondary = formatRateLimitWindow(`${label} secondary`, snapshot.secondary);
  if (primary) {
    lines.push(primary);
  }
  if (secondary) {
    lines.push(secondary);
  }
  if (snapshot.spendControlReached === true) {
    lines.push(`- Warning: ${label} spend control has been reached.`);
  }
  if (typeof snapshot.rateLimitReachedType === 'string' && snapshot.rateLimitReachedType.trim()) {
    lines.push(`- Warning: ${label} limit reached (${snapshot.rateLimitReachedType}).`);
  }
}

function appendRateLimits(lines: string[], value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }
  const start = lines.length;
  lines.push('Rate limits:');
  appendRateLimitSnapshot(lines, value, 'Account', true);
  const byLimitId = (value as { rateLimitsByLimitId?: unknown }).rateLimitsByLimitId;
  if (byLimitId && typeof byLimitId === 'object' && !Array.isArray(byLimitId)) {
    const primaryLimitId =
      typeof (value as RateLimitSnapshotLike).limitId === 'string'
        ? (value as RateLimitSnapshotLike).limitId
        : '';
    for (const [limitId, snapshot] of Object.entries(byLimitId)) {
      if (limitId === primaryLimitId) {
        continue;
      }
      appendRateLimitSnapshot(lines, snapshot, limitId, false);
    }
  }
  if (lines.length === start + 1) {
    lines.splice(start, 1);
    return;
  }
  lines.push('');
}

export function renderSetupReport(report: SetupRenderReport): string {
  const configuredProviderLines = report.providers.configured.map((provider) => {
    const aliases = report.providers.aliases
      .filter((entry) => entry.providerId === provider.id)
      .map((entry) => `codex:${entry.alias} → ${entry.model}`);
    const aliasSuffix = aliases.length > 0 ? ` (${aliases.join(', ')})` : '';
    const keyStatus = provider.envKey
      ? `${provider.envKey} ${provider.keySet ? 'set' : 'missing'}`
      : 'no env_key declared';
    return `- Custom provider ${provider.id}${aliasSuffix}: ${keyStatus}`;
  });
  const configuredRoleDefaults = (report.roleDefaults ?? []).filter(
    (entry) => entry.model || entry.effort,
  );
  const roleDefaultsSummary =
    configuredRoleDefaults.length === 0
      ? 'none configured'
      : `${configuredRoleDefaults.length} configured (${configuredRoleDefaults
          .map(
            (entry) =>
              `${entry.flag}=${entry.model ?? 'model not set'}${
                entry.effort ? ` (effort ${entry.effort})` : ''
              }`,
          )
          .join(', ')})`;
  const lines = [
    '# Codex Setup',
    '',
    `Status: ${report.ready ? 'ready' : 'needs attention'}`,
    '',
    'Checks:',
    `- node: ${report.node.detail}`,
    ...(report.nodeEngine ? [`- node engine: ${report.nodeEngine.detail}`] : []),
    `- npm: ${report.npm.detail}`,
    `- codex: ${report.codex.detail}`,
    ...(report.writeSandbox
      ? [
          `- write sandbox: ${
            report.writeSandbox.available === true
              ? 'ok'
              : report.writeSandbox.available === false
                ? `blocked (${report.writeSandbox.detail})`
                : report.writeSandbox.detail
          }`,
        ]
      : []),
    `- auth: ${report.auth.detail}`,
    `- Model provider: ${report.providers.active ?? 'unknown'} (default)`,
    ...configuredProviderLines,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- thread reservations: ${
      Array.isArray(report.strandedReservations) && report.strandedReservations.length > 0
        ? `${report.strandedReservations.length} stranded (see next steps)`
        : 'none stranded'
    }`,
    `- review gate: ${report.reviewGateEnabled ? 'enabled' : 'disabled'}`,
    `- role defaults: ${roleDefaultsSummary}`,
    '',
  ];

  appendRateLimits(lines, report.rateLimits);

  if (report.actionsTaken.length > 0) {
    lines.push('Actions taken:');
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push('');
  }

  if (report.nextSteps.length > 0) {
    lines.push('Next steps:');
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderReviewResult(parsedResult: ParsedResultLike, meta: ReviewRenderMeta): string {
  if (!parsedResult.parsed) {
    const lines = [
      `# Codex ${meta.reviewLabel}`,
      '',
      `Target: ${meta.targetLabel}`,
      'Codex did not return valid structured JSON.',
      '',
      `- Parse error: ${parsedResult.parseError}`,
    ];

    if (parsedResult.rawOutput) {
      lines.push('', 'Raw final message:', '', ...fencedBlock(parsedResult.rawOutput));
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join('\n').trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Codex ${meta.reviewLabel}`,
      '',
      `Target: ${meta.targetLabel}`,
      'Codex returned JSON with an unexpected review shape.',
      '',
      `- Validation error: ${validationError}`,
    ];

    if (parsedResult.rawOutput) {
      lines.push('', 'Raw final message:', '', ...fencedBlock(parsedResult.rawOutput));
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join('\n').trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed as ReviewResultShape);
  const findings = [...data.findings].sort(
    (left, right) => severityRank(left.severity) - severityRank(right.severity),
  );
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    '',
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    '',
    data.summary,
    '',
  ];

  if (findings.length === 0) {
    lines.push('No material findings.');
  } else {
    lines.push('Findings:');
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      const severityLabel =
        finding.confidence != null
          ? `${finding.severity}, confidence ${finding.confidence}`
          : finding.severity;
      lines.push(`- [${severityLabel}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push('', 'Next steps:');
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderPlanReviewResult(
  parsedResult: ParsedResultLike,
  meta: PlanReviewRenderMeta = {},
): string {
  const heading =
    (meta.round as number) > 1
      ? `# Codex Plan Review (round ${meta.round})`
      : '# Codex Plan Review';
  if (!parsedResult.parsed) {
    const lines = [
      heading,
      '',
      'Codex did not return valid structured JSON.',
      '',
      `- Parse error: ${parsedResult.parseError}`,
    ];

    if (parsedResult.rawOutput) {
      lines.push('', 'Raw final message:', '', ...fencedBlock(parsedResult.rawOutput));
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join('\n').trimEnd()}\n`;
  }

  const validationError = validatePlanReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      heading,
      '',
      'Codex returned JSON with an unexpected plan-review shape.',
      '',
      `- Validation error: ${validationError}`,
    ];

    if (parsedResult.rawOutput) {
      lines.push('', 'Raw final message:', '', ...fencedBlock(parsedResult.rawOutput));
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join('\n').trimEnd()}\n`;
  }

  const data = normalizePlanReviewResultData(parsedResult.parsed as PlanReviewResultShape);
  const findings = [...data.findings].sort(
    (left, right) => severityRank(left.severity) - severityRank(right.severity),
  );
  const lines = [heading, '', `Verdict: ${data.verdict}`, '', data.summary, ''];

  if (findings.length === 0) {
    lines.push('No material findings.');
  } else {
    lines.push('Findings:');
    for (const finding of findings) {
      const severityLabel =
        finding.confidence != null
          ? `${finding.severity}, confidence ${finding.confidence}`
          : finding.severity;
      lines.push(`- [${severityLabel}] ${finding.title} (${finding.section})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.revision_instructions.length > 0) {
    lines.push('', 'Revision instructions:');
    data.revision_instructions.forEach((instruction, index) => {
      lines.push(`${index + 1}. ${instruction}`);
    });
  }

  if (data.open_questions.length > 0) {
    lines.push('', 'Open questions:');
    for (const question of data.open_questions) {
      lines.push(`- ${question}`);
    }
  }

  if (data.residual_risks.length > 0) {
    lines.push('', 'Residual risks (non-blocking):');
    for (const risk of data.residual_risks) {
      lines.push(`- ${risk}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderNativeReviewResult(
  result: NativeReviewRenderResult,
  meta: ReviewRenderMeta,
): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [`# Codex ${meta.reviewLabel}`, '', `Target: ${meta.targetLabel}`, ''];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push('Codex review completed without any stdout output.');
  } else {
    lines.push('Codex review failed.');
  }

  if (stderr) {
    lines.push('', 'stderr:', '', ...fencedBlock(stderr));
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderTaskResult(
  parsedResult:
    | { rawOutput?: unknown; failureMessage?: unknown; reasoningSummary?: string[] | null }
    | null
    | undefined,
  meta: TaskRenderMeta | null | undefined,
): string {
  const rawOutput = typeof parsedResult?.rawOutput === 'string' ? parsedResult.rawOutput : '';
  if (rawOutput) {
    const output = rawOutput.endsWith('\n') ? rawOutput : `${rawOutput}\n`;
    if (meta?.write && Array.isArray(meta.touchedFiles) && meta.touchedFiles.length === 0) {
      return `${output}\nNote: this write-capable run reported no file changes.\n`;
    }
    return output;
  }

  const message =
    String(parsedResult?.failureMessage ?? '').trim() || 'Codex did not return a final message.';
  return `${message}\n`;
}

export function renderStatusReport(
  report: StatusRenderReport,
  options: StatusRenderOptions = {},
): string {
  const lines = [
    '# Codex Status',
    '',
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? 'enabled' : 'disabled'}`,
    '',
  ];

  appendStrandedReservationWarnings(lines, report.strandedReservations);

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push('');
    if (options.verbose) {
      lines.push('Live details:');
      for (const job of report.running) {
        pushJobDetails(lines, job, {
          showElapsed: true,
          showLog: true,
          showTimestamps: true,
        });
      }
      lines.push('');
    }
  }

  if (report.latestFinished) {
    lines.push('Latest finished:');
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: options.verbose || report.latestFinished.status === 'failed',
      showProgress: Boolean(options.verbose),
      ...(options.verbose ? { showTimestamps: true } : {}),
    });
    lines.push('');
  }

  if (report.recent.length > 0) {
    lines.push('Recent jobs:');
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: options.verbose || job.status === 'failed',
        showProgress: Boolean(options.verbose),
        ...(options.verbose ? { showTimestamps: true } : {}),
      });
    }
    lines.push('');
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push('No jobs recorded yet.', '');
  }

  if (report.needsReview) {
    lines.push('The stop-time review gate is enabled.');
    lines.push(
      "It runs a Codex review task over the previous Claude turn's changes and blocks if it finds issues.",
    );
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderJobStatusReport(
  job: RenderableJob,
  options: JobStatusRenderOptions = {},
): string {
  const lines = ['# Codex Job Status', ''];
  pushJobDetails(lines, job, {
    showElapsed: job.status === 'queued' || job.status === 'running',
    showDuration: job.status !== 'queued' && job.status !== 'running',
    showLog: true,
    ...(options.verbose ? { showTimestamps: true } : {}),
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true,
  });
  if (options.waitTimedOut) {
    lines.push(
      '',
      `Wait timed out after ${options.timeoutMs ?? 'the configured'} ms; the job is still ${job.status}.`,
    );
  }
  appendStrandedReservationWarnings(lines, options.strandedReservations);
  return `${lines.join('\n').trimEnd()}\n`;
}

function fencedBlock(text: string, lang = 'text'): string[] {
  // Untrusted output can contain backtick runs (```diff blocks in Codex
  // prose); size the fence one longer than the longest internal run so the
  // payload can never close the fence and inject live markdown.
  const longestRun = [...String(text ?? '').matchAll(/`+/g)].reduce(
    (max, match) => Math.max(max, match[0].length),
    0,
  );
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [`${fence}${lang}`, String(text ?? ''), fence];
}

function withResultFooter(
  text: string,
  threadId: string | null,
  modelDisplay: string,
  tokenUsage: unknown,
): string {
  const output = text.endsWith('\n') ? text : `${text}\n`;
  const footer = [`Model: ${modelDisplay}`];
  const tokenUsageLine = formatTokenUsage(tokenUsage);
  if (tokenUsageLine) {
    footer.push(tokenUsageLine);
  }
  if (threadId) {
    footer.push(`Codex session ID: ${threadId}`);
    footer.push(`Resume in Codex: codex resume ${threadId}`);
  }
  return `${output}\n${footer.join('\n')}\n`;
}

function appendStoredJobWarning(text: string, warning: string | null | undefined): string {
  if (!warning) {
    return text;
  }
  const output = text.endsWith('\n') ? text : `${text}\n`;
  return `${output}\nWarnings:\n- ${warning}\n`;
}

export function renderStoredJobResult(
  job: RenderableJob,
  storedJob: StoredJobLike | null | undefined,
  warning?: string | null,
): string {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const modelDisplay = job.modelDisplay ?? formatJobModel(resolveJobModel(job, storedJob));
  const renderWithFooter = (text: string): string =>
    withResultFooter(
      appendStoredJobWarning(text, warning),
      threadId,
      modelDisplay,
      storedJob?.tokenUsage ?? job.tokenUsage,
    );
  const taskClass = storedJob?.jobClass ?? job.jobClass ?? null;
  if (taskClass === 'task' && storedJob?.rendered) {
    return renderWithFooter(storedJob.rendered);
  }
  // Review-class jobs always prefer the stored rendering: native reviews
  // carry no result/parseError keys, so keying only on the structured shape
  // dropped their heading/Target/reasoning in favor of raw stdout.
  if (
    (taskClass === 'review' || isStructuredReviewStoredResult(storedJob)) &&
    storedJob?.rendered
  ) {
    return renderWithFooter(storedJob.rendered);
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === 'string' && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.codex?.stdout === 'string' && storedJob.result.codex.stdout) ||
    '';
  if (rawOutput) {
    return renderWithFooter(rawOutput);
  }

  if (storedJob?.rendered) {
    return renderWithFooter(storedJob.rendered);
  }

  const lines = [`# ${job.title ?? 'Codex Result'}`, '', `Job: ${job.id}`, `Status: ${job.status}`];

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push('', job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push('', storedJob.errorMessage);
  } else {
    lines.push('', 'No captured result payload was stored for this job.');
  }

  return renderWithFooter(`${lines.join('\n').trimEnd()}\n`);
}

export function renderCancelReport(job: RenderableJob, warning?: string | null): string {
  const lines = ['# Codex Cancel', '', `Cancelled ${job.id}.`, ''];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push('- Check `/stereo:status` for the updated queue.');

  return appendStoredJobWarning(`${lines.join('\n').trimEnd()}\n`, warning);
}

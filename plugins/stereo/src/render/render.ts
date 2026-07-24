import { describeStrandedReservation } from "../runtime/reservations.ts";
import type { StrandedReservationEntry } from "../runtime/reservations.ts";

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
  result?: StoredJobResultLike | null;
}

export interface SetupRenderReport {
  ready: boolean;
  node: { detail: string };
  npm: { detail: string };
  codex: { detail: string };
  writeSandbox?: { available: boolean | null; detail: string } | null;
  auth: { detail: string };
  sessionRuntime: { label: string };
  strandedReservations?: StrandedReservationEntry[] | null;
  reviewGateEnabled?: boolean | null;
  actionsTaken: string[];
  nextSteps: string[];
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
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding: NormalizedReviewFinding): string {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function validateReviewResultShape(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  const shape = data as Record<string, unknown>;
  if (typeof shape.verdict !== "string" || !shape.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof shape.summary !== "string" || !shape.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(shape.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(shape.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding: unknown, index: number): NormalizedReviewFinding {
  const source = (finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {}) as Record<string, unknown>;
  const lineStart = Number.isInteger(source.line_start) && (source.line_start as number) > 0 ? (source.line_start as number) : null;
  const lineEnd =
    Number.isInteger(source.line_end) && (source.line_end as number) > 0 && (!lineStart || (source.line_end as number) >= lineStart)
      ? (source.line_end as number)
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    confidence: Number.isFinite(source.confidence) ? Math.min(1, Math.max(0, source.confidence as number)) : null,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
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
      .filter((step): step is string => typeof step === "string" && Boolean(step.trim()))
      .map((step) => step.trim())
  };
}

// Tolerant-reader policy: the JSON schema sent to Codex marks residual_risks
// as required (so the model always emits it), but this validator deliberately
// does not — stored results from before the field existed must keep rendering.
function validatePlanReviewResultShape(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  const shape = data as Record<string, unknown>;
  if (typeof shape.verdict !== "string" || !shape.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof shape.summary !== "string" || !shape.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(shape.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(shape.revision_instructions)) {
    return "Missing array `revision_instructions`.";
  }
  if (!Array.isArray(shape.open_questions)) {
    return "Missing array `open_questions`.";
  }
  return null;
}

function normalizePlanReviewFinding(finding: unknown, index: number): NormalizedPlanReviewFinding {
  const source = (finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {}) as Record<string, unknown>;
  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    section: typeof source.section === "string" && source.section.trim() ? source.section.trim() : "general",
    confidence: Number.isFinite(source.confidence) ? Math.min(1, Math.max(0, source.confidence as number)) : null,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
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
      .filter((instruction): instruction is string => typeof instruction === "string" && Boolean(instruction.trim()))
      .map((instruction) => instruction.trim()),
    open_questions: data.open_questions
      .filter((question): question is string => typeof question === "string" && Boolean(question.trim()))
      .map((question) => question.trim()),
    residual_risks: (Array.isArray(data.residual_risks) ? data.residual_risks : [])
      .filter((risk): risk is string => typeof risk === "string" && Boolean(risk.trim()))
      .map((risk) => risk.trim())
  };
}

function isStructuredReviewStoredResult(storedJob: StoredJobLike | null | undefined): boolean {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

function formatJobLine(job: RenderableJob): string {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatCodexResumeCommand(job: RenderableJob | null | undefined): string | null {
  if (!job?.threadId) {
    return null;
  }
  return `codex resume ${job.threadId}`;
}

function appendActiveJobsTable(lines: string[], jobs: RenderableJob[]): void {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Codex Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/stereo:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/stereo:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines: string[], job: RenderableJob, options: JobDetailOptions = {}): void {
  lines.push(`- ${formatJobLine(job)}`);
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
    if (typeof job.createdAt === "string" && job.createdAt) {
      lines.push(`  Created: ${job.createdAt}`);
    }
    if (typeof job.startedAt === "string" && job.startedAt) {
      lines.push(`  Started: ${job.startedAt}`);
    }
    if (typeof job.completedAt === "string" && job.completedAt) {
      lines.push(`  Completed: ${job.completedAt}`);
    }
  }
  if (job.threadId) {
    lines.push(`  Codex session ID: ${job.threadId}`);
  }
  const resumeCommand = formatCodexResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Codex: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /stereo:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /stereo:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /stereo:review --wait");
    lines.push("  Stricter review: /stereo:adversarial-review --wait");
  }
  if ((options.showProgress ?? true) && job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

function appendReasoningSection(lines: string[], reasoningSummary: string[] | null | undefined): void {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

function appendStrandedReservationWarnings(lines: string[], entries: StrandedReservationEntry[] | null | undefined): void {
  if (!Array.isArray(entries) || entries.length === 0) {
    return;
  }
  if (lines.at(-1) !== "") {
    lines.push("");
  }
  lines.push("Warnings:");
  for (const entry of entries) {
    lines.push(`- ${describeStrandedReservation(entry)}`);
  }
  lines.push("");
}

export function renderSetupReport(report: SetupRenderReport): string {
  const lines = [
    "# Codex Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- codex: ${report.codex.detail}`,
    ...(report.writeSandbox
      ? [
          `- write sandbox: ${
            report.writeSandbox.available === true
              ? "ok"
              : report.writeSandbox.available === false
                ? `blocked (${report.writeSandbox.detail})`
                : report.writeSandbox.detail
          }`
        ]
      : []),
    `- auth: ${report.auth.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- thread reservations: ${
      Array.isArray(report.strandedReservations) && report.strandedReservations.length > 0
        ? `${report.strandedReservations.length} stranded (see next steps)`
        : "none stranded"
    }`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult: ParsedResultLike, meta: ReviewRenderMeta): string {
  if (!parsedResult.parsed) {
    const lines = [
      `# Codex ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Codex did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Codex ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Codex returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed as ReviewResultShape);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      const severityLabel =
        finding.confidence != null ? `${finding.severity}, confidence ${finding.confidence}` : finding.severity;
      lines.push(`- [${severityLabel}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderPlanReviewResult(parsedResult: ParsedResultLike, meta: PlanReviewRenderMeta = {}): string {
  const heading = (meta.round as number) > 1 ? `# Codex Plan Review (round ${meta.round})` : "# Codex Plan Review";
  if (!parsedResult.parsed) {
    const lines = [
      heading,
      "",
      "Codex did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validatePlanReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      heading,
      "",
      "Codex returned JSON with an unexpected plan-review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizePlanReviewResultData(parsedResult.parsed as PlanReviewResultShape);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    heading,
    "",
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const severityLabel =
        finding.confidence != null ? `${finding.severity}, confidence ${finding.confidence}` : finding.severity;
      lines.push(`- [${severityLabel}] ${finding.title} (${finding.section})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.revision_instructions.length > 0) {
    lines.push("", "Revision instructions:");
    data.revision_instructions.forEach((instruction, index) => {
      lines.push(`${index + 1}. ${instruction}`);
    });
  }

  if (data.open_questions.length > 0) {
    lines.push("", "Open questions:");
    for (const question of data.open_questions) {
      lines.push(`- ${question}`);
    }
  }

  if (data.residual_risks.length > 0) {
    lines.push("", "Residual risks (non-blocking):");
    for (const risk of data.residual_risks) {
      lines.push(`- ${risk}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result: NativeReviewRenderResult, meta: ReviewRenderMeta): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push("Codex review completed without any stdout output.");
  } else {
    lines.push("Codex review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(
  parsedResult: { rawOutput?: unknown; failureMessage?: unknown; reasoningSummary?: string[] | null } | null | undefined,
  meta: TaskRenderMeta | null | undefined
): string {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (meta?.write && Array.isArray(meta.touchedFiles) && meta.touchedFiles.length === 0) {
      return `${output}\nNote: this write-capable run reported no file changes.\n`;
    }
    return output;
  }

  const message = String(parsedResult?.failureMessage ?? "").trim() || "Codex did not return a final message.";
  return `${message}\n`;
}

export function renderStatusReport(report: StatusRenderReport, options: StatusRenderOptions = {}): string {
  const lines = [
    "# Codex Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ];

  appendStrandedReservationWarnings(lines, report.strandedReservations);

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    if (options.verbose) {
      lines.push("Live details:");
      for (const job of report.running) {
        pushJobDetails(lines, job, {
          showElapsed: true,
          showLog: true,
          showTimestamps: true
        });
      }
      lines.push("");
    }
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: options.verbose || report.latestFinished.status === "failed",
      showProgress: Boolean(options.verbose),
      ...(options.verbose ? { showTimestamps: true } : {})
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: options.verbose || job.status === "failed",
        showProgress: Boolean(options.verbose),
        ...(options.verbose ? { showTimestamps: true } : {})
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push("Ending the session will trigger a fresh Codex adversarial review and block if it finds issues.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job: RenderableJob, options: JobStatusRenderOptions = {}): string {
  const lines = ["# Codex Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    ...(options.verbose ? { showTimestamps: true } : {}),
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  if (options.waitTimedOut) {
    lines.push("", `Wait timed out after ${options.timeoutMs ?? "the configured"} ms; the job is still ${job.status}.`);
  }
  appendStrandedReservationWarnings(lines, options.strandedReservations);
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job: RenderableJob, storedJob: StoredJobLike | null | undefined): string {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `codex resume ${threadId}` : null;
  const taskClass = storedJob?.jobClass ?? job.jobClass ?? null;
  if (taskClass === "task" && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }
  // Review-class jobs always prefer the stored rendering: native reviews
  // carry no result/parseError keys, so keying only on the structured shape
  // dropped their heading/Target/reasoning in favor of raw stdout.
  if ((taskClass === "review" || isStructuredReviewStoredResult(storedJob)) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.codex?.stdout === "string" && storedJob.result.codex.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  const lines = [
    `# ${job.title ?? "Codex Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Codex session ID: ${threadId}`);
    lines.push(`Resume in Codex: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job: RenderableJob): string {
  const lines = [
    "# Codex Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/stereo:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}

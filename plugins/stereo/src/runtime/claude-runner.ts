import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { TokenUsageBreakdown } from '../protocol/app-server.ts';
import { spawnClaudePrint, terminateLiveClaudeRuns } from '../transport/claude-cli.ts';
import type {
  ClaudeModelUsage,
  ClaudePermissionDenial,
  ClaudeResultRecord,
  ClaudeStreamEvent,
} from '../transport/claude-cli.ts';
import { readJsonFile } from '../shared/fs.ts';
import { spawnedProcessIdentity } from '../platform/process.ts';
import type { RecordedProcess } from '../platform/process.ts';
import { finiteNumber, finiteOrZero, optionalString, recordLike } from '../shared/json.ts';
import { detectClaudeFamily, normalizeServedModelId } from '../models/claude-models.ts';
import {
  acquireThreadReservation,
  recordReservationChildPid,
  releaseThreadReservation,
} from './reservations.ts';
import type { ThreadReservation } from './reservations.ts';
import {
  buildAgentsFilePayload,
  loadRoleAgentDefinition,
  roleWrites,
  writeAgentsFile,
} from './role-agents.ts';
import type { ClaudeRole } from './role-agents.ts';
import {
  emitLogEvent,
  emitProgress,
  looksLikeVerificationCommand,
  MAX_COMMAND_OUTPUT_CHARS,
  resolveTurnInactivityTimeoutMs,
} from './turn-capture.ts';
import type { CapturedTokenUsage, ProgressReporter } from './turn-capture.ts';
import { errorMessage } from '../shared/errors.ts';

// Outranks every other effort source in the child (settings, saved per-model
// levels, agent frontmatter), so the role runs at exactly the level the
// companion resolved.
const CLAUDE_EFFORT_ENV = 'CLAUDE_CODE_EFFORT_LEVEL';
// A Node-run Claude sets process.title for the terminal title, which rewrites
// the command line the process-identity check reads (the
// `--permission-prompts` marker would vanish from it).
const CLAUDE_DISABLE_TERMINAL_TITLE_ENV = 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE';
// Every Bash call starts at the working root, so a command's recorded cwd is
// where it ran and a `cd` in one call never carries into the next.
const CLAUDE_MAINTAIN_WORKING_DIR_ENV = 'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR';
// Parent-session state that must not leak into the nested run: the parent's
// own effort marker, its messaging channel, the companion session id (the
// child's SessionEnd would otherwise touch this session's jobs), and the
// hook env file.
const SCRUBBED_ENV_KEYS = [
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CODEX_COMPANION_SESSION_ID',
  'CODEX_COMPANION_TRANSCRIPT_PATH',
  'CLAUDE_ENV_FILE',
  // A parent session's subagent-model override must not redirect a role.
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  // The parent's own identity: the child is a session of its own.
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
];
const MAX_REASONING_SUMMARIES = 20;
const MAX_REASONING_CHARS = 600;
const CLAUDE_TEMP_DIR_PREFIX = 'stereo-claude-';

// Per-run temp directories (the agents file) still on disk; removed after the
// run, or from the signal path when the companion is killed mid-run.
const liveTempDirs = new Set<string>();

// Signal-path cleanup: stop every live `claude -p` child and drop the temp
// files their runs created.
export function cleanupLiveClaudeRuns(): void {
  terminateLiveClaudeRuns();
  for (const dir of liveTempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort on the way out.
    }
  }
  liveTempDirs.clear();
}
// Build and test runners a contained implementer may invoke without a per-run
// grant; anything else needs `--allow`. Denied commands are reported, never
// retried silently.
export const IMPLEMENTER_DEFAULT_GRANTS: readonly string[] = [
  'Bash(node:*)',
  'Bash(npm:*)',
  'Bash(npx:*)',
  'Bash(pnpm:*)',
  'Bash(yarn:*)',
  'Bash(python3:*)',
  'Bash(pytest:*)',
  'Bash(go:*)',
  'Bash(cargo:*)',
  'Bash(make:*)',
];
// The edit tools: the calls `touchedFiles` and `lastEditOrder` record.
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface ClaudeTurnOptions {
  /** The Claude binary the launch's availability probe resolved. */
  binary: string;
  model: string;
  effort: string | null;
  role: ClaudeRole | null;
  prompt: string;
  resumeSessionId?: string | null;
  outputSchema?: unknown;
  allow?: readonly string[];
  /** Claude Code's own Bash sandbox in the child (writes confined to cwd). */
  sandbox?: boolean;
  onProgress?: ProgressReporter | null;
  env?: NodeJS.ProcessEnv;
  pluginRoot?: string;
  /** Names the owner in the session reservation, like a Codex thread's job. */
  jobId?: string | null;
}

export interface ClaudeCommandExecution {
  command: string;
  cwd: string;
  /** `interrupted`: the child ended (a kill) before the call reported a result. */
  status: 'completed' | 'denied' | 'interrupted';
  exitCode: number | null;
  durationMs: number | null;
  /** 1-based position of the call among every tool call of the run. */
  order: number;
  output?: string;
  /** Started with `run_in_background`: its exit is never known (exitCode null). */
  runInBackground?: true;
}

// The Claude-specific facts a job payload carries next to the shared fields.
export interface ClaudeDeniedCall {
  tool: string;
  /** The file path or command the call targeted; bodies are never stored. */
  target: string | null;
}

export interface ClaudeRunSummary {
  costUsd: number | null;
  permissionDenials: ClaudeDeniedCall[];
}

// A denied Write or Edit carries the whole file body in `tool_input`; the
// stored record keeps only what identifies the call.
function summarizeDenial(denial: ClaudePermissionDenial): ClaudeDeniedCall {
  return { tool: denial.tool_name, target: toolTarget(recordLike(denial.tool_input)) };
}

// What identifies a tool call without its body: a path, a command, a URL, a
// pattern, or a query. Commands are bounded because they can be long scripts.
function toolTarget(input: Record<string, unknown> | null): string | null {
  return (
    optionalString(input?.file_path) ??
    optionalString(input?.notebook_path) ??
    optionalString(input?.command)?.slice(0, 200) ??
    optionalString(input?.path) ??
    optionalString(input?.pattern) ??
    optionalString(input?.url) ??
    optionalString(input?.query) ??
    null
  );
}

// What the workflows need from either runtime once a turn has run: the
// app-server turn result has this shape, and a Claude run returns it too,
// with its envelope and the model that served it.
export interface CompanionTurn {
  status: number;
  threadId: string | null;
  turnId: string | null;
  finalMessage: string;
  error: unknown;
  stderr: string;
  reasoningSummary: string[];
  droppedNotifications: number;
  tokenUsage?: CapturedTokenUsage;
  claude?: ClaudeRunSummary;
  servedModel?: string | null;
}

// A Claude run: threadId is the session id; a structured answer is the JSON
// text of finalMessage.
export interface ClaudeTurnResult extends CompanionTurn {
  error: Error | null;
  claude: ClaudeRunSummary;
  servedModel: string | null;
  touchedFiles: string[];
  commandExecutions: ClaudeCommandExecution[];
  /** Order of the run's last edit-tool call (Edit, Write, MultiEdit, NotebookEdit), or null. */
  lastEditOrder: number | null;
}

export function buildClaudeEnv(base: NodeJS.ProcessEnv, effort: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of SCRUBBED_ENV_KEYS) {
    delete env[key];
  }
  if (effort) {
    env[CLAUDE_EFFORT_ENV] = effort;
  } else {
    delete env[CLAUDE_EFFORT_ENV];
  }
  env[CLAUDE_DISABLE_TERMINAL_TITLE_ENV] = '1';
  env[CLAUDE_MAINTAIN_WORKING_DIR_ENV] = '1';
  return env;
}

export interface ClaudeArgsOptions {
  model: string;
  effort: string | null;
  write: boolean;
  agentsFile: string | null;
  agentName: string | null;
  grants: readonly string[];
  outputSchema?: unknown;
  resumeSessionId?: string | null;
  sandbox?: boolean;
  /** The user's `apiKeyHelper`, which the child's project-only settings would drop. */
  apiKeyHelper?: string | null;
}

// The child reads project settings only (`--setting-sources project`), so a
// user-level `apiKeyHelper`, which counts as a login when the launch checks
// auth, would be missing in it. That one key is carried over through
// `--settings`; nothing else from the user's settings is.
export function readUserApiKeyHelper(env: NodeJS.ProcessEnv = process.env): string | null {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  try {
    const settings = recordLike(readJsonFile(path.join(configDir, 'settings.json')));
    return optionalString(settings?.apiKeyHelper);
  } catch {
    // No user settings, or unreadable ones: nothing to carry over.
    return null;
  }
}

// Everything after `-p`. Read roles run in dontAsk (the built-in read-only
// command set and read-only git need no grant; every other call is denied and
// reported); the implementer runs in acceptEdits, which confines edits and
// filesystem commands to the working directory, plus explicit runner grants.
export function buildClaudeArgs(options: ClaudeArgsOptions): string[] {
  const args = ['--output-format', 'stream-json', '--verbose', '--model', options.model];
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (options.agentsFile && options.agentName) {
    args.push('--agents', options.agentsFile, '--agent', options.agentName);
  }
  args.push(
    '--setting-sources',
    'project',
    '--settings',
    // The sandbox is opt-in: it confines shell writes to the working
    // directory, which may also block test runners that write to the OS
    // temp directory, and it needs bubblewrap (Linux) or seatbelt (macOS).
    JSON.stringify({
      disableAllHooks: true,
      ...(options.apiKeyHelper ? { apiKeyHelper: options.apiKeyHelper } : {}),
      ...(options.sandbox ? { sandbox: { enabled: true } } : {}),
    }),
    '--strict-mcp-config',
    '--permission-prompts',
    'none',
    '--permission-mode',
    options.write ? 'acceptEdits' : 'dontAsk',
  );
  if (options.outputSchema !== undefined && options.outputSchema !== null) {
    args.push('--json-schema', JSON.stringify(schemaForClaude(options.outputSchema)));
  }
  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }
  // Variadic: keep it last so no later flag is swallowed as a rule.
  if (options.grants.length > 0) {
    args.push('--allowedTools', ...options.grants);
  }
  return args;
}

// Claude Code validates `--json-schema` against draft-07 and rejects a
// document that declares another dialect ("no schema with key or ref
// https://json-schema.org/draft/2020-12/schema"). The plugin's schemas use
// only keywords both dialects share, so the declaration and id are dropped.
export function schemaForClaude(schema: unknown): unknown {
  const record = recordLike(schema);
  if (!record) {
    return schema;
  }
  const { $schema: _dialect, $id: _id, ...rest } = record;
  return rest;
}

interface MessageUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

function emptyBreakdown(): TokenUsageBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

// Thinking tokens are reported once per run, not per message: the caller
// sets reasoningOutputTokens itself.
function addUsage(
  into: TokenUsageBreakdown,
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number },
): void {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  into.inputTokens += input;
  into.cachedInputTokens += usage.cacheRead;
  into.cacheWriteInputTokens += usage.cacheWrite;
  into.outputTokens += usage.output;
  into.totalTokens += input + usage.output;
}

function describeToolUse(name: string, input: Record<string, unknown> | null): string {
  const target = toolTarget(input);
  return target ? `${name} ${target}` : name;
}

// The model that served the run. The usage table also lists the CLI's own
// auxiliary calls (a Haiku title or summary call can outspend a short run),
// so the entry of the requested model's family wins, then the entry of the
// family the session started on, and only then the one with the most output.
export function pickServedModel(
  modelUsage: Record<string, ClaudeModelUsage> | undefined,
  initModel: string | null,
  requestedModel: string | null = null,
): string | null {
  const entries = Object.entries(modelUsage ?? {}).map(([key, usage]) => ({
    id: optionalString(usage.canonicalModel) ?? key,
    output: finiteOrZero(usage.outputTokens),
  }));
  const mostOutput = (candidates: typeof entries): string | null =>
    candidates.reduce<(typeof entries)[number] | null>(
      (best, entry) => (!best || entry.output > best.output ? entry : best),
      null,
    )?.id ?? null;
  let served: string | null = null;
  for (const wanted of [requestedModel, initModel]) {
    const family = wanted ? detectClaudeFamily(wanted) : null;
    served ??= family
      ? mostOutput(entries.filter((entry) => detectClaudeFamily(entry.id) === family))
      : null;
  }
  served ??= mostOutput(entries) ?? initModel;
  // One form for the envelope, the job record, and the plan's reviewer label:
  // a dated snapshot id is recorded as the id its launch pinned.
  return served ? normalizeServedModelId(served) : served;
}

export async function runClaudeTurn(
  cwd: string,
  options: ClaudeTurnOptions,
): Promise<ClaudeTurnResult> {
  const write = roleWrites(options.role);
  const baseEnv = options.env ?? process.env;
  const env = buildClaudeEnv(baseEnv, options.effort);
  const inactivityTimeoutMs = resolveTurnInactivityTimeoutMs(baseEnv);
  if (!write) {
    // A granted check runs as in CI: jest, vitest, and playwright stop
    // writing the snapshots they do not find.
    env.CI = '1';
  }
  const onProgress = options.onProgress ?? null;

  // A session is driven by one run at a time, like a persisted Codex thread:
  // a resume reserves it before the spawn (a busy session fails fast), a
  // fresh session is reserved as soon as the CLI names it.
  let reservation: ThreadReservation | null = null;
  const reservationMeta = { jobId: options.jobId ?? null };
  if (options.resumeSessionId) {
    reservation = acquireThreadReservation(options.resumeSessionId, reservationMeta);
  }
  let agentsDir: string | null = null;
  let agentsFile: string | null = null;
  let agentName: string | null = null;
  if (options.role) {
    // Anything that fails here must give the session lock back: the run
    // never starts, so nothing else would release it.
    try {
      const definition = loadRoleAgentDefinition(options.role, { pluginRoot: options.pluginRoot });
      agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), CLAUDE_TEMP_DIR_PREFIX));
      liveTempDirs.add(agentsDir);
      agentsFile = writeAgentsFile(
        agentsDir,
        buildAgentsFilePayload(definition, {
          model: options.model,
          effort: options.effort,
          structuredOutput: options.outputSchema !== undefined && options.outputSchema !== null,
        }),
      );
      agentName = definition.name;
    } catch (error) {
      if (reservation) {
        releaseThreadReservation(reservation);
      }
      if (agentsDir) {
        liveTempDirs.delete(agentsDir);
        fs.rmSync(agentsDir, { recursive: true, force: true });
      }
      throw error;
    }
  }
  const grants = write
    ? [...IMPLEMENTER_DEFAULT_GRANTS, ...(options.allow ?? [])]
    : [...(options.allow ?? [])];
  const args = buildClaudeArgs({
    model: options.model,
    effort: options.effort,
    write,
    agentsFile,
    agentName,
    grants,
    outputSchema: options.outputSchema,
    resumeSessionId: options.resumeSessionId ?? null,
    sandbox: Boolean(options.sandbox),
    apiKeyHelper: readUserApiKeyHelper(baseEnv),
  });

  const touchedFiles = new Set<string>();
  // Write targets by tool_use id, promoted to touchedFiles only when the tool
  // result confirms the write (a denied write never touched anything).
  const pendingWrites = new Map<string, string>();
  const commands = new Map<string, ClaudeCommandExecution & { startedAt: number }>();
  const executions: ClaudeCommandExecution[] = [];
  // Every tool call is numbered in stream order, so a reader can tell whether
  // a verification command ran after the last edit.
  let toolCalls = 0;
  let lastEditOrder: number | null = null;
  const reasoningSummary: string[] = [];
  const usageByMessage = new Map<string, MessageUsage>();
  let sessionId: string | null = null;
  let initModel: string | null = null;
  // The child's pid travels on the session lock: a later run that finds this
  // one dead refuses the session while the child is still running it. Its
  // start token goes along, so a later process on a reused pid is told apart.
  let child: RecordedProcess | null = null;

  const onEvent = (event: ClaudeStreamEvent): void => {
    if (event.type === 'system' && event.subtype === 'init') {
      sessionId = optionalString(event.session_id) ?? sessionId;
      initModel = optionalString(event.model) ?? initModel;
      if (!reservation && sessionId) {
        try {
          reservation = acquireThreadReservation(sessionId, { ...reservationMeta, child });
        } catch (error) {
          // A fresh session id cannot be busy; an unwritable lock dir only
          // loses the guard, never the run.
          emitProgress(
            onProgress,
            `Could not reserve Claude session ${sessionId}: ${errorMessage(error)}`,
            null,
          );
        }
      }
      emitProgress(
        onProgress,
        `Claude session ready (${sessionId ?? 'unknown'}) on ${initModel ?? options.model}.`,
        'starting',
        { threadId: sessionId },
      );
      return;
    }
    if (event.type === 'system' && event.subtype === 'permission_denied') {
      emitProgress(
        onProgress,
        `Permission denied: ${optionalString(event.tool_name) ?? 'tool'}.`,
        null,
      );
      return;
    }
    const message = recordLike(event.message);
    if (event.type === 'assistant' && message) {
      const usage = recordLike(message.usage);
      const messageId = optionalString(message.id);
      if (usage && messageId) {
        usageByMessage.set(messageId, usage as MessageUsage);
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const item = recordLike(block);
        if (!item) {
          continue;
        }
        if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
          emitLogEvent(onProgress, {
            message: `Assistant message captured: ${item.text.trim().slice(0, 120)}`,
            logTitle: 'Assistant message',
            logBody: item.text,
          });
          continue;
        }
        if (item.type === 'thinking' && typeof item.thinking === 'string' && item.thinking.trim()) {
          const excerpt = item.thinking.trim().replace(/\s+/g, ' ').slice(0, MAX_REASONING_CHARS);
          if (reasoningSummary.length < MAX_REASONING_SUMMARIES) {
            reasoningSummary.push(excerpt);
          }
          emitLogEvent(onProgress, { logTitle: 'Reasoning summary', logBody: excerpt });
          continue;
        }
        if (item.type !== 'tool_use') {
          continue;
        }
        const name = optionalString(item.name) ?? 'tool';
        const input = recordLike(item.input);
        const toolUseId = optionalString(item.id);
        toolCalls += 1;
        const order = toolCalls;
        if (WRITE_TOOLS.has(name)) {
          lastEditOrder = order;
          const target =
            optionalString(input?.file_path) ?? optionalString(input?.notebook_path) ?? null;
          if (target && toolUseId) {
            pendingWrites.set(toolUseId, target);
          }
          emitProgress(onProgress, `Editing ${target ?? 'a file'}.`, 'editing');
        } else if (name === 'Bash') {
          const command = optionalString(input?.command) ?? '';
          const phase = looksLikeVerificationCommand(command) ? 'verifying' : 'running';
          const background = input?.run_in_background === true;
          if (toolUseId) {
            commands.set(toolUseId, {
              command,
              cwd,
              status: 'completed',
              exitCode: null,
              durationMs: null,
              order,
              ...(background ? { runInBackground: true as const } : {}),
              startedAt: Date.now(),
            });
          }
          emitProgress(onProgress, `Running: ${command.slice(0, 160)}`, phase);
        } else if (name === 'StructuredOutput') {
          emitProgress(onProgress, 'Returning the structured result.', 'finalizing');
        } else {
          emitProgress(onProgress, `Using ${describeToolUse(name, input)}.`, 'investigating');
        }
      }
      return;
    }
    if (event.type === 'user' && message) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const item = recordLike(block);
        if (!item || item.type !== 'tool_result') {
          continue;
        }
        const toolUseId = optionalString(item.tool_use_id);
        const content = item.content;
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .map((part) => optionalString(recordLike(part)?.text) ?? '')
                  .filter(Boolean)
                  .join('\n')
              : '';
        // Claude Code names the tool alone or with what it was asked to run
        // ("Permission to use Bash with command <cmd> has been denied.").
        const denied = /^Permission to use \w+(?: with [\s\S]+?)? has been denied/i.test(text);
        const writeTarget = toolUseId ? pendingWrites.get(toolUseId) : null;
        if (toolUseId && writeTarget !== undefined) {
          pendingWrites.delete(toolUseId);
          if (writeTarget && !denied && item.is_error !== true) {
            touchedFiles.add(writeTarget);
          }
          continue;
        }
        const pending = toolUseId ? commands.get(toolUseId) : null;
        if (!pending) {
          continue;
        }
        commands.delete(toolUseId as string);
        const failed = denied || item.is_error === true;
        const { startedAt, ...execution } = pending;
        // Same hygiene as the Codex capture: output is kept only for a
        // failed or denied command, as a bounded tail. A background call's
        // result only says it started: its exit is never known.
        executions.push({
          ...execution,
          status: denied ? 'denied' : 'completed',
          exitCode: denied || execution.runInBackground ? null : failed ? 1 : 0,
          durationMs: Date.now() - startedAt,
          ...(failed && text ? { output: text.slice(-MAX_COMMAND_OUTPUT_CHARS) } : {}),
        });
      }
    }
  };

  let outcome;
  try {
    // Inside the try: a throwing progress sink must still release the
    // session lock and remove the agents file.
    emitProgress(
      onProgress,
      options.resumeSessionId
        ? `Resuming Claude session ${options.resumeSessionId}.`
        : `Starting Claude ${options.role ?? 'task'} on ${options.model}${options.effort ? ` (effort ${options.effort})` : ''}.`,
      'starting',
      options.resumeSessionId ? { threadId: options.resumeSessionId } : {},
    );
    outcome = await spawnClaudePrint({
      binary: options.binary,
      cwd,
      env,
      args,
      prompt: options.prompt,
      onEvent,
      onSpawn: (pid) => {
        child = spawnedProcessIdentity(pid);
        if (!child) {
          return;
        }
        // A resume already holds its session lock; a fresh session takes the
        // pid along when the init event names it.
        if (reservation) {
          recordReservationChildPid(reservation, child);
        }
        emitProgress(onProgress, `Claude process started (pid ${pid}).`, null, {
          childPid: child.pid,
          childStart: child.start,
        });
      },
      inactivityTimeoutMs,
    });
  } finally {
    // Release first: a removal error must never strand the session lock. A
    // release that fails must not replace the run's outcome either: the next
    // acquire takes a dead owner's lock over.
    if (reservation) {
      try {
        releaseThreadReservation(reservation);
      } catch {
        // Best effort.
      }
    }
    if (agentsDir) {
      liveTempDirs.delete(agentsDir);
      try {
        fs.rmSync(agentsDir, { recursive: true, force: true });
      } catch {
        // Best effort; a leftover temp dir is not worth failing the run.
      }
    }
  }
  // Commands still pending at exit never reported: the child was stopped
  // (inactivity, a cancel) while they ran.
  for (const { startedAt, ...execution } of commands.values()) {
    executions.push({
      ...execution,
      status: 'interrupted',
      exitCode: null,
      durationMs: Date.now() - startedAt,
    });
  }

  const record: ClaudeResultRecord | null = outcome.result;
  const stderr = outcome.stderr.trim();
  const jobUsage = emptyBreakdown();
  for (const usage of usageByMessage.values()) {
    addUsage(jobUsage, {
      input: finiteOrZero(usage.input_tokens),
      cacheRead: finiteOrZero(usage.cache_read_input_tokens),
      cacheWrite: finiteOrZero(usage.cache_creation_input_tokens),
      output: finiteOrZero(usage.output_tokens),
    });
  }
  const thinking = finiteOrZero(
    recordLike(recordLike(outcome.result?.usage)?.output_tokens_details)?.thinking_tokens,
  );
  // The stream reports thinking tokens once, for the whole run; they belong to
  // this run's job accounting as much as to the session total.
  jobUsage.reasoningOutputTokens = thinking;

  if (!record) {
    const reason = outcome.spawnError
      ? `could not start ${outcome.spawnError.message}`
      : outcome.timedOut
        ? `produced no output for ${inactivityTimeoutMs} ms and was stopped`
        : `exited with ${outcome.signal ?? `code ${outcome.exitCode}`} before reporting a result`;
    const detail = [
      reason,
      stderr ? `stderr: ${stderr.slice(-1500)}` : '',
      outcome.firstUnparsedLine ? `output: ${outcome.firstUnparsedLine}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    return {
      status: 1,
      // A resume that died before its init still names the session it resumed.
      threadId: sessionId ?? options.resumeSessionId ?? null,
      turnId: null,
      finalMessage: '',
      error: new Error(`Claude ${detail}`),
      stderr,
      reasoningSummary,
      droppedNotifications: 0,
      tokenUsage: { job: jobUsage, thread: jobUsage, modelContextWindow: null },
      claude: { costUsd: null, permissionDenials: [] },
      servedModel: pickServedModel(undefined, initModel, options.model),
      touchedFiles: [...touchedFiles],
      commandExecutions: executions,
      lastEditOrder,
    };
  }

  const success = record.subtype === 'success' && record.is_error !== true;
  const structuredOutput = record.structured_output;
  // On an is_error result the "result" text is the failure notice (an expired
  // login, a rejected model); it belongs in the error, not in the output.
  const resultText = optionalString(record.result) ?? '';
  const finalMessage =
    structuredOutput !== undefined && structuredOutput !== null
      ? JSON.stringify(structuredOutput)
      : record.is_error === true
        ? ''
        : resultText;
  const permissionDenials = Array.isArray(record.permission_denials)
    ? record.permission_denials
    : [];
  const deniedWrites = permissionDenials
    .filter((denial) => WRITE_TOOLS.has(denial.tool_name))
    .map((denial) => toolTarget(recordLike(denial.tool_input)) ?? denial.tool_name);

  const threadUsage = emptyBreakdown();
  let modelContextWindow: number | null = null;
  for (const usage of Object.values(record.modelUsage ?? {})) {
    addUsage(threadUsage, {
      input: finiteOrZero(usage.inputTokens),
      cacheRead: finiteOrZero(usage.cacheReadInputTokens),
      cacheWrite: finiteOrZero(usage.cacheCreationInputTokens),
      output: finiteOrZero(usage.outputTokens),
    });
    const contextWindow = finiteNumber(usage.contextWindow);
    if (contextWindow !== null) {
      modelContextWindow = Math.max(modelContextWindow ?? 0, contextWindow);
    }
  }
  threadUsage.reasoningOutputTokens = thinking;
  const hasThreadUsage = threadUsage.totalTokens > 0;

  let status = success ? 0 : 1;
  let error: Error | null = null;
  if (!success) {
    const errors = Array.isArray(record.errors) ? record.errors.filter(Boolean).join('; ') : '';
    // A run the CLI marks is_error (an expired login, a rejected model) can
    // still carry subtype "success"; name it a failure, not a success.
    const outcomeLabel =
      record.is_error === true && record.subtype === 'success' ? 'failed' : record.subtype;
    const detail = errors || (finalMessage || resultText).slice(0, 500);
    error = new Error(
      `Claude run ${outcomeLabel === 'failed' ? 'failed' : `ended with ${outcomeLabel}`}${detail ? `: ${detail}` : ''}`,
    );
  } else if (write && deniedWrites.length > 0) {
    status = 1;
    error = new Error(
      `Claude was denied ${deniedWrites.length} write${deniedWrites.length === 1 ? '' : 's'} (${deniedWrites.join(', ')}); the working tree may be incomplete.`,
    );
  } else if (outcome.callbackError) {
    // The run's own events were not all recorded (a progress write failed):
    // what the job reports may be incomplete, so it cannot count as a success.
    status = 1;
    error = new Error(`Claude run failed: ${outcome.callbackError.message}`);
  }
  if (outcome.exitForced) {
    // The result stands: the CLI reported and merely failed to exit on its
    // own afterwards (a background process it started, an unflushed call).
    emitProgress(onProgress, 'Claude exited after its result was forced.', null);
  }
  emitProgress(
    onProgress,
    `Claude run finished (${optionalString(record.terminal_reason) ?? record.subtype}).`,
    status === 0 ? 'finalizing' : 'failed',
  );

  return {
    status,
    threadId: optionalString(record.session_id) ?? sessionId,
    turnId: null,
    finalMessage,
    error,
    stderr,
    reasoningSummary,
    droppedNotifications: 0,
    tokenUsage: {
      job: jobUsage,
      thread: hasThreadUsage ? threadUsage : jobUsage,
      modelContextWindow,
    },
    claude: {
      costUsd: finiteNumber(record.total_cost_usd),
      permissionDenials: permissionDenials.map(summarizeDenial),
    },
    servedModel: pickServedModel(record.modelUsage, initModel, options.model),
    touchedFiles: [...touchedFiles],
    commandExecutions: executions,
    lastEditOrder,
  };
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { parseArgs, splitRawArgumentString } from '../shared/args.ts';
import type { ParseArgsConfig, ParsedArgs, ParsedOptionValue } from '../shared/args.ts';
import {
  isOutsideAllowedRootsError,
  readStdinSyncBestEffort,
  readStdinTextIfPiped,
  resolveContainedUserFile,
} from '../shared/fs.ts';
import { recordLike } from '../shared/json.ts';
import { PLUGIN_ROOT } from '../shared/paths.ts';
import { DEFAULT_PLAN_SLOT, normalizePlanSlot } from '../workspace/state.ts';
import { resolveWorkspaceRoot } from '../workspace/workspace.ts';

// Parsed option bags as the command handlers receive them.
export type CommandOptions = Record<string, ParsedOptionValue>;

import { outputResult } from '../shared/text.ts';

export function outputCommandResult(payload: unknown, rendered: string, asJson: unknown): void {
  outputResult(asJson ? payload : rendered, asJson);
}

// Report-style commands (config, cancel, a queued launch, setup, doctor)
// carry the rendered report inside their JSON payload too, so a caller that
// reasons over fields can still print the exact text. Job status and result
// payloads stay lean: their bodies are already stored once and the commands
// read them with --json on every poll.
export function outputReportResult(payload: object, rendered: string, asJson: unknown): void {
  outputResult(asJson ? { ...payload, rendered } : rendered, asJson);
}

// `--args-stdin` alone: the raw argument string arrives on stdin. The slash
// commands' `!` blocks pass `$ARGUMENTS` through a quoted heredoc, so no shell
// ever reads the user's text (an apostrophe, `$`, or a backtick stays literal).
export const ARGS_STDIN_FLAG = '--args-stdin';
let stdinArguments: string | null = null;

function readArgumentsFromStdin(): string {
  // Read once: the pre-parse JSON check and the parse both normalize.
  stdinArguments ??= readStdinSyncBestEffort().replace(/\r?\n$/, '');
  return stdinArguments;
}

// Only the stdin text of `--args-stdin` is re-split like a shell line; every
// argument given on the command line is taken as it is.
export function normalizeArgv(argv: string[]): string[] {
  if (argv.length === 1 && argv[0] === ARGS_STDIN_FLAG) {
    const raw = readArgumentsFromStdin();
    return raw.trim() ? splitRawArgumentString(raw) : [];
  }
  return argv;
}

let jsonOutputRequested = false;
let argvParseCompleted = false;

// Called at the top of runCli: these globals model per-invocation state, and
// the in-process test helper runs several invocations in one process — a
// stale sticky value would make error-envelope behavior diverge from a
// spawned CLI. One-shot processes are unaffected.
export function resetJsonRequestState(): void {
  jsonOutputRequested = false;
  argvParseCompleted = false;
  stdinArguments = null;
}

export function parseCommandInput(argv: string[], config: ParseArgsConfig = {}): ParsedArgs {
  const parsed = parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: 'cwd',
      ...(config.aliasMap ?? {}),
    },
  });
  if (parsed.options.json) {
    jsonOutputRequested = true;
  }
  argvParseCompleted = true;
  return parsed;
}

export function wasJsonRequested(rawArgv: readonly string[] = process.argv.slice(2)): boolean {
  if (argvParseCompleted) {
    // Parsing decided: a --json inside prompt/focus text is a positional,
    // not a request for JSON output.
    return jsonOutputRequested;
  }
  // Pre-parse failures (unknown subcommand, missing flag values) never reach
  // parseCommandInput. The arguments after the subcommand are read the way
  // the parse would have: the stdin text of `--args-stdin` is re-split.
  const [subcommand, ...rest] = rawArgv;
  return subcommand === '--json' || normalizeArgv(rest).includes('--json');
}

export function resolveCommandCwd(options: CommandOptions = {}): string {
  return options.cwd ? path.resolve(process.cwd(), options.cwd as string) : process.cwd();
}

export function resolveCommandWorkspace(options: CommandOptions = {}): string {
  // --workspace keys durable state, jobs, logs, and the broker record; --cwd
  // sets the Codex thread cwd. They differ only for worktree-isolated runs.
  if (Object.hasOwn(options, 'workspace')) {
    const raw = String(options.workspace ?? '').trim();
    if (!raw) {
      throw new Error('Provide a directory path for --workspace.');
    }
    const resolved = path.resolve(process.cwd(), raw);
    try {
      if (!fs.statSync(resolved).isDirectory()) {
        throw new Error('not a directory');
      }
    } catch {
      throw new Error(`--workspace ${resolved} is not an existing directory.`);
    }
    return resolveWorkspaceRoot(resolved);
  }
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

export function resolvePlanSlotOption(options: CommandOptions = {}): string {
  if (!Object.hasOwn(options, 'slot')) {
    return DEFAULT_PLAN_SLOT;
  }
  const raw = String(options.slot ?? '').trim();
  if (!raw) {
    throw new Error('Provide a name for --slot.');
  }
  return normalizePlanSlot(raw);
}

const MAX_USER_FILE_BYTES = 16 * 1024 * 1024;

export function readUserFile(cwd: string, flagName: string, value: string): string;
export function readUserFile<T>(
  cwd: string,
  flagName: string,
  value: string,
  readImpl: (filePath: string) => T,
): T;
export function readUserFile<T = string>(
  cwd: string,
  flagName: string,
  value: string,
  readImpl: (filePath: string) => T = (filePath) => fs.readFileSync(filePath, 'utf8') as T,
): T {
  const resolved = path.resolve(cwd, value);
  let contained: string;
  try {
    const allowedRoots = [resolveWorkspaceRoot(cwd), cwd, os.tmpdir(), PLUGIN_ROOT];
    if (process.env.CLAUDE_PLUGIN_ROOT) {
      allowedRoots.push(process.env.CLAUDE_PLUGIN_ROOT);
    }
    contained = resolveContainedUserFile(resolved, allowedRoots);
  } catch (error) {
    if (isOutsideAllowedRootsError(error)) {
      throw new Error(
        `Refusing to read ${flagName} ${resolved}: it is outside this workspace, the OS temp directory, and the plugin directory. Copy the file into the repository or a temp directory and retry.`,
      );
    }
    throw new Error(
      `Could not read ${flagName} ${resolved}: ${(error as NodeJS.ErrnoException | null)?.message ?? error}`,
    );
  }

  try {
    if (fs.statSync(contained).size > MAX_USER_FILE_BYTES) {
      throw new Error(`${flagName} ${resolved} is larger than 16 MiB.`);
    }
    return readImpl(contained);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `${flagName} ${resolved} is larger than 16 MiB.`
    ) {
      throw error;
    }
    throw new Error(
      `Could not read ${flagName} ${resolved}: ${(error as NodeJS.ErrnoException | null)?.message ?? error}`,
    );
  }
}

// A JSON object from the user file a flag names. `checkContents` vets the
// text before it is parsed (a size cap of the flag's own).
export function readJsonObjectFile(
  cwd: string,
  flagName: string,
  value: string,
  checkContents?: (contents: string) => void,
): Record<string, unknown> {
  const contents = readUserFile(cwd, flagName, value);
  checkContents?.(contents);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Could not parse ${flagName} as JSON.`);
  }
  const record = recordLike(parsed);
  if (!record) {
    throw new Error(`Provide ${flagName} containing a JSON object.`);
  }
  return record;
}

export async function readTaskPrompt(
  cwd: string,
  options: CommandOptions,
  positionals: string[],
): Promise<string> {
  if (options['prompt-file']) {
    return readUserFile(cwd, '--prompt-file', options['prompt-file'] as string);
  }

  const positionalPrompt = positionals.join(' ');
  return (
    positionalPrompt || (await readStdinTextIfPiped({ label: 'task prompt', onTimeout: 'empty' }))
  );
}

export async function readPlanInput(
  cwd: string,
  options: CommandOptions,
  positionals: string[],
): Promise<string> {
  if (options['plan-file']) {
    return readUserFile(cwd, '--plan-file', options['plan-file'] as string);
  }

  const positionalPlan = positionals.join(' ');
  return (
    positionalPlan || (await readStdinTextIfPiped({ label: 'plan input', onTimeout: 'empty' }))
  );
}

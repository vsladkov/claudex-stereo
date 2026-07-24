import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseArgs, splitRawArgumentString } from "../shared/args.ts";
import type { ParseArgsConfig, ParsedArgs, ParsedOptionValue } from "../shared/args.ts";
import { readStdinIfPiped } from "../shared/fs.ts";
import { resolveWorkspaceRoot } from "../workspace/workspace.ts";

// Parsed option bags as the command handlers receive them.
export type CommandOptions = Record<string, ParsedOptionValue>;

import { outputResult } from "../shared/text.ts";

export function outputCommandResult(payload: unknown, rendered: string, asJson: unknown): void {
  outputResult(asJson ? payload : rendered, asJson);
}

export function normalizeArgv(argv: string[]): string[] {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

let jsonOutputRequested = false;
let argvParseCompleted = false;

export function parseCommandInput(argv: string[], config: ParseArgsConfig = {}): ParsedArgs {
  const parsed = parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
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
  // parseCommandInput; slash commands also pass all arguments as one raw
  // string, so split each raw token before looking for --json.
  return rawArgv.some((token) => {
    if (token === "--json") {
      return true;
    }
    try {
      return splitRawArgumentString(token).includes("--json");
    } catch {
      return false;
    }
  });
}

export function resolveCommandCwd(options: CommandOptions = {}): string {
  return options.cwd ? path.resolve(process.cwd(), options.cwd as string) : process.cwd();
}

export function resolveCommandWorkspace(options: CommandOptions = {}): string {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}



export function readUserFile(cwd: string, flagName: string, value: string): string {
  const resolved = path.resolve(cwd, value);
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${flagName} ${resolved}: ${(error as NodeJS.ErrnoException | null)?.message ?? error}`);
  }
}

export function readTaskPrompt(cwd: string, options: CommandOptions, positionals: string[]): string {
  if (options["prompt-file"]) {
    return readUserFile(cwd, "--prompt-file", options["prompt-file"] as string);
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

export function readPlanInput(cwd: string, options: CommandOptions, positionals: string[]): string {
  if (options["plan-file"]) {
    return readUserFile(cwd, "--plan-file", options["plan-file"] as string);
  }

  const positionalPlan = positionals.join(" ");
  return positionalPlan || readStdinIfPiped();
}

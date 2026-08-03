import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { errorCode } from '../platform/process.ts';
import { ensureAbsolutePath } from '../shared/fs.ts';

export const TRANSCRIPT_PATH_ENV = 'CODEX_COMPANION_TRANSCRIPT_PATH';
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

export interface ResolveClaudeSessionOptions {
  source?: string;
}

function resolveUserPath(cwd: string, value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

export function resolveClaudeSessionPath(
  cwd: string,
  options: ResolveClaudeSessionOptions = {},
): string {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    throw new Error(
      'Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.',
    );
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== '.jsonl') {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source: string;
  try {
    source = fs.realpathSync(sourcePath);
  } catch (error) {
    throw new Error(
      `Claude session file not found: ${sourcePath} (${errorCode(error) ?? String(error)})`,
    );
  }

  let projects: string;
  try {
    projects = fs.realpathSync(CLAUDE_PROJECTS_DIR);
  } catch (error) {
    throw new Error(
      `Claude projects directory unavailable: ${CLAUDE_PROJECTS_DIR} (${errorCode(error) ?? String(error)})`,
    );
  }
  const relative = path.relative(projects, source);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Codex can import Claude sessions only from ${CLAUDE_PROJECTS_DIR}: ${source}`);
  }
  return source;
}

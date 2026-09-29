import fs from 'node:fs';
import path from 'node:path';

import { readJsonFileTolerant, withFileLock, writeJsonAtomic } from '../shared/fs.ts';
import { recordLike } from '../shared/json.ts';
import { COMPANION_STATE_DIR } from './state.ts';
import { resolveCodexHome } from './thread-lock-io.ts';

// Which workspace roots a Claude Code session has launched jobs in. SessionEnd
// only knows the session's cwd, so a job launched with `--workspace <root>`
// from elsewhere would never be swept without this record. One small file per
// session under CODEX_HOME, removed when the session ends.
const SESSION_REGISTRY_DIR = path.join(COMPANION_STATE_DIR, 'session-workspaces');
const SESSION_REGISTRY_VERSION = 1;
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

// The directory of every session's registry file (and its lock).
export function resolveSessionRegistryDir(codexHome: string = resolveCodexHome()): string {
  return path.join(codexHome, SESSION_REGISTRY_DIR);
}

export function resolveSessionRegistryFile(
  sessionId: string,
  codexHome: string = resolveCodexHome(),
): string | null {
  return SAFE_SESSION_ID.test(sessionId)
    ? path.join(resolveSessionRegistryDir(codexHome), `${sessionId}.json`)
    : null;
}

export function readSessionWorkspaces(sessionId: string, codexHome?: string): string[] {
  const filePath = resolveSessionRegistryFile(sessionId, codexHome);
  if (!filePath) {
    return [];
  }
  const parsed = recordLike(readJsonFileTolerant(filePath).record);
  if (!parsed || parsed.version !== SESSION_REGISTRY_VERSION || !Array.isArray(parsed.roots)) {
    return [];
  }
  return parsed.roots.filter((root): root is string => typeof root === 'string' && root !== '');
}

// Best effort: a read-only CODEX_HOME only loses the sweep of other roots.
export function recordSessionWorkspace(
  sessionId: string,
  workspaceRoot: string,
  codexHome?: string,
): boolean {
  const filePath = resolveSessionRegistryFile(sessionId, codexHome);
  if (!filePath || !workspaceRoot) {
    return false;
  }
  // A root already listed (every later launch into it) needs no lock.
  if (readSessionWorkspaces(sessionId, codexHome).includes(workspaceRoot)) {
    return true;
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Two launches from one session into different roots must not drop
    // each other's entry: read-modify-write under the shared file lock.
    return withFileLock(`${filePath}.lock`, () => {
      const roots = readSessionWorkspaces(sessionId, codexHome);
      if (roots.includes(workspaceRoot)) {
        return true;
      }
      writeJsonAtomic(filePath, {
        version: SESSION_REGISTRY_VERSION,
        roots: [...roots, workspaceRoot],
      });
      return true;
    });
  } catch {
    return false;
  }
}

export function clearSessionWorkspaces(sessionId: string, codexHome?: string): void {
  const filePath = resolveSessionRegistryFile(sessionId, codexHome);
  if (!filePath) {
    return;
  }
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best effort.
  }
}

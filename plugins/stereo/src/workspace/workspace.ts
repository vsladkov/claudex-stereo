import { ensureGitRepository } from '../platform/git.ts';

// Every state-path, job, and hook resolution funnels through this, and each
// raw call is a synchronous `git rev-parse` subprocess (~50-150ms) — before
// this cache a single job progress tick paid ~15 spawns and one status wait
// hundreds. A cwd's repository root is stable for the life of a process
// (repositories do not move out from under live CLIs or workers), so
// memoize per cwd.
const workspaceRootCache = new Map<string, string>();

export function resolveWorkspaceRoot(cwd: string): string {
  const cached = workspaceRootCache.get(cwd);
  if (cached !== undefined) {
    return cached;
  }
  let root: string;
  try {
    root = ensureGitRepository(cwd);
  } catch {
    root = cwd;
  }
  workspaceRootCache.set(cwd, root);
  return root;
}

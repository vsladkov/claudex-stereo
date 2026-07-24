import { ensureGitRepository } from '../platform/git.ts';

export function resolveWorkspaceRoot(cwd: string): string {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}

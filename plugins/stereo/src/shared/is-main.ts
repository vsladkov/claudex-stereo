import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function resolveEntryPath(argvPath: string): string {
  try {
    // realpath, not resolve: Node symlink-resolves the ESM entry for
    // import.meta.url, so a symlinked install would otherwise mismatch and
    // silently disable the hook.
    return fs.realpathSync(argvPath);
  } catch {
    return path.resolve(argvPath);
  }
}

// True when the module at entryUrl is the file Node was asked to execute.
// INVARIANT: this comparison works only because there is no emit — a directly
// executed .ts entry passing its own import.meta.url is the file in
// process.argv[1]. The .cjs Node-version guards make process.argv[1] name the
// guard instead, so they delegate by calling the .ts module's exported main()
// and never rely on this comparison.
export function isMainModule(entryUrl: string): boolean {
  const argvPath = process.argv[1];
  return Boolean(argvPath && resolveEntryPath(argvPath) === fileURLToPath(entryUrl));
}

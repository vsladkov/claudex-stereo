import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
// INVARIANT: this comparison works only because there is no emit — the .ts
// entry shim passing its own import.meta.url is the very file in process.argv[1].
export function isMainModule(entryUrl: string): boolean {
  const argvPath = process.argv[1];
  return Boolean(argvPath && resolveEntryPath(argvPath) === fileURLToPath(entryUrl));
}

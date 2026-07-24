import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = path.join(ROOT, 'plugins', 'stereo', 'src');

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

// tsc runs with Bundler resolution (the codegen'd protocol types force it),
// so the compiler does not enforce Node's runtime import rules - a missing
// or extensionless relative specifier only fails when the module actually
// loads. Importing every src module here proves the whole graph resolves,
// covering branches no behavioral test executes. The scripts/ entry shims
// are excluded deliberately: they execute their entry point on import and
// are exercised by the spawn-level tests instead.
test("every src module's import graph resolves under Node's runtime loader", async () => {
  const files = listSourceFiles(SRC_ROOT);
  assert.ok(files.length >= 40, `expected the src tree, found ${files.length} files`);

  const failures: string[] = [];
  for (const file of files) {
    try {
      await import(pathToFileURL(file).href);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${path.relative(ROOT, file)}: ${message}`);
    }
  }

  assert.deepEqual(failures, []);
});

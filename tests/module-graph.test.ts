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

const LAYERS: Record<string, number> = {
  shared: 0,
  platform: 1,
  protocol: 2,
  broker: 2,
  workspace: 2,
  transport: 3,
  runtime: 4,
  jobs: 4,
  models: 4,
  render: 5,
  workflows: 5,
  cli: 6,
  hooks: 6,
};

function relativeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function topLevelSourceDirectory(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep)[0]!;
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

test('src modules import only their own or lower layers', () => {
  const violations: string[] = [];

  for (const file of listSourceFiles(SRC_ROOT)) {
    const sourceDirectory = topLevelSourceDirectory(file);
    const sourceLayer = LAYERS[sourceDirectory];
    assert.notEqual(sourceLayer, undefined, `missing layer for ${sourceDirectory}`);

    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of relativeImportSpecifiers(source)) {
      const target = path.resolve(path.dirname(file), specifier);
      const relativeTarget = path.relative(SRC_ROOT, target);
      if (relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
        continue;
      }

      const targetDirectory = topLevelSourceDirectory(target);
      const targetLayer = LAYERS[targetDirectory];
      assert.notEqual(targetLayer, undefined, `missing layer for ${targetDirectory}`);
      if ((targetLayer as number) > (sourceLayer as number)) {
        violations.push(
          `${path.relative(ROOT, file)}: ${sourceDirectory} -> ${targetDirectory} (${specifier})`,
        );
      }
    }
  }

  assert.deepEqual(violations, []);
});

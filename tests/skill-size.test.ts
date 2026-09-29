import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ROUTING = path.join(ROOT, 'plugins', 'stereo', 'skills', 'model-routing');

// The model-routing files are read whole with the Read tool, which refuses a
// file past 25k tokens; ~90 KB of this prose is a byte proxy for that cap.
// A file that outgrows it must be split, never left for a truncated read.
const MAX_SKILL_FILE_BYTES = 90 * 1024;

for (const file of fs.readdirSync(MODEL_ROUTING).filter((name) => name.endsWith('.md'))) {
  test(`model-routing ${file} stays small enough for one Read`, () => {
    const bytes = fs.statSync(path.join(MODEL_ROUTING, file)).size;
    assert.ok(
      bytes < MAX_SKILL_FILE_BYTES,
      `${file} is ${bytes} bytes; keep it under ${MAX_SKILL_FILE_BYTES} or split it`,
    );
  });
}

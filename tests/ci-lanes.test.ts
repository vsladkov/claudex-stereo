import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXCLUDED_WINDOWS_TESTS, TESTS_DIR, windowsTestFiles } from '../scripts/test-windows.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('npm run test:windows runs the lane runner', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.scripts?.['test:windows'], 'node scripts/test-windows.ts');
});

test('the Windows lane excludes existing test files only, each once, in sorted order', () => {
  assert.deepEqual(EXCLUDED_WINDOWS_TESTS, [...new Set(EXCLUDED_WINDOWS_TESTS)].sort());
  for (const file of EXCLUDED_WINDOWS_TESTS) {
    assert.equal(fs.existsSync(path.join(TESTS_DIR, file)), true, `${file} is a stale exclusion`);
  }
  const lane = windowsTestFiles();
  assert.ok(lane.length > 0);
  assert.ok(lane.every((file) => !EXCLUDED_WINDOWS_TESTS.includes(file)));
});

test('broker-spawning tests stay out of the Windows lane', () => {
  const reapingTests = fs
    .readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => {
      const source = fs.readFileSync(path.join(TESTS_DIR, name), 'utf8');
      return /import\s*\{[^}]*\bregisterBrokerReaping\b[^}]*\}\s*from\s*['"]\.\/runtime-helpers\.ts['"]/.test(
        source,
      );
    });
  assert.ok(reapingTests.length > 0);
  for (const file of reapingTests) {
    assert.equal(
      EXCLUDED_WINDOWS_TESTS.includes(file),
      true,
      `${file} imports registerBrokerReaping and must be excluded from the Windows lane`,
    );
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = path.join(ROOT, 'tests');

const EXCLUDED_WINDOWS_TESTS = new Set([
  'broker-reaper.test.ts',
  'broker.test.ts',
  'bump-version.test.ts',
  'config-command.test.ts',
  'env-bootstrap.test.ts',
  'git.test.ts',
  'provider-probe.test.ts',
  'runtime-core.test.ts',
  'runtime-implement-state.test.ts',
  'runtime-plan.test.ts',
  'runtime-sessions.test.ts',
  'runtime-tasks.test.ts',
  'runtime-tournament-state.test.ts',
  'stop-review-gate.test.ts',
  'version-command.test.ts',
]);

function windowsTestFiles(): string[] {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: { 'test:windows'?: string };
  };
  return [...(packageJson.scripts?.['test:windows'] ?? '').matchAll(/tests\/([^\s"]+\.test\.ts)/g)]
    .map((match) => match[1] as string)
    .sort();
}

test('the Windows CI test lane names an existing portable strict subset', () => {
  const listed = windowsTestFiles();
  const allTests = fs
    .readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.test.ts'))
    .sort();

  assert.ok(listed.length > 0);
  assert.ok(listed.length < allTests.length, 'test:windows must remain a strict subset');
  assert.equal(
    listed.length + EXCLUDED_WINDOWS_TESTS.size,
    allTests.length,
    'every test file must be classified: either in test:windows or explicitly excluded',
  );
  for (const file of listed) {
    assert.equal(fs.existsSync(path.join(TESTS_DIR, file)), true, file);
    assert.equal(allTests.includes(file), true, file);
    assert.equal(EXCLUDED_WINDOWS_TESTS.has(file), false, file);
  }
  for (const file of EXCLUDED_WINDOWS_TESTS) {
    assert.equal(allTests.includes(file), true, `${file} must remain an explicit test exclusion`);
    assert.equal(listed.includes(file), false, `${file} must not enter test:windows`);
  }
});

test('broker-spawning tests stay out of the Windows portable subset', () => {
  const listed = new Set(windowsTestFiles());
  const reapingTests = fs
    .readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => {
      const source = fs.readFileSync(path.join(TESTS_DIR, name), 'utf8');
      return /import\s*\{[^}]*\bregisterBrokerReaping\b[^}]*\}\s*from\s*['"]\.\/runtime-helpers\.ts['"]/.test(
        source,
      );
    });

  for (const file of reapingTests) {
    assert.equal(listed.has(file), false, file);
    assert.equal(
      EXCLUDED_WINDOWS_TESTS.has(file),
      true,
      `${file} imports registerBrokerReaping and must be classified as excluded`,
    );
  }
});

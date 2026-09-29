#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { isMainModule } from '../plugins/stereo/src/shared/is-main.ts';

// The Windows CI lane (`npm run test:windows`): every test file except these.
// A new test file joins the lane unless it is listed here. What keeps a file
// out: it starts a broker or a Codex app-server (the runtime-* files, the
// broker files, provider-probe, stop-review-gate), it sends POSIX signals to
// real processes (runtime-claude-lifecycle), or it asserts what only a POSIX
// host does (env-bootstrap: the preload leaves no Claude exec path; git:
// symbolic links, and git arguments a Windows shell would split).
export const EXCLUDED_WINDOWS_TESTS: readonly string[] = [
  'broker-reaper.test.ts',
  'broker.test.ts',
  'env-bootstrap.test.ts',
  'git.test.ts',
  'provider-probe.test.ts',
  'runtime-claude-lifecycle.test.ts',
  'runtime-claude.test.ts',
  'runtime-core-cancel.test.ts',
  'runtime-core-review.test.ts',
  'runtime-core-status.test.ts',
  'runtime-core.test.ts',
  'runtime-plan.test.ts',
  'runtime-sessions-reservations.test.ts',
  'runtime-sessions-teardown.test.ts',
  'runtime-sessions.test.ts',
  'runtime-tasks-app-server.test.ts',
  'runtime-tasks-models.test.ts',
  'runtime-tasks.test.ts',
  'stop-review-gate.test.ts',
];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TESTS_DIR = path.join(ROOT, 'tests');

// The lane's test files, by name, sorted.
export function windowsTestFiles(): string[] {
  return fs
    .readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.test.ts') && !EXCLUDED_WINDOWS_TESTS.includes(name))
    .sort();
}

if (isMainModule(import.meta.url)) {
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--require',
      './tests/env-bootstrap.cjs',
      '--test-global-setup=./tests/global-setup.ts',
      ...windowsTestFiles().map((name) => path.join('tests', name)),
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
}

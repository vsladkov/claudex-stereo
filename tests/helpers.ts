import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  shell?: boolean | string;
}

export interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

const createdTempDirs: string[] = [];
const allTempDirs: string[] = [];
let exitCleanupInstalled = false;

function installTempDirCleanup(): void {
  if (exitCleanupInstalled || process.env.STEREO_KEEP_TEST_TMP) {
    return;
  }
  exitCleanupInstalled = true;
  // Exit time, not afterEach: registerBrokerReaping() drains dirs during the
  // run and claude-session-transfer.test.ts creates module-scope dirs that
  // must outlive every test in the file.
  process.on('exit', () => {
    for (const dir of allTempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        // Cleanup is best effort; a leaked dir must never fail a test run.
      }
    }
  });
}

export function makeTempDir(prefix = 'codex-plugin-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.push(dir);
  allTempDirs.push(dir);
  installTempDirCleanup();
  return dir;
}

/**
 * Return the temp dirs created by this test-file process since the last
 * drain. Each test file runs in its own process, so afterEach reapers built
 * on this see only their own file's workspaces - never another file's.
 */
export function drainCreatedTempDirs(): string[] {
  return createdTempDirs.splice(0, createdTempDirs.length);
}

export function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { encoding: 'utf8', mode: 0o755 });
}

export function run(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
  return spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    input: options.input,
    shell: options.shell ?? (process.platform === 'win32' && !path.isAbsolute(command)),
    windowsHide: true,
  }) as unknown as RunResult;
}

export function initGitRepo(cwd: string): void {
  run('git', ['init', '-b', 'main'], { cwd });
  run('git', ['config', 'user.name', 'Codex Plugin Tests'], { cwd });
  run('git', ['config', 'user.email', 'tests@example.com'], { cwd });
  run('git', ['config', 'commit.gpgsign', 'false'], { cwd });
  run('git', ['config', 'tag.gpgsign', 'false'], { cwd });
}

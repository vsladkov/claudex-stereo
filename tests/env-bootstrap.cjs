const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The test runner loads this preload too, and has no NODE_TEST_CONTEXT; every
// test-file process it spawns inherits the runner's environment with one.
const isRunner = !process.env.NODE_TEST_CONTEXT;

// One id per test run, shared by the runner and everything spawned under it
// (test files, companions, brokers), so the global teardown reaps only its own
// run's brokers and never a concurrent run's. The runner always mints a fresh
// id: a value leaked from a developer shell must never make two runs look like
// one.
if (isRunner || !process.env.STEREO_TEST_RUN_ID) {
  process.env.STEREO_TEST_RUN_ID = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CODEX_COMPANION_SESSION_ID;
delete process.env.CODEX_COMPANION_TRANSCRIPT_PATH;
// SessionStart hooks append to CLAUDE_ENV_FILE; a leaked value would let a
// test spawn of the hook mutate the developer's live session env file.
delete process.env.CLAUDE_ENV_FILE;
// The stop gate falls back to CLAUDE_PROJECT_DIR for its cwd.
delete process.env.CLAUDE_PROJECT_DIR;
// A leaked broker endpoint would point every spawned companion at the
// developer's live workspace broker instead of a test-owned one.
delete process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
// The Claude transport prefers CLAUDE_CODE_EXECPATH (the running Claude Code
// binary inside a session) over PATH: a leaked one would launch the
// developer's real CLI. Tests that need an exec path set it (the fake's).
delete process.env.CLAUDE_CODE_EXECPATH;
// Claude credentials from the environment count as a login when `claude auth
// status` reports none, so a developer's key must not mask the logged-out paths.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
// The parent session's effort marker must not leak into spawned runs.
delete process.env.CLAUDE_EFFORT;
delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
delete process.env.STEREO_TURN_INACTIVITY_TIMEOUT_MS;
// Ephemeral companion state (especially broker.json and legacy migration
// sources) must be isolated from the machine-global /tmp fallback.
const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stereo-test-plugin-data-'));
process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
// Durable companion state lives under CODEX_HOME. Always replace a leaked
// developer home so in-process state tests cannot touch real Codex data.
const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stereo-test-codex-home-'));
process.env.CODEX_HOME = codexHomeDir;
// A Claude run carries the user's settings `apiKeyHelper` into its child: an
// empty config directory keeps the developer's settings out of every run.
const claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stereo-test-claude-config-'));
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

// A test that forgets a fake must fail loudly, never reach the developer's
// real CLI: decoy `codex` and `claude` binaries lead PATH. Tests that install
// a fake prepend their own bin ahead of them. The runner creates the decoys
// and every process under it reuses them, so they outlive each file's
// detached brokers until the run ends.
const DECOYS = ['codex', 'claude'];
let decoyDir = isRunner ? undefined : process.env.STEREO_TEST_DECOY_DIR;
let ownedDecoyDir = null;
if (!decoyDir || !DECOYS.every((name) => fs.existsSync(path.join(decoyDir, name)))) {
  decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stereo-test-decoy-'));
  ownedDecoyDir = decoyDir;
  for (const name of DECOYS) {
    const message = `stereo test decoy: the real ${name} must not run in tests`;
    fs.writeFileSync(path.join(decoyDir, name), `#!/bin/sh\necho '${message}' >&2\nexit 127\n`, {
      encoding: 'utf8',
      mode: 0o755,
    });
    if (process.platform === 'win32') {
      fs.writeFileSync(
        path.join(decoyDir, `${name}.cmd`),
        `@echo off\r\necho ${message} 1>&2\r\nexit /b 127\r\n`,
        'utf8',
      );
    }
  }
  process.env.STEREO_TEST_DECOY_DIR = decoyDir;
}
// On Windows a native claude.exe anywhere on PATH outranks a `.cmd` decoy,
// so there the exec path names the decoy itself.
if (process.platform === 'win32') {
  process.env.CLAUDE_CODE_EXECPATH = path.join(decoyDir, 'claude.cmd');
}
// Already on PATH (inherited, possibly behind a test's fake bin): keep the
// order, or the decoy would shadow the fake.
const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
if (!pathEntries.includes(decoyDir)) {
  process.env.PATH = [decoyDir, ...pathEntries.filter(Boolean)].join(path.delimiter);
}

if (!process.env.STEREO_KEEP_TEST_TMP) {
  process.on('exit', () => {
    for (const dir of [pluginDataDir, codexHomeDir, claudeConfigDir, ownedDecoyDir]) {
      if (!dir) {
        continue;
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        // Cleanup is best effort; a leaked dir must never fail a test run.
      }
    }
  });
}

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CODEX_COMPANION_SESSION_ID;
delete process.env.CODEX_COMPANION_TRANSCRIPT_PATH;
// SessionStart hooks append to CLAUDE_ENV_FILE; a leaked value would let a
// test spawn of the hook mutate the developer's live session env file.
delete process.env.CLAUDE_ENV_FILE;
// The stop gate falls back to CLAUDE_PROJECT_DIR for its cwd.
delete process.env.CLAUDE_PROJECT_DIR;
// Ephemeral companion state (especially broker.json and legacy migration
// sources) must be isolated from the machine-global /tmp fallback.
const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stereo-test-plugin-data-'));
process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
// Durable companion state lives under CODEX_HOME. Always replace a leaked
// developer home so in-process state tests cannot touch real Codex data.
const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stereo-test-codex-home-'));
process.env.CODEX_HOME = codexHomeDir;

if (!process.env.STEREO_KEEP_TEST_TMP) {
  process.on('exit', () => {
    for (const dir of [pluginDataDir, codexHomeDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        // Cleanup is best effort; a leaked dir must never fail a test run.
      }
    }
  });
}

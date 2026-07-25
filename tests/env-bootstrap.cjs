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
process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'stereo-test-plugin-data-'));
// Durable companion state lives under CODEX_HOME. Always replace a leaked
// developer home so in-process state tests cannot touch real Codex data.
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stereo-test-codex-home-'));

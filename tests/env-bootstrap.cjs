delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CODEX_COMPANION_SESSION_ID;
delete process.env.CODEX_COMPANION_TRANSCRIPT_PATH;
// SessionStart hooks append to CLAUDE_ENV_FILE; a leaked value would let a
// test spawn of the hook mutate the developer's live session env file.
delete process.env.CLAUDE_ENV_FILE;
// The stop gate falls back to CLAUDE_PROJECT_DIR for its cwd.
delete process.env.CLAUDE_PROJECT_DIR;

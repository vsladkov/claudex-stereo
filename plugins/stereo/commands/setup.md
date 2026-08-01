---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Happy path:

1. Install the Stereo plugin.
2. When the report's `- auth:` line is not ready, run `!codex login`; use
   `!codex login --device-auth` or `!codex login --with-api-key` when the report names those
   fallbacks.
3. Configure optional third-party provider keys only when the report lists unconfigured aliases
   or missing provider environment variables.
4. Optionally run `/stereo:setup --enable-review-gate` when `- review gate:` is disabled.
5. Optionally run `/stereo:config` to set workspace role defaults when `- role defaults:` says
   none are configured.
6. Verify the workspace with `/stereo:status` after the `- codex:` and `- auth:` checks are ready.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" setup "$ARGUMENTS --json"
```

If the result says Codex is unavailable and npm is available:

- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" setup "$ARGUMENTS --json"
```

If Codex is already installed or npm is unavailable:

- Do not ask about installation.

Output rules:

- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- Setup reports `needs attention` when Node is older than 24. Relay the Node >= 24 requirement
  with the exact found version because the plugin runs its `.ts` sources natively.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.
- Preserve the provider section verbatim when present: the active provider, each configured provider's key status, per-alias readiness, and any provider next steps. Exact environment-variable names matter.
- Always preserve stranded-reservation next steps with their exact file paths.

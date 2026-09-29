---
description: Check whether Codex and the Claude Code CLI are ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(npm install -g @openai/codex), AskUserQuestion
---

Happy path:

1. Install the Stereo plugin.
2. When the report's `- auth:` line is not ready, run `!codex login`; use
   `!codex login --device-auth` or `!codex login --with-api-key` when the report names those
   fallbacks.
3. When the `- claude:` or `- claude auth:` line is not ready, follow its next step: install or
   update Claude Code to the version the report names, or run `claude auth login`.
4. Configure optional third-party provider keys only when the report lists unconfigured aliases
   or missing provider environment variables.
5. Optionally run `/stereo:setup --enable-review-gate` when `- review gate:` is disabled.
6. Optionally run `/stereo:config` to set workspace role defaults when `- role defaults:` says
   none are configured.
7. Verify the workspace with `/stereo:status` after the `- codex:`, `- auth:`, `- claude:`, and
   `- claude auth:` checks are ready.

Use `/stereo:doctor` when install readiness is healthy but workspace runtime or durable state needs
inspection.

Raw slash-command arguments:
`$ARGUMENTS`

Parse them before running anything: the only accepted flags are `--enable-review-gate` and
`--disable-review-gate`, at most one of them. Reject any other token, and both flags together,
naming the two accepted flags. `<setupFlags>` is the accepted flag as its own argument, or nothing;
never pass the raw arguments through the shell. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" setup --json <setupFlags>
```

If the payload's `codex.available` is false and `npm.available` is true:

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
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" setup --json <setupFlags>
```

If Codex is already installed or npm is unavailable:

- Do not ask about installation.

Output rules:

- Print the payload's `rendered` field verbatim — the complete `# Stereo Setup` report — and relay
  its next steps as written, including every exact path, environment-variable name, and
  `!codex login` fallback. Never reconstruct, paraphrase, or reorder it.
- If installation was skipped, print the original run's `rendered` report.

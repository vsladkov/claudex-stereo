---
description: Show active and recent Codex jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all] [--verbose]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- When the user passed `--verbose`, do not compress the command output to the single compact table; include its per-job detail lines for log paths, timestamps, and progress.
- When the user did not pass `--verbose`, render the command output as a single Markdown table for the current and past runs in this session.
- Keep non-verbose output compact. Do not include progress blocks or extra prose outside the table, except for a `Warnings:` section from the command output.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.

Always preserve any `Warnings:` section and its file paths verbatim in both table and per-job presentations.

---
description: Show the stored pair plan document with its verdict, rounds, open questions, and residual risks
argument-hint: '[--open|--clear|--mark-implemented]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state`

Raw slash-command arguments:
`$ARGUMENTS`

Apply at most one action:

- With `--open`, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --open` and relay the
  exported path and whether VS Code opened.
- With `--clear`, use `AskUserQuestion` exactly once with `Delete the stored plan` and
  `Keep it (Recommended)`. Run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --clear` only when deletion
  is confirmed.
- With `--mark-implemented`, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --mark-implemented` and note
  that this marker is normally set automatically by `/stereo:implement` after a successful full
  phase.

Present the full command output to the user. Do not summarize or condense it.
Render the stored plan document as Markdown while preserving its contents verbatim.
Relay `implementedAt` when present; it means a full implementation phase completed with an
accepted review, not that the work was committed or merged.
If no plan is stored, relay the message and point the user to `/stereo:plan`.

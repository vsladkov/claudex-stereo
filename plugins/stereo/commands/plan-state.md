---
description: Show the stored pair plan document with its verdict, rounds, open questions, and residual risks
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state`

Present the full command output to the user. Do not summarize or condense it.
Render the stored plan document as Markdown while preserving its contents verbatim.
If no plan is stored, relay the message and point the user to `/stereo:plan`.

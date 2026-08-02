---
description: Transfer the current Claude Code session into a resumable Codex thread
argument-hint: '[--source <claude-jsonl>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Codex session ID and the `codex resume <session-id>` command.

Transfer is deliberately one-directional: Claude Code session → resumable Codex thread. It takes
no `--model` because the destination runtime is fixed, and there is no Codex → Claude direction
because Codex threads resume in Codex. For Codex work that should be reviewed or continued on the
Claude side, use `/stereo:adversarial-review --model claude:<alias>` or the Claude role routes in
`/stereo:plan`, `/stereo:implement`, and `/stereo:quick`.

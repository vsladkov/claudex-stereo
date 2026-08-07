---
description: Show or change this repository's default Claude/Codex model for each Stereo role
argument-hint: '[--planner <model>] [--planner-effort <effort>] [--plan-reviewer <model>] [--plan-reviewer-effort <effort>] [--implementer <model>] [--implementer-effort <effort>] [--implementation-reviewer <model>] [--implementation-reviewer-effort <effort>] [--clear <key>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" config "$ARGUMENTS"`

Present the command output verbatim. Relay every warning with the exact role and stored value it
names.

Explicit role flags take precedence over stored workspace defaults, which take precedence over
built-in defaults. The built-in defaults are `claude:fable` for the planner, `codex:sol` for the
plan reviewer, `claude:opus` for the implementer, and `codex:sol` for the implementation
reviewer, shared by the two phase commands and `/stereo:quick` alike. An unset role uses that
command's built-in default.

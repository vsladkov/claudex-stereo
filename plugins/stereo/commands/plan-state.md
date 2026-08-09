---
description: Show the stored pair plan document with its verdict, rounds, open questions, and residual risks, or compare two slots
argument-hint: '[--list] [--compare <slotA> <slotB>] [--open|--clear|--mark-implemented|--metadata] [--slot <name>]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --metadata`

Raw slash-command arguments:
`$ARGUMENTS`

The preamble shows the `default` slot's metadata only, so a flagged invocation never pays for a
plan document it will not use. With no arguments, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state` and present that full output
(metadata plus the stored plan document) instead of the preamble. With `--list`, `--compare`, or
an explicit `--slot`,
run the requested companion command and present that output instead.

Apply at most one action:

- With `--list`, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --list` and present the slot
  inventory verbatim. `--list` does not combine with `--slot`.
- With `--compare <slotA> <slotB>`, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --compare <slotA> <slotB>` and
  present the comparison verbatim: both metadata blocks and the plan diff. `--compare` names both
  slots, so it does not combine with `--slot` or another action. Both slots must hold a stored plan;
  on a missing-slot error, relay the message and point the user at
  `/stereo:plan-state --list`. When the diff is suppressed, relay the export hint instead of
  attempting a diff yourself.
- With `--open`, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --open [--slot <slot>]` and
  relay the exported path and whether VS Code opened.
- With `--clear` and an explicit slot, first run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json --slot <slot>` and use
  its summary, verdict, round, and `updatedAt` to describe that exact slot in the confirmation.
  Then use `AskUserQuestion` exactly once with `Delete the plan in slot <slot>` and
  `Keep it (Recommended)`. Without an explicit slot, retain the existing question:
  `Delete the stored plan and any implementation record` and `Keep it (Recommended)`. Run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --clear [--slot <slot>]` only
  when deletion is confirmed.
- With `--mark-implemented`, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --mark-implemented [--slot <slot>]`
  and note that this marker is normally set automatically by `/stereo:implement` after a
  successful full phase.
- With an explicit `--slot` and no action, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --slot <slot>`.

Present the full command output to the user. Do not summarize or condense it.
Render the stored plan document as Markdown while preserving its contents verbatim.
Clearing a slot removes the implementation record only when that record belongs to the cleared
slot. When `--clear` also removes an implementation record, preserve the extra status and path
lines. Relay the `Kept the implementation record...` line verbatim when it is present.
Relay `implementedAt` when present; it means a full implementation phase completed with an
accepted review, not that the work was committed or merged.
If no plan is stored, relay the message and point the user to `/stereo:plan`.

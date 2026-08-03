---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[job-id] [--workspace <path>] [--report]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" result "$ARGUMENTS"`

Use `--workspace <path>` to inspect jobs recorded against another repository root, such as the
main workspace used by a worktree-isolated `/stereo:implement --isolated` or
`/stereo:tournament` run.

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:

- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Any `Warnings:` section and its file paths verbatim
- Follow-up commands such as `/stereo:status <id>` and `/stereo:review`
- Following `codex-result-handling`, keep review findings in severity order with their evidence
  boundaries intact.
- `codex-result-handling` CRITICAL: After presenting review findings, stop. Never apply or offer to
  apply a fix; ask the user which issues to fix before touching a file.

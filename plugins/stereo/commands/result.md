---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[job-id] [--report]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:

- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Any `Warnings:` section and its file paths verbatim
- Follow-up commands such as `/stereo:status <id>` and `/stereo:review`

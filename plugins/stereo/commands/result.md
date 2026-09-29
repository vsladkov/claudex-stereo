---
description: Show the stored final output for a finished companion job in this repository
argument-hint: '[job-id] [--workspace <path>] [--report]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" result --args-stdin <<'STEREO_ARGS_Q7X2'
$ARGUMENTS
STEREO_ARGS_Q7X2
```

Use `--workspace <path>` to inspect jobs recorded against another repository root, such as the
main workspace used by a worktree-isolated `/stereo:implement --isolated` or
`/stereo:tournament` run. `--report` prints only the report: the raw stored report on a completed
job, the rendered result body on a failed one.

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:

- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- The result body's heading and its closing `Model:`, token-usage, `Cost:`, session-id, and resume
  lines verbatim
- A failed job's `Run failed:` and `Denied:` lines
- File paths and line numbers exactly as reported
- Any error messages or parse errors; relay a `No finished …` error verbatim and direct the user
  to `/stereo:status`
- Any `Warnings:` section and its file paths verbatim
- Follow-up commands such as `/stereo:status <id>` and `/stereo:review`
- Review findings in severity order with their evidence boundaries intact.

After presenting review findings, stop. Never apply or offer to apply a fix; ask the user which
issues to fix before touching a file.

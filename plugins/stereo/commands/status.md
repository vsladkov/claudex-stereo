---
description: Show active and recent Codex jobs for this repository, including review-gate status
argument-hint: '[job-id] [--workspace <path>] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all] [--usage] [--verbose]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" status "$ARGUMENTS"`

Use `--workspace <path>` to inspect jobs recorded against another repository root, such as the
main workspace used by a worktree-isolated `/stereo:implement --isolated` or
`/stereo:tournament` run.

When the user passed `--usage`, present the usage headline and both tables verbatim. Preserve the
window and scope sentence exactly, including whether it covers this session or the workspace.
Never describe these local retained-job totals as Codex account usage or all-time history.

If the user did not pass a job ID:

- When the user passed `--verbose`, do not compress the command output to the single compact table; include its per-job detail lines for log paths, timestamps, and progress.
- When the user did not pass `--verbose`, render the command output as a single Markdown table for the current and past runs in this session.
- Keep non-verbose output compact. Preserve the `Session runtime:` and `Review gate:` header lines
  above the table, but do not include progress blocks or other prose outside the table except for
  a `Warnings:` section from the command output.
- Preserve the actionable fields the command output actually contains. Active jobs and the
  latest finished job carry job ID, kind, model, status, phase, elapsed or duration, summary, and
  follow-up commands; other recent jobs render as one line (id, status, kind, title, duration) —
  present that line as-is and never invent the fields it omits.
- Keep the `Model` column in the active-jobs table; it may show `model@provider`, and an absent model must remain `-`.

If the user did pass a job ID:

- Present the full command output to the user.
- Do not summarize or condense it.

Always preserve any `Warnings:` section and its file paths verbatim in both table and per-job presentations.

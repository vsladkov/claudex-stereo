---
description: Show active and recent companion jobs for this repository, including review-gate status
argument-hint: '[job-id] [--workspace <path>] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--brief] [--all] [--usage] [--verbose]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" status --args-stdin <<'STEREO_ARGS_Q7X2'
$ARGUMENTS
STEREO_ARGS_Q7X2
```

Use `--workspace <path>` to inspect jobs recorded against another repository root, such as the
main workspace used by a worktree-isolated `/stereo:implement --isolated` or
`/stereo:tournament` run. `--all` lists every session's jobs in this workspace, not only this
session's, and lifts the cap on recent finished jobs.

`--brief` with a job ID prints one line, `<status> <phase> <elapsedSeconds>s`; present it verbatim.
A `stalled` phase means the job's worker process is gone, so no wait will settle it: point to
`/stereo:cancel <id>`.

When the user passed `--usage`, present the `# Stereo Usage` headline and both tables verbatim.
Preserve the window and scope sentence exactly, including whether it covers this session or the
workspace. Never describe these local retained-job totals as Codex or Claude account usage or
all-time history.

If the user did not pass a job ID:

- When the user passed `--verbose`, do not compress the command output to the single compact table; include its per-job detail lines for log paths, timestamps, and progress.
- When the user did not pass `--verbose`, render the command output as a single Markdown table for the current and past runs in this session (or in the whole workspace with `--all`).
- Keep non-verbose output compact. Keep the `# Stereo Status` heading and preserve the
  `Session runtime:` and `Review gate:` header lines above the table, but do not include progress
  blocks or other prose outside the table except for a `Warnings:` section from the command
  output.
- Preserve the actionable fields the command output actually contains. Active jobs and the
  latest finished job carry job ID, kind, model, status, phase, elapsed or duration, summary, and
  follow-up commands; other recent jobs render as one line (id, status, kind, title, duration) —
  present that line as-is and never invent the fields it omits. Present each job's kind as printed
  (a task that ran a role is labelled by that role).
- Keep the `Model` column in the active-jobs table; it may show `model@provider`, and an absent model must remain `-`.

If the user did pass a job ID:

- Present the full `# Stereo Job Status` output to the user.
- Do not summarize or condense it; preserve its `Model:`, session-id, and resume lines verbatim.

Always preserve any `Warnings:` section and its file paths verbatim in both table and per-job presentations.

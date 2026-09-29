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

If the user did not pass a job ID, present the command output as printed: the `# Stereo Status`
heading, the `Session runtime:` and `Review gate:` lines, the active-jobs table with its `Model`
column, the latest finished job, and the other recent jobs. Add no field the output omits and no
commentary of your own. `--verbose` adds per-job detail lines for log paths, timestamps, and
progress; present those as printed too.

If the user did pass a job ID:

- Present the full `# Stereo Job Status` output to the user.
- Do not summarize or condense it; preserve its `Model:`, session-id, and resume lines verbatim.

Always preserve any `Warnings:` section and its file paths verbatim in both table and per-job presentations.

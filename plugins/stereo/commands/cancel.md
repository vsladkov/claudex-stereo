---
description: Cancel an active background companion job in this repository
argument-hint: '[job-id] [--workspace <path>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" cancel --args-stdin <<'STEREO_ARGS_Q7X2'
$ARGUMENTS
STEREO_ARGS_Q7X2
```

Use `--workspace <path>` to cancel jobs recorded against another repository root, such as the main
workspace used by a worktree-isolated `/stereo:implement --isolated` or `/stereo:tournament` run.

Present the rendered `# Stereo Cancel` result verbatim without summarizing it, including every
warning and path it prints: a `Stored job file is unreadable:` warning; a
`Job <id> already finished (<status>); nothing to cancel.` line, which is not an error — point to
`/stereo:result <id>` for its output; and a warning naming a process the cancel could not confirm
stopped, which the user ends themselves.

Relay these failure paths exactly and follow each with a direction to run `/stereo:status`:

- `No active job found for "<ref>".`
- `Job reference "<ref>" is ambiguous. Use a longer job id.`
- `Multiple companion jobs are active. Pass a job id to /stereo:cancel.`
- `No active companion jobs to cancel for this session.` A job owned by another session is
  cancelled by its explicit id; also direct the user to `/stereo:status --all`.
- `No active companion jobs to cancel.`

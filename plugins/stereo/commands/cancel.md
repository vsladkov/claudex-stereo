---
description: Cancel an active background Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" cancel "$ARGUMENTS"`

Present the rendered result verbatim without summarizing it. Preserve any
`Stored job file is unreadable:` warning and its path.

Relay these failure paths exactly and follow each with a direction to run `/stereo:status`:

- `No active job found for "<ref>".`
- `Job reference "<ref>" is ambiguous. Use a longer job id.`
- `Multiple Codex jobs are active. Pass a job id to /stereo:cancel.`
- `No active Codex jobs to cancel for this session.` A job owned by another session is reachable
  only by explicit id; also direct the user to `/stereo:status --all`.
- `No active Codex jobs to cancel.`

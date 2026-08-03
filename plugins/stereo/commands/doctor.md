---
description: Inspect this workspace's Stereo runtime and durable diagnostic state
argument-hint: '[--reset-job-announcements]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" doctor "$ARGUMENTS --json"
```

Output rules:

- Present the complete diagnostics output after the embedded setup report.
- Preserve every reported path verbatim, especially the broker log, durable state directory, and
  stranded-worktree removal commands.
- When an implementation record is in progress, name `/stereo:implement --resume` as the
  continuation path.
- Describe an unavailable model-catalog check as "not checked"; it is never a diagnostics
  failure.
- Point to `/stereo:setup` for installation, authentication, sandbox, provider, or rate-limit
  remediation.

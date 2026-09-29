---
description: Inspect this workspace's Stereo runtime and durable diagnostic state
argument-hint: '[--reset-job-announcements]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Raw slash-command arguments:
`$ARGUMENTS`

Parse them before running anything: the only accepted flag is `--reset-job-announcements`, at most
once. Reject any other token, naming the accepted flag. `<doctorFlags>` is that flag as its own
argument, or nothing; never pass the raw arguments through the shell. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" doctor --json <doctorFlags>
```

Output rules:

- Print the payload's `rendered` field verbatim — the complete diagnostics, the embedded setup
  report included — and relay its next steps. Never reconstruct, paraphrase, reorder, or shorten
  it, and preserve every path exactly, especially the broker log, the durable state directory,
  and the stranded-worktree removal commands.
- A stalled job's next step is `/stereo:cancel <id>`, which settles it; doctor itself never changes
  a job.
- Point to `/stereo:setup` for Codex or Claude Code installation, authentication, sandbox,
  provider, or rate-limit remediation.

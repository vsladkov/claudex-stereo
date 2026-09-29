---
description: Show or change this repository's default Claude/Codex model for each Stereo role
argument-hint: '[--planner <model>] [--planner-effort <effort>] [--plan-reviewer <model>] [--plan-reviewer-effort <effort>] [--implementer <model>] [--implementer-effort <effort>] [--implementation-reviewer <model>] [--implementation-reviewer-effort <effort>] [--claude-sandbox on|off] [--clear <key>]...'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" config --args-stdin <<'STEREO_ARGS_Q7X2'
$ARGUMENTS
STEREO_ARGS_Q7X2
```

Present the command output verbatim. Relay every warning with the exact role and stored value it
names.

`--clear <key>` may be repeated, and `--clear roles` clears every stored role default at once.
`--claude-sandbox on|off` stores whether a named Claude implementer runs under Claude Code's own
Bash sandbox (off by default).

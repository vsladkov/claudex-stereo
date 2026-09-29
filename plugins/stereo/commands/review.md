---
description: Run a code review against local git state on Codex or Claude
argument-hint: '[--wait|--background] [--native] [--base <ref>] [--pr <n>] [--scope auto|working-tree|branch] [--model <model-or-alias>] [--effort <effort>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git rev-parse:*), Bash(git check-ref-format:*), Bash(git show-ref:*), Bash(git symbolic-ref refs/remotes/origin/HEAD), Bash(gh pr view:*), AskUserQuestion
---

First Read `${CLAUDE_PLUGIN_ROOT}/skills/model-routing/review-procedure.md` and run its "Standalone
review procedure" with the rules below. The allowed tools pre-approve only `gh pr view` and the
read-only git subcommands that procedure runs.

Run one standard implementation-quality review: the `reviewer` role, briefed by
`${CLAUDE_PLUGIN_ROOT}/prompts/review.md` and validated against
`${CLAUDE_PLUGIN_ROOT}/schemas/review-output.schema.json` on every route. If the user needs more
adversarial framing, point to `/stereo:adversarial-review`.

Raw slash-command arguments:
`$ARGUMENTS`

`--native` opts a Codex selection into Codex's built-in reviewer, the same reviewer as `/review`
inside Codex. It exposes no reasoning-effort control, takes no focus text, and reviews only the
working tree or a base branch, so the companion rejects `--effort`, trailing text, and other
targets with it; relay those errors verbatim. It passes no effort and, unless `--model` names one,
no model, so Codex's own configured defaults apply. Reject `--native` with a Claude selection
before repository work, pointing at the reviewer role.

Companion launch lines (Codex or named Claude):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" review <reviewArgs> <focusFileArg>
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" review <reviewArgs> --background <focusFileArg>
```

The inline `claude:session` path fills `${CLAUDE_PLUGIN_ROOT}/prompts/review.md`.

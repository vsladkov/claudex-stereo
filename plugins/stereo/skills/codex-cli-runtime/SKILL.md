---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `stereo:codex-rescue` subagent.

Primary helper — the flags as separate arguments, the task text on stdin through a quoted heredoc:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task <taskFlags> <<'STEREO_EOF'
<task text>
STEREO_EOF
```

- `<taskFlags>` is each routing flag as its own argument, in this order when present: `--write`,
  `--background`, `--resume` (or `--resume-last`) or `--fresh`, `--model '<selection>'`, and
  `--effort '<effort>'`,
  every value single-quoted (an embedded `'` becomes `'"'"'`). Nothing else goes on the command
  line: never put the task text, or any other user text, in an argument or a shell string.
- The task text — the user's request with the routing flags removed, or the prompt the
  `codex-prompting` skill tightened from it — goes between the heredoc lines verbatim. The quoted
  delimiter `'STEREO_EOF'` keeps the shell from expanding anything inside it. If a line of the text
  is exactly `STEREO_EOF`, append digits to the delimiter (`STEREO_EOF_2`) on both lines until no
  line of the text matches it. With `--resume` and no new text, omit the heredoc.
- Run the Bash call with a `timeout` of 600000 ms (the tool's maximum): a foreground rescue task
  routinely outlasts the default two minutes.

Execution rules:

- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `stereo:codex-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `codex-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort, and then forward the value verbatim. Never invent an effort the user did not ask for.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one, then pass that value through verbatim, with or without its `codex:` prefix.
- The companion resolves and validates the model and the effort itself. Never resolve, expand, or check either value; a value the companion refuses comes back as the failure line below.
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:

- Use exactly one `task` invocation per rescue handoff.
- The Agent invocation and Bash call are always foreground. Strip `--wait` and make a foreground
  `task` call; map `--background` to `task --background`. Neither flag is part of the
  natural-language task text.
- If the forwarded request includes `--model`, pass its value to `task` as `--model '<selection>'`
  without expanding aliases.
- If the forwarded request includes `--effort`, pass its value to `task` as `--effort '<effort>'`.
- Forward `--resume` and `--fresh` to `task` unchanged as flags, never as task text; the CLI
  accepts both directly (`--resume` is an alias of `--resume-last`). `--resume` always resumes,
  and `--fresh` always runs fresh, even when the request text is ambiguous.
- `--effort`: the values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run; it continues this session's latest rescue thread.

Safety rules:

- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return exactly
  `Codex rescue failed: <first line of the error>. Run /stereo:setup to check the Codex CLI.` and
  add nothing else.

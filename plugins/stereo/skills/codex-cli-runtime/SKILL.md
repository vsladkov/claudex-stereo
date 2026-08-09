---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `stereo:codex-rescue` subagent.

Primary helper:

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task "<raw arguments>"`

Execution rules:

- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `stereo:codex-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `codex-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort. Task runs never inject an effort default; the pair workflow applies defaults only to OpenAI `gpt-*` models. An explicit `--effort` is forwarded verbatim, including for provider models that may ignore or reject it. Never invent an effort the user did not ask for.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one, then pass that value through verbatim — a model id or one of the plugin aliases (`codex:mini`, `codex:sol`, `codex:terra`, `codex:luna`, `codex:kimi`, `codex:qwen`, `codex:deepseek`, `codex:glm`); the runtime resolves aliases itself, and `/stereo:setup` shows each provider alias's readiness. The bare form without the `codex:` prefix is also accepted; forward either verbatim because the runtime strips the prefix.
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:

- Use exactly one `task` invocation per rescue handoff.
- The Agent invocation and Bash call are always foreground. Strip `--wait` and make a foreground
  `task` call; map `--background` to `task --background`. Neither flag is part of the
  natural-language task text.
- If the forwarded request includes `--model`, pass it through to `task` without expanding aliases.
- If the forwarded request includes `--effort`, pass it through to `task`.
- Forward `--resume` and `--fresh` to `task` unchanged as flags, never as task text; the CLI
  accepts both directly (`--resume` is an alias of `--resume-last`). `--resume` always resumes,
  and `--fresh` always runs fresh, even when the request text is ambiguous.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:

- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return exactly
  `Codex rescue failed: <first line of the error>. Run /stereo:setup to check the Codex CLI.` and
  add nothing else.

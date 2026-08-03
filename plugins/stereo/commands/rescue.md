---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: '[--background|--wait] [--resume|--fresh] [--model <codex-model-or-alias>] [--effort <none|minimal|low|medium|high|xhigh|max>] [what Codex should investigate, solve, or continue]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `stereo:codex-rescue` subagent via the `Agent` tool (`subagent_type: "stereo:codex-rescue"`), forwarding the raw user request as the prompt.
`stereo:codex-rescue` is a subagent, not a skill — do not call `Skill(stereo:codex-rescue)` (no such skill) or `Skill(stereo:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Codex's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- The `Agent` invocation and the subagent's single `Bash` call are always foreground, so there is
  always stdout to return verbatim.
- `--background` is forwarded to the companion `task` call as `--background`; its stdout is the
  launch record naming the job id and `/stereo:status <jobId>`.
- `--wait` is never forwarded; it selects a foreground companion `task` call.
- If neither flag is present, let the subagent choose whether to add `task --background` from the
  request's size and complexity.
- Do not treat `--background` or `--wait` as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task`
  call, but do not treat them as part of the natural-language task text. If `--model` starts with
  `claude:`, stop before invoking the subagent and explain that `/stereo:rescue` is a Codex bridge:
  `stereo:codex-rescue` only forwards to the companion `task` runtime. For Claude-routed work, ask
  this session directly; use `/stereo:quick --implementer claude:<alias>` or
  `/stereo:implement --implementer claude:<alias>` for a contained Claude implementer; or use
  `/stereo:adversarial-review --model claude:<alias>` for a Claude review.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Codex, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task ...` and return that command's stdout as-is.
- Return the Codex companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/stereo:status`, fetch `/stereo:result`, call `/stereo:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort. Task runs never inject an effort default; the pair workflow applies defaults only to OpenAI `gpt-*` models. An explicit `--effort` is forwarded verbatim, including for provider models that may ignore or reject it. Never invent an effort the user did not ask for.
- Leave the model unset unless the user explicitly asks for one. Otherwise pass the user's
  `--model` value through verbatim — a model id or one of the plugin aliases (`codex:mini`,
  `codex:sol`, `codex:terra`, `codex:luna`, `codex:kimi`, `codex:qwen`, `codex:deepseek`,
  `codex:glm`); the runtime resolves aliases itself, and `/stereo:setup` shows each provider
  alias's readiness. The bare form without the `codex:` prefix is also accepted; forward either
  verbatim because the runtime strips the prefix. The runtime rejects `claude:*` values, so a
  Claude selection must never be forwarded.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/stereo:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.

---
name: model-routing
description: Internal routing, foreground-agent, validation, persistence, and Codex background-job rules for Stereo pair workflows
user-invocable: false
---

# Model Routing

Apply these rules whenever a Stereo command routes a planner, reviewer, implementer, or
adversarial reviewer. Let the command's step-specific prompts and loop rules override generic
wording here.

## Model addressing

Interpret selections as follows:

| Selection        | Route                                                     |
| ---------------- | --------------------------------------------------------- |
| `claude:session` | Run inline in the current Claude session                  |
| `claude:sonnet`  | Run the named foreground agent with `model: "sonnet"`     |
| `claude:opus`    | Run the named foreground agent with `model: "opus"`       |
| `claude:haiku`   | Run the named foreground agent with `model: "haiku"`      |
| `claude:fable`   | Run the named foreground agent with `model: "fable"`      |
| Anything else    | Pass the requested Codex model to the companion unchanged |

Allow `claude:session` for planner, plan-reviewer, implementation-reviewer, and
adversarial-reviewer roles. Reject it for the implementer: Claude writes must stay inside the
contained `stereo:implementer` agent.

Never pass a `claude:*` selection to the companion. Reject unknown `claude:*` values before
starting work.

For Codex pair roles, use the user-supplied `--effort` when present. Otherwise use `max` for the
`gpt-5.6` family, `xhigh` for other `gpt-*` models, and omit `--effort` for non-OpenAI models.
Preserve command-specific stored-model/stored-effort rules when the command defines them.

Claude foreground and inline invocations do not expose a per-invocation reasoning-effort control.
Never translate `--effort` into thinking-keyword prompt tricks. When more Claude-side reasoning is
needed, recommend selecting a stronger Claude model instead.

## Foreground agents

Always invoke these agents in the foreground. Supply the command's complete step-specific context
where a bracketed placeholder appears.

Planner:

```text
subagent_type: "stereo:planner"
model: "<sonnet|opus|haiku|fable>"
run_in_background: false
prompt: |
  [filled ${CLAUDE_PLUGIN_ROOT}/prompts/plan-draft.md]
```

Validate that the result has exactly these second-level headings, once each and in order:
`Goal`, `Approach`, `Files to change`, `Step-by-step changes`, `Testing and verification`,
`Risks and edge cases`, and `Out of scope`.

Plan reviewer:

```text
subagent_type: "stereo:plan-reviewer"
model: "<sonnet|opus|haiku|fable>"
run_in_background: false
prompt: |
  [filled ${CLAUDE_PLUGIN_ROOT}/prompts/plan-review.md]
```

Validate the top-level object and every required field, enum, array, finding field, confidence
range, and non-empty string required by
`${CLAUDE_PLUGIN_ROOT}/schemas/plan-review-output.schema.json`.

Implementer:

```text
subagent_type: "stereo:implementer"
model: "<sonnet|opus|haiku|fable>"
run_in_background: false
prompt: |
  Apply only the requested file edits. Never request command execution.
  [full plan, baseline dirty paths, and optional numbered fixes]
```

Validate that the report contains `Files touched`, `Plan steps completed`, and `Deviations`.
Inspect the actual worktree rather than trusting the report's file list.

Implementation reviewer:

```text
subagent_type: "stereo:implementation-reviewer"
model: "<sonnet|opus|haiku|fable>"
run_in_background: false
prompt: |
  [filled ${CLAUDE_PLUGIN_ROOT}/prompts/implementation-review.md]
```

Validate `acceptable`, non-empty `summary`, and `fixes`; validate every fix's non-empty `file`,
positive-integer `line`, non-empty `problem`, and non-empty `correct`. Require empty fixes when
acceptable and at least one fix otherwise.

Adversarial reviewer:

```text
subagent_type: "stereo:adversarial-reviewer"
model: "<sonnet|opus|haiku|fable>"
run_in_background: false
prompt: |
  Apply the filled adversarial-review prompt below to the named git target.
  [filled ${CLAUDE_PLUGIN_ROOT}/prompts/adversarial-review.md]

  Return only raw JSON matching
  ${CLAUDE_PLUGIN_ROOT}/schemas/review-output.schema.json.
```

Validate the top-level object and every field required by
`${CLAUDE_PLUGIN_ROOT}/schemas/review-output.schema.json`, including verdict enums, finding
severity, positive line ranges, confidence range, recommendation, and `next_steps`.

After every foreground Agent invocation, record the token usage and duration reported in the
Agent result. If the harness omits either metric, record `usage unavailable` for the missing
metric instead of dropping it. Include these per-invocation metrics in the command's round note
and final report wherever Codex per-invocation usage is reported.

For malformed agent output, retry the same selected agent once with the exact validation error and
the full original input. If the retry is also malformed, ask whether to perform the step inline or
stop without inferring a verdict. For an Agent tool or selected-model availability error, report
the error verbatim and stop immediately; never substitute a different model.

## Codex background jobs

Launch every Codex pair turn with the command's step-specific companion invocation plus
`--background --json`. Parse the launch object's `jobId`. Poll in bounded windows:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" status <jobId> --wait --timeout-ms 90000 --json
```

After every non-terminal poll, report the job phase, elapsed time, and last entry of
`job.progressPreview`. Poll again while status is `queued` or `running`. At terminal status, fetch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" result <jobId> --json
```

Treat a top-level `{"error": ...}` from launch, status, or result as a command failure: surface it
and stop or follow the command's explicit retry rule. Do not confuse an empty terminal
`progressPreview` with missing progress.

From every successful `result <jobId> --json` fetch, record `storedJob.tokenUsage.job` as that
invocation's usage. `storedJob.tokenUsage.thread` is cumulative for the whole Codex thread: it may
be reported separately only when labeled cumulative, and must never be compared with a single
Claude invocation. If `tokenUsage` or the relevant counter is absent, record `usage unavailable`
instead of omitting the usage line. Carry each invocation's usage into the command's round notes
and final report.

Track the last phase and last progress entry. Only treat a job as stalled after roughly ten
minutes with neither a phase change nor a new progress entry. Ask whether to keep waiting
(recommended) or cancel the active step and stop. Elapsed time alone is not a stall.

If Codex is unavailable or unauthenticated, stop and direct the user to `/stereo:setup`. Never
replace a requested model after an availability or provider error.

## Quoting

Pass task, plan, diff, and finding bodies through quoted heredoc stdin with a step-specific fixed
delimiter. Never use an unquoted heredoc. Shell-quote each short metadata argument independently
with single quotes, replacing an embedded `'` with `'"'"'`. Never interpolate reviewer or task
text unquoted into a shell command.

## Plan persistence

Codex `plan-review` stores every successfully parsed round automatically. Claude-side review
results do not. Whenever a command reaches a terminal Claude-side plan verdict, persist the full
current plan with `plan-store`, the actual verdict and round, the reviewer label, summary, and each
open question and residual risk as its own repeatable option. Do this before transitioning to
implementation or returning control to the user.

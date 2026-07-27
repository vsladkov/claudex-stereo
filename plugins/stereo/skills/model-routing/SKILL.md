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

| Selection        | Route                                                             |
| ---------------- | ----------------------------------------------------------------- |
| `claude:session` | Run inline in the current Claude session                          |
| `claude:inherit` | Run the named foreground agent with the `model` parameter omitted |
| `claude:sonnet`  | Run the named foreground agent with `model: "sonnet"`             |
| `claude:opus`    | Run the named foreground agent with `model: "opus"`               |
| `claude:haiku`   | Run the named foreground agent with `model: "haiku"`              |
| `claude:fable`   | Run the named foreground agent with `model: "fable"`              |
| Anything else    | Pass the requested Codex model to the companion unchanged         |

`claude:inherit` requests the platform's model inheritance. With the Agent `model` parameter
omitted, `CLAUDE_CODE_SUBAGENT_MODEL` wins when that environment variable is set; otherwise the
agent frontmatter's `model: inherit` resolves to the main conversation's model. Record the
effective model reported by the Agent result in the invocation note; if it is not exposed, label
the effective model `unavailable` rather than guessing.

Allow `claude:session` for planner, plan-reviewer, implementation-reviewer, and
adversarial-reviewer roles. Reject it for the implementer: Claude writes must stay inside the
contained `stereo:implementer` agent.

Never pass a `claude:*` selection to the companion. Reject unknown `claude:*` values before
starting work.

Resolve effort independently for each active Codex-routed role:

1. Use that role's effort flag when present.
2. Otherwise use the command-wide `--effort` when present.
3. Otherwise preserve the command's stored-model/stored-effort rule, when it has one, or use
   `max` for every `gpt-*` model and omit `--effort` for non-OpenAI models.

A role effort flag is valid only when that role runs in the selected mode and is Codex-routed;
reject it for an inactive or Claude-routed role. A role or command-wide effort override replaces
the stored implementer effort. An explicit implementer model with neither effort override clears
the stored effort because it belongs to the old model, then uses the normal model-pair default.

Claude-side reasoning has three distinct controls. Stereo's agent definitions omit `effort`, so
Claude-routed roles inherit the session's effort and extended-thinking configuration. Subagents
have no per-subagent thinking setting; `ultrathink` is the only recognized thinking keyword and
applies to the main turn, so never translate `--effort` into prompt tricks. Agent definitions do
support an `effort` frontmatter field (`low|medium|high|xhigh|max`, availability
model-dependent), which overrides session effort. A modified copy under `.claude/agents/` can be
invoked manually, but it cannot shadow the plugin-scoped `stereo:*` agent types used by these
commands. Model selection remains the per-invocation Claude strength control; dynamic
per-invocation Claude effort is not available on the Agent invocation surface.

## Foreground agents

Always invoke these agents in the foreground. Supply the command's complete step-specific context
where a bracketed placeholder appears.

For `claude:sonnet|opus|haiku|fable`, include the explicit `model` parameter shown below. For
`claude:inherit`, omit the `model` parameter entirely; do not pass the string `inherit` or a null
value.

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

## Continuing an agent across plan-review rounds

This rule applies only to named-Claude plan-review loops. Implementation-review invocations stay
stateless in both ecosystems. Inline `claude:session` plan reviews already share the main
conversation and do not use this rule.

Round 1 always invokes `stereo:plan-reviewer` with the complete filled `planReviewBrief` and keeps
the returned agent continuation handle only for the current command run. For every later round:

1. When the harness exposes agent follow-up or resume, continue that same reviewer. Send a compact
   round message containing the round number, the full revised plan, the instruction to verify its
   own earlier findings and the recorded responses or descopes, and a reminder to return the same
   plan-review output contract. Do not resend the full role brief.
2. Validate the continued result against the same schema. If it is malformed, continue the same
   agent once more with the exact validation error and the full revised plan.
3. If continuation is unavailable, errors, or remains malformed after that retry, invoke a fresh
   `stereo:plan-reviewer` of the same selected model for that round. Give it the complete filled
   brief with the prior findings, responses, open questions, and complete residual risks embedded
   in `{{REVISION_CONTEXT}}`, exactly as the stateless flow does. Apply the normal validation and
   one-retry rule to this fresh invocation, and use its continuation handle for any later round.

A continuation transport or Agent-tool error uses this fresh-agent fallback instead of the
generic immediate-stop rule above. If that fresh invocation reports a selected-model availability
error, surface it and stop without substituting a model.

Continuation never crosses command runs or Claude sessions. Every new command starts with a fresh
round-1 agent. For each continued round, report the token usage and duration from that follow-up's
result when the harness provides them; otherwise report `usage unavailable`.

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

Write every Codex task, plan, diff, and finding payload to a file in a temporary directory outside
the user's repository, using the Write tool. Prefer the session scratch directory when the
harness provides one; otherwise use a unique `mktemp -d`-style location under the operating
system's temporary directory. Never write payload files into the user's repository. Deliver plan
documents with `plan-review --plan-file "<payloadFile>"`, task and brief payloads with
`task --prompt-file "<payloadFile>"`, and stored plans through stdin. Store a Claude review's
findings array as JSON in a distinct `<findingsPayloadFile>`; never overwrite the plan payload with
the findings payload. Payload file contents must never pass through the shell.
Shell-quote each short metadata argument independently with single quotes, replacing an embedded
`'` with `'"'"'`. Never interpolate reviewer or task text unquoted into a shell command.

## Plan persistence

Codex `plan-review` stores every successfully parsed round automatically. Claude-side review
results do not. Whenever a command reaches a terminal Claude-side plan verdict, persist the full
current plan with `plan-store`, the actual verdict and round, the reviewer label, summary,
findings, and each open question and residual risk. Write the full plan to `<payloadFile>` and the
findings array as JSON to the distinct `<findingsPayloadFile>`, then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-store --json --verdict '<actual verdict>' --round <reviewRound> --reviewed-by '<reviewer label>' --summary '<summary>' --findings-file "<findingsPayloadFile>" <repeated --open-question/--residual-risk args> < "<payloadFile>"
```

Do this before transitioning to implementation or returning control to the user.

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

| Selection           | Route                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `claude:session`    | Run inline in the current Claude session                                                                                   |
| `claude:inherit`    | Run the named foreground agent with the `model` parameter omitted                                                          |
| `claude:sonnet`     | Run the named foreground agent with `model: "sonnet"`                                                                      |
| `claude:opus`       | Run the named foreground agent with `model: "opus"`                                                                        |
| `claude:haiku`      | Run the named foreground agent with `model: "haiku"`                                                                       |
| `claude:fable`      | Run the named foreground agent with `model: "fable"`                                                                       |
| `codex:<selection>` | The written form for Codex-side models; pass it to the companion unchanged — it strips exactly one leading `codex:` prefix |
| Anything else       | A bare Codex selection, equivalent to its `codex:` form; pass it to the companion unchanged                                |

The prefix names the executing runtime, not the model vendor. `claude:` is required because it
names a closed six-value set; every other selection runs through the Codex companion runtime,
including third-party provider aliases. On the Codex side, `codex:` is optional addressing sugar:
pass it unchanged, and the companion strips exactly one occurrence before resolving aliases,
providers, and effort defaults. The prefix never changes routing, effort, or persistence.
Present Codex-side selections with the `codex:` prefix in user-facing reports; state and job
fields store the resolved model id, which is never prefixed.

### One-runtime surfaces

The remaining one-runtime surfaces and route asymmetries are deliberate:

- `/stereo:review` uses Codex's built-in reviewer (`review/start`) on the Codex path, with no
  reasoning-effort control, and a foreground structured review against
  `schemas/review-output.schema.json` on the Claude path. `--effort` is rejected on both paths, and
  `--background` remains Codex-only.
- `/stereo:rescue` and `/stereo:transfer` are Codex bridges. A `claude:*` `--model` is rejected on
  rescue, and transfer is Claude → Codex only.
- `--background` creates durable Codex jobs. Claude agent runs are session-bound and never appear
  in `/stereo:status`.
- `--effort` and `--*-effort` are Codex runtime controls. Model selection is the Claude strength
  control; the detailed Claude-side controls are described below.
- Stored-plan `model`/`effort` record the last Codex pair values only; they never resolve the
  implementer, whose selection is the role flag, the durable workspace default
  (`/stereo:config --implementer <model>`), or the built-in `claude:opus`.

`claude:inherit` requests the platform's model inheritance. With the Agent `model` parameter
omitted, `CLAUDE_CODE_SUBAGENT_MODEL` wins when that environment variable is set; otherwise the
agent frontmatter's `model: inherit` resolves to the main conversation's model. Record the
effective model reported by the Agent result in the invocation note; if it is not exposed, label
the effective model `unavailable` rather than guessing.

Allow `claude:session` for planner, plan-reviewer, reviewer, implementation-reviewer, and
adversarial-reviewer roles. Reject it for the implementer: Claude writes must stay inside the
contained `stereo:implementer` agent.

Never pass a `claude:*` selection to the companion. Reject unknown `claude:*` values and
`codex:claude:*` before starting work.

Resolve effort independently for each active Codex-routed role:

1. Use that role's effort flag when present.
2. Otherwise use the command-wide `--effort` when present.
3. Otherwise use that role's valid stored workspace effort default when present.
4. Otherwise preserve the command's stored-plan model/effort rule, when it has one, or use the
   selected model's registry pair default when it is a registry row (`xhigh` for
   `codex:mini`/`gpt-5.4-mini`; `max` for the other OpenAI rows), use `max` for an unregistered
   raw `gpt-*` id, and omit `--effort` for non-OpenAI selections.

A role effort flag is valid only when that role runs in the selected mode and is Codex-routed;
reject it for an inactive or Claude-routed role. A role or command-wide effort override replaces
the stored-plan implementer effort. An explicit or workspace-supplied implementer model with
neither effort override clears the stored-plan effort because it belongs to the old model, then
uses the workspace effort default or normal model-pair default.
When no active role is Codex-routed, a command-wide `--effort` is inert: accept it, report it as
inert, and never translate it into a Claude-side control.

Claude-side reasoning has three distinct controls. Stereo's agent definitions omit `effort`, so
Claude-routed roles inherit the session's effort and extended-thinking configuration. Subagents
have no per-subagent thinking setting; `ultrathink` is the only recognized thinking keyword and
applies to the main turn, so never translate `--effort` into prompt tricks. Agent definitions do
support an `effort` frontmatter field (`low|medium|high|xhigh|max`, availability
model-dependent), which overrides session effort. A modified copy under `.claude/agents/` can be
invoked manually, but it cannot shadow the plugin-scoped `stereo:*` agent types used by these
commands. Model selection remains the per-invocation Claude strength control; dynamic
per-invocation Claude effort is not available on the Agent invocation surface.

## Workspace role defaults

Before any routed step in `/stereo:plan`, `/stereo:implement`, or `/stereo:quick`, read this
repository's defaults with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" config --json
```

If that read fails, report the failure and continue with the command's built-in defaults. The
four canonical entries and matching flags are `planner` / `--planner`, `planReviewer` /
`--plan-reviewer`, `implementer` / `--implementer`, and `implementationReviewer` /
`--implementation-reviewer`. For each role, resolve the model as explicit role flag > valid
stored workspace default > command built-in default. Resolve a Codex role's effort with the
ladder above. A stored effort attached to a Claude-routed selection is inert: report it and do not
pass it anywhere.

State is deliberately read tolerantly. When an entry has a non-null `invalidReason`, relay its
warning with the exact role and stored value, ignore the whole entry, and use the built-in default
for that role. A stored `claude:*` value is a routing selection resolved by the command; it is
never passed to the companion's `--model` flag.

The implementer resolves as explicit flag > workspace implementer default > `claude:opus`.
Stored-plan `model`/`effort` record the last Codex pair values for the plan and never resolve the
implementer; stored-plan effort belongs to the stored model and is never borrowed by a different
selection. A Codex-routed implementer's effective effort is role flag > command-wide effort >
workspace implementer effort default > that model's pair default. Stored review-thread resumption
is independent of these choices.

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
  Implement the plan below. Your shell exists only to build the repository and run its tests
  and static checks: fix the build and unit-test failures your changes introduced before
  reporting, report suspected pre-existing failures instead of fixing them, and never claim a
  result from a command you did not run. The orchestrator remains the authority for anything
  not run on this host.
  [full plan, baseline dirty paths, known pre-existing baseline failures, worktree target when
  isolated, and optional numbered fixes]
```

Validate that the report contains `Files touched`, `Plan steps completed`, `Verification`, and
`Deviations`. Inspect the actual worktree rather than trusting the report's file list.

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

Reviewer:

```text
subagent_type: "stereo:reviewer"
model: "<sonnet|opus|haiku|fable>"
run_in_background: false
prompt: |
  Apply the filled review prompt below to the named git target.
  [filled ${CLAUDE_PLUGIN_ROOT}/prompts/review.md]

  Return only raw JSON matching
  ${CLAUDE_PLUGIN_ROOT}/schemas/review-output.schema.json.
```

Validate the top-level object and every field required by
`${CLAUDE_PLUGIN_ROOT}/schemas/review-output.schema.json`, including verdict enums, finding
severity, positive line ranges, confidence range, recommendation, and `next_steps`.

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

If a foreground agent is killed mid-turn — a session limit, a transport failure, an interrupted
harness — resume it through its agent handle first: a resumed agent keeps its progress, and every
edit it completed is already on disk, so never discard or redo that work. Re-invoke the role
fresh only when resumption itself fails, and tell the fresh agent what the killed run already
changed.

For malformed agent output, retry the same selected agent once with the exact validation error and
the full original input. If the retry is also malformed, ask whether to perform the step inline or
stop without inferring a verdict. For an Agent tool or selected-model availability error, report
the error verbatim and stop immediately; never substitute a different model.

## Continuing an agent across review rounds

This rule applies to named-Claude plan-review and implementation-review loops within one command
run. Inline `claude:session` reviews already share the main conversation and do not use it. Codex
plan reviews resume `planReviewThreadId` under the plan commands' own round rule. Codex
implementation reviews stay stateless by design: every round launches a fresh read-only `task`,
and `implementationReviewThreadId` remains a malformed-output retry target only. A Codex round
must carry the fully filled `implementationReviewBrief` either way, so resuming would add thread
history without removing payload cost and would weaken the cross-ecosystem reviewer's per-round
fresh-task independence. A mode that runs exactly one review round, such as
`/stereo:plan --review-only` or `/stereo:implement --review-only`, keeps no continuation handle.

The same mechanics extend to the contained `stereo:implementer` across fix turns within one
command run: keep its continuation handle from the implementation turn and continue it for a
gate-fix or review-driven fix turn with a compact message carrying only the numbered fixes or
attributed gate failures (with exit statuses and output tails) — the plan, baseline context, and
conduct rules are already in its context and are not resent. Validate the same four-label report
either way. When continuation is unsupported, errors, or stays malformed after one continued
retry, re-invoke a fresh implementer with the complete brief — full plan, baseline-dirty paths,
known pre-existing baseline failures, the worktree target and provisioning status when isolated,
and the fixes — and keep its handle for later turns. A
Codex implementer needs none of this: its fix turns already resume `implementationThreadId`.

Round 1 always invokes the role's agent: `stereo:plan-reviewer` with the complete filled
`planReviewBrief`, or `stereo:implementation-reviewer` with the complete filled
`implementationReviewBrief`. Keep the returned continuation handle only for the current command
run. For every later round:

1. When the harness exposes agent follow-up or resume, continue that same reviewer with a compact
   round message; do not resend the full role brief. The message always carries the round number,
   what changed since the last round, an instruction to verify its own earlier findings, and a
   reminder to return the same output contract. Its role-specific contents are:
   - Plan review: the full revised plan plus the recorded responses or descopes for its earlier
     findings.
   - Implementation review: every numbered fix from that reviewer's last round with the
     orchestrator's `resolved`/`unresolved` assessment presented as a claim to be judged, the
     latest fix-round implementer report verbatim, and the latest host-verification results. The
     plan, baseline semantics, and round-1 review context are unchanged and are not resent.
     Because the delta itself is not in the message, instruct the reviewer to re-inspect the
     current worktree rather than judge from memory.
2. Validate the continued result against the same schema that route uses. If malformed, continue
   the same agent once more with the exact validation error and the same round message.
3. If continuation is unavailable, errors, or remains malformed after that retry, invoke a fresh
   agent of the same selected model for that round with the complete filled brief: a
   `planReviewBrief` whose `{{REVISION_CONTEXT}}` embeds prior findings, responses, open questions,
   and complete residual risks, or an `implementationReviewBrief` whose `{{REVIEW_CONTEXT}}`
   embeds the complete `implementationReviewHistory`, exactly as the stateless flow does. Apply
   the normal validation and one-retry rule to that fresh invocation, and use its continuation
   handle for any later round.

Maintain the stateless `## Reviewer responses` history or `implementationReviewHistory` every
round even while continuing, because a later round can always fall back to a fresh fully briefed
agent.

A continuation transport or Agent-tool error uses this fresh-agent fallback instead of the
generic immediate-stop rule above. If that fresh invocation reports a selected-model availability
error, surface it and stop without substituting a model.

Continuation never crosses command runs or Claude sessions. Every new command starts with a fresh
round-1 agent. `/stereo:implement --resume` therefore always re-briefs statelessly on its first
resumed round; across command runs, the durable implementation-state record rather than the
conversation carries `implementationReviewHistory`. For every review round, report the token
usage and duration from its invocation or
follow-up when the harness provides them; otherwise report `usage unavailable`. Also report
whether the round was continued or re-briefed.

## Codex background jobs

Launch every Codex pair turn with the command's step-specific companion invocation plus
`--background --json`. Parse the launch object's `jobId`. Poll in bounded windows with this
rendered single-pipe command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" status <jobId> --wait --timeout-ms 90000 | grep -E 'Phase|Elapsed|^ {4}'
```

Polls run in the foreground and are never backgrounded. A poll is exactly one command and one
plain `grep`: never use a multi-command chain, a background watcher, or an interpreter pipeline
such as `node -e`, `jq`, or `python`. The four-space-indented lines retained by the grep are the
`progressPreview` entries. After every non-terminal window, report the phase, elapsed time, and
last progress entry as text between tool calls, then poll again while the job is queued or
running. If the poll exits nonzero or prints nothing, rerun it once without the pipe to read the
full error, then apply the failure rule below. At terminal status, fetch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" result <jobId> --json
```

A prose-report job (an implementation or fix `task` launched without `--output-schema`) may instead
be fetched with `result <jobId> --report --json`. That payload contains `jobId`, `status`, `report`,
`threadId`, and `tokenUsage`; save the thread id and apply the `tokenUsage.job` recording rule to
its top-level `tokenUsage`. A schema-validated job must keep the full fetch because it needs
`storedJob.result` and `parseError`. A `null` report means re-fetch with the full `--json` form.

Treat a top-level `{"error": ...}` from launch or result, or an error from the rendered status
poll, as a command failure: surface it and stop or follow the command's explicit retry rule. Do
not confuse an empty terminal `progressPreview` with missing progress.

A malformed-output retry relaunches on the same thread carrying the original `--model` and effort
selection arguments plus a `--prompt-file` retry instruction that names the exact validation
error. A bare `--thread` retry is prohibited because it silently runs the Codex CLI default model.

From every successful full `result <jobId> --json` fetch, record `storedJob.tokenUsage.job` as that
invocation's usage. `storedJob.tokenUsage.thread` is cumulative for the whole Codex thread: it may
be reported separately only when labeled cumulative, and must never be compared with a single
Claude invocation. If `tokenUsage` or the relevant counter is absent, record `usage unavailable`
instead of omitting the usage line. Carry each invocation's usage into the command's round notes
and final report.

When the fetched result payload carries `droppedNotifications`, report that count and note that
the run dropped that many malformed notifications, so its captured progress and diff data may be
incomplete.

Track the last phase and last progress entry. Only treat a job as stalled after roughly ten
minutes with neither a phase change nor a new progress entry. Ask whether to keep waiting
(recommended) or cancel the active step and stop. Elapsed time alone is not a stall.

If Codex is unavailable or unauthenticated, stop and direct the user to `/stereo:setup`. Never
replace a requested model after an availability or provider error.

## Quoting

Write every Codex task, plan, diff, and model-generated metadata payload to a file in a temporary
directory outside the user's repository, using the Write tool. Prefer the session scratch
directory when the harness provides one; otherwise use a unique `mktemp -d`-style location under
the operating system's temporary directory. Never write payload files into the user's repository.
Deliver plan documents with `plan-review --plan-file "<payloadFile>"`, task and brief payloads with
`task --prompt-file "<payloadFile>"`, and stored plans through stdin. Store a Claude review's
summary, findings, open questions, and residual risks in distinct `<summaryPayloadFile>`,
`<findingsPayloadFile>`, `<openQuestionsPayloadFile>`, and `<residualRisksPayloadFile>` files. None
of those metadata files is the plan payload file. Payload file contents must never pass through the
shell. Shell-quote only short controlled metadata tokens (`--verdict`, `--round`, `--reviewed-by`,
`--thread`, and `--slot`) independently with single quotes, replacing an embedded `'` with
`'"'"'`; model-generated prose never travels through a shell argument.

## Plan persistence

Codex `plan-review` stores every successfully parsed round automatically. Claude-side review
results do not. Whenever a command reaches a terminal Claude-side plan verdict, persist the full
current plan with `plan-store`, the actual verdict and round, the reviewer label, summary,
findings, and each open question and residual risk. Write the full plan to `<payloadFile>`, the
summary as plain text to `<summaryPayloadFile>`, and the findings, open questions, and residual
risks as JSON arrays to their distinct metadata files. Questions and risks are JSON string arrays;
write `[]` when either is empty. Always write and pass all four metadata files, then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-store --json <slotArg> --verdict '<actual verdict>' --round <reviewRound> <--thread <planReviewThreadId>|--no-thread> --reviewed-by '<reviewer label>' --summary-file "<summaryPayloadFile>" --findings-file "<findingsPayloadFile>" --open-questions-file "<openQuestionsPayloadFile>" --residual-risks-file "<residualRisksPayloadFile>" < "<payloadFile>"
```

`<slotArg>` is `--slot <slot>` when the invoking command targets a non-default slot and is omitted
otherwise.

Pass `--thread <planReviewThreadId>` when this run holds a Codex plan-review thread for the
persisted plan, and `--no-thread` otherwise; a persist never silently inherits a stored thread.

Do this before transitioning to implementation or returning control to the user.

---
description: Draft and adversarially review an implementation plan with independently selected Claude or Codex models
argument-hint: '[--planner-model <model>] [--model <review-model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--max-plan-rounds <n>] [task description]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion, Agent
---

Run the planning half of the dual-model pair workflow through the shared plugin runtime.
The main Claude session orchestrates drafting and adversarial review; the selected Claude or Codex
model performs each routed step. Implementation is separate: the user starts it later with
`/stereo:implement`. Never start implementing from this command.

Raw slash-command arguments:
`$ARGUMENTS`

Scope of the result-handling rules:

- This command is a deliberate, user-invoked iterative workflow.
- Within it, the `codex-result-handling` rule to STOP after presenting findings applies only at the user-decision points defined below.
- Inside the plan-review loop, act on the reviewer's findings and revise the plan without asking the user.

Argument handling:

- Parse all arguments before inspecting the repository or starting an agent or Codex job. Reject
  missing flag values, duplicate model flags, invalid effort values, and unknown `claude:*` values
  before work.
- `--planner-model <model>` selects the drafter and defaults to `claude:session`.
- `--model <model>` selects the plan reviewer and defaults to `sol`.
- `--effort <none|minimal|low|medium|high|xhigh|max>` applies only to Codex-side selections. Never
  pass it to a Claude-side step.
- `--max-plan-rounds <n>` caps the review loop. If absent, the cap defaults to 6 — healthy loops
  approve in 2-5 rounds; a plan that cannot converge by then has a scope problem, not a detail
  problem.
- All remaining text is the task description. If it is empty, ask the user what to plan before
  doing anything else.

Model addressing is step-local:

- `claude:sonnet`, `claude:opus`, `claude:haiku`, and `claude:fable` select the corresponding
  foreground Claude subagent model override.
- `claude:session` selects inline work by the main session and is valid for both drafting and plan
  review.
- Anything not beginning with `claude:` is a Codex model request. Forward aliases, raw ids, and
  qualified `model@provider` values to the companion, which resolves them with
  `normalizeRequestedModel`.
- For Codex `plan-review`, let the companion apply its pair defaults when effort is absent. For a
  Codex draft task, use the same pair rules: gpt-5.6-family models use `max`, other `gpt-*` models
  use `xhigh`, and non-OpenAI models omit effort. A user `--effort` always wins.

Use `<plannerSelectionArgs>` and `<reviewSelectionArgs>` below for the applicable
`--model <selectedCodexModel>` plus optional effective `--effort`. Never pass Claude-prefixed
values to the companion.

Every Codex turn is launched with `--background --json`; never wait on a long turn in one
foreground Bash call. Parse `jobId`, poll until terminal, post phase/elapsed/latest
`job.progressPreview` updates, and fetch the stored result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" status <jobId> --wait --timeout-ms 90000 --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" result <jobId> --json
```

If a launch or poll prints a top-level `{"error": ...}`, surface it and stop. Treat no phase change
and no new progress entry for roughly 10 minutes as stalled; ask `Keep waiting (Recommended)` or
`Cancel the review and stop`. Elapsed time alone is not a stall.

Phase 0.5 - Draft routing:

- Explore the repository first with Read, Glob, and Grep until the draft can name exact files,
  symbols, and integration points.
- The self-contained plan document must contain exactly these headings once each and in order:
  `## Goal`, `## Approach`, `## Files to change`, `## Step-by-step changes`,
  `## Testing and verification`, `## Risks and edge cases`, `## Out of scope`.
- The plan must stand alone: the reviewer sees only the plan text plus the repository, never this
  conversation.
- Keep the plan proportional to the task. If an honest draft needs more than roughly 400 lines,
  propose a split before launching round 1.
- Do not write the plan into the user's repository. Deliver Codex inputs via quoted heredoc stdin
  so the shell never expands plan or task text.

Route by `--planner-model`:

- `claude:session`: inspect the repository read-only and draft the seven-section plan inline,
  preserving today's default behavior.
- A named Claude model: invoke the planner in the foreground:

```text
subagent_type: "stereo:planner"
model: "<sonnet|opus|haiku|fable>"
run_in_background: false
prompt: |
  Explore this repository read-only and draft the requested seven-section plan.
  Task:
  [task text verbatim]
```

- A Codex model: launch one read-only task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json <plannerSelectionArgs> <<'CODEX_PAIR_PLAN'
<task>
Explore this repository read-only and draft an implementation plan for the task below.

[task text verbatim]
</task>
<output_contract>
Return only the plan document with exactly these headings once each and in order:
## Goal
## Approach
## Files to change
## Step-by-step changes
## Testing and verification
## Risks and edge cases
## Out of scope
No preamble, Markdown fence, or trailing commentary.
</output_contract>
CODEX_PAIR_PLAN
```

For a Codex draft, read `storedJob.result.rawOutput` and save its thread id only as
`plannerThreadId`. It never becomes a plan-review or implementation thread.

Validate the seven headings before review. On malformed named-Claude or Codex output, retry the
same planner once with the exact validation error appended. A Claude retry is a new foreground
Agent call with `run_in_background: false`; a Codex retry resumes `plannerThreadId` with a
read-only `task --background --json --thread <plannerThreadId>`. If the second result is malformed,
draft inline. An Agent tool/model availability error is not malformed output: report it verbatim
and stop instead of silently changing the selected model. For the inline route, correct any
heading validation error inline before review.

Phase 2 - Review loop:

Maintain `reviewRound`, the current plan, latest summary/findings/instructions/questions/risks,
the selected reviewer kind, and an optional `planReviewThreadId`. Both reviewer ecosystems use the
exact contract in `plugins/stereo/schemas/plan-review-output.schema.json`.

Route every round by `--model`:

- `claude:session`: adversarially inspect the plan and repository inline, producing the schema's
  data as internal loop state.
- A named Claude model: call the reviewer in the foreground:

```text
subagent_type: "stereo:plan-reviewer"
model: "<sonnet|opus|haiku|fable>"
run_in_background: false
prompt: |
  Review round [reviewRound].
  [For rounds above 1: prior verdict, findings, responses, questions, and residual risks.]

  Full current plan:
  [plan text verbatim]

  Return only raw JSON matching plugins/stereo/schemas/plan-review-output.schema.json.
```

Claude rounds have no persistent thread. Include the full plan and bounded prior-round context
in every invocation.

- A Codex model: launch round 1 without `--thread`; later rounds resume only
  `planReviewThreadId`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --round 1 <reviewSelectionArgs> <<'CODEX_PAIR_PLAN'
<full plan document>
CODEX_PAIR_PLAN
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --thread <planReviewThreadId> --round <n> <reviewSelectionArgs> <<'CODEX_PAIR_PLAN'
<full revised plan document>
CODEX_PAIR_PLAN
```

For named-Claude output, parse exactly one raw JSON object and validate every required field, enum,
array, and per-finding `severity`, `title`, `body`, `section`, `confidence`, and `recommendation`.
Retry one new foreground Agent invocation with `run_in_background: false`, including the validation
error. If that also fails, ask `Let the orchestrator review this round inline (Recommended)` or
`Stop and treat the plan as unapproved`; never infer a verdict.

For Codex output, read `storedJob.result`: `.threadId` (save and update it only as
`planReviewThreadId`), `.model`, `.effort`, `.result`, and `.parseError`. If `parseError` is set,
resubmit the same plan and round once on `planReviewThreadId`. If it fails again, show the raw
output and ask the same inline-review/stop question.

If a Codex job fails, recover according to the round: retry round 1 once fresh; retry a later round
once on `planReviewThreadId`. If that also fails, restart as round 1 fresh with accumulated
`## Reviewer responses` in the plan. Surface the error if the fresh restart fails.

After every completed round, report the round number, verdict, and finding count. On
`needs-revision`, address every finding with exactly one move:

1. Change the plan to fix it.
2. Rebut it under `## Reviewer responses` with concrete repository evidence.
3. Descope it: when the fix adds machinery beyond `## Goal` or fixes a pre-existing hazard the plan
   does not create, move it to `## Out of scope` as a documented residual with a suggested
   follow-up, and record the descope under `## Reviewer responses`.

Carry the complete latest `residual_risks`; fold material entries into `## Risks and edge cases`.
Keep `## Reviewer responses` bounded: full entries for standing rebuttals and the last 5 rounds,
with older accepted entries compressed to one line each. Resubmit automatically until approval or
a safeguard.

Stall safeguards (these are safeguards, not caps):

- At the round cap, or when the plan grows beyond roughly 1.5 times its first draft, review-added
  machinery attracts findings, the same finding survives two evidence-backed rebuttals, or the
  plan oscillates, ask `Split the plan (Recommended)`, `Keep iterating`, `Accept the plan as-is`,
  or `Stop here`.
- A split keeps the original core and descopes named follow-ups.
- `Accept the plan as-is` carries the current verdict and findings truthfully into implementation.

When a Claude-side reviewer (named agent or session) approves, persist the final record. Also
persist after a user accepts a Claude-reviewed plan as-is, using its actual verdict. Pass every
question and risk as its own repeatable option. Shell-quote each short metadata value independently
with single quotes, replacing an embedded `'` with `'"'"'`; never interpolate reviewer text
unquoted:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-store --json --verdict '<verdict>' --round <reviewRound> --reviewed-by '<reviewer label>' --summary '<summary>' <repeated --open-question/--residual-risk args> <<'CODEX_PAIR_PLAN'
[full final plan text, verbatim]
CODEX_PAIR_PLAN
```

Codex plan review stores the same state automatically. Only a final Codex verdict on
`planReviewThreadId` permits later implementation-thread reuse; Claude-reviewed records correctly
store null thread/model/effort values.

Finish:

- Present the reviewed plan, final verdict, rounds used, reviewer kind, `open_questions`, and the
  complete `residual_risks`.
- Say whether the plan has a resumable Codex review thread. Label `plannerThreadId` separately and
  never present it as an implementation resume target.
- Tell the user to run `/stereo:implement`.
- If Codex is missing or unauthenticated at any point, stop and tell the user to run
  `/stereo:setup`.

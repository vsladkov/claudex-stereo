---
description: Draft or review a plan with independently selected Claude or Codex role models
argument-hint: '[--draft-only|--review-only] [--plan-file <path>] [--slot <name>] [--planner <model>] [--planner-effort <none|minimal|low|medium|high|xhigh|max>] [--plan-reviewer <model>] [--plan-reviewer-effort <none|minimal|low|medium|high|xhigh|max>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--max-plan-rounds <n>] [task description]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(git:*), AskUserQuestion, Agent
---

First Read `${CLAUDE_PLUGIN_ROOT}/skills/model-routing/SKILL.md` and apply its routing, foreground
agent, validation, persistence, quoting, and background-job rules. The rules below are
step-specific.

Run the planning phase of the Stereo workflow. The current Claude session orchestrates; the
selected planner and plan-reviewer perform their routed steps. Never implement from this command.

Raw slash-command arguments:
`$ARGUMENTS`

## Arguments and modes

After reading the routing skill, parse every argument before inspecting the repository or starting
a routed step:

- `--planner <model>` selects the drafter and defaults to `claude:opus`.
- `--planner-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort for a
  Codex-routed planner.
- `--plan-reviewer <model>` selects the plan reviewer and defaults to `claude:fable`.
- `--plan-reviewer-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort for a
  Codex-routed plan reviewer.
- `--effort <none|minimal|low|medium|high|xhigh|max>` is the command-wide default for
  Codex-routed roles that have no role effort flag.
  When no active role is Codex-routed, as under the command defaults, accept `--effort` but report
  that it is inert rather than silently dropping it.
- `--max-plan-rounds <n>` defaults to 6.
- `--slot <name>` selects the durable plan slot this run stores into and defaults to `default`.
  Slot names are trimmed, lowercased, may contain only letters, digits, hyphens, and underscores,
  and must start with a letter or digit. Relay the CLI's validation error verbatim.
- `--draft-only` runs one draft step, stores it, and stops.
- `--review-only` reviews the stored plan exactly once and stops.
- `--plan-file <path>` reviews that external plan exactly once and is valid only with
  `--review-only`.
- Without a mode flag, run the complete draft-plus-review/revision phase.

Reject missing values, duplicate role or role-effort flags, invalid effort or round values,
unknown flags, unknown `claude:*` values, and both mode flags together. Accept `claude:inherit`
alongside `claude:session` and the four explicit Claude aliases. Accept a Codex selection with or
without the `codex:` prefix and reject `codex:claude:*`. The removed `--planner-model` and reviewer
`--model` flags are unknown; report the role-named replacements.

For `--review-only`, reject task text, `--planner`, and `--planner-effort`. Reject `--plan-file`
with `--draft-only` or the full phase and say that it requires `--review-only`. For `--draft-only`,
reject `--plan-reviewer`, `--plan-reviewer-effort`, and `--max-plan-rounds`. Reject a role effort
flag when its selected role is Claude-routed. Resolve each active Codex role through the routing
skill's role effort > command-wide effort > workspace role effort > model default hierarchy. Full
phase and `--draft-only` require task text; if it is empty, ask the user what to plan.

Define these invocation placeholders before any routed step:

- `<plannerSelectionArgs>` = `--model <effectivePlannerModel> <plannerEffortArg>`.
- `<reviewSelectionArgs>` =
  `--model <effectivePlanReviewerModel> <planReviewerEffortArg>`.
- `<plannerEffortArg>` and `<planReviewerEffortArg>` are `--effort <resolved effort>` when the
  corresponding role's resolved effort is non-null, and are omitted entirely otherwise.
- `<slotArg>` = `--slot <slot>` when this run targets a non-default slot, and is omitted entirely
  for the `default` slot.

The `task` command injects no server-side effort default, so omitting the planner `--effort`
silently loses a resolved `max` for a `gpt-*` planner. `plan-review` does default a missing
`--effort` to the selected model's pair default, so the reviewer placeholder enforces consistency
rather than correcting runtime behavior.

The `codex-result-handling` stop-after-findings rule applies at explicit user-decision points and
to `--review-only`. During the full phase's review loop, revise automatically.

## Workspace role defaults

Before any routed step, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" config --json
```

Read `roleDefaults`. If the command fails, report that failure and continue with built-in
defaults. If an entry has a non-null `invalidReason`, report it and use the built-in default for
that role. Resolve the planner as `--planner` > stored `planner` > `claude:opus`, and the plan
reviewer as `--plan-reviewer` > stored `planReviewer` > `claude:fable`. For each Codex-routed role,
resolve effort as role effort flag > command-wide `--effort` > stored role effort > model pair
default. Report a stored effort for a Claude-routed role as inert. Resolve stored `claude:*`
selections as Claude routes and never pass them to the companion's `--model` flag.

## Stored-plan overwrite guard

Apply this guard only to a run that will store new plan content: the full phase, `--draft-only`, or
`--review-only --plan-file`. Plain `--review-only` reviews the stored target slot and skips this
guard entirely. Run the guard before drafting or routing any review:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json <slotArg>
```

If `available` is false, continue. If `implementedAt` is present, report it and continue without
asking. If `available` is true and `implementedAt` is absent, name the stored summary, verdict,
round, and `updatedAt`, then use `AskUserQuestion` exactly once with:

- `Replace the plan in slot <slot>`
- `Keep it; store this run in a new slot`
- `Stop here`

For the new-slot choice, derive a candidate from the task text for the full phase or `--draft-only`,
and from the plan file's extension-stripped basename for `--plan-file` intake. Lowercase it,
collapse non-alphanumeric runs to `-`, trim leading and trailing hyphens, and limit it to 32
characters. Check the candidate against `plan-state --list --json`; append `-2`, `-3`, and so on
until it is unused. Set `<slot>` and `<slotArg>` to that result and announce the chosen slot before
continuing. This guard is the single replacement confirmation for every mode it covers.

## Stored-plan review step

For `--review-only`, skip drafting. With `--plan-file`, perform external intake first:

1. Report the target slot's stored summary from the overwrite-guard read when one exists. This step
   is informational; do not ask a second replacement question.
2. Read `<planFile>` from the exact user-provided path. Keep its exact bytes as the current plan.
   Warn, but do not reject it, when any of the seven canonical headings are absent.
3. Always start an independent round 1 with no stored review thread. Fill the normal
   `planReviewBrief` with the external plan, round `1`, empty repo map, and empty revision context.
4. Route exactly one review. For a Codex reviewer, pass the user's path through unchanged; do not
   make a temporary copy:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --round 1 <slotArg> <reviewSelectionArgs> --plan-file "<planFile>"
```

For `claude:session` apply the brief inline; for a named Claude model use it verbatim as the
`stereo:plan-reviewer` prompt. Validate and retry once under the routing skill. A successful Codex
review persists automatically. For a Claude-side result, write the summary as plain text and the
findings, open questions, and residual risks as JSON arrays (`[]` for empty lists) to distinct
`<summaryPayloadFile>`, `<findingsPayloadFile>`, `<openQuestionsPayloadFile>`, and
`<residualRisksPayloadFile>` files. Persist the user's exact file bytes with no thread:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-store --json <slotArg> --verdict '<actual verdict>' --round 1 --no-thread --reviewed-by '<reviewer label>' --summary-file "<summaryPayloadFile>" --findings-file "<findingsPayloadFile>" --open-questions-file "<openQuestionsPayloadFile>" --residual-risks-file "<residualRisksPayloadFile>" < "<planFile>"
```

Report the verdict, findings, questions, risks, and reviewer usage/duration. Name the stored slot
and give its matching implementation command (`/stereo:implement` for `default`, or
`/stereo:implement --slot <slot>` otherwise), then stop.

Without `--plan-file`, review the stored plan:

1. Load:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json <slotArg>
```

2. If `available` is false, stop with: `Run /stereo:plan first.`
3. Use the exact stored `plan` as the current plan. Always perform an independent round 1; do not
   resume a stored thread.
4. Read `${CLAUDE_PLUGIN_ROOT}/prompts/plan-review.md` and fill it without changing any other
   text:
   - `{{PLAN_INPUT}}` = the full stored plan.
   - `{{ROUND_NUMBER}}` = `1`.
   - `{{REPO_MAP}}` = empty; the Claude reviewer inspects the repository with its native tools.
   - `{{REVISION_CONTEXT}}` = empty because this is an independent round 1.
     The result is the single `planReviewBrief` for either Claude route.
5. Route exactly one round through `--plan-reviewer`:
   - For `claude:session`, apply `planReviewBrief` inline and produce structured loop state.
   - For a named Claude model, use `planReviewBrief` verbatim as the routing skill's
     `stereo:plan-reviewer` prompt.
   - For Codex, write the full stored plan verbatim to `<payloadFile>` under the routing skill's
     temporary-directory rule, then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --round 1 <slotArg> <reviewSelectionArgs> --plan-file "<payloadFile>"
```

Use the routing skill's validation and one-retry recovery. Read Codex results from
`storedJob.result`, including `threadId`, `model`, `effort`, `result`, and `parseError`, and record
the invocation usage using the routing skill's `storedJob.tokenUsage` rule.

Codex plan review stores a successfully parsed result automatically. For a Claude-side result,
persist the actual verdict, even `needs-revision`, with the full plan and complete question and risk
arrays. Write the full stored plan verbatim to `<payloadFile>` under the routing skill's
temporary-directory rule. Under the same rule, write the summary as plain text and the findings,
open questions, and residual risks as JSON arrays (`[]` for empty lists) to distinct
`<summaryPayloadFile>`, `<findingsPayloadFile>`, `<openQuestionsPayloadFile>`, and
`<residualRisksPayloadFile>` files, then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-store --json <slotArg> --verdict '<actual verdict>' --round 1 <--thread <threadId reported by plan-state>|--no-thread> --reviewed-by '<reviewer label>' --summary-file "<summaryPayloadFile>" --findings-file "<findingsPayloadFile>" --open-questions-file "<openQuestionsPayloadFile>" --residual-risks-file "<residualRisksPayloadFile>" < "<payloadFile>"
```

Pass the `threadId` reported by `plan-state` with `--thread` when present; otherwise pass
`--no-thread`.

Report the verdict, findings, revision instructions, open questions, complete residual risks, and
the reviewer's per-invocation usage and duration (or `usage unavailable`) verbatim. Name the stored
slot and give its matching implementation command (`/stereo:implement` for `default`, or
`/stereo:implement --slot <slot>` otherwise). Do not revise or implement.

## Draft step

For the full phase or `--draft-only`, the selected planner must inspect the repository read-only
until the draft can name exact files, symbols, callers, configuration, registration points, and
tests. For `claude:session`, the orchestrator performs that exploration before drafting inline;
otherwise the named Claude or Codex planner performs it in the routed step and the orchestrator
skips a separate up-front exploration. During the full review loop, the orchestrator still
inspects the repository as needed to judge findings, revise the plan, and support rebuttals with
concrete evidence.

Read `${CLAUDE_PLUGIN_ROOT}/prompts/plan-draft.md` and fill it without changing any other text:

- `{{TASK_TEXT}}` = the task text verbatim.
- `{{SIZE_CONTRACT}}` = `If an honest draft needs more than roughly 400 lines, propose splitting
the task before review.`

The result is the single `planDraftBrief` for every route. Never write the draft into the user's
repository; a Codex route may write it only as a payload file under the routing skill's
temporary-directory rule.

Route by `--planner`:

- `claude:session`: apply `planDraftBrief` inline after read-only exploration.
- Named Claude: use `planDraftBrief` verbatim as the routing skill's `stereo:planner` prompt.
- Codex: write `planDraftBrief` verbatim to `<payloadFile>` under the routing skill's
  temporary-directory rule, then launch a fresh read-only task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json <plannerSelectionArgs> --prompt-file "<payloadFile>"
```

For a Codex draft, read `storedJob.result.rawOutput` and save its thread id only as
`plannerThreadId`. Record its per-job usage from `storedJob.tokenUsage.job`; never treat the
cumulative sibling `storedJob.tokenUsage.thread` as this invocation's usage. Never use the thread
as a review or implementation thread.

For a named-Claude draft, record the Agent result's token usage and duration. For an inline draft,
record any invocation metrics the harness exposes. Use `usage unavailable` when the relevant
result omits metrics.

Validate the seven headings. For malformed named-Claude output, apply the routing skill's single
retry. For malformed Codex output, apply the routing skill's malformed-output retry: write a retry
instruction naming the exact validation error, restating the seven-heading contract, and saying
"return the corrected full plan" to `<retryPayloadFile>` under the routing skill's
temporary-directory rule, then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --thread <plannerThreadId> <plannerSelectionArgs> --prompt-file "<retryPayloadFile>"
```

If the second result is malformed, ask whether to draft inline or stop. Correct malformed inline
output once; if it still violates the heading contract, ask whether to retry inline or stop.

For `--draft-only`, derive a one-line summary. Write the full draft plan verbatim to
`<payloadFile>` and the summary as plain text to `<summaryPayloadFile>` under the routing skill's
temporary-directory rule, then store the draft with no reviewer label:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-store --json <slotArg> --verdict 'draft' --round 0 --no-thread --summary-file "<summaryPayloadFile>" < "<payloadFile>"
```

Present the stored draft, identify the selected planner and its per-invocation usage/duration (or
`usage unavailable`), and stop. Name the stored slot. Say that the matching implementation command
(`/stereo:implement` for `default`, `/stereo:implement --slot <slot>` otherwise) will gate on the
unapproved `draft` verdict and that `--review-only` runs the next step.

## Full plan-review phase

Maintain `reviewRound`, the full current plan, the latest structured result, reviewer kind,
optional `planReviewThreadId`, the current named-Claude reviewer continuation handle, and the
complete residual-risk set. Both reviewer ecosystems use
`${CLAUDE_PLUGIN_ROOT}/schemas/plan-review-output.schema.json`.

For each round:

- For `claude:session`, named-Claude round 1, and any named-Claude stateless fallback, read
  `${CLAUDE_PLUGIN_ROOT}/prompts/plan-review.md` and fill it without changing any other text:
  - `{{PLAN_INPUT}}` = the full current plan.
  - `{{ROUND_NUMBER}}` = the current round.
  - `{{REPO_MAP}}` = empty; the Claude reviewer uses Read, Glob, Grep, and read-only Bash.
  - `{{REVISION_CONTEXT}}` = empty in round 1. For `claude:session` later rounds and a
    named-Claude stateless fallback, use the runtime's revision-context meaning: state that the
    plan responds to earlier findings; embed the earlier findings, responses, open questions, and
    complete residual risks; require every rebuttal to be verified; and prohibit re-auditing
    unchanged, previously accepted sections unless the revision changed their assumptions.
    Use the resulting `planReviewBrief` verbatim for the selected Claude route.
- `claude:session`: apply `planReviewBrief` inline into structured loop state.
- Named Claude round 1: use `planReviewBrief` as the foreground `stereo:plan-reviewer` prompt and
  retain its continuation handle for this command only.
- Later named-Claude rounds: apply the routing skill's
  "Continuing an agent across review rounds" rule. Continue the same reviewer with the round
  number, full revised plan, and self-verification instruction when supported; otherwise use the
  fully briefed stateless fallback above. Apply the same schema validation in either mode and
  report whether the round was continued or re-briefed.
- Codex round 1: write the full current plan verbatim to `<payloadFile>` under the routing skill's
  temporary-directory rule, then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --round 1 <slotArg> <reviewSelectionArgs> --plan-file "<payloadFile>"
```

- Later Codex rounds resume only `planReviewThreadId`. Write the full revised plan verbatim to
  `<payloadFile>` under the same temporary-directory rule, then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --thread <planReviewThreadId> --round <n> <slotArg> <reviewSelectionArgs> --plan-file "<payloadFile>"
```

Refresh `planReviewThreadId` only from successful Codex plan-review payloads. On `parseError`,
resubmit the same plan and round once on that thread. If it fails again, show the raw output and
ask whether the orchestrator should review inline or stop unapproved.

If a Codex job fails, retry round 1 once fresh or a later round once on `planReviewThreadId`. If
that fails, restart as round 1 fresh with accumulated `## Reviewer responses`; surface the error
if the restart also fails.

After every completed round, report its number, verdict, finding count, and the reviewer's
per-invocation usage and duration (or `usage unavailable`). On `needs-revision`, address every
finding exactly once:

1. Change the plan.
2. Rebut it under `## Reviewer responses` with concrete repository evidence.
3. Descope scope-expanding machinery or a pre-existing hazard into `## Out of scope`, record the
   descope in `## Reviewer responses`, and carry it as a residual.

Carry the complete latest `residual_risks` and fold material entries into
`## Risks and edge cases`. Keep reviewer responses bounded to standing rebuttals, the last five
rounds, and one-line summaries of older accepted responses.

Automatically continue until approval or a safeguard. At the configured cap, plan growth beyond
roughly 1.5 times the first draft, review-added machinery attracting findings, two surviving
evidence-backed rebuttals, or oscillation, ask whether to split (recommended), keep iterating,
accept as-is, or stop. A split retains the core and names follow-ups in `## Out of scope`.
Accept-as-is retains the actual verdict and findings.

Whenever the terminal reviewer is Claude-side, persist the full current plan and actual verdict
before finishing, following the routing skill's persistence rule. Codex rounds store
automatically. A Claude-side persist keeps a resumable Codex review thread only when it passes
`planReviewThreadId` through with `--thread`; `--no-thread` explicitly clears it.

Finish with the full plan, verdict, rounds, reviewer, open questions, complete residual risks, and
per-invocation usage/duration for every routed draft and review turn (using `usage unavailable`
when omitted), plus whether a resumable Codex review thread exists. Use
`storedJob.tokenUsage.job` for Codex turns and the Agent result's usage/duration for named Claude
turns. Label `storedJob.tokenUsage.thread` separately as cumulative when it is included; never
compare it with a single Claude invocation. Label `plannerThreadId` separately. Name the slot that
was stored and give the exact follow-up command: `/stereo:implement` for `default`, or
`/stereo:implement --slot <slot>` for a named slot. Never implement, commit, or push.

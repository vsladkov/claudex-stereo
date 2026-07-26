---
description: Draft or review a plan with independently selected Claude or Codex role models
argument-hint: '[--draft-only|--review-only] [--planner <model>] [--plan-reviewer <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--max-plan-rounds <n>] [task description]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion, Agent
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

- `--planner <model>` selects the drafter and defaults to `claude:session`.
- `--plan-reviewer <model>` selects the plan reviewer and defaults to `sol`.
- `--effort <none|minimal|low|medium|high|xhigh|max>` applies to every Codex-routed role.
- `--max-plan-rounds <n>` defaults to 6.
- `--draft-only` runs one draft step, stores it, and stops.
- `--review-only` reviews the stored plan exactly once and stops.
- Without a mode flag, run the complete draft-plus-review/revision phase.

Reject missing values, duplicate role flags, invalid effort or round values, unknown flags,
unknown `claude:*` values, and both mode flags together. The removed `--planner-model` and
reviewer `--model` flags are unknown; report the role-named replacements.

For `--review-only`, reject task text and `--planner`. For `--draft-only`, reject
`--plan-reviewer` and `--max-plan-rounds`. Full phase and `--draft-only` require task text; if it
is empty, ask the user what to plan.

The `codex-result-handling` stop-after-findings rule applies at explicit user-decision points and
to `--review-only`. During the full phase's review loop, revise automatically.

## Stored-plan review step

For `--review-only`, skip drafting:

1. Load:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json
```

2. If `available` is false, stop with: `Run /stereo:plan first.`
3. Use the exact stored `plan` as the current plan. Always perform an independent round 1; do not
   resume a stored thread.
4. Route exactly one round through `--plan-reviewer`:
   - For `claude:session`, review inline using the plan-review schema.
   - For a named Claude model, use the routing skill's `stereo:plan-reviewer` template.
   - For Codex, launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --round 1 <reviewSelectionArgs> <<'CODEX_PAIR_PLAN'
[full stored plan, verbatim]
CODEX_PAIR_PLAN
```

Use the routing skill's validation and one-retry recovery. Read Codex results from
`storedJob.result`, including `threadId`, `model`, `effort`, `result`, and `parseError`.

Codex plan review stores a successfully parsed result automatically. For a Claude-side result,
persist the actual verdict, even `needs-revision`, with the full plan and one option per question
and risk:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-store --json --verdict '<actual verdict>' --round 1 --reviewed-by '<reviewer label>' --summary '<summary>' <repeated --open-question/--residual-risk args> <<'CODEX_PAIR_PLAN'
[full stored plan, verbatim]
CODEX_PAIR_PLAN
```

Report the verdict, findings, revision instructions, open questions, and complete residual risks
verbatim. Do not revise or implement.

## Draft step

For the full phase or `--draft-only`, inspect the repository read-only until the draft can name
exact files, symbols, callers, configuration, registration points, and tests.

Produce a self-contained plan with exactly these headings once each and in order:

1. `## Goal`
2. `## Approach`
3. `## Files to change`
4. `## Step-by-step changes`
5. `## Testing and verification`
6. `## Risks and edge cases`
7. `## Out of scope`

If an honest draft needs more than roughly 400 lines, propose splitting the task before review.
Never write the draft into the user's repository.

Route by `--planner`:

- `claude:session`: draft inline after read-only exploration.
- Named Claude: use the routing skill's `stereo:planner` template with the task verbatim.
- Codex: launch a fresh read-only task:

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
`plannerThreadId`. Never use it as a review or implementation thread.

Validate the seven headings. For malformed named-Claude or Codex output, apply the routing skill's
single retry. A Codex retry resumes only `plannerThreadId` with a read-only
`task --background --json --thread <plannerThreadId>`. If the second result is malformed, ask
whether to draft inline or stop. Correct malformed inline output once; if it still violates the
heading contract, ask whether to retry inline or stop.

For `--draft-only`, derive a one-line summary and store the draft with no reviewer label:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-store --json --verdict 'draft' --round 0 --summary '<one-line summary>' <<'CODEX_PAIR_PLAN'
[full draft plan, verbatim]
CODEX_PAIR_PLAN
```

Present the stored draft, identify the selected planner, and stop. Say that `/stereo:implement`
will gate on the unapproved `draft` verdict and that `--review-only` runs the next step.

## Full plan-review phase

Maintain `reviewRound`, the full current plan, the latest structured result, reviewer kind,
optional `planReviewThreadId`, and the complete residual-risk set. Both reviewer ecosystems use
`${CLAUDE_PLUGIN_ROOT}/schemas/plan-review-output.schema.json`.

For each round:

- `claude:session`: review inline into structured loop state.
- Named Claude: use the routing skill's foreground `stereo:plan-reviewer` template with the full
  plan and bounded prior-round context.
- Codex round 1:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --round 1 <reviewSelectionArgs> <<'CODEX_PAIR_PLAN'
[full current plan, verbatim]
CODEX_PAIR_PLAN
```

- Later Codex rounds resume only `planReviewThreadId`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --thread <planReviewThreadId> --round <n> <reviewSelectionArgs> <<'CODEX_PAIR_PLAN'
[full revised plan, verbatim]
CODEX_PAIR_PLAN
```

Refresh `planReviewThreadId` only from successful Codex plan-review payloads. On `parseError`,
resubmit the same plan and round once on that thread. If it fails again, show the raw output and
ask whether the orchestrator should review inline or stop unapproved.

If a Codex job fails, retry round 1 once fresh or a later round once on `planReviewThreadId`. If
that fails, restart as round 1 fresh with accumulated `## Reviewer responses`; surface the error
if the restart also fails.

After every completed round, report its number, verdict, and finding count. On
`needs-revision`, address every finding exactly once:

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
automatically. Only a final Codex verdict on `planReviewThreadId` can supply a later resumable
review thread.

Finish with the full plan, verdict, rounds, reviewer, open questions, complete residual risks, and
whether a resumable Codex review thread exists. Label `plannerThreadId` separately. Tell the user
to run `/stereo:implement`. Never implement, commit, or push.

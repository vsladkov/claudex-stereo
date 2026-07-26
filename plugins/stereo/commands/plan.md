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
   - For Codex, launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --round 1 <reviewSelectionArgs> <<'CODEX_PAIR_PLAN'
[full stored plan, verbatim]
CODEX_PAIR_PLAN
```

Use the routing skill's validation and one-retry recovery. Read Codex results from
`storedJob.result`, including `threadId`, `model`, `effort`, `result`, and `parseError`, and record
the invocation usage using the routing skill's `storedJob.tokenUsage` rule.

Codex plan review stores a successfully parsed result automatically. For a Claude-side result,
persist the actual verdict, even `needs-revision`, with the full plan and one option per question
and risk:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-store --json --verdict '<actual verdict>' --round 1 --reviewed-by '<reviewer label>' --summary '<summary>' <repeated --open-question/--residual-risk args> <<'CODEX_PAIR_PLAN'
[full stored plan, verbatim]
CODEX_PAIR_PLAN
```

Report the verdict, findings, revision instructions, open questions, complete residual risks, and
the reviewer's per-invocation usage and duration (or `usage unavailable`) verbatim. Do not revise
or implement.

## Draft step

For the full phase or `--draft-only`, inspect the repository read-only until the draft can name
exact files, symbols, callers, configuration, registration points, and tests.

Read `${CLAUDE_PLUGIN_ROOT}/prompts/plan-draft.md` and fill it without changing any other text:

- `{{TASK_TEXT}}` = the task text verbatim.
- `{{SIZE_CONTRACT}}` = `If an honest draft needs more than roughly 400 lines, propose splitting
the task before review.`

The result is the single `planDraftBrief` for every route. Never write the draft into the user's
repository.

Route by `--planner`:

- `claude:session`: apply `planDraftBrief` inline after read-only exploration.
- Named Claude: use `planDraftBrief` verbatim as the routing skill's `stereo:planner` prompt.
- Codex: launch a fresh read-only task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json <plannerSelectionArgs> <<'CODEX_PAIR_PLAN'
[planDraftBrief, verbatim]
CODEX_PAIR_PLAN
```

For a Codex draft, read `storedJob.result.rawOutput` and save its thread id only as
`plannerThreadId`. Record its per-job usage from `storedJob.tokenUsage.job`; never treat the
cumulative sibling `storedJob.tokenUsage.thread` as this invocation's usage. Never use the thread
as a review or implementation thread.

For a named-Claude draft, record the Agent result's token usage and duration. For an inline draft,
record any invocation metrics the harness exposes. Use `usage unavailable` when the relevant
result omits metrics.

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

Present the stored draft, identify the selected planner and its per-invocation usage/duration (or
`usage unavailable`), and stop. Say that `/stereo:implement` will gate on the unapproved `draft`
verdict and that `--review-only` runs the next step.

## Full plan-review phase

Maintain `reviewRound`, the full current plan, the latest structured result, reviewer kind,
optional `planReviewThreadId`, and the complete residual-risk set. Both reviewer ecosystems use
`${CLAUDE_PLUGIN_ROOT}/schemas/plan-review-output.schema.json`.

For each round:

- For either Claude route, read `${CLAUDE_PLUGIN_ROOT}/prompts/plan-review.md` and fill it without
  changing any other text:
  - `{{PLAN_INPUT}}` = the full current plan.
  - `{{ROUND_NUMBER}}` = the current round.
  - `{{REPO_MAP}}` = empty; the Claude reviewer uses Read, Glob, Grep, and read-only Bash.
  - `{{REVISION_CONTEXT}}` = empty in round 1. In later rounds, use the runtime's revision-context
    meaning adapted for a stateless reviewer: state that the plan responds to earlier findings;
    embed the earlier findings, responses, open questions, and complete residual risks; require
    every rebuttal to be verified; and prohibit re-auditing unchanged, previously accepted
    sections unless the revision changed their assumptions.
    Use the resulting `planReviewBrief` verbatim for the selected Claude route.
- `claude:session`: apply `planReviewBrief` inline into structured loop state.
- Named Claude: use `planReviewBrief` as the foreground `stereo:plan-reviewer` prompt.
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
automatically. Only a final Codex verdict on `planReviewThreadId` can supply a later resumable
review thread.

Finish with the full plan, verdict, rounds, reviewer, open questions, complete residual risks, and
per-invocation usage/duration for every routed draft and review turn (using `usage unavailable`
when omitted), plus whether a resumable Codex review thread exists. Use
`storedJob.tokenUsage.job` for Codex turns and the Agent result's usage/duration for named Claude
turns. Label `storedJob.tokenUsage.thread` separately as cumulative when it is included; never
compare it with a single Claude invocation. Label `plannerThreadId` separately. Tell the user to
run `/stereo:implement`. Never implement, commit, or push.

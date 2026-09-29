---
description: Draft or review a plan with independently selected Claude or Codex role models
argument-hint: '[--draft-only|--review-only] [--plan-file <path>] [--slot <name>] [--planner <model>] [--planner-effort <effort>] [--plan-reviewer <model>] [--plan-reviewer-effort <effort>] [--max-plan-rounds <n>] [task description]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(git:*), AskUserQuestion
---

First Read `${CLAUDE_PLUGIN_ROOT}/skills/model-routing/SKILL.md`, then
`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/pair-procedures.md` and
`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/plan-procedures.md`, and apply their rules. The rules
below are step-specific; a quoted heading names the section of a routing file that defines the
step.

Run the planning phase of the Stereo workflow. The current Claude session orchestrates; the
selected planner and plan reviewer perform their routed steps. Never implement from this command.

Raw slash-command arguments:
`$ARGUMENTS`

## Arguments and modes

Parse every argument per "Selection and effort parsing" before inspecting the repository, then
read the "Workspace role defaults":

- `--planner <model>` and `--planner-effort <effort>` select the drafter and its effort.
- `--plan-reviewer <model>` and `--plan-reviewer-effort <effort>` select the plan reviewer and its
  effort.
- `--max-plan-rounds <n>` defaults to 6.
- `--slot <name>` selects the durable plan slot this run stores into and defaults to `default`.
  Slot names are trimmed, lowercased, may contain only letters, digits, hyphens, and underscores,
  and must start with a letter or digit. Relay the CLI's validation error verbatim.
- `--draft-only` runs one draft step, stores it, and stops.
- `--review-only` reviews the stored plan exactly once and stops.
- `--plan-file <path>` reviews that external plan exactly once and is valid only with
  `--review-only`.
- Without a mode flag, run the complete draft-plus-review/revision phase.

`claude:session` is legal for both roles. Reject both mode flags together. For `--review-only`,
reject task text, `--planner`, and `--planner-effort`. Reject `--plan-file` with `--draft-only` or
the full phase and say that it requires `--review-only`. For `--draft-only`, reject
`--plan-reviewer`, `--plan-reviewer-effort`, and `--max-plan-rounds`. The full phase and
`--draft-only` require task text; if it is empty, ask the user what to plan.

In `--review-only` and at explicit user-decision points, stop after presenting review findings and
let the user decide what changes. During the full phase's review loop, revise automatically.

## Stored-plan overwrite guard

Apply this guard only to a run that will store new plan content: the full phase, `--draft-only`, or
`--review-only --plan-file`. Plain `--review-only` reviews the stored target slot and skips it. Run
the guard before drafting or routing any review (metadata only):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --metadata --json <slotArg>
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

For `--review-only`, skip drafting and run exactly one independent round 1 of "Plan review rounds":
a fresh reviewer, an empty repo map, and an empty revision context.

With `--plan-file`, perform external intake first:

1. Report the target slot's stored summary from the overwrite-guard read when one exists; do not ask
   a second replacement question.
2. Copy the plan from the exact user-provided path, byte for byte, to a payload file under
   "Quoting" — never through the Write tool, which would re-encode it — with the user's path
   single-quoted and after `--`, so a path that starts with `-` is never read as a Node option:

   ```bash
   node -e "require('fs').copyFileSync(process.argv[1], process.argv[2])" -- '<userPlanPath>' '<planFile>'
   ```

   `<planFile>` names that copy from here on, so every later step reads the user's exact bytes
   without touching the original path again; Read it as the current plan and review it in place of
   `<payloadFile>` — never the user's original path, which may lie outside the directories the
   companion reads a plan file from. Warn, but do not reject it, when any of the seven canonical
   headings are absent.

Without `--plan-file`, load the stored plan:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json <slotArg>
```

If `available` is false, stop with: `Run /stereo:plan first.` Otherwise use the exact stored
`plan` as the current plan.

A companion review stores its parsed result automatically; persist an inline `claude:session`
result under "Plan persistence". A review job that fails or is cancelled follows "Failed and
cancelled jobs"; nothing is stored. Report the verdict, findings, revision instructions, open
questions, complete residual risks, and the reviewer's usage line verbatim; for a companion
reviewer, add its thread line and, for a Claude reviewer, the Claude invocation note ("Final
report lines"). Add the slot line, then stop without revising or implementing.

## Draft step

For the full phase or `--draft-only`, run "Plan draft step" with this command's fills. The selected
planner inspects the repository read-only until the draft can name exact files, symbols, callers,
configuration, registration points, and tests: for `claude:session`, the orchestrator performs that
exploration before drafting inline; a companion planner performs it in its own run. During the
full review loop, the orchestrator still inspects the repository as needed to judge findings,
revise the plan, and support rebuttals with concrete evidence.

- `{{SIZE_CONTRACT}}` = `If an honest draft needs more than roughly 400 lines, do not draft:
return exactly one line — SPLIT REQUIRED: <one-sentence reason> — and nothing else, so the split
can be discussed before review.`
- Split action: on a `SPLIT REQUIRED:` result, relay the reason and ask whether to split the task
  or draft anyway.

For `--draft-only`, derive a one-line summary. Write the full draft plan verbatim to
`<payloadFile>` and the summary as plain text to `<summaryPayloadFile>`, then store the draft with
no reviewer label:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-store --json <slotArg> --verdict 'draft' --round 0 --summary-file '<summaryPayloadFile>' < '<payloadFile>'
```

Present the draft from this run (plan-store returns metadata only), identify the selected planner
and its usage line, and add the slot line; say that the implementation commands will gate on the
unapproved `draft` verdict and that `--review-only` runs the next step. When the store fails,
follow "Plan persistence": the draft presented from this run is then the only copy.

## Full plan-review phase

Run every round as "Plan review rounds" describes, revising the plan automatically until approval
or a safeguard. At the configured cap (`--max-plan-rounds`, default 6), plan growth beyond roughly
1.5 times the first draft, review-added machinery attracting findings, two surviving
evidence-backed rebuttals, or oscillation, ask whether to split (recommended), keep iterating,
accept as-is, or stop. Keep-iterating runs exactly one more round; ask the same question again
after every round beyond the cap, so no round past the cap starts without an answer. A split
retains the core and names follow-ups in `## Out of scope`. Accept-as-is retains the actual verdict
and findings.

Whenever the terminal reviewer is the inline `claude:session` route, persist the full current plan
and actual verdict before finishing ("Plan persistence").

Finish with the full plan, verdict, rounds, reviewer, open questions, complete residual risks, and,
per "Final report lines", the usage line for every routed draft and review turn, the Claude
invocation note for every Claude turn, the thread line for `planReviewThreadId` (naming whether a
resumable companion review thread exists) and for `plannerThreadId` labeled separately, and the
slot line. Never implement, commit, or push.

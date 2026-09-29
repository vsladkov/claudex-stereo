---
description: Plan, review, implement, and verify one small task with independently routed Claude or Codex roles
argument-hint: '[--isolated] [--slot <name>] [--planner <model>] [--planner-effort <effort>] [--plan-reviewer <model>] [--plan-reviewer-effort <effort>] [--implementer <model>] [--implementer-effort <effort>] [--implementation-reviewer <model>] [--implementation-reviewer-effort <effort>] [--max-plan-rounds <n>] [--max-fix-rounds <n>] [small task description]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(npm:*), Bash(git:*), Bash(npx:*), Bash(pnpm:*), Bash(yarn:*), Bash(dotnet:*), Bash(cargo:*), Bash(go:*), Bash(make:*), Bash(python3:*), Bash(pytest:*), Bash(mvn:*), Bash(gradle:*), AskUserQuestion
---

First Read `${CLAUDE_PLUGIN_ROOT}/skills/model-routing/SKILL.md`, then
`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/pair-procedures.md`,
`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/plan-procedures.md`, and
`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/implement-procedures.md` — plus
`${CLAUDE_PLUGIN_ROOT}/skills/model-routing/worktree-procedure.md` for an `--isolated` run — and
apply their rules. The rules below are step-specific; a quoted heading names the section of a
routing file that defines the step.

Run both Stereo phases for one small task. Preserve the canonical `/stereo:plan` and
`/stereo:implement` semantics with fixed quick safeguards and no approval gate between an approved
plan and implementation.

Raw slash-command arguments:
`$ARGUMENTS`

## Arguments and role defaults

Parse all arguments per "Selection and effort parsing" before repository work, then read the
"Workspace role defaults" and say in the effective-role recap which role a workspace default
supplied:

- `--planner`, `--plan-reviewer`, `--implementer`, and `--implementation-reviewer` select the four
  roles, each with its `-effort` flag. The scope gate still runs inline in this session before any
  routed draft.
- `--slot <name>` selects the durable plan slot this run stores into and defaults to `default`.
  Slot names are trimmed, lowercased, may contain only letters, digits, hyphens, and underscores,
  and must start with a letter or digit. Relay the CLI's validation error verbatim.
- `--max-plan-rounds <n>` defaults to 2 and must be an integer from 1 to 6; above 6, point at
  `/stereo:plan` for a longer plan-review loop.
- `--max-fix-rounds <n>` defaults to 2 and must be a positive integer. Direct gate-fix turns and
  review-driven fix turns both count toward it; the implementer's own inner-loop iterations never
  do.
- `--isolated` runs implementation, implementation review, and fixes in a throwaway detached git
  worktree and hands the delta back as a user-confirmed patch; the plan draft and every
  plan-review round still run against the main tree.
- Remaining text is the task. Ask for it if empty.

`/stereo:quick` has no `--resume`: an interrupted Quick run restarts from the beginning. Use
`/stereo:plan` plus `/stereo:implement` for a long task that needs durable phase state. Quick
writes no implementation record, so a crash during an `--isolated` run strands the worktree with no
durable pointer to it; Quick prints `<worktreePath>` at creation, and `/stereo:doctor` lists every
stranded `stereo-worktrees` entry with its removal command.

Keep these ids distinct and never cross-assign them: `plannerThreadId` (the companion draft),
`planReviewThreadId` (companion plan-review payloads), `implementationThreadId` (companion
implementation and fix payloads), and `implementationReviewThreadId` (companion
implementation-review tasks).

## Scope gate and draft

Explore the repository read-only just enough to judge the task's size and boundaries — which
feature or subsystem it touches and roughly how many files; the routed planner performs the full
grounding itself. Quick is for one small feature whose honest plan fits roughly 120 lines. If it
crosses features/subsystems or exceeds that bound, stop before review and direct the user to
`/stereo:plan`. When the size check surfaced concrete grounding (files, symbols, tests), append it
to `planDraftBrief` after the filled template as clearly labeled advisory context the planner must
verify before relying on.

Draft through "Plan draft step" with these fills:

- `{{SIZE_CONTRACT}}` = `This is a compact Quick plan. If the task crosses features or subsystems,
or an honest plan would exceed roughly 120 lines, do not draft: return exactly one line —
SPLIT REQUIRED: <one-sentence reason> — and nothing else.`
- Split action: on a `SPLIT REQUIRED:` result, relay the reason and direct the user to
  `/stereo:plan`.

## Existing-plan warning

After the scope gate but before review, load (metadata only):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --metadata --json <slotArg>
```

If `available` is true, warn that Quick will replace the plan in slot `<slot>`, naming its summary
and `updatedAt`; every other slot is untouched. Report `implementedAt` when present; otherwise say
`not marked implemented`. Name `--slot <name>` as the escape hatch for keeping the current plan.
Do not read plan-state again during this run; carry current plan/review state in the conversation.

## Plan-review loop

Run every round as "Plan review rounds" describes. Retain each completed round's findings array as
`latestPlanFindings`; the terminal round's array feeds the implementation and
implementation-review payloads. On approval, continue without a user gate, persisting a terminal
inline `claude:session` verdict first ("Plan persistence").

After round `<maxPlanRounds>` still needs revision, ask:

- `Keep iterating (Recommended)`: continue automatically through the rounds after
  `<maxPlanRounds>` up to 5 while converging; at round 6 ask only implement-anyway or stop.
- `Implement anyway`: first persist an inline `claude:session` `needs-revision` result when
  applicable, retain the findings as original unapproved findings, then enter the truthful
  unapproved branch.
- `Stop here`: first persist an inline `claude:session` `needs-revision` result when applicable,
  report the findings, and stop.

When `<maxPlanRounds>` is already 6, that first pause is the absolute safeguard: offer only
implement-anyway or stop. Pause at the same decision point on plan growth beyond roughly 1.5 times
round 1, review-added machinery attracting findings, two surviving rebuttals, or oscillation.

## Implementation preflight

Use the in-conversation plan and latest result. Show the plan summary, rounds, effective
implementer, and residual risks, then run "Implementation preflight" over the current plan. Quick
keeps the snapshot, the implementer's `launchArgs`, and all fix accounting in the session only — it
writes no durable state, and an interrupted run restarts clean with a fresh snapshot.

## Isolated worktree mode

For `--isolated`, follow "Isolated worktrees". Quick keeps no implementation record, so the
`<worktreePath>` printed at creation is the only record of the worktree that survives a crashed
run. Hand the delta back at every terminal exit — accepted full phase, safeguard stop, or
max-rounds stop.

## Implementation routing

Launch the implementer with the fresh line of "Implementer launches and payloads": the approved
variant after approval and the unapproved one after `Implement anyway`. Fill the shared payload
with the current full plan verbatim and `latestPlanFindings` — framed as original unapproved
findings in the latest-findings block after `Implement anyway`, and under the advisory heading
otherwise, only when the array is non-empty. After every launch, follow that section's checks and
its one fresh retry. A job that fails or is cancelled follows "Failed and cancelled jobs"; Quick
keeps no durable record, so a stop ends the run with the delta where it was written (the working
tree, or the printed `<worktreePath>`) for the user to inspect.

## Staged verification and review loop

Verify per "Staged verification", tracking every fix turn toward `--max-fix-rounds` in the session.
Run every review round per "Implementation review rounds", with `latestPlanFindings` as the
plan-review findings (labeled original unapproved findings after `Implement anyway`, advisory
otherwise). Quick pauses when fix turns reach `<maxFixRounds>` with the cap question that section
defines. For every original unapproved plan finding, track `resolved` only when delta/tests prove
it; otherwise `unresolved`.

After the accepted review and a green (or absent) heavy stage, and before the final report, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --mark-implemented --json <slotArg>
```

Report a marker failure but never fail Quick because of it. In isolated mode, run the marker only
under the hand-back conditions "Isolated worktrees" states.

## Final report

Report selected roles, every fix turn (direct gate-fix and review-driven, with the gates or
findings that drove it), attributed files, the verification lines, every pre-existing or
unattributable red and its disposition, deviations, user-owned steps, open questions, residual
risks, and, per "Final report lines", the usage line for every draft, plan-review, implementer,
fix, and implementation-review turn, the Claude invocation note for every Claude turn, the thread
line for `implementationThreadId` (with all other thread ids labeled by role), the slot line, the
isolated-run lines for an isolated run, and the commit line. If unapproved implementation was
chosen, list every original finding with status and evidence.

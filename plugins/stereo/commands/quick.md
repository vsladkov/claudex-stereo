---
description: Plan, review, implement, and verify one small task with independently routed Claude or Codex roles
argument-hint: '[--planner <model>] [--planner-effort <none|minimal|low|medium|high|xhigh|max>] [--plan-reviewer <model>] [--plan-reviewer-effort <none|minimal|low|medium|high|xhigh|max>] [--implementer <model>] [--implementer-effort <none|minimal|low|medium|high|xhigh|max>] [--implementation-reviewer <model>] [--implementation-reviewer-effort <none|minimal|low|medium|high|xhigh|max>] [--effort <none|minimal|low|medium|high|xhigh|max>] [small task description]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(git:*), AskUserQuestion, Agent
---

First Read `${CLAUDE_PLUGIN_ROOT}/skills/model-routing/SKILL.md` and apply its routing, foreground
agent, validation, persistence, quoting, and background-job rules. The rules below are
step-specific.

Run both Stereo phases for one small task. Preserve the canonical `/stereo:plan` and
`/stereo:implement` semantics with fixed quick safeguards and no approval gate between an approved
plan and implementation.

Raw slash-command arguments:
`$ARGUMENTS`

## Arguments and role defaults

After reading the routing skill, parse all arguments before repository work:

- `--planner <model>` defaults to `claude:session`; the scope gate already grounds the task in
  this session.
- `--planner-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort for a
  Codex-routed planner.
- `--plan-reviewer <model>` defaults to `claude:fable`.
- `--plan-reviewer-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort for a
  Codex-routed plan reviewer.
- `--implementer <model>` defaults to the model/effort resolved by the latest Codex plan-review
  payload. If the plan reviewer is Claude-side, default to `sol` with the matching role effort,
  command-wide effort, or `max`.
- `--implementer-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort for a
  Codex-routed implementer, including the effort from a Codex plan-review payload.
- `--implementation-reviewer <model>` defaults to `claude:fable`; the contained reviewer is
  independent of this orchestrating session.
- `--implementation-reviewer-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort
  for a Codex-routed implementation reviewer.
- `--effort <none|minimal|low|medium|high|xhigh|max>` is the command-wide default for
  Codex-routed roles that have no role effort flag.
- Remaining text is the task. Ask for it if empty.

Reject missing values, duplicate role or role-effort flags, invalid effort, unknown flags, unknown
`claude:*` values, and `claude:session` as implementer. Accept `claude:inherit` alongside
`claude:session` and the four explicit Claude aliases. Reject a role effort flag when its selected
role is Claude-routed. Resolve every Codex role through role effort > command-wide effort > the
routing skill's pair default. When `--implementer` is omitted, use the plan-review payload's
resolved model and effort at the last level; either `--implementer-effort` or `--effort` overrides
that payload effort. An explicit implementer model instead uses that model's pair default when
neither effort flag is present. The removed `--model` flag is unknown; report the role-named
alternatives. The renamed `--impl-reviewer` and `--impl-reviewer-effort` flags are unknown; report
`--implementation-reviewer` and `--implementation-reviewer-effort` as their replacements. Quick
has no configurable round-count flags.

Keep these ids distinct:

- `plannerThreadId`: Codex draft only; never reused.
- `planReviewThreadId`: Codex plan-review payloads only.
- `implementationThreadId`: Codex implementation/fix payloads only.
- `implementationReviewThreadId`: fresh Codex implementation-review tasks only.

Never cross-assign them.

## Scope gate and draft

Explore the repository read-only until the task can be grounded in exact files, symbols, callers,
configuration, registration, and tests. Quick is for one small feature whose honest plan fits
roughly 120 lines. If it crosses features/subsystems or exceeds that bound, stop before review and
direct the user to `/stereo:plan`.

Read `${CLAUDE_PLUGIN_ROOT}/prompts/plan-draft.md` and fill it without changing any other text:

- `{{TASK_TEXT}}` = the task text verbatim.
- `{{SIZE_CONTRACT}}` = `This is a compact Quick plan. If the task crosses features or subsystems,
or an honest plan would exceed roughly 120 lines, stop and direct the user to /stereo:plan.`

The result is the single `planDraftBrief` for every route. Never write the plan into the
repository; a Codex route may write it only as a payload file under the routing skill's
temporary-directory rule.

Route the draft:

- `claude:session`: apply `planDraftBrief` inline.
- Named Claude: use `planDraftBrief` verbatim as the routing skill's `stereo:planner` prompt.
- Codex: write `planDraftBrief` verbatim to `<payloadFile>` under the routing skill's
  temporary-directory rule, then launch a fresh read-only task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json <plannerSelectionArgs> --prompt-file "<payloadFile>"
```

For a Codex draft, read `storedJob.result.rawOutput` and save its thread only as
`plannerThreadId`. Record per-job usage from `storedJob.tokenUsage.job`. For a named-Claude draft,
record the Agent result's token usage and duration. Record any inline metrics the harness exposes;
otherwise use `usage unavailable`. Validate the seven headings and apply the routing skill's
one-retry recovery.

## Existing-plan warning

After the scope gate but before review, load:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json
```

If `available` is true, warn that Quick will replace the stored plan, naming its summary and
`updatedAt`. Do not claim whether it was implemented. Do not read plan-state again during this
run; carry current plan/review state in the conversation.

## Plan-review loop

Quick pauses after 2 plan-review rounds, with an absolute safeguard at 6 after an explicit
keep-iterating choice.

For each round:

- For `claude:session`, named-Claude round 1, and any named-Claude stateless fallback, read
  `${CLAUDE_PLUGIN_ROOT}/prompts/plan-review.md` and fill it without changing any other text:
  - `{{PLAN_INPUT}}` = the full current plan.
  - `{{ROUND_NUMBER}}` = the current round.
  - `{{REPO_MAP}}` = empty; the Claude reviewer uses its native read-only repository tools.
  - `{{REVISION_CONTEXT}}` = empty in round 1. For `claude:session` later rounds and a
    named-Claude stateless fallback, use the runtime's revision-context meaning: state that the
    plan responds to earlier findings; embed the earlier findings, responses, open questions, and
    complete residual risks; require rebuttals to be verified; and prohibit re-auditing
    unchanged, previously accepted sections unless the revision changed their assumptions.
    Use the resulting `planReviewBrief` verbatim for the selected Claude route.
- `claude:session`: apply `planReviewBrief` inline into structured state.
- Named Claude round 1: use `planReviewBrief` as the `stereo:plan-reviewer` prompt and retain its
  continuation handle for this command only.
- Later named-Claude rounds: apply the routing skill's
  "Continuing an agent across review rounds" rule. Continue the same reviewer with the round
  number, full revised plan, and self-verification instruction when supported; otherwise use the
  fully briefed stateless fallback above. Apply the same schema validation in either mode and
  report whether the round was continued or re-briefed.
- Codex round 1: write the full current plan verbatim to `<payloadFile>` under the routing skill's
  temporary-directory rule, then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --round 1 <reviewSelectionArgs> --plan-file "<payloadFile>"
```

- Later Codex rounds: write the full revised plan verbatim to `<payloadFile>` under the same
  temporary-directory rule, then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --thread <planReviewThreadId> --round <n> <reviewSelectionArgs> --plan-file "<payloadFile>"
```

Refresh `planReviewThreadId`, resolved model, and resolved effort only from Codex plan-review
payloads. Apply the canonical parse-error, failed-job, and one-retry recovery rules. A fresh
restart becomes round 1 and carries accumulated `## Reviewer responses`.

After every completed round, report its number, verdict, finding count, and reviewer
per-invocation usage and duration (or `usage unavailable`).
Retain that round's findings array as `latestPlanFindings`; the terminal round's array feeds the
implementation and implementation-review payloads.

On `needs-revision`, address every finding by changing the plan, rebutting with repository
evidence, or explicitly descoping scope-expanding/pre-existing hazards. Carry complete residual
risks.

On approval, continue without a user gate. Before leaving a terminal Claude-side review, write
the full current plan verbatim to `<payloadFile>` under the routing skill's temporary-directory
rule. Write the reviewer's findings array as JSON to a distinct `<findingsPayloadFile>` under the
same rule, then persist:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-store --json --verdict '<actual verdict>' --round <reviewRound> --reviewed-by '<reviewer label>' --summary '<summary>' --findings-file "<findingsPayloadFile>" <repeated --open-question/--residual-risk args> < "<payloadFile>"
```

Codex plan reviews already store each parsed round.

After round 2 still needs revision, ask:

- `Keep iterating (Recommended)`: continue automatically through rounds 3-5 while converging; at
  round 6 ask only implement-anyway or stop.
- `Implement anyway`: first persist a Claude-side `needs-revision` result when applicable, retain
  the findings as original unapproved findings, then enter the truthful unapproved branch.
- `Stop here`: first persist a Claude-side `needs-revision` result when applicable, report the
  findings, and stop.

Pause at the same decision point on plan growth beyond roughly 1.5 times round 1, review-added
machinery attracting findings, two surviving rebuttals, or oscillation.

## Implementation preflight

Use the in-conversation plan and latest result. Show the plan summary, rounds, effective
implementer, and residual risks.

Record `baselineCommit`, status, and all already-dirty paths. If dirty, ask whether to stop for a
commit/stash (recommended) or continue. Mention an enabled stop-review gate.

If the selected implementer is Claude, scan for command-requiring work beyond host verification:
version bumps, dependency installation, code generation, migrations, or interactive/long-running
processes. If found, ask whether to switch to canonical Codex `sol`, leave each command user-owned,
or stop. Never execute shell text on a Claude agent's behalf.

## Implementation routing

### Codex implementer

If `planReviewThreadId` exists, resume it. Otherwise launch fresh without `--thread`. Always pass
the effective implementer model and optional effort.

Approved, resumed. Write this complete payload to `<payloadFile>` under the routing skill's
temporary-directory rule:

```text
<task>
Implement the approved plan below in this repository. You reviewed and approved this plan earlier
in this thread.

[current full plan, verbatim]

Advisory review findings (the approved plan takes precedence where they conflict):
[latest findings, verbatim]
</task>
<action_safety>
Only make changes the plan calls for. Do not commit, push, or touch unrelated files.
</action_safety>
<completeness_contract>
Implement the whole plan and report impossible steps explicitly.
</completeness_contract>
<verification_loop>
Run relevant tests or builds and fix regressions.
</verification_loop>
<compact_output_contract>
Report changes, touched files, verification, and deviations.
</compact_output_contract>
```

Then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <planReviewThreadId> --model <effectiveModel> <effortArg> --prompt-file "<payloadFile>"
```

Approved after a Claude review, fresh. Write this complete payload to `<payloadFile>` under the
routing skill's temporary-directory rule:

```text
<task>
Implement the approved plan below in this repository. The plan was reviewed and approved outside
this Codex thread, by <reviewer label>.

[current full plan, verbatim]

Advisory review findings (the approved plan takes precedence where they conflict):
[latest findings, verbatim]
</task>
<action_safety>
Only make changes the plan calls for. Do not commit, push, or touch unrelated files.
</action_safety>
<completeness_contract>
Implement the whole plan and report impossible steps explicitly.
</completeness_contract>
<verification_loop>
Run relevant tests or builds and fix regressions.
</verification_loop>
<compact_output_contract>
Report changes, touched files, verification, and deviations.
</compact_output_contract>
```

Then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --model <effectiveModel> <effortArg> --prompt-file "<payloadFile>"
```

Include the advisory findings block in both approved variants only when `latestPlanFindings` is
non-empty; it never authorizes work outside the approved plan.

For `Implement anyway` with `planReviewThreadId`, replace the approved task block with:

```text
<task>
Implement the reviewed but unapproved plan below in this repository. You reviewed this plan
earlier in this thread, and the user explicitly chose to continue despite the current verdict.
Implement only the plan's scope and do not silently discard the known findings.

[current full plan, verbatim]

Latest unapproved review findings:
[latest findings, verbatim]
</task>
```

For `Implement anyway` without `planReviewThreadId`, launch fresh and use:

```text
<task>
Implement the reviewed but unapproved plan below in this repository. The plan was reviewed
outside this Codex thread, by <reviewer label>, and the user explicitly chose to continue despite
the current verdict. Implement only the plan's scope and do not silently discard the known
findings.

[current full plan, verbatim]

Latest unapproved review findings:
[latest findings, verbatim]
</task>
```

Both variants retain all four safety/output contracts from the approved templates.

Poll and fetch through the routing skill. If resume fails, or claimed changes have neither
`touchedFiles` nor an actual delta, retry once fresh with the same truthful full prompt. Adopt the
latest implementation payload's thread only as `implementationThreadId`. Record every Codex
implementation or retry invocation's per-job usage from `storedJob.tokenUsage.job`.

### Claude implementer

Use the routing skill's foreground `stereo:implementer` template with the plan, baseline-dirty
paths, `latestPlanFindings` when non-empty, and user-owned steps. Frame those findings as original
unapproved findings after `Implement anyway`; otherwise use the same advisory findings heading the
approved Codex payloads use. After every invocation, record the Agent result's token usage and
duration (or `usage unavailable`), compare HEAD with `baselineCommit`, and inspect the actual
delta. Stop and retract the never-commit claim if HEAD moved.

After either implementer, run identifiable host tests/builds and record commands and results.

## Implementation-review and fix loop

Build input from the plan, baseline, baseline-dirty paths, complete current delta, implementer
report, host results, and `latestPlanFindings`. The canonical result is
`${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json`.

Maintain `implementationReviewHistory` for every route and, for a named-Claude reviewer, the
continuation handle for this command run only. Build the history every round even while a reviewer
is being continued, because a fallback round needs it:

- Round 1 contains the implementer report verbatim plus `latestPlanFindings` verbatim when
  non-empty. Label them as original unapproved findings when the user selected `Implement anyway`
  and as "Advisory findings from the approving plan review, context only: the approved plan takes
  precedence, and the reviewer must not report a fix solely because an advisory finding was not
  adopted" otherwise; state that there are none when the array is empty.
- Every later round preserves that round-1 context, retains every prior numbered
  implementation-review fix with its `resolved`/`unresolved` status from the latest delta and host
  results, and includes the latest fix-round implementer report verbatim.

Route each review:

- For `claude:session`, named-Claude round 1, every named-Claude stateless fallback round, and
  every Codex round, read `${CLAUDE_PLUGIN_ROOT}/prompts/implementation-review.md` and fill it once
  for the current round without changing any other text:
  - `{{PLAN_INPUT}}` = the full current plan.
  - `{{BASELINE_CONTEXT}}` = the normal Quick attribution semantics, including `baselineCommit`,
    baseline-dirty paths excluded from attribution, current status/diff, and every attributed
    changed and untracked file.
  - `{{REVIEW_CONTEXT}}` = the current `implementationReviewHistory`.
  - `{{HOST_RESULTS}}` = every named host-verification command and its exact exit result/output
    summary for the latest delta.
    Use the resulting `implementationReviewBrief` verbatim for the selected route.
- `claude:session`: apply `implementationReviewBrief` inline.
- Named Claude round 1: use `implementationReviewBrief` as the routing skill's
  `stereo:implementation-reviewer` prompt and retain its continuation handle for this command
  only.
- Later named-Claude rounds: apply the routing skill's
  "Continuing an agent across review rounds" rule. Continue the same reviewer with the round
  number, the previous round's numbered fixes and their to-be-judged `resolved`/`unresolved`
  status, the latest fix-round implementer report verbatim, the latest host results, and the
  instruction to re-inspect the current worktree and verify its own earlier findings when
  supported; otherwise use the fully briefed stateless fallback above. Apply the same schema
  validation in either mode and report whether the round was continued or re-briefed.
- Codex: write `implementationReviewBrief` verbatim to `<payloadFile>` under the routing skill's
  temporary-directory rule, then launch a fresh read-only task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --model <effectiveReviewModel> <reviewEffortArg> --output-schema "${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json" --prompt-file "<payloadFile>"
```

Save a Codex review task's thread only as `implementationReviewThreadId`. Parse
`storedJob.result.rawOutput`; retry malformed output once on that review thread while preserving
the same `--output-schema` flag. Never assign it to `implementationThreadId`.

After every completed review round, report its number, verdict/fix count, and reviewer
per-invocation usage and duration (or `usage unavailable`), and whether the round was continued or
re-briefed. If acceptable, finish. Otherwise send exact numbered fixes to the original implementer.

Codex fix. Write this complete payload to `<payloadFile>` under the routing skill's
temporary-directory rule:

```text
<task>
Fix the review findings below in this repository. Keep all other behavior unchanged.

[numbered fixes]
</task>
<verification_loop>
Run relevant tests or builds and fix regressions.
</verification_loop>
<compact_output_contract>
Report fixed findings and verification.
</compact_output_contract>
```

Then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <implementationThreadId> --model <effectiveModel> <effortArg> --prompt-file "<payloadFile>"
```

For Claude fixes, use the same named implementer and model with the full plan and fixes. Recheck
HEAD and delta. After every fix, rerun host checks, update every prior fix's
`resolved`/`unresolved` status for the next `{{REVIEW_CONTEXT}}`, and invoke the selected reviewer.

Quick pauses after 2 fix rounds. Show remaining fixes and ask whether to send one more implementer
round, let Claude fix directly, or stop. Do not silently exceed the cap.

For every original unapproved plan finding, track `resolved` only when delta/tests prove it;
otherwise `unresolved`.

## Final report

Report selected roles, fix rounds, attributed files, host results, deviations, user-owned steps,
open questions, residual risks, and per-invocation usage/duration for every draft, plan-review,
implementer, fix, and implementation-review turn. Use `usage unavailable` when metrics were
omitted. For Codex turns use `storedJob.tokenUsage.job`; for named Claude turns use the Agent
result's usage and duration. Label `storedJob.tokenUsage.thread` cumulative when shown and never
compare it with one Claude invocation. If unapproved implementation was chosen, list every
original finding with status and evidence.

Include `implementationThreadId` and `codex resume <implementationThreadId>` only when Codex
implemented. Label all other thread ids by role. Give rollback guidance relative to the baseline
without erasing pre-existing dirty paths. State nothing was committed or pushed only if HEAD is
unchanged; otherwise retract that claim. Never commit or push.

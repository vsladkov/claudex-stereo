---
description: Plan, review, implement, and verify one small task with independently routed Claude or Codex roles
argument-hint: '[--planner <model>] [--plan-reviewer <model>] [--implementer <model>] [--impl-reviewer <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [small task description]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion, Agent
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

- `--planner <model>` defaults to `claude:session`.
- `--plan-reviewer <model>` defaults to `sol`.
- `--implementer <model>` defaults to the model/effort resolved by the latest Codex plan-review
  payload. If the plan reviewer is Claude-side, default to `sol` with user `--effort` or `max`.
- `--impl-reviewer <model>` defaults to `claude:session`.
- `--effort <none|minimal|low|medium|high|xhigh|max>` applies to every Codex-routed role.
- Remaining text is the task. Ask for it if empty.

Reject missing values, duplicate role flags, invalid effort, unknown flags, unknown `claude:*`
values, and `claude:session` as implementer. The removed `--model` flag is unknown; report the
role-named alternatives. Quick has no configurable round-count flags.

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

Draft exactly the seven canonical headings in order. Never write the plan into the repository.

Route the draft:

- `claude:session`: draft inline.
- Named Claude: use the routing skill's `stereo:planner` template.
- Codex: launch a fresh read-only task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json <plannerSelectionArgs> <<'CODEX_PAIR_PLAN'
<task>
Explore this repository read-only and draft a compact implementation plan for this small task:

[task text verbatim]
</task>
<output_contract>
Return only a plan with exactly these headings once each and in order:
## Goal
## Approach
## Files to change
## Step-by-step changes
## Testing and verification
## Risks and edge cases
## Out of scope
</output_contract>
CODEX_PAIR_PLAN
```

For a Codex draft, read `storedJob.result.rawOutput` and save its thread only as
`plannerThreadId`. Validate the seven headings and apply the routing skill's one-retry recovery.

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

- `claude:session`: review inline into structured state.
- Named Claude: use the routing skill's `stereo:plan-reviewer` template with full plan and bounded
  prior context.
- Codex round 1:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --round 1 <reviewSelectionArgs> <<'CODEX_PAIR_PLAN'
[full current plan, verbatim]
CODEX_PAIR_PLAN
```

- Later Codex rounds:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --thread <planReviewThreadId> --round <n> <reviewSelectionArgs> <<'CODEX_PAIR_PLAN'
[full revised plan, verbatim]
CODEX_PAIR_PLAN
```

Refresh `planReviewThreadId`, resolved model, and resolved effort only from Codex plan-review
payloads. Apply the canonical parse-error, failed-job, and one-retry recovery rules. A fresh
restart becomes round 1 and carries accumulated `## Reviewer responses`.

On `needs-revision`, address every finding by changing the plan, rebutting with repository
evidence, or explicitly descoping scope-expanding/pre-existing hazards. Carry complete residual
risks. Report round, verdict, and finding count.

On approval, continue without a user gate. Before leaving a terminal Claude-side review, persist:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-store --json --verdict '<actual verdict>' --round <reviewRound> --reviewed-by '<reviewer label>' --summary '<summary>' <repeated --open-question/--residual-risk args> <<'CODEX_PAIR_PLAN'
[full current plan, verbatim]
CODEX_PAIR_PLAN
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

Approved, resumed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <planReviewThreadId> --model <effectiveModel> <effortArg> <<'CODEX_PAIR_IMPL'
<task>
Implement the approved plan below in this repository. You reviewed and approved this plan earlier
in this thread.

[current full plan, verbatim]
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
CODEX_PAIR_IMPL
```

Approved after a Claude review, fresh:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --model <effectiveModel> <effortArg> <<'CODEX_PAIR_IMPL'
<task>
Implement the approved plan below in this repository. The plan was reviewed and approved outside
this Codex thread, by <reviewer label>.

[current full plan, verbatim]
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
CODEX_PAIR_IMPL
```

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
latest implementation payload's thread only as `implementationThreadId`.

### Claude implementer

Use the routing skill's foreground `stereo:implementer` template with the plan, baseline-dirty
paths, original unapproved findings when present, and user-owned steps. After every invocation,
compare HEAD with `baselineCommit` and inspect the actual delta. Stop and retract the never-commit
claim if HEAD moved.

After either implementer, run identifiable host tests/builds and record commands and results.

## Implementation-review and fix loop

Build input from the plan, baseline, baseline-dirty paths, complete current delta, implementer
report, host results, and original unapproved findings. The canonical result is
`${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json`.

Route each review:

- `claude:session`: review inline.
- Named Claude: use the routing skill's `stereo:implementation-reviewer` template.
- Codex: launch a fresh read-only task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --model <effectiveReviewModel> <reviewEffortArg> <<'CODEX_PAIR_PLAN'
<task>
Review the current implementation delta against the complete plan. Inspect status and diff
relative to the baseline, ignore already-dirty paths, run only named verification commands, and
do not edit files.

Plan:
[current full plan, verbatim]

Baseline commit and already-dirty paths:
[baseline data]

Host verification:
[commands and results]

Original unapproved findings:
[findings or none]
</task>
<output_contract>
Return only raw JSON matching
${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json.
</output_contract>
CODEX_PAIR_PLAN
```

Save a Codex review task's thread only as `implementationReviewThreadId`. Parse
`storedJob.result.rawOutput`; retry malformed output once on that review thread. Never assign it
to `implementationThreadId`.

If acceptable, finish. Otherwise send exact numbered fixes to the original implementer.

Codex fix:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <implementationThreadId> --model <effectiveModel> <effortArg> <<'CODEX_PAIR_FIX'
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
CODEX_PAIR_FIX
```

For Claude fixes, use the same named implementer and model with the full plan and fixes. Recheck
HEAD and delta. After every fix, rerun host checks and the selected reviewer.

Quick pauses after 2 fix rounds. Show remaining fixes and ask whether to send one more implementer
round, let Claude fix directly, or stop. Do not silently exceed the cap.

For every original unapproved plan finding, track `resolved` only when delta/tests prove it;
otherwise `unresolved`.

## Final report

Report selected roles, fix rounds, attributed files, host results, deviations, user-owned steps,
open questions, and residual risks. If unapproved implementation was chosen, list every original
finding with status and evidence.

Include `implementationThreadId` and `codex resume <implementationThreadId>` only when Codex
implemented. Label all other thread ids by role. Give rollback guidance relative to the baseline
without erasing pre-existing dirty paths. State nothing was committed or pushed only if HEAD is
unchanged; otherwise retract that claim. Never commit or push.

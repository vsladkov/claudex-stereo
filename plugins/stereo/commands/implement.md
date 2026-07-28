---
description: Implement or review the stored plan with independently selected Claude or Codex role models
argument-hint: '[--implement-only|--review-only] [--implementer <model>] [--implementer-effort <none|minimal|low|medium|high|xhigh|max>] [--implementation-reviewer <model>] [--implementation-reviewer-effort <none|minimal|low|medium|high|xhigh|max>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--max-fix-rounds <n>] [--fresh]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(git:*), AskUserQuestion, Agent
---

First Read `${CLAUDE_PLUGIN_ROOT}/skills/model-routing/SKILL.md` and apply its routing, foreground
agent, validation, quoting, and background-job rules. The rules below are step-specific.

Run the implementation phase of the Stereo workflow. The main Claude session owns preflight,
baselines, host verification, review/fix orchestration, and the final report.

Raw slash-command arguments:
`$ARGUMENTS`

## Arguments and modes

After reading the routing skill, parse all arguments before loading state:

- `--implementer <model>` selects the implementer. When absent, use the stored Codex model; if it
  is null, use `codex:sol`.
- `--implementer-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort for a
  Codex-routed implementer.
- `--implementation-reviewer <model>` selects the implementation reviewer and defaults to
  `claude:fable`: the implementation review is the last gate before commit, and a contained
  reviewer is independent of the orchestrator that produced and fixed the delta. `claude:session`
  remains valid and is the cheaper inline choice.
- `--implementation-reviewer-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort
  for a Codex-routed implementation reviewer.
- `--effort <none|minimal|low|medium|high|xhigh|max>` is the command-wide default for
  Codex-routed roles that have no role effort flag.
- `--max-fix-rounds <n>` defaults to 4.
- `--fresh` skips a reusable stored Codex plan-review thread.
- `--implement-only` implements and verifies once, then stops before review.
- `--review-only` reviews the current dirty/untracked implementation delta once without fixing.
- Without a mode flag, run the complete implement-plus-review/fix phase.

Reject missing values, duplicates, positionals, invalid effort/round values, unknown flags,
unknown `claude:*` values, and both mode flags together. Accept `claude:inherit` alongside
`claude:session` and the four explicit Claude aliases. Accept a Codex selection with or without
the `codex:` prefix and reject `codex:claude:*`. The removed implementer `--model` and `--review-model`
flags are unknown; report the role-named replacements.
The renamed `--impl-reviewer` and `--impl-reviewer-effort` flags are unknown; report
`--implementation-reviewer` and `--implementation-reviewer-effort` as their replacements.

For `--review-only`, reject `--implementer`, `--implementer-effort`, `--fresh`, and
`--max-fix-rounds`. For `--implement-only`, reject `--implementation-reviewer`,
`--implementation-reviewer-effort`, and `--max-fix-rounds`. Reject a role effort flag when its
selected role is Claude-routed.

Reject `claude:session` as the implementer; Claude writes must use the contained named agent.

For Codex implementation, resolve effort as `--implementer-effort` > command-wide `--effort` >
stored effort > the selected model's pair default. Either effort flag replaces the stored effort.
If the user overrides the implementer model while supplying neither effort flag, clear the stored
effort because it belonged to the old model, then use the new model's pair default. When both
stored values are null, use `codex:sol` and the user's matching role/command effort or `max`. Omit a
null effort. For a Codex implementation reviewer, resolve `--implementation-reviewer-effort` >
command-wide `--effort` > the routing skill's pair default.

Inside the full fix loop, act on findings automatically. The stop-after-review rule applies to
`--review-only` and explicit safeguard decisions.

## Common stored-plan preflight

Load:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json
```

If `available` is false, stop and tell the user to run `/stereo:plan`. Save a non-null stored
thread only as `storedPlanReviewThreadId`, never as an implementation thread.
Retain the stored `findings` array as `storedPlanFindings`, treating a missing or non-array value
as empty.

If the stored verdict is not `approve`, ask once:

- `Run /stereo:plan first (Recommended)`
- `Implement/review the unapproved plan anyway`
- `Stop here`

Show the summary, verdict, round (including round 0 for a draft), `updatedAt`, reviewer label when
present, whether residual risks exist, and the stored finding count (treat missing or non-array
`findings` as zero). Mention `/stereo:plan-state` for the complete plan.

## Standalone implementation-review step

For `--review-only`, do not use the normal dirty-worktree attribution rule:

1. Record `baselineCommit = HEAD`.
2. Read `git status --porcelain=v1 --untracked-files=all`.
3. Treat every current dirty and untracked path as the implementation delta.
4. If the worktree is clean, stop with `Nothing to review.`
5. Run the repository's identifiable host checks and record every command and exit result.
6. Build review input from the full stored plan, `HEAD`, current status/diff, every untracked file,
   the host-check results, and `storedPlanFindings`.

Read `${CLAUDE_PLUGIN_ROOT}/prompts/implementation-review.md` and fill it once without changing
any other text:

- `{{PLAN_INPUT}}` = the full stored plan.
- `{{BASELINE_CONTEXT}}` = the literal standalone-review rule that the entire current dirty and
  untracked worktree is the delta against `HEAD`, with the recorded HEAD, status, diff, and
  untracked-file inventory. Explicitly say not to apply the normal baseline-dirty exclusion.
- `{{REVIEW_CONTEXT}}` = `This is a standalone implementation review. There is no implementer
report and there are no prior implementation-review rounds.` Append `storedPlanFindings` verbatim
  when non-empty, labeled as "Advisory findings from the approving plan review, context only: the
  approved plan takes precedence, and the reviewer must not report a fix solely because an
  advisory finding was not adopted" when the stored verdict is `approve` and as known unapproved
  findings otherwise.
- `{{HOST_RESULTS}}` = every named host-verification command and its exact exit result/output
  summary.

The result is the single `implementationReviewBrief` for every route.

Route exactly one review through `--implementation-reviewer`:

- `claude:session`: apply `implementationReviewBrief` inline to the complete delta.
- Named Claude: use `implementationReviewBrief` verbatim as the routing skill's
  `stereo:implementation-reviewer` prompt.
- Codex: write `implementationReviewBrief` verbatim to `<payloadFile>` under the routing skill's
  temporary-directory rule, launch one fresh read-only task, and save its thread only as
  `implementationReviewThreadId`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --model <effectiveReviewModel> <reviewEffortArg> --output-schema "${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json" --prompt-file "<payloadFile>"
```

Validate through the routing skill, including the acceptable/fixes coupling and one retry. A
Codex retry preserves the same `--output-schema` flag. Report the exact
`{acceptable, summary, fixes}` result, host checks, and reviewer per-invocation usage and duration
(or `usage unavailable`), then stop. Do not fix or store implementation state.

## Implementation preflight

For the full phase or `--implement-only`, record:

- `baselineCommit` from `git rev-parse HEAD`.
- The exact paths from `git status --porcelain=v1 --untracked-files=all`.

If dirty, ask whether to stop so the user can commit/stash (recommended) or continue. Preserve the
baseline-dirty list for attribution and rollback. If the stop-time review gate is enabled, mention
that completion triggers an additional Codex review and how to disable it during long pair runs.

If the selected implementer is Claude, scan the stored plan's `## Step-by-step changes` before any
edit for commands beyond the fixed host verification gates: version bumps, package installation,
code generation, migrations, or interactive/long-running processes. If present, ask:

- Switch to the canonical `codex:sol` implementer with the user's effort or `max` (recommended).
- Continue with file edits only and leave each command step user-owned.
- Stop.

Record every user-owned step. The Claude implementer never requests commands, and the orchestrator
never executes shell text on an agent's behalf.

## Implementation routing

### Codex implementer

When `storedPlanReviewThreadId` is non-null and `--fresh` was not passed, resume it. Otherwise
start a fresh write thread. Embed the complete stored plan verbatim in every fresh prompt.

Approved, resumed. Write this complete payload to `<payloadFile>` under the routing skill's
temporary-directory rule:

```text
<task>
Implement the approved plan below in this repository. You reviewed and approved this plan earlier
in this thread.

[full stored plan, verbatim]

Advisory review findings (the approved plan takes precedence where they conflict):
[stored findings, verbatim]
</task>
<action_safety>
Only make changes the plan calls for. Do not commit, push, or touch unrelated files.
</action_safety>
<completeness_contract>
Implement the whole plan before stopping. Report any impossible step explicitly.
</completeness_contract>
<verification_loop>
Run the repository's relevant tests or build and fix regressions.
</verification_loop>
<compact_output_contract>
Report changes, touched files, verification results, and deviations with reasons.
</compact_output_contract>
```

Include the advisory findings block only when `storedPlanFindings` is non-empty; it never
authorizes work outside the approved plan.

Then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <storedPlanReviewThreadId> --model <effectiveModel> <effortArg> --prompt-file "<payloadFile>"
```

Approved, fresh. Write this complete payload to `<payloadFile>` under the routing skill's
temporary-directory rule:

```text
<task>
Implement the approved plan below in this repository. The plan was reviewed and approved outside
this Codex thread<, by reviewedBy when present>.

[full stored plan, verbatim]

Advisory review findings (the approved plan takes precedence where they conflict):
[stored findings, verbatim]
</task>
<action_safety>
Only make changes the plan calls for. Do not commit, push, or touch unrelated files.
</action_safety>
<completeness_contract>
Implement the whole plan before stopping. Report any impossible step explicitly.
</completeness_contract>
<verification_loop>
Run the repository's relevant tests or build and fix regressions.
</verification_loop>
<compact_output_contract>
Report changes, touched files, verification results, and deviations with reasons.
</compact_output_contract>
```

Include the advisory findings block only when `storedPlanFindings` is non-empty; it never
authorizes work outside the approved plan.

Then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --model <effectiveModel> <effortArg> --prompt-file "<payloadFile>"
```

Unapproved, resumed (only after the preflight gate):

```text
<task>
Implement the reviewed but unapproved plan below in this repository. You reviewed this plan
earlier in this thread, and the user explicitly chose to continue despite its stored verdict.
Implement only the plan's scope and do not silently discard the known findings.

[full stored plan, verbatim]

Latest stored review findings:
[stored findings, verbatim]
</task>
```

Use this task block in the approved-resumed command and retain all four safety/output contracts.
Include the findings block only when the stored findings array is non-empty.

Unapproved, fresh (only after the preflight gate):

```text
<task>
Implement the reviewed but unapproved plan below in this repository. The plan was reviewed
outside this Codex thread<, by reviewedBy when present>, and the user explicitly chose to
continue despite its stored verdict.
Implement only the plan's scope and do not silently discard the known findings.

[full stored plan, verbatim]

Latest stored review findings:
[stored findings, verbatim]
</task>
```

Use this task block in the approved-fresh command and retain all four safety/output contracts.
Include the findings block only when the stored findings array is non-empty. `--fresh` always
selects the corresponding fresh variant, even when a stored review thread exists.

Poll and fetch through the routing skill. If resume fails, or Codex claims changes while both
`touchedFiles` and the actual delta are empty, retry once fresh with the identical full prompt.
Save only the latest implementation/fix payload's thread id as `implementationThreadId`. Record
each implementation or retry invocation's per-job usage from `storedJob.tokenUsage.job`.

### Claude implementer

Use the routing skill's foreground `stereo:implementer` template with the full plan, baseline-dirty
paths, and user-owned command steps. On an unapproved run with stored findings, also append this
block to the implementer prompt:

```text
Latest stored review findings:
[stored findings, verbatim]
```

On an approved run with stored findings, append this advisory block instead:

```text
Advisory review findings (the approved plan takes precedence where they conflict):
[stored findings, verbatim]
```

After every Claude implementation or fix:

- Record the Agent result's token usage and duration, or `usage unavailable` when omitted.
- Compare `git rev-parse HEAD` with `baselineCommit`.
- If HEAD moved, stop, surface the commit change, and retract the final never-commit claim.
- Inspect `git diff <baselineCommit>`, status, and every new file while excluding baseline-dirty
  paths from attribution.

## Host verification and implement-only stop

After either implementer, run the identifiable repository checks on the host. For this repository:

```text
npm test
npm run typecheck
npm run lint
npm run format:check
npm run check-version
```

Elsewhere, use documented equivalents. Record every command and exit result. These are
orchestrator-owned gates, not model-requested shell work.

For `--implement-only`, report the attributed delta, selected implementer, host results,
deviations, user-owned steps, and every implementer invocation's per-invocation usage/duration (or
`usage unavailable`). Point to `/stereo:implement --review-only` and stop without any review or
fix round.

## Full implementation-review and fix loop

Build review input from the full plan, `baselineCommit`, baseline-dirty paths, current status/diff,
changed and untracked files, implementer report, host results, and `storedPlanFindings`. The
canonical contract is `${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json`.

Maintain `implementationReviewHistory` for every route and, for a named-Claude reviewer, the
continuation handle for this command run only. Build the history every round even while a reviewer
is being continued, because a fallback round needs it:

- Round 1 contains the implementer report verbatim, states that no earlier implementation-review
  fixes exist, and contains `storedPlanFindings` verbatim when non-empty. Label them as "Advisory
  findings from the approving plan review, context only: the approved plan takes precedence, and
  the reviewer must not report a fix solely because an advisory finding was not adopted" when the
  stored verdict is `approve` and as known unapproved findings otherwise; explicitly state that
  there are no stored plan-review findings when the array is empty.
- Every later round preserves the round-1 context, retains every prior numbered fix, marks each
  `resolved` or `unresolved` from the latest attributed delta and host results, and includes the
  latest fix-round implementer report verbatim.

The same per-round delta those bullets describe—the newly judged fixes, latest fix-round
implementer report, and latest host results—is what a continued round sends as its compact
message.

Route every round:

- For `claude:session`, named-Claude round 1, every named-Claude stateless fallback round, and
  every Codex round, read `${CLAUDE_PLUGIN_ROOT}/prompts/implementation-review.md` and fill it once
  for the current round without changing any other text:
  - `{{PLAN_INPUT}}` = the full stored plan.
  - `{{BASELINE_CONTEXT}}` = the normal phase-flow attribution semantics, including
    `baselineCommit`, baseline-dirty paths excluded from attribution, current status/diff, and all
    attributed changed and untracked files.
  - `{{REVIEW_CONTEXT}}` = the current `implementationReviewHistory`.
  - `{{HOST_RESULTS}}` = every named host-verification command and its exact exit result/output
    summary for the latest delta.
    Use the resulting `implementationReviewBrief` verbatim for the selected route.
- `claude:session`: apply `implementationReviewBrief` inline and produce internal
  `{acceptable, summary, fixes}` data.
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
  temporary-directory rule, start a fresh read-only task, and save its id only as
  `implementationReviewThreadId`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --model <effectiveReviewModel> <reviewEffortArg> --output-schema "${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json" --prompt-file "<payloadFile>"
```

Parse named-Claude output directly and Codex output from `storedJob.result.rawOutput`. Apply the
routing skill's validation and retry, including its continuation ladder for later named-Claude
rounds. A Codex retry resumes only
`implementationReviewThreadId` and preserves the same `--output-schema` flag; never assign it to
`implementationThreadId`. After the routing skill's retries for that round are exhausted, ask
whether to review inline or stop.

After every completed review round, report its number, verdict/fix count, and reviewer
per-invocation usage and duration (or `usage unavailable`), and whether the round was continued or
re-briefed. If acceptable, finish. Otherwise send the exact numbered fixes to the same implementer
kind that produced the delta.

Codex fix. Write this complete payload to `<payloadFile>` under the routing skill's
temporary-directory rule:

```text
<task>
Fix the review findings below in this repository. Keep all other behavior unchanged.

[numbered fixes with file, line, problem, and correct result]
</task>
<verification_loop>
Run the repository's relevant tests or build and fix regressions.
</verification_loop>
<compact_output_contract>
Report which findings were fixed, how, and what verification ran.
</compact_output_contract>
```

Then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <implementationThreadId> --model <effectiveModel> <effortArg> --prompt-file "<payloadFile>"
```

For Claude fixes, invoke the same contained implementer with the original model, full plan, and
numbered fixes. Recheck HEAD and the delta immediately. After every fix, rerun host checks and the
selected reviewer. Update every prior fix's `resolved`/`unresolved` status before constructing the
next round's `{{REVIEW_CONTEXT}}`.

At `--max-fix-rounds` (default 4), or when substantially the same issue survives three rounds,
show remaining fixes and ask whether to send one more implementer round, let the orchestrator fix
directly, or stop and report as-is.

## Final report

Report selected roles, fix rounds, attributed files, host results, deviations, user-owned steps,
all stored open questions and residual risks, and per-invocation usage/duration for every
implementer, fix, and reviewer turn. Use `usage unavailable` when metrics were omitted. For Codex
turns use `storedJob.tokenUsage.job`; for named Claude turns use the Agent result's usage and
duration. For Codex implementation, include `implementationThreadId` and
`codex resume <implementationThreadId>`. Label `storedJob.tokenUsage.thread` cumulative when shown
and never compare it with one Claude invocation. Label `storedPlanReviewThreadId` and
`implementationReviewThreadId` by role and never present them as implementation resume targets.

Give rollback guidance relative to `baselineCommit` without erasing baseline-dirty paths. If HEAD
is unchanged, state that nothing was committed or pushed. If it moved, retract that statement and
report the observed change. Never commit or push.

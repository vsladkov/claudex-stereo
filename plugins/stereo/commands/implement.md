---
description: Implement or review the stored plan with independently selected Claude or Codex role models
argument-hint: '[--implement-only|--review-only] [--implementer <model>] [--impl-reviewer <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--max-fix-rounds <n>] [--fresh]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion, Agent
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
  is null, use `sol`.
- `--impl-reviewer <model>` selects the implementation reviewer and defaults to
  `claude:session`.
- `--effort <none|minimal|low|medium|high|xhigh|max>` applies to all Codex-routed roles.
- `--max-fix-rounds <n>` defaults to 4.
- `--fresh` skips a reusable stored Codex plan-review thread.
- `--implement-only` implements and verifies once, then stops before review.
- `--review-only` reviews the current dirty/untracked implementation delta once without fixing.
- Without a mode flag, run the complete implement-plus-review/fix phase.

Reject missing values, duplicates, positionals, invalid effort/round values, unknown flags,
unknown `claude:*` values, and both mode flags together. The removed implementer `--model` and
`--review-model` flags are unknown; report the role-named replacements.

For `--review-only`, reject `--implementer`, `--fresh`, and `--max-fix-rounds`. For
`--implement-only`, reject `--impl-reviewer` and `--max-fix-rounds`.

Reject `claude:session` as the implementer; Claude writes must use the contained named agent.

For Codex implementation, user-supplied implementer and effort values override stored values. If
the user overrides only the model, clear the stored effort because it belonged to the old model.
When both stored values are null, use `sol` and the user's effort or `max`. Omit a null effort.
For a Codex implementation reviewer, apply the routing skill's pair defaults.

Inside the full fix loop, act on findings automatically. The stop-after-review rule applies to
`--review-only` and explicit safeguard decisions.

## Common stored-plan preflight

Load:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json
```

If `available` is false, stop and tell the user to run `/stereo:plan`. Save a non-null stored
thread only as `storedPlanReviewThreadId`, never as an implementation thread.

If the stored verdict is not `approve`, ask once:

- `Run /stereo:plan first (Recommended)`
- `Implement/review the unapproved plan anyway`
- `Stop here`

Show the summary, verdict, round (including round 0 for a draft), `updatedAt`, reviewer label when
present, and whether residual risks exist. Mention `/stereo:plan-state` for the complete plan.

## Standalone implementation-review step

For `--review-only`, do not use the normal dirty-worktree attribution rule:

1. Record `baselineCommit = HEAD`.
2. Read `git status --porcelain=v1 --untracked-files=all`.
3. Treat every current dirty and untracked path as the implementation delta.
4. If the worktree is clean, stop with `Nothing to review.`
5. Run the repository's identifiable host checks and record every command and exit result.
6. Build review input from the full stored plan, `HEAD`, current status/diff, every untracked file,
   and the host-check results.

Route exactly one review through `--impl-reviewer`:

- `claude:session`: inspect the complete delta inline.
- Named Claude: use the routing skill's `stereo:implementation-reviewer` template.
- Codex: launch one fresh read-only task and save its thread only as
  `implementationReviewThreadId`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --model <effectiveReviewModel> <reviewEffortArg> <<'CODEX_PAIR_PLAN'
<task>
Review the entire current dirty and untracked worktree against the stored plan below. The current
worktree is the implementation delta; do not apply the normal phase-flow baseline exclusion.
Inspect git status, git diff against HEAD, and every untracked file. Run only the named
verification commands. Do not edit files.

Plan:
[full stored plan, verbatim]

Host verification:
[commands and results]
</task>
<output_contract>
Return only raw JSON matching
${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json.
</output_contract>
CODEX_PAIR_PLAN
```

Validate through the routing skill, including the acceptable/fixes coupling and one retry. Report
the exact `{acceptable, summary, fixes}` result and host checks, then stop. Do not fix or store
implementation state.

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

- Switch to canonical Codex `sol` with the user's effort or `max` (recommended).
- Continue with file edits only and leave each command step user-owned.
- Stop.

Record every user-owned step. The Claude implementer never requests commands, and the orchestrator
never executes shell text on an agent's behalf.

## Implementation routing

### Codex implementer

When `storedPlanReviewThreadId` is non-null and `--fresh` was not passed, resume it. Otherwise
start a fresh write thread. Embed the complete stored plan verbatim in every fresh prompt.

Approved, resumed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <storedPlanReviewThreadId> --model <effectiveModel> <effortArg> <<'CODEX_PAIR_IMPL'
<task>
Implement the approved plan below in this repository. You reviewed and approved this plan earlier
in this thread.

[full stored plan, verbatim]
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
CODEX_PAIR_IMPL
```

Approved, fresh:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --model <effectiveModel> <effortArg> <<'CODEX_PAIR_IMPL'
<task>
Implement the approved plan below in this repository. The plan was reviewed and approved outside
this Codex thread<, by reviewedBy when present>.

[full stored plan, verbatim]
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
CODEX_PAIR_IMPL
```

Unapproved, resumed (only after the preflight gate):

```text
<task>
Implement the reviewed but unapproved plan below in this repository. You reviewed this plan
earlier in this thread, and the user explicitly chose to continue despite its stored verdict.

[full stored plan, verbatim]
</task>
```

Use this task block in the approved-resumed command and retain all four safety/output contracts.

Unapproved, fresh (only after the preflight gate):

```text
<task>
Implement the reviewed but unapproved plan below in this repository. The plan was reviewed
outside this Codex thread<, by reviewedBy when present>, and the user explicitly chose to
continue despite its stored verdict.

[full stored plan, verbatim]
</task>
```

Use this task block in the approved-fresh command and retain all four safety/output contracts.
`--fresh` always selects the corresponding fresh variant, even when a stored review thread exists.

Poll and fetch through the routing skill. If resume fails, or Codex claims changes while both
`touchedFiles` and the actual delta are empty, retry once fresh with the identical full prompt.
Save only the latest implementation/fix payload's thread id as `implementationThreadId`.

### Claude implementer

Use the routing skill's foreground `stereo:implementer` template with the full plan, baseline-dirty
paths, and user-owned command steps. After every Claude implementation or fix:

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
deviations, and user-owned steps. Point to `/stereo:implement --review-only` and stop without any
review or fix round.

## Full implementation-review and fix loop

Build review input from the full plan, `baselineCommit`, baseline-dirty paths, current status/diff,
changed and untracked files, implementer report, and host results. The canonical contract is
`${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json`.

Route every round:

- `claude:session`: inspect inline and produce internal `{acceptable, summary, fixes}` data.
- Named Claude: use the routing skill's `stereo:implementation-reviewer` template.
- Codex: start a fresh read-only task and save its id only as
  `implementationReviewThreadId`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --model <effectiveReviewModel> <reviewEffortArg> <<'CODEX_PAIR_PLAN'
<task>
Review the current implementation delta against the complete plan below. Inspect status and diff
relative to the supplied baseline, ignore already-dirty paths, run only the named verification
commands, and do not edit files.

Plan:
[full stored plan, verbatim]

Baseline commit:
[baselineCommit]

Already-dirty paths:
[path list]

Host verification:
[commands and results]
</task>
<output_contract>
Return only raw JSON matching
${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json.
</output_contract>
CODEX_PAIR_PLAN
```

Parse named-Claude output directly and Codex output from `storedJob.result.rawOutput`. Apply the
routing skill's validation and retry. A Codex retry resumes only
`implementationReviewThreadId`; never assign it to `implementationThreadId`. After a second
malformed result, ask whether to review inline or stop.

If acceptable, finish. Otherwise send the exact numbered fixes to the same implementer kind that
produced the delta.

Codex fix:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <implementationThreadId> --model <effectiveModel> <effortArg> <<'CODEX_PAIR_FIX'
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
CODEX_PAIR_FIX
```

For Claude fixes, invoke the same contained implementer with the original model, full plan, and
numbered fixes. Recheck HEAD and the delta immediately. After every fix, rerun host checks and the
selected reviewer.

At `--max-fix-rounds` (default 4), or when substantially the same issue survives three rounds,
show remaining fixes and ask whether to send one more implementer round, let the orchestrator fix
directly, or stop and report as-is.

## Final report

Report selected roles, fix rounds, attributed files, host results, deviations, user-owned steps,
and all stored open questions and residual risks. For Codex implementation, include
`implementationThreadId` and `codex resume <implementationThreadId>`. Label
`storedPlanReviewThreadId` and `implementationReviewThreadId` by role and never present them as
implementation resume targets.

Give rollback guidance relative to `baselineCommit` without erasing baseline-dirty paths. If HEAD
is unchanged, state that nothing was committed or pushed. If it moved, retract that statement and
report the observed change. Never commit or push.

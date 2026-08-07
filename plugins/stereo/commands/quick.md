---
description: Plan, review, implement, and verify one small task with independently routed Claude or Codex roles
argument-hint: '[--isolated] [--slot <name>] [--planner <model>] [--planner-effort <none|minimal|low|medium|high|xhigh|max>] [--plan-reviewer <model>] [--plan-reviewer-effort <none|minimal|low|medium|high|xhigh|max>] [--implementer <model>] [--implementer-effort <none|minimal|low|medium|high|xhigh|max>] [--implementation-reviewer <model>] [--implementation-reviewer-effort <none|minimal|low|medium|high|xhigh|max>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--max-plan-rounds <n>] [--max-fix-rounds <n>] [small task description]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(node:*), Bash(npm:*), Bash(git:*), AskUserQuestion, Agent
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

- `--planner <model>` resolves as explicit flag > workspace `planner` default >
  `claude:fable`; the scope gate still runs inline in this session before any routed draft.
- `--planner-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort for a
  Codex-routed planner.
- `--plan-reviewer <model>` resolves as explicit flag > workspace `planReviewer` default >
  `codex:sol`.
- `--plan-reviewer-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort for a
  Codex-routed plan reviewer.
- `--implementer <model>` resolves as explicit flag > workspace `implementer` default >
  `claude:opus`. The latest Codex plan-review payload's model and effort never resolve the
  implementer; per the implementation routing below, a Codex-routed selection resumes
  `planReviewThreadId` only when it is the plan reviewer's resolved model.
- `--implementer-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort for a
  Codex-routed implementer.
- `--implementation-reviewer <model>` resolves as explicit flag > workspace
  `implementationReviewer` default > `codex:sol`; the cross-ecosystem reviewer is independent of
  this orchestrating session and of the Claude-routed default implementer.
- `--implementation-reviewer-effort <none|minimal|low|medium|high|xhigh|max>` overrides effort
  for a Codex-routed implementation reviewer.
- `--effort <none|minimal|low|medium|high|xhigh|max>` is the command-wide default for
  Codex-routed roles that have no role effort flag.
  When no active role is Codex-routed, a command-wide `--effort` is inert: accept it, report it as
  inert, and never translate it into a Claude-side control.
- `--slot <name>` selects the durable plan slot this run stores into and defaults to `default`.
  Slot names are trimmed, lowercased, may contain only letters, digits, hyphens, and underscores,
  and must start with a letter or digit. Relay the CLI's validation error verbatim.
- `--max-plan-rounds <n>` defaults to 2 and must be an integer from 1 to 6.
- `--max-fix-rounds <n>` defaults to 2 and must be a positive integer.
- `--isolated` runs implementation, implementation review, and fixes in a throwaway detached git
  worktree outside the repository and hands the delta back as a user-confirmed patch. It never
  commits and never writes in the main working tree. The plan draft and every plan-review round
  always run against the main tree.
- Remaining text is the task. Ask for it if empty.

Reject missing values, duplicate role or role-effort flags, invalid effort or round values,
unknown flags, unknown `claude:*` values, and `claude:session` as implementer. Accept
`claude:inherit` alongside `claude:session` and the four explicit Claude aliases. Accept a Codex
selection with or without the `codex:` prefix and reject `codex:claude:*`. Reject a role effort
flag when its selected role is Claude-routed. Resolve every Codex role through role effort >
command-wide effort > workspace role effort > the routing skill's pair default. Plan-review
payload effort belongs to the payload model and is never borrowed by the resolved implementer.
A delta is never gated by the model that produced it: when the resolved implementer and
implementation reviewer are the same model and the reviewer came from the built-in default rather
than a flag or workspace default, substitute the other ecosystem's review default (`codex:sol`
for a Claude-routed implementer, `claude:fable` for a Codex-routed one) and report the
substitution; a same-model reviewer selected by flag or workspace default is honored but called
out as self-review.
The removed `--model` flag is unknown; report the role-named alternatives. The renamed
`--impl-reviewer` and `--impl-reviewer-effort` flags are unknown; report
`--implementation-reviewer` and `--implementation-reviewer-effort` as their replacements. Reject
`--max-plan-rounds` above 6 and point at `/stereo:plan` for a longer plan-review loop; Quick's
absolute safeguard at 6 is fixed.

`/stereo:quick` has no `--resume`: an interrupted Quick run restarts from the beginning. Use
`/stereo:plan` plus `/stereo:implement` for a long task that needs durable phase state and
`/stereo:implement --resume`. Quick writes no implementation record, so a crash during an
`--isolated` run strands the worktree with no durable pointer to it; Quick prints `<worktreePath>`
at creation and `/stereo:doctor` lists every stranded `stereo-worktrees` entry with its exact
removal command.

Define these invocation placeholders before any routed step:

- `<plannerSelectionArgs>` = `--model <effectivePlannerModel> <plannerEffortArg>`.
- `<reviewSelectionArgs>` =
  `--model <effectivePlanReviewerModel> <planReviewerEffortArg>`.
- `<plannerEffortArg>` and `<planReviewerEffortArg>` are `--effort <resolved effort>` when the
  corresponding role's resolved effort is non-null, and are omitted entirely otherwise.
- `<slotArg>` = `--slot <slot>` when this run targets a non-default slot, and is omitted entirely
  for the `default` slot.
- `<isolationArgs>` is defined in **Isolated worktree mode** and is empty in every non-isolated
  run.

The `task` command injects no server-side effort default, so omitting the planner `--effort`
silently loses a resolved `max` for a `gpt-*` planner. `plan-review` does default a missing
`--effort` to the selected model's pair default, so the reviewer placeholder enforces consistency
rather than correcting runtime behavior.

Keep these ids distinct:

- `plannerThreadId`: Codex draft only; never reused.
- `planReviewThreadId`: Codex plan-review payloads only.
- `implementationThreadId`: Codex implementation/fix payloads only.
- `implementationReviewThreadId`: fresh Codex implementation-review tasks only.

Never cross-assign them.

## Workspace role defaults

Before any routed step, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" config --json
```

Read `roleDefaults`. If the command fails, report the failure and continue with built-in defaults.
Ignore an entry with a non-null `invalidReason`, report its warning, and use the built-in default
for that role. Report a stored effort for a Claude-routed role as inert. Resolve stored `claude:*`
selections as Claude routes and never pass them to the companion's `--model` flag. When a
workspace default supplies a role's model, say so in the effective-role recap.

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
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --json <slotArg>
```

If `available` is true, warn that Quick will replace the plan in slot `<slot>`, naming its summary
and `updatedAt`; every other slot is untouched. Report `implementedAt` when present; otherwise say
`not marked implemented`. Name `--slot <name>` as the escape hatch for keeping the current plan.
Do not read plan-state again during this run; carry current plan/review state in the conversation.

## Plan-review loop

Quick pauses after <maxPlanRounds> plan-review rounds, with an absolute safeguard at 6 after an
explicit keep-iterating choice.

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
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --round 1 <slotArg> <reviewSelectionArgs> --plan-file "<payloadFile>"
```

- Later Codex rounds: write the full revised plan verbatim to `<payloadFile>` under the same
  temporary-directory rule, then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-review --background --json --thread <planReviewThreadId> --round <n> <slotArg> <reviewSelectionArgs> --plan-file "<payloadFile>"
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

On approval, continue without a user gate. Before leaving a terminal Claude-side review, write the
full current plan verbatim to `<payloadFile>` under the routing skill's temporary-directory rule.
Under the same rule, write the summary as plain text and the findings, open questions, and residual
risks as JSON arrays (`[]` for empty lists) to distinct `<summaryPayloadFile>`,
`<findingsPayloadFile>`, `<openQuestionsPayloadFile>`, and `<residualRisksPayloadFile>` files, then
persist:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-store --json <slotArg> --verdict '<actual verdict>' --round <reviewRound> <--thread <planReviewThreadId>|--no-thread> --reviewed-by '<reviewer label>' --summary-file "<summaryPayloadFile>" --findings-file "<findingsPayloadFile>" --open-questions-file "<openQuestionsPayloadFile>" --residual-risks-file "<residualRisksPayloadFile>" < "<payloadFile>"
```

Pass `--thread <planReviewThreadId>` when this run has one; otherwise pass `--no-thread`.

Codex plan reviews already store each parsed round.

After round <maxPlanRounds> still needs revision, ask:

- `Keep iterating (Recommended)`: continue automatically through the rounds after
  `<maxPlanRounds>` up to 5 while converging; at round 6 ask only implement-anyway or stop.
- `Implement anyway`: first persist a Claude-side `needs-revision` result when applicable, retain
  the findings as original unapproved findings, then enter the truthful unapproved branch.
- `Stop here`: first persist a Claude-side `needs-revision` result when applicable, report the
  findings, and stop.

When `<maxPlanRounds>` is already 6, that first pause is the absolute safeguard: offer only
implement-anyway or stop and omit the keep-iterating option.

Pause at the same decision point on plan growth beyond roughly 1.5 times round 1, review-added
machinery attracting findings, two surviving rebuttals, or oscillation.

## Implementation preflight

Use the in-conversation plan and latest result. Show the plan summary, rounds, effective
implementer, and residual risks.

Record `baselineCommit`, status, and all already-dirty paths. If dirty, ask whether to stop for a
commit/stash (recommended) or continue. In isolated mode, use the expanded question in **Isolated
worktree mode** instead of asking twice. Mention an enabled stop-review gate.

If the selected implementer is Claude, scan for command-requiring work beyond host verification:
version bumps, dependency installation, code generation, migrations, or interactive/long-running
processes. If found, ask whether to switch to the command-capable `codex:sol` implementer, leave
each command step user-owned, or stop. Never execute shell text on a Claude agent's behalf.

## Isolated worktree mode

This section applies to every `--isolated` run. Quick keeps no implementation record, so nothing
here reads or writes durable state. Set `<mainRoot>` to `git rev-parse --show-toplevel`. The
worktree is detached and temporary; no command in this flow creates a branch or commit. The plan
draft and every plan-review round run against `<mainRoot>`; only implementation, implementation
review, and fixes run in the worktree.

1. **Extra preflight.** After recording `baselineCommit` and the baseline-dirty paths, if the main
   tree is dirty, explain that the isolated worktree starts from `HEAD` and therefore does not
   contain those uncommitted changes. Hand-back refuses patched paths that overlap the dirty set.
   Ask exactly once whether to stop and commit/stash (recommended) or continue. If the stop-time
   review gate is enabled, also explain that it reviews the main tree, which remains clean during
   the isolated run, and point to `/stereo:setup --disable-review-gate`.
2. **Creation.** Derive `<repoSlug>` from the basename of `<mainRoot>` by replacing every run of
   characters outside `[A-Za-z0-9._-]` with `-`. Generate a fresh unique `<shortId>` and create the
   worktree only outside the repository working tree:

   ```bash
   git -C "<mainRoot>" worktree add --detach "${TMPDIR:-/tmp}/stereo-worktrees/<repoSlug>-<shortId>" HEAD
   ```

   `git worktree add` creates the missing temporary parent directories. Save the resulting
   absolute path as `<worktreePath>`. Print `<worktreePath>` as soon as creation succeeds; it is the
   only record of this worktree that survives a crashed Quick run. Never place it inside
   `<mainRoot>`. If creation fails, report the exact failure and stop without launching an
   implementer.

3. **Companion routing.** Define `<isolationArgs>` as empty in every non-isolated run. In isolated
   mode it is:

   ```text
   --cwd "<worktreePath>" --workspace "<mainRoot>"
   ```

   `--cwd` sets the Codex thread cwd, which confines Codex writes to the worktree. `--workspace`
   keeps the job record, log, durable state, and shared broker keyed to the main workspace. Thus
   `/stereo:status`, `/stereo:result`, and `/stereo:cancel` continue to work unchanged from the
   main repository, and no second worktree-keyed broker is started.

4. **Post-turn containment guard.** After every implementation or fix turn, run
   `git -C "<mainRoot>" status --porcelain=v1 --untracked-files=all` and compare its exact path set
   with the recorded baseline-dirty set. Any new main-tree path means the implementer wrote outside
   the worktree: stop, report the paths verbatim, and do not continue the loop. Codex-reported
   `touchedFiles` are absolute to the worktree; do not mistake them for main-tree writes.
5. **Review and verification target.** Use `git -C "<worktreePath>" ...` for every diff, status,
   and file inspection. `{{BASELINE_CONTEXT}}` must say that the delta lives in the isolated
   worktree at `<worktreePath>`, provide its `baselineCommit`, and say that fix `file` values remain
   repository-relative and are identical in both trees. For a named-Claude or `claude:session`
   reviewer, provide the absolute worktree path and require inspection with
   `git -C "<worktreePath>"` and absolute Read paths. If the harness denies reads outside the main
   workspace, fall back to the complete diff already embedded in `{{BASELINE_CONTEXT}}` and record
   that limitation in the round note. A contained `stereo:implementer` also receives absolute
   worktree paths for every Edit, Write, and Read operation. If its Edit or Write is denied outside
   the main workspace, stop and report the denial instead of falling back to the main tree.
6. **Host gates.** Run repository gates with the worktree as their working directory. For npm
   projects use `npm --prefix "<worktreePath>" test`, and the corresponding `npm --prefix` form for
   every other script. If a gate cannot run because gitignored dependencies or generated artifacts
   are absent, record its exact result as `not runnable in the isolated worktree`, carry it into
   `{{HOST_RESULTS}}` and the final report, and do not call it passed. After a confirmed hand-back,
   rerun the complete gate set in the main tree before the final report.
7. **Delta hand-back.** At every terminal exit—accepted full phase, safeguard stop, or max-rounds
   stop—create a patch under the routing skill's temporary-directory rule, never inside either
   repository tree:

   ```bash
   git -C "<worktreePath>" add -N .
   git -C "<worktreePath>" diff --binary --no-ext-diff "<baselineCommit>" > "<patchFile>"
   git -C "<worktreePath>" diff --stat "<baselineCommit>"
   git -C "<worktreePath>" diff --name-only "<baselineCommit>"
   ```

   If the patch is empty, say so and proceed directly to cleanup. Otherwise recompute
   `git -C "<mainRoot>" status --porcelain=v1 --untracked-files=all` and
   `git -C "<mainRoot>" rev-parse HEAD`. Report every overlap between patched paths and currently
   dirty main-tree paths and report when `HEAD` moved from `baselineCommit`. Show the patch stat and
   ask exactly once:

   - `Apply the patch to the working tree (Recommended)`
   - `Leave the patch and the worktree for me`
   - `Discard the worktree without applying`

   When `HEAD` moved, include in that apply question itself that a 3-way merge may conflict. On
   apply, first run `git -C "<mainRoot>" apply --3way --check "<patchFile>"`; only after it succeeds
   run `git -C "<mainRoot>" apply --3way "<patchFile>"`. The check validates pre-images and index
   compatibility, but with `--3way` it does not detect every merge conflict: the real apply can
   still exit nonzero, leave conflict markers, and create unmerged index entries on paths that were
   clean before it. A successful `--3way` apply stages the delta because it implies `--index`;
   nothing is committed or pushed. On failure at either step, report git's exact output and
   `git -C "<mainRoot>" diff --name-only --diff-filter=U`, identify real-apply conflict paths as
   having been clean before the apply, keep the patch and worktree, and hand resolution to the
   user. Explain that those paths can be returned to their pre-apply `HEAD` state with a
   user-chosen `git reset -- <paths>` followed by `git checkout -- <paths>`; do not run that
   recovery automatically.

8. **Cleanup.** Only after the user confirms the patch landed (or the patch was empty), run
   `git -C "<mainRoot>" worktree remove --force "<worktreePath>"`. In every other case print
   `<worktreePath>`, `<patchFile>`, and that exact removal command, and say the worktree was
   intentionally left in place.

## Implementation routing

### Codex implementer

If `planReviewThreadId` exists and the effective implementer is the plan reviewer's resolved
model, resume it. Otherwise launch fresh without `--thread` — a different model never resumes
another model's review thread. Always pass the effective implementer model and optional effort.

Approved, resumed. Write this complete payload to `<payloadFile>` under the routing skill's
temporary-directory rule:

```text
<task>
Implement the approved plan below in this repository. You reviewed and approved this plan earlier
in this thread.

[current full plan, verbatim]

Advisory review findings (the approved plan takes precedence where they conflict):
[latest findings, verbatim]

[When isolated: The working root for this task is <worktreePath>, a detached worktree at
<baselineCommit>. Do not modify any other directory.]
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

Then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <planReviewThreadId> --model <effectiveModel> <effortArg> <isolationArgs> --prompt-file "<payloadFile>"
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

[When isolated: The working root for this task is <worktreePath>, a detached worktree at
<baselineCommit>. Do not modify any other directory.]
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

Then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --model <effectiveModel> <effortArg> <isolationArgs> --prompt-file "<payloadFile>"
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

[When isolated: The working root for this task is <worktreePath>, a detached worktree at
<baselineCommit>. Do not modify any other directory.]
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

[When isolated: The working root for this task is <worktreePath>, a detached worktree at
<baselineCommit>. Do not modify any other directory.]
</task>
```

Both variants retain all four safety/output contracts from the approved templates.

Poll and fetch through the routing skill. If resume fails, or claimed changes have neither
`touchedFiles` nor an actual delta, retry once fresh with the same truthful full prompt. Adopt the
latest implementation payload's thread only as `implementationThreadId`. Record every Codex
implementation or retry invocation's per-job usage from `storedJob.tokenUsage.job`. Retain
`<isolationArgs>` on that retry.

### Claude implementer

Use the routing skill's foreground `stereo:implementer` template with the plan, baseline-dirty
paths, `latestPlanFindings` when non-empty, and user-owned steps. Frame those findings as original
unapproved findings after `Implement anyway`; otherwise use the same advisory findings heading the
approved Codex payloads use. After every invocation, record the Agent result's token usage and
duration (or `usage unavailable`), compare HEAD with `baselineCommit`, and inspect the actual
delta. Stop and retract the never-commit claim if HEAD moved.

After either implementer, run identifiable host tests/builds and record commands and results. In
isolated mode, run them per **Isolated worktree mode**'s host-gates step.

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
    changed and untracked file. In isolated mode, say the delta lives in the isolated worktree at
    `<worktreePath>`, provide its `baselineCommit`, and say that fix `file` values remain
    repository-relative and identical in both trees.
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --model <effectiveReviewModel> <reviewEffortArg> --output-schema "${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json" <isolationArgs> --prompt-file "<payloadFile>"
```

Save a Codex review task's thread only as `implementationReviewThreadId`. Parse
`storedJob.result.rawOutput`; retry malformed output once on that review thread while preserving
the same `--output-schema` flag and `<isolationArgs>`. Never assign it to
`implementationThreadId`.

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
Run the repository's relevant tests or build and fix regressions.
</verification_loop>
<compact_output_contract>
Report which findings were fixed, how, and what verification ran.
</compact_output_contract>
```

The four implementer contract bodies are shared verbatim across `/stereo:implement` and
`/stereo:quick` and must be edited together.

Then launch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" task --background --json --write --thread <implementationThreadId> --model <effectiveModel> <effortArg> <isolationArgs> --prompt-file "<payloadFile>"
```

For Claude fixes, use the same named implementer and model with the full plan and fixes. Recheck
HEAD and delta. After every fix, rerun host checks, update every prior fix's
`resolved`/`unresolved` status for the next `{{REVIEW_CONTEXT}}`, and invoke the selected reviewer.

Quick pauses after <maxFixRounds> fix rounds. Show remaining fixes and ask whether to send one more
implementer round, let Claude fix directly, or stop. Do not silently exceed the cap.

For every original unapproved plan finding, track `resolved` only when delta/tests prove it;
otherwise `unresolved`.

After an accepted implementation review and before the final report, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" plan-state --mark-implemented --json <slotArg>
```

Report a marker failure but never fail Quick because of it. Do not mark the plan until the full
implementation-review phase is accepted. In isolated mode, run the marker only after the hand-back
resolves to an applied or empty patch; when the user discarded the delta, skip the marker and say
so.

## Final report

Report selected roles, fix rounds, attributed files, host results, deviations, user-owned steps,
open questions, residual risks, and per-invocation usage/duration for every draft, plan-review,
implementer, fix, and implementation-review turn. Use `usage unavailable` when metrics were
omitted. For Codex turns use `storedJob.tokenUsage.job`; for named Claude turns use the Agent
result's usage and duration. Label `storedJob.tokenUsage.thread` cumulative when shown and never
compare it with one Claude invocation. If unapproved implementation was chosen, list every
original finding with status and evidence. Name the stored plan slot and, for a named slot, give
`/stereo:implement --slot <slot>` as the follow-up command.

Include `implementationThreadId` and `codex resume <implementationThreadId>` only when Codex
implemented. Label all other thread ids by role.

For an isolated run, also report the worktree path, patch file, hand-back decision and result,
including `staged, not committed` on success and every conflicted path on failure. Say whether the
worktree was removed and list every gate recorded as `not runnable in the isolated worktree` plus
the result of its post-hand-back main-tree rerun.

Give rollback guidance relative to the baseline without erasing pre-existing dirty paths. State
nothing was committed or pushed only if HEAD is unchanged; otherwise retract that claim. Never
commit or push.
